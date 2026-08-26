/**
 * `adversary replay <runId>` - re-renders a stored run.
 *
 * It reads. It does not re-execute, does not call a model, and does not touch a
 * rail. Replaying a live-rail run therefore moves no money, which is the whole
 * reason replay is a read rather than a re-run: the transcript of what happened
 * is already the evidence, and executing it again would produce a *second*
 * thing that happened.
 */

import type {
  GateDecision,
  InvariantStatus,
  MoneyKind,
  RailResult,
  ReproducibilityTier,
  TrajectoryEventKind,
  TrajectoryRole,
} from '@adversary/core';

import type { DbHandle } from '../db/client.js';

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

export interface ReplayedAction {
  readonly id: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: MoneyKind;
  readonly params: Record<string, unknown>;
  readonly amountPaise: number;
  readonly payeeRef: string | null;
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  readonly idempotencySource: string;
  readonly taint: unknown[];
  readonly gateDecision: GateDecision;
  readonly gateReasons: string[];
  readonly ruleTrace: unknown[];
  readonly agentRationale: string;
  readonly railResult: RailResult;
  readonly railRef: string | null;
  readonly railError: string | null;
}

export interface ReplayedRun {
  readonly runId: string;
  readonly runKey: string;
  readonly attempt: number;
  readonly scenarioId: string;
  readonly scenarioContentHash: string;
  readonly seed: number;
  readonly rail: string;
  readonly gateEnabled: boolean;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly model: string | null;
  readonly reproducibility: ReproducibilityTier;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly verdict: InvariantStatus | null;
  readonly error: string | null;
  readonly turnsUsed: number;
  readonly actions: readonly ReplayedAction[];
  readonly trajectory: readonly {
    readonly seq: number;
    readonly role: TrajectoryRole;
    readonly kind: TrajectoryEventKind;
    readonly content: Record<string, unknown>;
  }[];
  readonly verdicts: readonly {
    readonly invariantId: string;
    readonly status: InvariantStatus;
    readonly observed: unknown;
    readonly expected: unknown;
    readonly blastRadiusPaise: number;
    readonly witnessIds: string[];
  }[];
}

const ph = (dialect: DbHandle['dialect'], n = 1): string => (dialect === 'postgres' ? `$${n}` : '?');

export async function replayRun(db: DbHandle, runId: string): Promise<ReplayedRun> {
  const runs = await db.all<Record<string, unknown>>(
    `SELECT * FROM runs WHERE id = ${ph(db.dialect)}`,
    [runId],
  );
  const run = runs[0];
  if (!run) throw new ReplayError(`No run with id "${runId}".`);

  const actions = await db.all<Record<string, unknown>>(
    `SELECT * FROM money_actions WHERE run_id = ${ph(db.dialect)} ORDER BY seq`,
    [runId],
  );
  const events = await db.all<Record<string, unknown>>(
    `SELECT * FROM trajectory_events WHERE run_id = ${ph(db.dialect)} ORDER BY seq`,
    [runId],
  );
  const verdicts = await db.all<Record<string, unknown>>(
    `SELECT * FROM verdicts WHERE run_id = ${ph(db.dialect)} ORDER BY invariant_id`,
    [runId],
  );

  return {
    runId: String(run['id']),
    runKey: String(run['run_key']),
    attempt: Number(run['attempt']),
    scenarioId: String(run['scenario_id']),
    scenarioContentHash: String(run['scenario_content_hash']),
    seed: Number(run['seed']),
    rail: String(run['rail']),
    // SQLite stores 0/1, Postgres a real boolean. Normalised here so a reader
    // never has to know which database produced the row.
    gateEnabled: Boolean(run['gate_enabled']),
    agentName: String(run['agent_name']),
    agentVersion: String(run['agent_version']),
    model: (run['model'] as string | null) ?? null,
    reproducibility: run['reproducibility'] as ReproducibilityTier,
    startedAt: Number(run['started_at']),
    finishedAt: run['finished_at'] === null ? null : Number(run['finished_at']),
    verdict: (run['verdict'] as InvariantStatus | null) ?? null,
    error: (run['error'] as string | null) ?? null,
    turnsUsed: Number(run['turns_used']),

    actions: actions.map((row) => ({
      id: String(row['id']),
      seq: Number(row['seq']),
      ts: Number(row['ts']),
      kind: row['kind'] as MoneyKind,
      params: json(row['params_json'], {}),
      amountPaise: Number(row['amount_paise']),
      payeeRef: (row['payee_ref'] as string | null) ?? null,
      subjectRef: (row['subject_ref'] as string | null) ?? null,
      idempotencyKey: String(row['idempotency_key']),
      idempotencySource: String(row['idempotency_source']),
      taint: json(row['taint_json'], []),
      gateDecision: row['gate_decision'] as GateDecision,
      gateReasons: json(row['gate_reasons_json'], []),
      ruleTrace: json(row['rule_trace_json'], []),
      agentRationale: String(row['agent_rationale']),
      railResult: row['rail_result'] as RailResult,
      railRef: (row['rail_ref'] as string | null) ?? null,
      railError: (row['rail_error'] as string | null) ?? null,
    })),

    trajectory: events.map((row) => ({
      seq: Number(row['seq']),
      role: row['role'] as TrajectoryRole,
      kind: row['kind'] as TrajectoryEventKind,
      content: json(row['content_json'], {}),
    })),

    verdicts: verdicts.map((row) => ({
      invariantId: String(row['invariant_id']),
      status: row['status'] as InvariantStatus,
      observed: json<unknown>(row['observed_json'], null),
      expected: json<unknown>(row['expected_json'], null),
      blastRadiusPaise: Number(row['blast_radius_paise']),
      witnessIds: json(row['witness_ids_json'], []),
    })),
  };
}

/**
 * A stored JSON column that will not parse is a corrupt row, and reporting it
 * as an empty object would quietly change what the run says happened. It throws.
 */
function json<T>(value: unknown, _fallback: T): T {
  if (value === null || value === undefined) return _fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch (err) {
    throw new ReplayError(
      `Stored JSON is corrupt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Every run stored for one experiment, oldest attempt first. */
export async function listAttempts(db: DbHandle, runKey: string): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM runs WHERE run_key = ${ph(db.dialect)} ORDER BY attempt`,
    [runKey],
  );
  return rows.map((r) => r.id);
}
