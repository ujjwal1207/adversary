/**
 * The shape of `public/snapshot.json`, as the viewer reads it.
 *
 * The metric types come from `@adversary/core`, so a change to what a scorecard
 * contains breaks this build rather than silently rendering a stale shape. The
 * run and trajectory types are declared here instead of imported from
 * `@adversary/runner`, because the runner is the composition root: it knows
 * about databases and file systems, and the viewer has no business depending on
 * it. `version` exists so a snapshot written by a newer CLI can be refused
 * rather than half-rendered.
 */

import type { GateComparison, Paise } from '@adversary/core';

export type { GateComparison, Paise, Scorecard } from '@adversary/core';

export interface SnapshotScenario {
  readonly id: string;
  readonly contentHash: string;
  readonly title: string;
  readonly family: string;
  readonly kind: string;
}

export interface SnapshotAction {
  readonly id: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly amountPaise: Paise;
  readonly payeeRef: string | null;
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  readonly idempotencySource: string;
  readonly taint: readonly unknown[];
  readonly gateDecision: 'allow' | 'block' | 'escalate' | 'bypassed';
  readonly gateReasons: readonly string[];
  readonly ruleTrace: readonly unknown[];
  readonly agentRationale: string;
  // The closed union, not `string`: this viewer once summed
  // `railResult === 'executed'`, a value that does not exist, and every
  // "moved" column read a reassuring zero. A wrong literal must not typecheck.
  readonly railResult: RailResult;
  readonly railRef: string | null;
  readonly railError: string | null;
}

export interface SnapshotEvent {
  readonly seq: number;
  readonly role: string;
  readonly kind: string;
  readonly content: Record<string, unknown>;
}

export interface SnapshotVerdict {
  readonly invariantId: string;
  readonly status: InvariantStatus;
  readonly observed: unknown;
  readonly expected: unknown;
  readonly blastRadiusPaise: Paise;
  readonly witnessIds: readonly string[];
}

export type InvariantStatus = 'pass' | 'violated' | 'blocked' | 'error';

/** `ok` means the money moved. Nothing else does. */
export type RailResult = 'ok' | 'failed' | 'not_executed';

export interface SnapshotRun {
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
  readonly reproducibility: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly verdict: InvariantStatus | null;
  readonly error: string | null;
  readonly turnsUsed: number;
  readonly synthetic: boolean;
  readonly actions: readonly SnapshotAction[];
  readonly trajectory: readonly SnapshotEvent[];
  readonly verdicts: readonly SnapshotVerdict[];
}

export interface Snapshot {
  readonly version: 1;
  readonly comparison: GateComparison;
  readonly scenarios: readonly SnapshotScenario[];
  readonly runs: readonly SnapshotRun[];
}
