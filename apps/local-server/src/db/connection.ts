import type { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';

import { resolveLibraryPath } from '../library';
import { createSqliteCompatPostgresDatabase } from './postgres/sqliteCompatDatabase';
import { createSyncPostgresClient } from './postgres/syncPostgresBridge';

let defaultDb: Database | null = null;
const runtimeRequire = createRequire(import.meta.url);

export function getDb(db?: Database) {
  if (db) return db;
  if (!defaultDb) {
    // Hosted mode (ADR 0013) keeps the same synchronous store API on Postgres.
    const postgresUrl = process.env.STUDIO_DATABASE_URL;
    if (postgresUrl) {
      defaultDb = createSqliteCompatPostgresDatabase(
        createSyncPostgresClient({ kind: 'pg', connectionString: postgresUrl }),
      );
      return defaultDb;
    }
    const { Database: DatabaseConstructor } = runtimeRequire(
      'bun:sqlite',
    ) as typeof import('bun:sqlite');
    defaultDb = new DatabaseConstructor(resolveLibraryPath('library.sqlite'));
    // Wait for another connection (maintenance, CLI tools) instead of failing at once with
    // SQLITE_BUSY; an unhandled busy error in the worker takes the whole server down.
    defaultDb.run('PRAGMA busy_timeout = 5000');
    defaultDb.run('PRAGMA journal_mode = WAL');
    defaultDb.run('PRAGMA foreign_keys = ON');
  }
  return defaultDb;
}

/** Installs the process-wide handle, for hosted bootstrap and tests. */
export function setDefaultDb(db: Database | null) {
  defaultDb = db;
}

export function closeDb(db?: Database) {
  const target = db ?? defaultDb;
  if (!target) return;

  try {
    target.close();
  } catch {
    // Best effort; reset flows can recreate the database afterwards.
  } finally {
    if (!db) defaultDb = null;
  }
}
