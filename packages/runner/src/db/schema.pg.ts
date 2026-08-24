/**
 * Drizzle table definitions for Postgres.
 *
 * The same tables as `schema.sqlite.ts`, with the three type differences the
 * dialects force: epoch milliseconds need BIGINT (they do not fit in a 32-bit
 * integer, and SQLite's INTEGER is already 64-bit), and Postgres has a real
 * boolean where SQLite stores 0/1.
 *
 * `bigint({ mode: 'number' })` returns a JS number rather than a bigint. Epoch
 * milliseconds are ~1.8e12, comfortably inside Number.MAX_SAFE_INTEGER, and
 * every timestamp in this system comes from the injected Clock as a number.
 * Keeping the runtime type identical across dialects is what lets one ledger
 * digest compare runs stored in either.
 */

import { bigint, boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';

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

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  runKey: text('run_key').notNull(),
  attempt: integer('attempt').notNull(),
  scenarioId: text('scenario_id').notNull(),
  scenarioContentHash: text('scenario_content_hash').notNull(),
  seed: integer('seed').notNull(),
  rail: text('rail').$type<RailKind>().notNull(),
  gateEnabled: boolean('gate_enabled').notNull(),
  agentName: text('agent_name').notNull(),
  agentVersion: text('agent_version').notNull(),
  model: text('model'),
  reproducibility: text('reproducibility').$type<ReproducibilityTier>().notNull(),
  cassetteHash: text('cassette_hash'),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  verdict: text('verdict').$type<InvariantStatus>(),
  error: text('error'),
  turnsUsed: integer('turns_used').notNull().default(0),
});

export const moneyActions = pgTable('money_actions', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
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

export const trajectoryEvents = pgTable('trajectory_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  seq: integer('seq').notNull(),
  role: text('role').$type<TrajectoryRole>().notNull(),
  kind: text('kind').$type<TrajectoryEventKind>().notNull(),
  contentJson: text('content_json').notNull().default('{}'),
});

export const verdicts = pgTable('verdicts', {
  runId: text('run_id').notNull(),
  invariantId: text('invariant_id').notNull(),
  status: text('status').$type<InvariantStatus>().notNull(),
  observedJson: text('observed_json').notNull().default('null'),
  expectedJson: text('expected_json').notNull().default('null'),
  blastRadiusPaise: integer('blast_radius_paise').notNull().default(0),
  witnessIdsJson: text('witness_ids_json').notNull().default('[]'),
});

export const scenarios = pgTable('scenarios', {
  id: text('id').notNull(),
  version: text('version').notNull(),
  contentHash: text('content_hash').notNull(),
  kind: text('kind').$type<ScenarioKind>().notNull(),
  family: text('family').$type<ScenarioFamily>().notNull(),
  pairId: text('pair_id'),
  yamlSnapshot: text('yaml_snapshot').notNull(),
});

export const pgSchema = {
  runs,
  moneyActions,
  trajectoryEvents,
  verdicts,
  scenarios,
};
