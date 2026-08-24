/**
 * Reading the schema back out of a live database.
 *
 * This exists so the tests can assert what a migrated database actually
 * contains rather than what the migration was supposed to create. The Phase 1
 * gate is "db:migrate creates all five tables on both SQLite and Postgres", and
 * the only honest way to check that is to ask the database.
 */

import type { DbHandle } from './client.js';

/** Table names in the default schema, excluding driver-internal tables. */
export async function listTables(handle: DbHandle): Promise<string[]> {
  const rows =
    handle.dialect === 'sqlite'
      ? await handle.all<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
      : await handle.all<{ name: string }>(
          `SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
        );
  return rows.map((r) => r.name);
}

/** Column names for one table, in declaration order. */
export async function listColumns(
  handle: DbHandle,
  table: string,
): Promise<string[]> {
  assertSafeIdentifier(table);

  if (handle.dialect === 'sqlite') {
    const rows = await handle.all<{ name: string; cid: number }>(
      `PRAGMA table_info("${table}")`,
    );
    return [...rows].sort((a, b) => a.cid - b.cid).map((r) => r.name);
  }

  const rows = await handle.all<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}'
     ORDER BY ordinal_position`,
  );
  return rows.map((r) => r.name);
}

/**
 * Table names arrive from TABLE_SPEC, never from input. The guard is here so
 * that stays true if someone later wires this to something else.
 */
function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to introspect unsafe identifier: ${name}`);
  }
}
