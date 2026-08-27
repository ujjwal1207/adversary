/**
 * Step 9: hand off to metrics.
 *
 * A `RunResult` carries everything about an execution; a `RunRecord` is the
 * subset the metrics engine needs. The conversion lives here rather than in
 * core because it needs the scenario - the kind and family a run belongs to are
 * properties of the scenario, not of the ledger.
 */

import type { InvariantResult, RunRecord } from '@adversary/core';

import type { Scenario } from '../scenario/schema.js';
import type { RunResult } from './runner.js';

export function toRunRecord(result: RunResult, scenario: Scenario): RunRecord {
  return {
    scenarioId: result.scenarioId,
    scenarioKind: scenario.kind,
    family: scenario.family,
    // `rail` is a string on RunResult because a custom Rail can name itself
    // anything; the metrics engine needs the closed union, and anything that is
    // not the mock rail is treated as live for reporting purposes.
    rail: result.rail === 'mock' ? 'mock' : 'live-test',
    gateEnabled: result.gateEnabled,
    verdict: result.verdict,
    turnsUsed: result.turnsUsed,
    reproducibility: result.reproducibility,
    agentName: result.agentName,
    agentVersion: result.agentVersion,
    model: result.model,
    actions: result.actions,
    verdicts: canonicalVerdicts(result.verdicts),
  };
}

/**
 * Verdicts in the one form a measurement should see them.
 *
 * Two things happen here, both so that a record built in memory and the same
 * record read back out of the database are indistinguishable:
 *
 *  - **Order.** The evaluator returns verdicts in the scenario's declared
 *    order; the database has no column that preserves it. Rather than add one
 *    for a fact no metric consults - the run verdict is the worst status, which
 *    is order-independent - both sides sort by invariant id.
 *  - **Absence.** A passing invariant often observes nothing, and `undefined`
 *    is not a JSON value: it goes into the database as `null` and comes back as
 *    `null`. Canonicalising it here means storage is lossless by construction
 *    instead of nearly-lossless in a way only a deep comparison would catch.
 *
 * Found by `tests/round-trip.test.ts`, which compares the two directly.
 */
export function canonicalVerdicts(
  verdicts: readonly InvariantResult[],
): readonly InvariantResult[] {
  return [...verdicts]
    .map((v) => ({ ...v, observed: v.observed ?? null, expected: v.expected ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
