import type { Database } from 'bun:sqlite';

import { isPostgresDatabase } from './postgres/sqliteCompatDatabase';

// SQL fragments whose SQLite spelling has no Postgres equivalent (ADR 0012). Everything else is
// shared SQL; sqliteCompatDatabase.ts only rewrites placeholders, aliases and INSERT OR IGNORE.

/** A JSON text column as a set of array elements named `value`, or no rows when it is not an array. */
export function jsonTextArrayElements(db: Database, column: string, alias: string) {
  if (!isPostgresDatabase(db)) {
    return `json_each(CASE WHEN json_valid(${column})
      THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END
      ELSE '[]' END) AS ${alias}`;
  }
  return `jsonb_array_elements_text(CASE WHEN pg_input_is_valid(${column}, 'jsonb')
      THEN CASE WHEN jsonb_typeof(${column}::jsonb) = 'array' THEN ${column}::jsonb ELSE '[]'::jsonb END
      ELSE '[]'::jsonb END) AS ${alias}(value)`;
}

/** A top-level string field of a JSON text column. */
export function jsonTextField(db: Database, column: string, field: string) {
  return isPostgresDatabase(db)
    ? `(CASE WHEN pg_input_is_valid(${column}, 'jsonb') THEN ${column}::jsonb ->> '${field}' END)`
    : `json_extract(${column}, '$.${field}')`;
}

/** Case-insensitive equality between two expressions. */
export function equalsIgnoringCase(db: Database, left: string, right: string) {
  return isPostgresDatabase(db)
    ? `lower(${left}) = lower(${right})`
    : `${left} = ${right} COLLATE NOCASE`;
}

/** An ORDER BY term that sorts case-insensitively. */
export function orderIgnoringCase(db: Database, expression: string, direction: 'ASC' | 'DESC') {
  return isPostgresDatabase(db)
    ? `lower(${expression}) ${direction}`
    : `${expression} COLLATE NOCASE ${direction}`;
}

/** SQLite LIKE ignores ASCII case; Postgres needs ILIKE for the same result. */
export function likeIgnoringCase(db: Database) {
  return isPostgresDatabase(db) ? 'ILIKE' : 'LIKE';
}

/** Comma-separated distinct values of a column within a group. */
export function groupConcatDistinct(db: Database, column: string) {
  return isPostgresDatabase(db)
    ? `string_agg(DISTINCT ${column}, ',')`
    : `GROUP_CONCAT(DISTINCT ${column})`;
}
