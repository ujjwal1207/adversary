/**
 * The determinism check. The project's central claim, made testable.
 *
 * "The same scenario with the same seed, run twice, produces byte-identical
 * verdicts and identical ledgers."
 *
 * Two things this deliberately does *not* do.
 *
 * It does not compare runs it cannot honestly compare. A hosted model is not
 * deterministic even at temperature 0 - batching and provider-side updates both
 * break identity - so a `live` run is reported as drift measured, never as
 * identity asserted. A run whose wall-clock cap fired is likewise excluded: that
 * cap is the one thing in a run that reads real time, so a difference caused by
 * it says nothing about the system (docs/ARCHITECTURE.md 9.4).
 *
 * And it does not stop at "the digests differ". That is not a debuggable error
 * message, and this is the check most likely to fail on a change nobody expected
 * to matter, so it reports the first field on which two runs diverge.
 */

import type { PaymentAgent, PolicyGate, ReproducibilityTier } from '@adversary/core';
import { firstDifference } from '@adversary/core';

import type { LoadedScenario } from '../scenario/loader.js';
import type { RunResult } from './runner.js';
import { runScenario } from './runner.js';

export interface DeterminismReport {
  readonly scenarioId: string;
  readonly runKey: string;
  readonly attempts: number;
  /** True only when every attempt agreed and the runs were comparable. */
  readonly ok: boolean;
  /** False when the tier or an aborted run makes comparison meaningless. */
  readonly comparable: boolean;
  readonly reproducibility: ReproducibilityTier;
  readonly reason: string | null;
  readonly ledgerDigests: readonly string[];
  readonly verdictDigests: readonly string[];
  /** The first diverging field, as a path. Null when the runs agreed. */
  readonly firstDifference: string | null;
}

export interface DeterminismOptions {
  readonly loaded: LoadedScenario;
  readonly gate: PolicyGate | null;
  /** Default 3: two runs can agree by luck more easily than three. */
  readonly attempts?: number;
  readonly agent?: PaymentAgent;
  readonly model?: string | null;
  readonly reproducibility?: ReproducibilityTier;
}

export async function verifyDeterminism(
  options: DeterminismOptions,
): Promise<DeterminismReport> {
  const attempts = options.attempts ?? 3;
  if (attempts < 2) {
    throw new RangeError('verifyDeterminism needs at least two attempts to compare.');
  }

  const runs: RunResult[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    runs.push(
      await runScenario({
        loaded: options.loaded,
        gate: options.gate,
        attempt,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reproducibility === undefined
          ? {}
          : { reproducibility: options.reproducibility }),
      }),
    );
  }

  const first = runs[0] as RunResult;
  const base = {
    scenarioId: first.scenarioId,
    runKey: first.runKey,
    attempts,
    reproducibility: first.reproducibility,
    ledgerDigests: runs.map((r) => r.ledgerDigest),
    verdictDigests: runs.map((r) => r.verdictDigest),
  };

  const notComparable = whyNotComparable(runs);
  if (notComparable !== null) {
    return { ...base, ok: false, comparable: false, reason: notComparable, firstDifference: null };
  }

  for (let i = 1; i < runs.length; i += 1) {
    const other = runs[i] as RunResult;

    if (other.ledgerDigest !== first.ledgerDigest) {
      return {
        ...base,
        ok: false,
        comparable: true,
        reason: `ledgers differ between attempt 0 and attempt ${i}`,
        firstDifference: firstDifference(first.actions, other.actions),
      };
    }

    if (other.verdictDigest !== first.verdictDigest) {
      return {
        ...base,
        ok: false,
        comparable: true,
        reason: `verdicts differ between attempt 0 and attempt ${i}`,
        firstDifference: verdictDifference(first, other),
      };
    }
  }

  return { ...base, ok: true, comparable: true, reason: null, firstDifference: null };
}

/**
 * Why these runs cannot be held to byte-identity.
 *
 * Returning a reason rather than silently passing matters: a determinism gate
 * that quietly skipped the runs it could not check would report green while
 * checking nothing.
 */
function whyNotComparable(runs: readonly RunResult[]): string | null {
  const live = runs.find((r) => r.reproducibility === 'live');
  if (live) {
    return (
      'runs used a live model, which is not deterministic even at temperature 0. ' +
      'Byte-identity is not a claim that can hold here; use a scripted agent or ' +
      'a cassette, and report measured drift for live runs.'
    );
  }

  const timedOut = runs.find((r) => r.error === 'wall_clock_exceeded');
  if (timedOut) {
    return (
      `attempt ${timedOut.attempt} hit the wall-clock cap. That cap is the one ` +
      'thing in a run that reads real time, so a difference it caused says ' +
      'nothing about the system under test.'
    );
  }

  return null;
}

function verdictDifference(a: RunResult, b: RunResult): string {
  const byId = new Map(b.verdicts.map((v) => [v.id, v]));

  for (const left of a.verdicts) {
    const right = byId.get(left.id);
    if (!right) return `verdict ${left.id}: present in attempt 0, absent later`;
    if (left.status !== right.status) {
      return `verdict ${left.id}.status: ${left.status} vs ${right.status}`;
    }
    if (left.blastRadiusPaise !== right.blastRadiusPaise) {
      return `verdict ${left.id}.blastRadiusPaise: ${left.blastRadiusPaise} vs ${right.blastRadiusPaise}`;
    }
  }

  const extra = b.verdicts.find((v) => !a.verdicts.some((x) => x.id === v.id));
  return extra ? `verdict ${extra.id}: appeared only in a later attempt` : 'unknown';
}

/** Runs the check across a whole corpus, one report per scenario. */
export async function verifyDeterminismAcross(
  scenarios: readonly LoadedScenario[],
  options: Omit<DeterminismOptions, 'loaded'>,
): Promise<DeterminismReport[]> {
  const reports: DeterminismReport[] = [];
  for (const loaded of scenarios) {
    reports.push(await verifyDeterminism({ ...options, loaded }));
  }
  return reports;
}
