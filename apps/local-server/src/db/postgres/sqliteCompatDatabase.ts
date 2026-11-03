import type { Database } from 'bun:sqlite';

import type { SyncPostgresClient } from './syncPostgresBridge';

// A Postgres-backed stand-in for the subset of the bun:sqlite Database API that the stores use:
// query(sql).all/get/run, run(sql), transaction(fn) with .immediate(), changes and
// lastInsertRowid. SQL keeps SQLite's `?` placeholders; the few statements whose meaning
// differs branch on isPostgresDatabase() at the call site instead of being rewritten here.

const POSTGRES_DIALECT = Symbol.for('cozy-studio.postgres-dialect');

// Tables whose integer key SQLite returns through lastInsertRowid.
const GENERATED_KEY_COLUMNS: Record<string, string> = {
  job_events: 'id',
  system_logs: 'id',
  output_generations: 'generation_number',
};

const translationCache = new Map<string, string | null>();

/** Rewrites SQLite-flavoured SQL that means the same thing in Postgres. Null means "skip". */
export function translateSqliteSql(sql: string): string | null {
  const cached = translationCache.get(sql);
  if (cached !== undefined) return cached;

  let translated: string | null;
  if (/^\s*PRAGMA\b/i.test(sql)) {
    translated = null;
  } else {
    let out = '';
    let unquoted = '';
    let placeholder = 0;
    let quote: "'" | '"' | null = null;
    // Unquoted identifiers fold to lower case in Postgres. Quote camelCase ones, the aliases the
    // stores read back, everywhere outside literals so `AS presetId` and a later `presetId` agree.
    const flush = () => {
      out += unquoted.replace(/(?<![\w$])([a-z]+[A-Z][A-Za-z0-9]*)\b/g, '"$1"');
      unquoted = '';
    };
    for (const char of sql) {
      if (quote) {
        out += char;
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        flush();
        quote = char;
        out += char;
        continue;
      }
      unquoted += char === '?' ? `$${++placeholder}` : char;
    }
    flush();
    if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
      out = out.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b/i, '$1INSERT INTO');
      out = /\bRETURNING\b/i.test(out)
        ? out.replace(/\bRETURNING\b/i, 'ON CONFLICT DO NOTHING RETURNING')
        : `${out.trimEnd()} ON CONFLICT DO NOTHING`;
    }
    translated = out;
  }
  translationCache.set(sql, translated);
  return translated;
}

function normalizeParams(params: readonly unknown[]) {
  // bun:sqlite accepts either spread values or a single array.
  const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
}

function generatedKeyColumn(sql: string) {
  const match = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(sql);
  if (!match || /\bRETURNING\b/i.test(sql)) return null;
  return GENERATED_KEY_COLUMNS[match[1].toLowerCase()] ?? null;
}

export interface PostgresCompatDatabase {
  readonly [POSTGRES_DIALECT]: true;
  readonly client: SyncPostgresClient;
}

export function isPostgresDatabase(db: unknown): db is PostgresCompatDatabase {
  return Boolean(db && typeof db === 'object' && POSTGRES_DIALECT in db);
}

/** Creates the Postgres stand-in typed as the bun:sqlite Database the stores expect. */
export function createSqliteCompatPostgresDatabase(client: SyncPostgresClient): Database {
  let transactionDepth = 0;

  const execute = (sql: string, params: readonly unknown[]) => {
    const translated = translateSqliteSql(sql);
    if (translated === null) return { rows: [] as Record<string, unknown>[], rowCount: 0 };
    return client.query(translated, normalizeParams(params));
  };

  const runStatement = (sql: string, params: readonly unknown[]) => {
    const keyColumn = generatedKeyColumn(sql);
    const result = execute(keyColumn ? `${sql.trimEnd()} RETURNING ${keyColumn}` : sql, params);
    const lastInsertRowid = keyColumn ? Number(result.rows[0]?.[keyColumn] ?? 0) : 0;
    return { changes: result.rowCount, lastInsertRowid };
  };

  const statement = (sql: string) => ({
    all: (...params: unknown[]) => execute(sql, params).rows,
    get: (...params: unknown[]) => execute(sql, params).rows[0] ?? null,
    run: (...params: unknown[]) => runStatement(sql, params),
    values: (...params: unknown[]) => execute(sql, params).rows.map((row) => Object.values(row)),
    finalize: () => undefined,
  });

  const transaction = <Args extends unknown[], Result>(work: (...args: Args) => Result) => {
    const run = (...args: Args): Result => {
      const savepoint = transactionDepth > 0 ? `cozy_sp_${transactionDepth}` : null;
      client.query(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      transactionDepth += 1;
      try {
        const result = work(...args);
        transactionDepth -= 1;
        client.query(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        transactionDepth -= 1;
        client.query(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
        throw error;
      }
    };
    // Postgres row locks and unique constraints replace SQLite's write-lock modes.
    return Object.assign(run, { immediate: run, deferred: run, exclusive: run });
  };

  const database = {
    [POSTGRES_DIALECT]: true as const,
    client,
    query: statement,
    prepare: statement,
    run: (sql: string, ...params: unknown[]) => runStatement(sql, params),
    exec: (sql: string, ...params: unknown[]) => runStatement(sql, params),
    transaction,
    close: () => client.close(),
    get inTransaction() {
      return transactionDepth > 0;
    },
  };
  return database as unknown as Database;
}
