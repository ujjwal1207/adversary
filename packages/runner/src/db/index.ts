/**
 * The persistence layer.
 *
 * It lives in `runner` rather than in `core` because `core` is a pure domain
 * layer with no I/O, and step 8 of the nine-step run flow ("Persist") is the
 * runner's job. `report` never queries the database - the CLI reads and hands
 * data to it - which keeps the dependency matrix in docs/ARCHITECTURE.md 5.1
 * true.
 */

export type { DbHandle } from './client.js';
export { openDb } from './client.js';

export type { DbConfig, Dialect } from './dialect.js';
export {
  DbConfigError,
  DEFAULT_SQLITE_PATH,
  DIALECTS,
  SQLITE_MEMORY,
  dbConfigFromEnv,
  describeConfig,
  redactUrl,
} from './dialect.js';

export { listColumns, listTables } from './introspect.js';

export type { MigrationReport } from './migrate.js';
export { MigrationError, assertSchemaComplete, migrate, reset } from './migrate.js';

export type { Migration } from './migrations/index.js';
export { MIGRATIONS } from './migrations/index.js';

export type { TableName } from './table-spec.js';
export { MIGRATIONS_TABLE, TABLE_NAMES, TABLE_SPEC, sqlInList } from './table-spec.js';

export * as sqliteTables from './schema.sqlite.js';
export * as pgTables from './schema.pg.js';
