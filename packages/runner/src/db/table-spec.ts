/**
 * The canonical shape of the five tables, independent of dialect.
 *
 * Drizzle needs a separate table definition per dialect (`sqlite-core` and
 * `pg-core` are different builders producing different DDL), and the migrations
 * are hand-written SQL. That is three artefacts describing one schema, and
 * three artefacts describing one thing is how schemas drift.
 *
 * This module is the referee. `schema-parity.test.ts` asserts that the SQLite
 * Drizzle schema, the Postgres Drizzle schema, and the tables a real migrated
 * database actually contains all agree with what is written here. Adding a
 * column in one place and not the others fails the test rather than surfacing
 * as a null six phases later.
 *
 * Why hand-written migrations rather than `drizzle-kit generate`: the migration
 * SQL is the most audit-relevant artefact in the persistence layer - it is what
 * actually constrains the data - and this project's premise is that every claim
 * is checkable. Generated DDL that nobody read is not checkable. Drizzle still
 * owns querying; it just does not own the constraints.
 */

/** Table name -> its exact column set, in declaration order. */
export const TABLE_SPEC = {
  runs: [
    'id',
    'run_key',
    'attempt',
    'scenario_id',
    'scenario_content_hash',
    'seed',
    'rail',
    'gate_enabled',
    'agent_name',
    'agent_version',
    'model',
    'reproducibility',
    'cassette_hash',
    'started_at',
    'finished_at',
    'verdict',
    'error',
    'turns_used',
  ],
  money_actions: [
    'id',
    'run_id',
    'seq',
    'ts',
    'kind',
    'params_json',
    'amount_paise',
    'payee_ref',
    'subject_ref',
    'idempotency_key',
    'idempotency_source',
    'taint_json',
    'gate_decision',
    'gate_reasons_json',
    'rule_trace_json',
    'agent_rationale',
    'rail_result',
    'rail_ref',
    'rail_error',
  ],
  trajectory_events: ['id', 'run_id', 'seq', 'role', 'kind', 'content_json'],
  verdicts: [
    'run_id',
    'invariant_id',
    'status',
    'observed_json',
    'expected_json',
    'blast_radius_paise',
    'witness_ids_json',
  ],
  scenarios: [
    'id',
    'version',
    'content_hash',
    'kind',
    'family',
    'pair_id',
    'yaml_snapshot',
  ],
} as const satisfies Record<string, readonly string[]>;

export type TableName = keyof typeof TABLE_SPEC;

export const TABLE_NAMES = Object.keys(TABLE_SPEC) as TableName[];

/**
 * The bookkeeping table the migrator uses. Excluded from TABLE_SPEC because it
 * is infrastructure rather than part of the data model, but the migration test
 * still asserts it exists.
 */
export const MIGRATIONS_TABLE = '_adversary_migrations';

/**
 * Renders a SQL `IN (...)` list from one of the enum arrays in
 * `@adversary/core`, so the CHECK constraints and the TypeScript unions cannot
 * disagree.
 *
 * Values come from our own frozen constant arrays, never from input, so string
 * interpolation here is safe. Bind parameters are not usable in DDL anyway.
 */
export function sqlInList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}
