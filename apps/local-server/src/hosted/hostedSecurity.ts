import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  signOwnerSession,
  verifyAgentToken,
  verifyLibrarySignature,
  verifyOwnerSession,
} from './hostedAuth';

// Requests made by the app to itself (MCP tools call app.request) carry this per-process secret.
export const INTERNAL_REQUEST_HEADER = 'x-cozy-internal';
const internalRequestSecret = randomBytes(24).toString('base64url');

export function withInternalRequestHeader(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_REQUEST_HEADER, internalRequestSecret);
  return { ...init, headers };
}

export interface HostedSecurityOptions {
  database: () => Database;
  sessionSecret: string;
  allowedOrigins: string[];
}

type Caller = 'internal' | 'owner' | 'agent' | 'signed-url' | null;

// Routes that host-local Studio offers but a hosted instance must not (ADR 0012).
const HOST_LOCAL_PREFIXES = [
  '/api/updates',
  '/api/onboarding',
  '/api/app-server',
  '/api/runtime/doctor',
  '/api/codex',
  '/api/output-sources',
  '/api/maintenance',
  '/api/extensions/install-local',
  '/api/studio/reset',
  '/api/sprite-atlas',
  '/api/animation-sequence',
  '/api/bootstrap-config',
];

export function isHostLocalRoute(method: string, path: string) {
  if (HOST_LOCAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return true;
  }
  // Registering arbitrary host folders makes no sense on a disposable instance.
  return path.startsWith('/api/libraries') && method !== 'GET';
}

function bearerToken(header: string | undefined) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function normalizeOrigin(value: string | undefined | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function createHostedSecurityMiddleware(options: HostedSecurityOptions): MiddlewareHandler {
  const allowedOrigins = new Set(
    options.allowedOrigins.map(normalizeOrigin).filter((origin): origin is string => !!origin),
  );

  const identify = (request: Request, path: string): Caller => {
    if (request.headers.get(INTERNAL_REQUEST_HEADER) === internalRequestSecret) return 'internal';
    const cookie = request.headers.get('cookie') ?? '';
    const sessionValue = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (verifyOwnerSession(options.sessionSecret, sessionValue)) return 'owner';
    const token = bearerToken(request.headers.get('authorization') ?? undefined);
    if (token && verifyAgentToken(options.database(), token)) return 'agent';
    if (path.startsWith('/library/')) {
      const url = new URL(request.url);
      if (
        verifyLibrarySignature(
          options.sessionSecret,
          path,
          url.searchParams.get('exp'),
          url.searchParams.get('sig'),
        )
      ) {
        return 'signed-url';
      }
    }
    return null;
  };

  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    const origin = normalizeOrigin(c.req.header('origin'));

    if (origin && allowedOrigins.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
    if (method === 'OPTIONS') {
      if (!origin || !allowedOrigins.has(origin)) return c.body(null, 403);
      c.header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }

    if (isHostLocalRoute(method, path)) {
      return c.json(
        { error: 'Not available in hosted Cozy Studio.', code: 'host_local_route' },
        404,
      );
    }

    // The sweep route checks its own secret; the session route verifies Neon Auth itself.
    const isPublic =
      path === '/api/session' ||
      path.startsWith('/internal/sweep/') ||
      path.startsWith('/neon-auth/');
    if (isPublic) return next();

    const caller = identify(c.req.raw, path);
    const ownerOnly = path.startsWith('/api/agent-tokens');
    const allowed =
      caller === 'internal' ||
      caller === 'owner' ||
      (caller === 'agent' && !ownerOnly) ||
      (caller === 'signed-url' && (method === 'GET' || method === 'HEAD'));
    if (!allowed) {
      return c.json({ error: 'Sign in to Cozy Studio.', code: 'unauthorized' }, 401);
    }

    // Cookie-authenticated writes must come from the Studio UI (CSRF).
    const isWrite = !['GET', 'HEAD'].includes(method);
    if (caller === 'owner' && isWrite && (!origin || !allowedOrigins.has(origin))) {
      return c.json({ error: 'Request origin is not allowed.', code: 'forbidden_origin' }, 403);
    }
    return next();
  };
}

export interface OwnerSessionRoutesOptions {
  database: () => Database;
  sessionSecret: string;
  ownerEmail: string;
  neonAuthBaseUrl: string;
  neonAuthJwksUrl: string;
  /** Tests replace the remote JWKS. */
  keySet?: JWTVerifyGetKey;
}

export function createOwnerSessionRoutes(options: OwnerSessionRoutesOptions) {
  const routes = new Hono();
  const issuer = new URL(options.neonAuthBaseUrl).origin;
  const keySet = options.keySet ?? createRemoteJWKSet(new URL(options.neonAuthJwksUrl));
  const ownerEmail = options.ownerEmail.trim().toLowerCase();

  routes.get('/api/session', (c) => {
    const session = verifyOwnerSession(options.sessionSecret, getCookie(c, SESSION_COOKIE));
    return c.json(
      session ? { authenticated: true, email: session.email } : { authenticated: false },
    );
  });

  // Exchanges a Neon Auth JWT for the Studio session cookie.
  routes.post('/api/session', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return c.json({ error: 'Missing Neon Auth token.', code: 'unauthorized' }, 401);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keySet, { issuer, audience: issuer }));
    } catch {
      return c.json({ error: 'Neon Auth token is not valid.', code: 'unauthorized' }, 401);
    }
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email || email !== ownerEmail || payload.emailVerified === false) {
      return c.json({ error: 'This account cannot use this Studio.', code: 'forbidden' }, 403);
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    setCookie(
      c,
      SESSION_COOKIE,
      signOwnerSession(options.sessionSecret, {
        sub: typeof payload.sub === 'string' ? payload.sub : '',
        email,
        exp,
      }),
      {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
      },
    );
    return c.json({ authenticated: true, email });
  });

  routes.delete('/api/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.json({ authenticated: false });
  });

  routes.get('/api/agent-tokens', (c) => c.json({ tokens: listAgentTokens(options.database()) }));
  routes.post('/api/agent-tokens', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const created = createAgentToken(
      options.database(),
      typeof body.name === 'string' ? body.name : 'Agent',
    );
    return c.json(created, 201);
  });
  routes.delete('/api/agent-tokens/:id', (c) =>
    revokeAgentToken(options.database(), c.req.param('id'))
      ? c.json({ revoked: true })
      : c.json({ error: 'Token not found.' }, 404),
  );

  return routes;
}
