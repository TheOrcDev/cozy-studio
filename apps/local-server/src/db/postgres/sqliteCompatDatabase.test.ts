import { describe, expect, it } from 'vitest';

import { translateSqliteSql } from './sqliteCompatDatabase';

describe('translateSqliteSql', () => {
  it('numbers placeholders outside string literals', () => {
    expect(translateSqliteSql("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2",
    );
  });

  it('keeps camelCase aliases and skips PRAGMA statements', () => {
    expect(translateSqliteSql('SELECT last_used_at AS lastUsedAt FROM t')).toBe(
      'SELECT last_used_at AS "lastUsedAt" FROM t',
    );
    expect(translateSqliteSql('PRAGMA foreign_keys = ON')).toBeNull();
  });

  it('quotes camelCase identifiers where they are read back, but not inside literals', () => {
    expect(
      translateSqliteSql(
        "SELECT x AS presetId FROM t WHERE presetId <> '' AND s.presetId = 'a presetId' GROUP BY presetId",
      ),
    ).toBe(
      `SELECT x AS "presetId" FROM t WHERE "presetId" <> '' AND s."presetId" = 'a presetId' GROUP BY "presetId"`,
    );
  });

  it('turns INSERT OR IGNORE into ON CONFLICT DO NOTHING', () => {
    expect(translateSqliteSql('INSERT OR IGNORE INTO t (a) SELECT ?')).toBe(
      'INSERT INTO t (a) SELECT $1 ON CONFLICT DO NOTHING',
    );
  });
});
