import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPostgresDatabase } from '../db/postgres/testPostgresDatabase';
import { createAgentToken, SESSION_COOKIE, signLibraryPath, signOwnerSession } from './hostedAuth';
import { shapeRemoteMcpResult } from './hostedMcp';
import {
  createHostedSecurityMiddleware,
  isHostLocalRoute,
  withInternalRequestHeader,
} from './hostedSecurity';
import { createNeonAuthProxyRoutes, toHostOnlyCookie } from './neonAuthProxy';

const SECRET = 'test-session-secret';
const ORIGIN = 'https://studio.example.com';

describe('hosted security middleware', () => {
  let database: Database;
  let app: Hono;
  let agentToken: string;
  const ownerCookie = `${SESSION_COOKIE}=${signOwnerSession(SECRET, {
    sub: 'owner',
    email: 'me@example.com',
    exp: Math.floor(Date.now() / 1000) + 60,
  })}`;

  beforeAll(() => {
    database = createTestPostgresDatabase();
    agentToken = createAgentToken(database, 'Agent').token;
    app = new Hono();
    app.use(
      '*',
      createHostedSecurityMiddleware({
        database: () => database,
        sessionSecret: SECRET,
        allowedOrigins: [ORIGIN],
      }),
    );
    app.all('*', (c) => c.json({ ok: true }));
  }, 60_000);

  afterAll(() => database?.close());

  const call = (path: string, init: RequestInit = {}) =>
    app.request(`https://function.example.com${path}`, init);

  it('hides host-local routes and requires a caller elsewhere', async () => {
    expect((await call('/api/updates', { headers: { cookie: ownerCookie } })).status).toBe(404);
    expect(isHostLocalRoute('POST', '/api/libraries')).toBe(true);
    expect(isHostLocalRoute('GET', '/api/libraries')).toBe(false);
    expect((await call('/api/jobs')).status).toBe(401);
    expect((await call('/api/session')).status).toBe(200);
    expect((await call('/neon-auth/ok')).status).toBe(200);
  });

  it('lets the owner read, and write only from the Studio origin', async () => {
    expect((await call('/api/jobs', { headers: { cookie: ownerCookie } })).status).toBe(200);
    const write = { method: 'POST', headers: { cookie: ownerCookie } };
    expect((await call('/api/jobs', write)).status).toBe(403);
    const fromStudio = await call('/api/jobs', {
      method: 'POST',
      headers: { cookie: ownerCookie, origin: ORIGIN },
    });
    expect(fromStudio.status).toBe(200);
    expect(fromStudio.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('accepts agent tokens except for token management', async () => {
    const bearer = { authorization: `Bearer ${agentToken}` };
    expect((await call('/mcp', { method: 'POST', headers: bearer })).status).toBe(200);
    expect((await call('/api/agent-tokens', { headers: bearer })).status).toBe(401);
    expect(
      (await call('/api/jobs', { headers: { authorization: 'Bearer cozy_at_wrong' } })).status,
    ).toBe(401);
  });

  it('accepts signed Library URLs and in-process requests', async () => {
    const path = '/library/lib/outputs/a.png';
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signLibraryPath(SECRET, path, exp);
    expect((await call(`${path}?exp=${exp}&sig=${sig}`)).status).toBe(200);
    expect((await call(`${path}?exp=${exp}&sig=${sig}x`)).status).toBe(401);
    expect((await call('/api/jobs', withInternalRequestHeader())).status).toBe(200);
  });
});

describe('remote MCP results', () => {
  it('signs Library URLs and removes instance paths', () => {
    const shaped = shapeRemoteMcpResult(
      { images: [{ publicUrl: '/library/a/b.png', filePath: '/tmp/cozy/x.png', prompt: 'p' }] },
      { publicOrigin: `${ORIGIN}/`, sessionSecret: SECRET, now: 0 },
    ) as { images: Array<Record<string, string>> };
    const image = shaped.images[0]!;
    expect(image.filePath).toBeUndefined();
    expect(image.prompt).toBe('p');
    const url = new URL(image.publicUrl!);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/library/a/b.png');
    expect(url.searchParams.get('sig')).toBe(
      signLibraryPath(SECRET, '/library/a/b.png', Number(url.searchParams.get('exp'))),
    );
  });
});

describe('Neon Auth proxy', () => {
  it('drops forwarded headers and keeps cookies host-only', async () => {
    let seen: Request | null = null;
    const routes = createNeonAuthProxyRoutes({
      baseUrl: 'https://auth.example.com/neondb/auth/',
      fetchImpl: async (input: string, init: RequestInit) => {
        seen = new Request(input, init);
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append('set-cookie', 'session=abc; Domain=auth.example.com; Path=/; HttpOnly');
        return new Response('{"ok":true}', { status: 200, headers });
      },
    });
    const response = await routes.request('https://studio.example.com/neon-auth/token?x=1', {
      headers: { 'x-forwarded-host': 'studio.example.com', cookie: 'session=abc', origin: ORIGIN },
    });
    expect(seen!.url).toBe('https://auth.example.com/neondb/auth/token?x=1');
    expect(seen!.headers.get('x-forwarded-host')).toBeNull();
    expect(seen!.headers.get('cookie')).toBe('session=abc');
    expect(response.headers.get('set-cookie')).toBe('session=abc; Path=/; HttpOnly');
    expect(toHostOnlyCookie('a=b; domain=x.com; Secure')).toBe('a=b; Secure');
  });
});
