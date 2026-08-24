/**
 * Drizzle table definitions for SQLite.
 *
 * These describe the tables for *querying*. They deliberately do not declare
 * constraints or indexes: those live in `migrations/0000-init.ts`, which is
 * what actually constrains the database. Splitting it this way means there is
 * exactly one place to read to know what the data is guaranteed to satisfy.
 *
 * `schema-parity.test.ts` holds this file, `schema.pg.ts`, and a real migrated
 * database to the same column set in `table-spec.ts`.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type {
  GateDecision,
  IdempotencySource,
  InvariantStatus,
  MoneyKind,
  RailKind,
  RailResult,
  ReproducibilityTier,
  ScenarioFamily,
  ScenarioKind,
  TrajectoryEventKind,
  TrajectoryRole,
} from '@adversary/core';

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  runKey: text('run_key').notNull(),
  attempt: integer('attempt').notNull(),
  scenarioId: text('scenario_id').notNull(),
  scenarioContentHash: text('scenario_content_hash').notNull(),
  seed: integer('seed').notNull(),
  rail: text('rail').$type<RailKind>().notNull(),
  gateEnabled: integer('gate_enabled', { mode: 'boolean' }).notNull(),
  agentName: text('agent_name').notNull(),
  agentVersion: text('agent_version').notNull(),
  model: text('model'),
  reproducibility: text('reproducibility').$type<ReproducibilityTier>().notNull(),
  cassetteHash: text('cassette_hash'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  verdict: text('verdict').$type<InvariantStatus>(),
  error: text('error'),
  turnsUsed: integer('turns_used').notNull().default(0),
});

export const moneyActions = sqliteTable('money_actions', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  ts: integer('ts').notNull(),
  kind: text('kind').$type<MoneyKind>().notNull(),
  paramsJson: text('params_json').notNull().default('{}'),
  amountPaise: integer('amount_paise').notNull(),
  payeeRef: text('payee_ref'),
  subjectRef: text('subject_ref'),
  idempotencyKey: text('idempotency_key').notNull(),
  idempotencySource: text('idempotency_source').$type<IdempotencySource>().notNull(),
  taintJson: text('taint_json').notNull().default('[]'),
  gateDecision: text('gate_decision').$type<GateDecision>().notNull(),
  gateReasonsJson: text('gate_reasons_json').notNull().default('[]'),
  ruleTraceJson: text('rule_trace_json').notNull().default('[]'),
  agentRationale: text('agent_rationale').notNull().default(''),
  railResult: text('rail_result').$type<RailResult>().notNull(),
  railRef: text('rail_ref'),
  railError: text('rail_error'),
});

export const trajectoryEvents = sqliteTable('trajectory_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  role: text('role').$type<TrajectoryRole>().notNull(),
  kind: text('kind').$type<TrajectoryEventKind>().notNull(),
  contentJson: text('content_json').notNull().default('{}'),
});

export const verdicts = sqliteTable('verdicts', {
  runId: text('run_id').notNull(),
  invariantId: text('invariant_id').notNull(),
  status: text('status').$type<InvariantStatus>().notNull(),
  observedJson: text('observed_json').notNull().default('null'),
  expectedJson: text('expected_json').notNull().default('null'),
  blastRadiusPaise: integer('blast_radius_paise').notNull().default(0),
  witnessIdsJson: text('witness_ids_json').notNull().default('[]'),
});

export const scenarios = sqliteTable('scenarios', {
  id: text('id').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').notNull(),
  kind: text('kind').$type<ScenarioKind>().notNull(),
  family: text('family').$type<ScenarioFamily>().notNull(),
  pairId: text('pair_id'),
  yamlSnapshot: text('yaml_snapshot').notNull(),
});

export const sqliteSchema = {
  runs,
  moneyActions,
  trajectoryEvents,
  verdicts,
  scenarios,
};
