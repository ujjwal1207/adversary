/**
 * Reading persisted runs back as metric records.
 *
 * `adversary run` writes; `adversary report` reads. Keeping those separate is
 * what lets a scorecard be regenerated months later from stored evidence rather
 * than from a re-run - which is the whole reason the runs are persisted at all.
 *
 * The scenario's kind and family come from the `scenarios` table rather than
 * being denormalised onto the run, so a report always describes the scenario
 * version that actually produced the run.
 */

import type { InvariantResult, MoneyAction, RailKind, RunRecord } from '@adversary/core';
import { paise } from '@adversary/core';

import type { DbHandle } from '../db/client.js';
import { canonicalVerdicts } from './record.js';

export interface ReadRecordsFilter {
  readonly rail?: RailKind;
  readonly gateEnabled?: boolean;
  readonly corpusHash?: string;
  /** Only the newest attempt of each experiment. Default true. */
  readonly latestAttemptOnly?: boolean;
}

const ph = (dialect: DbHandle['dialect'], n: number): string =>
  dialect === 'postgres' ? `$${n}` : '?';

export async function readRunRecords(
  db: DbHandle,
  filter: ReadRecordsFilter = {},
): Promise<RunRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.rail !== undefined) {
    where.push(`rail = ${ph(db.dialect, params.length + 1)}`);
    params.push(filter.rail);
  }
  if (filter.gateEnabled !== undefined) {
    where.push(`gate_enabled = ${ph(db.dialect, params.length + 1)}`);
    params.push(db.dialect === 'postgres' ? filter.gateEnabled : filter.gateEnabled ? 1 : 0);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const runs = await db.all<Record<string, unknown>>(
    `SELECT * FROM runs ${clause} ORDER BY scenario_id, attempt`,
    params,
  );

  // Scenario metadata, keyed by the exact content hash the run cited. A report
  // must describe the scenario that produced the run, not whatever the file
  // says today.
  const scenarios = await db.all<Record<string, unknown>>(
    'SELECT id, content_hash, kind, family FROM scenarios',
  );
  const meta = new Map(
    scenarios.map((s) => [
      `${String(s['id'])}|${String(s['content_hash'])}`,
      { kind: String(s['kind']), family: String(s['family']) },
    ]),
  );

  const chosen = filter.latestAttemptOnly === false ? runs : latestPerKey(runs);
  const records: RunRecord[] = [];

  for (const row of chosen) {
    const runId = String(row['id']);
    const key = `${String(row['scenario_id'])}|${String(row['scenario_content_hash'])}`;
    const scenario = meta.get(key);

    if (scenario === undefined) {
      // A run whose scenario row is missing cannot be attributed to attack or
      // benign, and guessing would put it in a denominator it may not belong
      // in. Skipping it silently would be worse, so it throws.
      throw new Error(
        `Run ${runId} cites scenario ${key} which is not in the scenarios ` +
          'table. The scorecard would have to guess whether it was an attack.',
      );
    }

    records.push({
      scenarioId: String(row['scenario_id']),
      scenarioKind: scenario.kind as RunRecord['scenarioKind'],
      family: scenario.family as RunRecord['family'],
      rail: String(row['rail']) as RailKind,
      gateEnabled: Boolean(row['gate_enabled']),
      verdict: String(row['verdict'] ?? 'error') as RunRecord['verdict'],
      turnsUsed: Number(row['turns_used']),
      reproducibility: String(row['reproducibility']) as RunRecord['reproducibility'],
      agentName: String(row['agent_name']),
      agentVersion: String(row['agent_version']),
      model: (row['model'] as string | null) ?? null,
      actions: await readActions(db, runId),
      verdicts: await readVerdicts(db, runId),
    });
  }

  return records;
}

async function readActions(db: DbHandle, runId: string): Promise<MoneyAction[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM money_actions WHERE run_id = ${ph(db.dialect, 1)} ORDER BY seq`,
    [runId],
  );

  return rows.map((row) => ({
    id: String(row['id']),
    runId,
    seq: Number(row['seq']),
    ts: Number(row['ts']),
    kind: String(row['kind']) as MoneyAction['kind'],
    params: JSON.parse(String(row['params_json'])) as Record<string, unknown>,
    amountPaise: paise(Number(row['amount_paise'])),
    payeeRef: (row['payee_ref'] as string | null) ?? null,
    subjectRef: (row['subject_ref'] as string | null) ?? null,
    idempotencyKey: String(row['idempotency_key']),
    idempotencySource: String(row['idempotency_source']) as MoneyAction['idempotencySource'],
    taint: JSON.parse(String(row['taint_json'])) as MoneyAction['taint'],
    gateDecision: String(row['gate_decision']) as MoneyAction['gateDecision'],
    gateReasons: JSON.parse(String(row['gate_reasons_json'])) as string[],
    ruleTrace: JSON.parse(String(row['rule_trace_json'])) as MoneyAction['ruleTrace'],
    agentRationale: String(row['agent_rationale']),
    railResult: String(row['rail_result']) as MoneyAction['railResult'],
    railRef: (row['rail_ref'] as string | null) ?? null,
    railError: (row['rail_error'] as string | null) ?? null,
  }));
}

async function readVerdicts(
  db: DbHandle,
  runId: string,
): Promise<readonly InvariantResult[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM verdicts WHERE run_id = ${ph(db.dialect, 1)} ORDER BY invariant_id`,
    [runId],
  );

  // Through the same canonicaliser the in-memory path uses, so the two agree
  // by construction rather than by coincidence.
  return canonicalVerdicts(rows.map((row) => ({
    id: String(row['invariant_id']),
    status: String(row['status']) as InvariantResult['status'],
    observed: JSON.parse(String(row['observed_json'])) as unknown,
    expected: JSON.parse(String(row['expected_json'])) as unknown,
    blastRadiusPaise: paise(Number(row['blast_radius_paise'])),
    witnessIds: JSON.parse(String(row['witness_ids_json'])) as string[],
  })));
}

/**
 * The newest attempt per experiment.
 *
 * Re-running a scenario should update the scorecard, not double its
 * denominator - counting attempt 0 and attempt 1 as two scenarios would halve
 * every rate the second time anyone pressed the button.
 */
function latestPerKey(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const best = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const key = String(row['run_key']);
    const existing = best.get(key);
    if (existing === undefined || Number(row['attempt']) > Number(existing['attempt'])) {
      best.set(key, row);
    }
  }

  return [...best.values()];
}
