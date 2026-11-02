import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestPostgresDatabase } from '../db/postgres/testPostgresDatabase';
import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  signLibraryPath,
  signOwnerSession,
  verifyAgentToken,
  verifyLibrarySignature,
  verifyOwnerSession,
} from './hostedAuth';
import {
  createSealedSubscriptionAuthStore,
  sealCredential,
  unsealCredential,
} from './sealedCredentialStore';

const SECRET = 'test-session-secret';

describe('owner sessions and signed Library URLs', () => {
  it('accepts a signed, unexpired session and rejects tampering or expiry', () => {
    const value = signOwnerSession(SECRET, { sub: 'u1', email: 'me@example.com', exp: 2_000 });
    expect(verifyOwnerSession(SECRET, value, 1_000)?.email).toBe('me@example.com');
    expect(verifyOwnerSession(SECRET, value, 2_001)).toBeNull();
    expect(verifyOwnerSession('other-secret', value, 1_000)).toBeNull();
    const [body] = value.split('.');
    expect(verifyOwnerSession(SECRET, `${body}x.${value.split('.')[1]}`, 1_000)).toBeNull();
    expect(verifyOwnerSession(SECRET, undefined)).toBeNull();
  });

  it('signs a Library path until it expires', () => {
    const signature = signLibraryPath(SECRET, '/library/a/b.png', 500);
    expect(verifyLibrarySignature(SECRET, '/library/a/b.png', '500', signature, 400)).toBe(true);
    expect(verifyLibrarySignature(SECRET, '/library/a/c.png', '500', signature, 400)).toBe(false);
    expect(verifyLibrarySignature(SECRET, '/library/a/b.png', '500', signature, 501)).toBe(false);
    expect(verifyLibrarySignature(SECRET, '/library/a/b.png', null, signature, 400)).toBe(false);
  });
});

describe('sealed provider credentials', () => {
  it('round-trips and rejects modified ciphertext', () => {
    const sealed = sealCredential(SECRET, '{"accessToken":"abc"}');
    expect(sealed).not.toContain('abc');
    expect(unsealCredential(SECRET, sealed)).toBe('{"accessToken":"abc"}');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => unsealCredential(SECRET, parts.join('.'))).toThrow();
    expect(() => unsealCredential('wrong-key', sealed)).toThrow();
  });
});

describe('hosted stores on Postgres', () => {
  let database: Database;

  beforeAll(() => {
    database = createTestPostgresDatabase();
  }, 60_000);

  afterAll(() => database?.close());

  it('creates, verifies and revokes agent tokens by hash', () => {
    const { token, summary } = createAgentToken(database, 'Laptop');
    expect(token.startsWith('cozy_at_')).toBe(true);
    expect(JSON.stringify(database.query('SELECT * FROM agent_tokens').all())).not.toContain(token);
    expect(verifyAgentToken(database, token)).toBe(summary.id);
    expect(verifyAgentToken(database, `${token}x`)).toBeNull();
    expect(listAgentTokens(database).map((item) => item.name)).toEqual(['Laptop']);
    expect(revokeAgentToken(database, summary.id)).toBe(true);
    expect(verifyAgentToken(database, token)).toBeNull();
    expect(listAgentTokens(database)).toEqual([]);
  });

  it('stores provider tokens sealed and tracks generations', () => {
    const store = createSealedSubscriptionAuthStore({ database, secret: SECRET });
    expect(store.readProvider('codex').status).toBe('logged_out');
    store.writeProvider('codex', {
      ...store.readProvider('codex'),
      status: 'logged_in',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    });
    expect(store.readProvider('codex').refreshToken).toBe('refresh-secret');
    const raw = JSON.stringify(database.query('SELECT * FROM provider_credentials').all());
    expect(raw).not.toContain('refresh-secret');
    const generation = store.generation('codex');
    store.clearProvider('codex');
    expect(store.generation('codex')).toBe(generation + 1);
    expect(store.readProvider('codex').accessToken).toBeNull();
  });
});
