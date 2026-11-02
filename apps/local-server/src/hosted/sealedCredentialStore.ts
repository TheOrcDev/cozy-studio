import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';

import type { SubscriptionProviderId } from '../../../../packages/shared/src';
import { STUDIO_OAUTH_STORE_VERSION } from '../auth/constants';
import {
  emptyRecord,
  type StoredSubscriptionTokens,
  type SubscriptionAuthStore,
} from '../auth/store';

// Hosted provider sign-in tokens (ADR 0012). Postgres only ever holds AES-256-GCM ciphertext; the
// key lives in the function's environment, never in the database, settings or logs.

const PROVIDERS: SubscriptionProviderId[] = ['codex', 'xai', 'google'];
const SEAL_VERSION = 'v1';

function deriveKey(secret: string) {
  const decoded = Buffer.from(secret, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(secret).digest();
}

export function sealCredential(secret: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [SEAL_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function unsealCredential(secret: string, sealed: string) {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== SEAL_VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Stored provider credential has an unknown format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function createSealedSubscriptionAuthStore({
  database,
  secret,
  now = () => new Date(),
}: {
  database: Database;
  secret: string;
  now?: () => Date;
}): SubscriptionAuthStore {
  const readRow = (providerId: SubscriptionProviderId) =>
    database
      .query('SELECT sealed, generation FROM provider_credentials WHERE provider_id = ?')
      .get(providerId) as { sealed: string | null; generation: number } | null;

  const readProvider = (providerId: SubscriptionProviderId): StoredSubscriptionTokens => {
    const row = readRow(providerId);
    if (!row?.sealed) return emptyRecord(now());
    return JSON.parse(unsealCredential(secret, row.sealed)) as StoredSubscriptionTokens;
  };

  const writeSealed = (
    providerId: SubscriptionProviderId,
    sealed: string | null,
    bump: boolean,
  ) => {
    database
      .query(
        `INSERT INTO provider_credentials (provider_id, sealed, generation, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET sealed = excluded.sealed,
           generation = provider_credentials.generation + ?, updated_at = excluded.updated_at`,
      )
      .run(providerId, sealed, bump ? 1 : 0, now().toISOString(), bump ? 1 : 0);
  };

  return {
    filePath: () => 'postgres:provider_credentials',
    assertWritable() {
      database.query('SELECT 1 FROM provider_credentials LIMIT 1').get();
    },
    read() {
      return {
        version: STUDIO_OAUTH_STORE_VERSION,
        providers: Object.fromEntries(
          PROVIDERS.map((providerId) => [providerId, readProvider(providerId)]),
        ) as Record<SubscriptionProviderId, StoredSubscriptionTokens>,
      };
    },
    readProvider,
    writeProvider(providerId, record) {
      const next = { ...record, updatedAt: now().toISOString() };
      writeSealed(providerId, sealCredential(secret, JSON.stringify(next)), false);
    },
    clearProvider(providerId) {
      writeSealed(providerId, sealCredential(secret, JSON.stringify(emptyRecord(now()))), true);
    },
    generation(providerId) {
      return Number(readRow(providerId)?.generation ?? 0);
    },
    bumpGeneration(providerId) {
      const row = readRow(providerId);
      writeSealed(providerId, row?.sealed ?? null, true);
    },
  };
}
