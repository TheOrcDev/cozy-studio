import type { Database } from 'bun:sqlite';

import { migratePostgresDatabase } from './postgresSchema';
import { createSqliteCompatPostgresDatabase } from './sqliteCompatDatabase';
import { createSyncPostgresClient } from './syncPostgresBridge';

/** In-memory Postgres (PGlite in a worker) with the hosted schema, for tests. */
export function createTestPostgresDatabase(): Database {
  const database = createSqliteCompatPostgresDatabase(createSyncPostgresClient({ kind: 'pglite' }));
  migratePostgresDatabase(database);
  return database;
}
