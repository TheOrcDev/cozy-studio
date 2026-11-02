import { Hono } from 'hono';

// Neon Auth rejects requests that carry a forwarded host, which Vercel rewrites add. The browser
// therefore reaches Neon Auth through this function: same origin as the UI, so its session cookie
// stays first-party, and a clean upstream request (ADR 0012).

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'origin',
  'user-agent',
];
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

/** Keeps Neon Auth cookies host-only on the Studio domain. */
export function toHostOnlyCookie(setCookie: string) {
  return setCookie
    .split(';')
    .filter((part) => !/^\s*domain=/i.test(part))
    .join(';');
}

export function createNeonAuthProxyRoutes({
  baseUrl,
  fetchImpl = (input, init) => fetch(input, init),
}: {
  baseUrl: string;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}) {
  const routes = new Hono();
  const upstreamBase = baseUrl.replace(/\/$/, '');

  routes.all('/neon-auth/*', async (c) => {
    const incoming = new URL(c.req.url);
    const target = `${upstreamBase}${incoming.pathname.slice('/neon-auth'.length)}${incoming.search}`;
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const method = c.req.method;
    const upstream = await fetchImpl(target, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
      redirect: 'manual',
    });
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    });
    for (const cookie of upstream.headers.getSetCookie()) {
      responseHeaders.append('set-cookie', toHostOnlyCookie(cookie));
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });

  return routes;
}
