/**
 * `pnpm db:migrate` - applies migrations to the configured database.
 *
 * Flags:
 *   --fresh   drop every table this schema owns, then migrate from empty
 *
 * The command checks the Phase 1 gate itself rather than leaving it to the test
 * suite: after migrating it asserts that exactly the five tables of the data
 * model exist, and exits non-zero if not.
 */

import {
  assertSchemaComplete,
  dbConfigFromEnv,
  describeConfig,
  migrate,
  openDb,
  reset,
} from './index.js';

async function main(): Promise<void> {
  const fresh = process.argv.includes('--fresh');
  const config = dbConfigFromEnv();

  console.log(`adversary db:migrate -> ${describeConfig(config)}`);

  const handle = await openDb(config);
  try {
    if (fresh) {
      console.log('  --fresh: dropping existing tables');
      await reset(handle);
    }

    const report = await migrate(handle);
    assertSchemaComplete(report);

    if (report.applied.length > 0) {
      console.log(`  applied: ${report.applied.join(', ')}`);
    }
    if (report.skipped.length > 0) {
      console.log(`  already applied: ${report.skipped.join(', ')}`);
    }
    console.log(`  tables (${report.tables.length}): ${report.tables.join(', ')}`);
    console.log('  ok');
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`db:migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
