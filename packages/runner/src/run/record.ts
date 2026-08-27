/**
 * Step 9: hand off to metrics.
 *
 * A `RunResult` carries everything about an execution; a `RunRecord` is the
 * subset the metrics engine needs. The conversion lives here rather than in
 * core because it needs the scenario - the kind and family a run belongs to are
 * properties of the scenario, not of the ledger.
 */

import type { RunRecord } from '@adversary/core';

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
    verdicts: result.verdicts,
  };
}
