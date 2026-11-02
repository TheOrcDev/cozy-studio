import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';

// Hosted access control (ADR 0012). The owner signs in once through Neon Auth and receives an
// HttpOnly session cookie, which also covers EventSource and <img> requests. Agents use bearer
// tokens that the owner creates and revokes; only their SHA-256 hash is stored.

export const SESSION_COOKIE = 'cozy_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const AGENT_TOKEN_PREFIX = 'cozy_at_';

export interface OwnerSession {
  sub: string;
  email: string;
  exp: number;
}

function hmac(secret: string, value: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signOwnerSession(secret: string, session: OwnerSession) {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${body}.${hmac(secret, `session:${body}`)}`;
}

export function verifyOwnerSession(
  secret: string,
  value: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): OwnerSession | null {
  if (!value) return null;
  const [body, signature] = value.split('.');
  if (!body || !signature || !safeEqual(signature, hmac(secret, `session:${body}`))) return null;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OwnerSession;
    return typeof session.exp === 'number' && session.exp > nowSeconds ? session : null;
  } catch {
    return null;
  }
}

/** Short-lived signature for a Library URL, so agents can download results without a header. */
export function signLibraryPath(secret: string, libraryPath: string, expiresAt: number) {
  return hmac(secret, `library:${libraryPath}:${expiresAt}`);
}

export function verifyLibrarySignature(
  secret: string,
  libraryPath: string,
  expires: string | null,
  signature: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const expiresAt = Number(expires);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < nowSeconds) return false;
  return safeEqual(signature, signLibraryPath(secret, libraryPath, expiresAt));
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export interface AgentTokenSummary {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function createAgentToken(database: Database, name: string) {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const summary: AgentTokenSummary = {
    id: randomUUID(),
    name: name.trim().slice(0, 80) || 'Agent',
    hint: token.slice(-4),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  database
    .query(
      'INSERT INTO agent_tokens (id, name, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(summary.id, summary.name, hashToken(token), summary.hint, summary.createdAt);
  return { token, summary };
}

export function listAgentTokens(database: Database): AgentTokenSummary[] {
  return (
    database
      .query(
        `SELECT id, name, token_hint, created_at, last_used_at FROM agent_tokens
         WHERE revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, string | null>>
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    hint: String(row.token_hint),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at ?? null,
  }));
}

export function revokeAgentToken(database: Database, id: string) {
  return (
    database
      .query('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id).changes === 1
  );
}

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export function verifyAgentToken(database: Database, token: string | undefined) {
  if (!token?.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = database
    .query('SELECT id, last_used_at FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as { id: string; last_used_at: string | null } | null;
  if (!row) return null;
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
    database
      .query('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);
  }
  return row.id;
}
