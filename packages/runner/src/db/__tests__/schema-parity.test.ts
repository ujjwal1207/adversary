/**
 * One schema, three artefacts: the SQLite Drizzle tables, the Postgres Drizzle
 * tables, and the hand-written migration SQL. Three artefacts describing one
 * thing is how schemas drift, so `table-spec.ts` is the referee and this file
 * holds all three to it.
 *
 * The migrated-database side of the comparison lives in `migrate.test.ts`,
 * which asks a real database what it actually contains.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';

import { TABLE_SPEC, sqlInList } from '../table-spec.js';
import { pgSchema } from '../schema.pg.js';
import { sqliteSchema } from '../schema.sqlite.js';
import { up } from '../migrations/0000-init.js';

/** TABLE_SPEC key -> the Drizzle export that should implement it. */
const BINDINGS = [
  ['runs', 'runs'],
  ['money_actions', 'moneyActions'],
  ['trajectory_events', 'trajectoryEvents'],
  ['verdicts', 'verdicts'],
  ['scenarios', 'scenarios'],
] as const;

/**
 * The JavaScript property names of a Drizzle table that are actually columns.
 *
 * Drizzle hangs its own helpers off the same object - `pgTable` adds an
 * `enableRLS` method, for instance - so a plain Object.keys comparison across
 * dialects compares builder internals rather than schema.
 */
function columnProperties(table: object): string[] {
  return Object.entries(table)
    .filter(
      ([, value]) =>
        typeof value === 'object' && value !== null && 'columnType' in value,
    )
    .map(([key]) => key)
    .sort();
}

describe('schema parity', () => {
  describe.each(BINDINGS)('%s', (specName, exportName) => {
    const expected = [...TABLE_SPEC[specName]];

    it('the SQLite Drizzle table declares exactly the specified columns', () => {
      const table = sqliteSchema[exportName];
      const config = getSqliteTableConfig(table);

      expect(config.name).toBe(specName);
      expect(config.columns.map((c) => c.name).sort()).toEqual([...expected].sort());
    });

    it('the Postgres Drizzle table declares exactly the specified columns', () => {
      const table = pgSchema[exportName];
      const config = getPgTableConfig(table);

      expect(config.name).toBe(specName);
      expect(config.columns.map((c) => c.name).sort()).toEqual([...expected].sort());
    });

    it('both dialects expose the same TypeScript property names', () => {
      // The column *types* differ between dialects by design (BIGINT vs
      // INTEGER for epoch millis, BOOLEAN vs INTEGER for flags). The property
      // names must not, or a query written against one dialect breaks silently
      // on the other.
      expect(columnProperties(sqliteSchema[exportName])).toEqual(
        columnProperties(pgSchema[exportName]),
      );
    });

    it('the migration creates the table with every specified column', () => {
      for (const dialect of ['sqlite', 'postgres'] as const) {
        const create = up(dialect).find((s) =>
          new RegExp(`CREATE TABLE ${specName}\\b`).test(s),
        );
        expect(create, `${specName} CREATE TABLE missing for ${dialect}`).toBeDefined();

        for (const column of expected) {
          expect(
            new RegExp(`^\\s*${column}\\s`, 'm').test(create as string),
            `${dialect}/${specName} is missing column ${column}`,
          ).toBe(true);
        }
      }
    });
  });

  it('covers every table in the data model and no others', () => {
    expect(Object.keys(TABLE_SPEC).sort()).toEqual(BINDINGS.map(([s]) => s).sort());
  });

  it('declares no duplicate columns within a table', () => {
    for (const [name, columns] of Object.entries(TABLE_SPEC)) {
      expect(new Set(columns).size, `${name} has duplicate columns`).toBe(
        columns.length,
      );
    }
  });
});

describe('sqlInList', () => {
  it('renders a quoted SQL list', () => {
    expect(sqlInList(['a', 'b'])).toBe("'a', 'b'");
  });

  it('escapes embedded quotes rather than closing the literal early', () => {
    // No enum member contains a quote today. The guard is here so that stays
    // safe if one ever does.
    expect(sqlInList(["it's"])).toBe("'it''s'");
  });
});

describe('migration SQL', () => {
  it('differs between dialects only in column types, not in structure', () => {
    const sqlite = up('sqlite');
    const postgres = up('postgres');

    expect(sqlite.length).toBe(postgres.length);

    const structure = (s: string) =>
      s.replace(/\b(BIGINT|INTEGER|BOOLEAN|TEXT)\b/g, 'TYPE').replace(/\s+/g, ' ');

    for (let i = 0; i < sqlite.length; i += 1) {
      expect(structure(sqlite[i] as string)).toBe(structure(postgres[i] as string));
    }
  });

  it('uses BIGINT for epoch milliseconds on Postgres', () => {
    // 1.8e12 does not fit in a 32-bit integer. Getting this wrong would not
    // surface until a timestamp overflowed in production-shaped data.
    const runs = up('postgres').find((s) => s.includes('CREATE TABLE runs'));
    expect(runs).toMatch(/started_at\s+BIGINT/);
  });
});
