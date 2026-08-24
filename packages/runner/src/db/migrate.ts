/**
 * The migrator.
 *
 * Roughly forty lines of logic, hand-rolled rather than pulled in, for the same
 * reason the invariant evaluator is hand-rolled: this is a component whose
 * behaviour has to be fully understood by whoever defends the project, and
 * "the migration tool did something" is not a defence.
 *
 * Semantics: each migration's statements and its bookkeeping row are applied
 * inside one transaction, so a migration is either fully applied or not applied
 * at all. Already-applied migrations are skipped by id, which makes `migrate()`
 * idempotent - running it twice is a no-op, and the Phase 1 gate exercises that.
 */

import type { DbHandle } from './client.js';
import type { Dialect } from './dialect.js';
import { MIGRATIONS } from './migrations/index.js';
import { MIGRATIONS_TABLE, TABLE_NAMES } from './table-spec.js';

export interface MigrationReport {
  readonly dialect: Dialect;
  readonly describe: string;
  /** Migration ids applied by this call. Empty when already up to date. */
  readonly applied: string[];
  /** Migration ids that were already present. */
  readonly skipped: string[];
  /** Tables present after migrating, excluding the bookkeeping table. */
  readonly tables: string[];
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  constructor(
    message: string,
    readonly migrationId: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export async function migrate(handle: DbHandle): Promise<MigrationReport> {
  await ensureBookkeepingTable(handle);

  const done = new Set(
    (
      await handle.all<{ id: string }>(
        `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`,
      )
    ).map((r) => r.id),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }

    try {
      await handle.transaction(async () => {
        for (const statement of migration.up(handle.dialect)) {
          await handle.exec(statement);
        }
        await handle.exec(
          `INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ('${migration.id}')`,
        );
      });
    } catch (err) {
      throw new MigrationError(
        `Migration ${migration.id} failed on ${handle.dialect}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        migration.id,
        err,
      );
    }

    applied.push(migration.id);
  }

  const { listTables } = await import('./introspect.js');
  const tables = (await listTables(handle)).filter((t) => t !== MIGRATIONS_TABLE);

  return { dialect: handle.dialect, describe: handle.describe, applied, skipped, tables };
}

/**
 * Drops every table this schema owns.
 *
 * Used by `--fresh` and by tests. Order matters under foreign keys, so the data
 * tables go before `runs`; CASCADE would work on Postgres but SQLite has no
 * such clause and the explicit order documents the dependency either way.
 */
export async function reset(handle: DbHandle): Promise<void> {
  const dropOrder = [
    'verdicts',
    'trajectory_events',
    'money_actions',
    'scenarios',
    'runs',
    MIGRATIONS_TABLE,
  ];
  for (const table of dropOrder) {
    await handle.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

async function ensureBookkeepingTable(handle: DbHandle): Promise<void> {
  // CURRENT_TIMESTAMP / NOW() rather than a JS timestamp: the harness bans
  // wall-clock reads in run-path code, and there is no reason to make an
  // exception here when the database can stamp the row itself.
  const appliedAt =
    handle.dialect === 'postgres'
      ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'
      : 'TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)';

  await handle.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       id         TEXT PRIMARY KEY NOT NULL,
       applied_at ${appliedAt}
     )`,
  );
}

/**
 * Asserts that a migrated database contains exactly the five tables of the data
 * model. Called by `migrate-cli` so the gate is checked by the command that
 * claims to satisfy it, not only by the test suite.
 */
export function assertSchemaComplete(report: MigrationReport): void {
  const found = new Set(report.tables);
  const missing = TABLE_NAMES.filter((t) => !found.has(t));
  const unexpected = report.tables.filter(
    (t) => !(TABLE_NAMES as string[]).includes(t),
  );

  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [
      `Schema incomplete on ${report.dialect} (${report.describe}).`,
      missing.length > 0 ? `Missing tables: ${missing.join(', ')}.` : '',
      unexpected.length > 0 ? `Unexpected tables: ${unexpected.join(', ')}.` : '',
    ].filter(Boolean);
    throw new Error(parts.join(' '));
  }
}
