/**
 * Step 8: persist.
 *
 * A run, its money actions, its trajectory and its verdicts, written in one
 * transaction. Partial persistence would leave a run row claiming a verdict
 * with no evidence behind it, which is worse than no row at all.
 *
 * Scenarios are stored keyed by `(id, content_hash)` rather than by id, so
 * editing a scenario adds a row instead of mutating one and a scorecard from
 * last month stays explainable by the corpus that produced it.
 */

import type { DbHandle } from '../db/client.js';
import type { LoadedScenario } from '../scenario/loader.js';
import type { RunResult } from './runner.js';

/** SQLite takes `?`; Postgres takes `$1`. */
function placeholders(dialect: DbHandle['dialect'], count: number, offset = 0): string {
  return Array.from({ length: count }, (_unused, i) =>
    dialect === 'postgres' ? `$${offset + i + 1}` : '?',
  ).join(', ');
}

/** SQLite has no boolean type; Postgres does. */
function bool(dialect: DbHandle['dialect'], value: boolean): boolean | number {
  return dialect === 'postgres' ? value : value ? 1 : 0;
}

export async function persistScenario(
  db: DbHandle,
  loaded: LoadedScenario,
): Promise<void> {
  const { scenario, contentHash, yamlSnapshot } = loaded;
  const conflict =
    db.dialect === 'postgres'
      ? 'ON CONFLICT (id, content_hash) DO NOTHING'
      : 'ON CONFLICT (id, content_hash) DO NOTHING';

  await db.run(
    `INSERT INTO scenarios (id, version, content_hash, kind, family, pair_id, yaml_snapshot)
     VALUES (${placeholders(db.dialect, 7)}) ${conflict}`,
    [
      scenario.id,
      scenario.version,
      contentHash,
      scenario.kind,
      scenario.family,
      scenario.pair ?? null,
      yamlSnapshot,
    ],
  );
}

export async function persistRun(db: DbHandle, result: RunResult): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO runs (
         id, run_key, attempt, scenario_id, scenario_content_hash, seed, rail,
         gate_enabled, agent_name, agent_version, model, reproducibility,
         cassette_hash, started_at, finished_at, verdict, error, turns_used
       ) VALUES (${placeholders(db.dialect, 18)})`,
      [
        result.runId,
        result.runKey,
        result.attempt,
        result.scenarioId,
        result.scenarioContentHash,
        result.seed,
        result.rail,
        bool(db.dialect, result.gateEnabled),
        result.agentName,
        result.agentVersion,
        result.model,
        result.reproducibility,
        result.cassetteHash,
        result.startedAt,
        result.finishedAt,
        result.verdict,
        result.error,
        result.turnsUsed,
      ],
    );

    for (const action of result.actions) {
      await db.run(
        `INSERT INTO money_actions (
           id, run_id, seq, ts, kind, params_json, amount_paise, payee_ref,
           subject_ref, idempotency_key, idempotency_source, taint_json,
           gate_decision, gate_reasons_json, rule_trace_json, agent_rationale,
           rail_result, rail_ref, rail_error
         ) VALUES (${placeholders(db.dialect, 19)})`,
        [
          action.id,
          action.runId,
          action.seq,
          action.ts,
          action.kind,
          JSON.stringify(action.params),
          action.amountPaise,
          action.payeeRef,
          action.subjectRef,
          action.idempotencyKey,
          action.idempotencySource,
          JSON.stringify(action.taint),
          action.gateDecision,
          JSON.stringify(action.gateReasons),
          JSON.stringify(action.ruleTrace),
          action.agentRationale,
          action.railResult,
          action.railRef,
          action.railError,
        ],
      );
    }

    for (const event of result.trajectory) {
      await db.run(
        `INSERT INTO trajectory_events (id, run_id, seq, role, kind, content_json)
         VALUES (${placeholders(db.dialect, 6)})`,
        [event.id, event.runId, event.seq, event.role, event.kind, JSON.stringify(event.content)],
      );
    }

    for (const verdict of result.verdicts) {
      await db.run(
        `INSERT INTO verdicts (
           run_id, invariant_id, status, observed_json, expected_json,
           blast_radius_paise, witness_ids_json
         ) VALUES (${placeholders(db.dialect, 7)})`,
        [
          result.runId,
          verdict.id,
          verdict.status,
          JSON.stringify(verdict.observed ?? null),
          JSON.stringify(verdict.expected ?? null),
          verdict.blastRadiusPaise,
          JSON.stringify(verdict.witnessIds),
        ],
      );
    }
  });
}

/** How many times this experiment has already been run. */
export async function nextAttempt(db: DbHandle, runKey: string): Promise<number> {
  const rows = await db.all<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM runs WHERE run_key = ${placeholders(db.dialect, 1)}`,
    [runKey],
  );
  return Number(rows[0]?.n ?? 0);
}
