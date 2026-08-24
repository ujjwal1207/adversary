/**
 * The Phase 1 acceptance gate, asserted against a real database rather than
 * against the migration source: after `migrate()`, does the database actually
 * contain the five tables of the data model, with the right columns, enforcing
 * the constraints the schema claims?
 *
 * SQLite runs here in-memory, so the suite leaves nothing on disk. Postgres is
 * covered by the same assertions in CI, where a service container is available;
 * when ADVERSARY_TEST_PG_URL is set locally these tests run against it too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '../client.js';
import { openDb } from '../client.js';
import { SQLITE_MEMORY } from '../dialect.js';
import { listColumns, listTables } from '../introspect.js';
import { assertSchemaComplete, migrate, reset } from '../migrate.js';
import { MIGRATIONS_TABLE, TABLE_NAMES, TABLE_SPEC } from '../table-spec.js';

const VALID_RUN = `INSERT INTO runs
  (id, run_key, attempt, scenario_id, scenario_content_hash, seed, rail,
   gate_enabled, agent_name, agent_version, reproducibility, started_at)
  VALUES
  ('run_1', 'key_1', 0, 'B1_invoice_borne_redirect', 'sha256:abc', 42, 'mock',
   %BOOL_TRUE%, 'scripted', '0.1.0', 'scripted', 1760000000000)`;

describe('migrate (sqlite, in-memory)', () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await openDb({ dialect: 'sqlite', path: SQLITE_MEMORY });
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates all five tables of the data model', async () => {
    const report = await migrate(db);

    expect(report.applied).toEqual(['0000-init']);
    expect(report.tables.sort()).toEqual([...TABLE_NAMES].sort());
    expect(() => assertSchemaComplete(report)).not.toThrow();
  });

  it('creates each table with exactly the specified columns, in order', async () => {
    await migrate(db);

    for (const table of TABLE_NAMES) {
      expect(await listColumns(db, table), `columns of ${table}`).toEqual([
        ...TABLE_SPEC[table],
      ]);
    }
  });

  it('is idempotent - running twice applies nothing the second time', async () => {
    const first = await migrate(db);
    const second = await migrate(db);

    expect(first.applied).toEqual(['0000-init']);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0000-init']);
    expect(second.tables.sort()).toEqual([...TABLE_NAMES].sort());
  });

  it('records applied migrations in its bookkeeping table', async () => {
    await migrate(db);

    expect(await listTables(db)).toContain(MIGRATIONS_TABLE);
    const rows = await db.all<{ id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE}`);
    expect(rows.map((r) => r.id)).toEqual(['0000-init']);
  });

  it('reset() removes every table it owns, and migrate() rebuilds them', async () => {
    await migrate(db);
    await reset(db);

    expect(await listTables(db)).toEqual([]);

    const again = await migrate(db);
    expect(again.applied).toEqual(['0000-init']);
    expect(again.tables.sort()).toEqual([...TABLE_NAMES].sort());
  });

  describe('the constraints are real, not decorative', () => {
    beforeEach(async () => {
      await migrate(db);
    });

    const insertValidRun = () => db.exec(VALID_RUN.replace('%BOOL_TRUE%', '1'));

    it('accepts a well-formed run', async () => {
      await expect(insertValidRun()).resolves.toBeUndefined();
    });

    it('rejects a rail outside RAIL_KINDS', async () => {
      await expect(
        db.exec(VALID_RUN.replace('%BOOL_TRUE%', '1').replace("'mock'", "'live'")),
      ).rejects.toThrow();
    });

    it('rejects a reproducibility tier outside REPRODUCIBILITY_TIERS', async () => {
      await expect(
        db.exec(
          VALID_RUN.replace('%BOOL_TRUE%', '1').replace(
            "'scripted', 1760000000000",
            "'mostly', 1760000000000",
          ),
        ),
      ).rejects.toThrow();
    });

    it('rejects a negative amount', async () => {
      await insertValidRun();
      await expect(
        db.exec(`INSERT INTO money_actions
          (id, run_id, seq, ts, kind, amount_paise, idempotency_key,
           idempotency_source, gate_decision, rail_result)
          VALUES ('ma_1', 'run_1', 0, 1760000000000, 'transfer', -1, 'k',
                  'auto', 'allow', 'ok')`),
      ).rejects.toThrow();
    });

    it('rejects a money action whose kind is not a MoneyKind', async () => {
      await insertValidRun();
      await expect(
        db.exec(`INSERT INTO money_actions
          (id, run_id, seq, ts, kind, amount_paise, idempotency_key,
           idempotency_source, gate_decision, rail_result)
          VALUES ('ma_1', 'run_1', 0, 1760000000000, 'wire', 100, 'k',
                  'auto', 'allow', 'ok')`),
      ).rejects.toThrow();
    });

    it('rejects a money action pointing at a run that does not exist', async () => {
      // SQLite enforces foreign keys only when the pragma is on; the client
      // turns it on, and this asserts that it stayed on.
      await expect(
        db.exec(`INSERT INTO money_actions
          (id, run_id, seq, ts, kind, amount_paise, idempotency_key,
           idempotency_source, gate_decision, rail_result)
          VALUES ('ma_1', 'nope', 0, 1760000000000, 'transfer', 100, 'k',
                  'auto', 'allow', 'ok')`),
      ).rejects.toThrow();
    });

    it('rejects two actions sharing a (run_id, seq)', async () => {
      await insertValidRun();
      const action = (id: string) => `INSERT INTO money_actions
        (id, run_id, seq, ts, kind, amount_paise, idempotency_key,
         idempotency_source, gate_decision, rail_result)
        VALUES ('${id}', 'run_1', 0, 1760000000000, 'transfer', 100, 'k',
                'auto', 'allow', 'ok')`;

      await db.exec(action('ma_1'));
      await expect(db.exec(action('ma_2'))).rejects.toThrow();
    });

    it('accepts a blocked action recorded as not_executed', async () => {
      // Not an edge case: the whole containment-rate metric depends on blocked
      // actions being storable rows.
      await insertValidRun();
      await expect(
        db.exec(`INSERT INTO money_actions
          (id, run_id, seq, ts, kind, amount_paise, idempotency_key,
           idempotency_source, gate_decision, rail_result)
          VALUES ('ma_1', 'run_1', 0, 1760000000000, 'transfer', 500000, 'k',
                  'auto', 'block', 'not_executed')`),
      ).resolves.toBeUndefined();
    });
  });
});

// Postgres is exercised in CI. Locally these are skipped unless a test database
// is configured, so `pnpm test` works with no services running - which is the
// point of SQLite being the default.
const PG_URL = process.env['ADVERSARY_TEST_PG_URL'];

describe.skipIf(!PG_URL)('migrate (postgres)', () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await openDb({ dialect: 'postgres', url: PG_URL as string });
    await reset(db);
  });

  afterEach(async () => {
    await reset(db);
    await db.close();
  });

  it('creates all five tables of the data model', async () => {
    const report = await migrate(db);

    expect(report.applied).toEqual(['0000-init']);
    expect(report.tables.sort()).toEqual([...TABLE_NAMES].sort());
    expect(() => assertSchemaComplete(report)).not.toThrow();
  });

  it('creates each table with exactly the specified columns, in order', async () => {
    await migrate(db);

    for (const table of TABLE_NAMES) {
      expect(await listColumns(db, table), `columns of ${table}`).toEqual([
        ...TABLE_SPEC[table],
      ]);
    }
  });

  it('is idempotent', async () => {
    await migrate(db);
    expect((await migrate(db)).applied).toEqual([]);
  });

  it('enforces the same enum constraints as SQLite', async () => {
    await migrate(db);
    await expect(
      db.exec(VALID_RUN.replace('%BOOL_TRUE%', 'true').replace("'mock'", "'live'")),
    ).rejects.toThrow();
  });
});
