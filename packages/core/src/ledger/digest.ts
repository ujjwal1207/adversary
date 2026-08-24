/**
 * Ledger digests - the mechanism behind the project's central claim, that the
 * same scenario with the same seed run twice produces identical ledgers.
 *
 * "Identical" needs defining, because a few fields legitimately differ between
 * two executions of the same experiment. `runId` carries an attempt counter;
 * `id` is per-row. Those are bookkeeping, not behaviour, and including them
 * would make the check fail for reasons that say nothing about the system.
 *
 * Everything else is in by default. Relaxations are opt-in and named, so a
 * loosened comparison is visible at the call site rather than buried in a
 * helper (docs/ARCHITECTURE.md 9.5).
 */

import type { MoneyAction } from '../contracts.js';
import { canonicalJson, sha256Hex } from '../canonical.js';

export interface DigestOptions {
  /**
   * Include rail references. Mock-rail refs are derived from `runKey` and are
   * stable; live-test refs are assigned by the provider and are not. Live runs
   * therefore compare without them - and carry no determinism claim anyway.
   */
  readonly includeRailRefs?: boolean;
  /**
   * Include timestamps. True under the virtual clock, false on the live rail
   * where they come from the system clock.
   */
  readonly includeTimestamps?: boolean;
  /**
   * Include the agent's stated rationale.
   *
   * On by default, because for a scripted agent it is deterministic and a
   * change in it is a real change. Turned off when comparing harness behaviour
   * across live model runs, where prose varies without the ledger's substance
   * varying - and where the honest report is measured drift, not an assertion
   * of identity.
   */
  readonly includeRationale?: boolean;
}

const STRICT: Required<DigestOptions> = {
  includeRailRefs: true,
  includeTimestamps: true,
  includeRationale: true,
};

/**
 * The canonical projection of one action.
 *
 * `id` and `runId` are absent by construction rather than deleted afterwards,
 * so adding a field to `MoneyAction` without deciding whether it belongs in the
 * digest is a compile error rather than a silent omission.
 */
export function projectAction(
  action: MoneyAction,
  options: DigestOptions = {},
): Record<string, unknown> {
  const opts = { ...STRICT, ...options };

  const projected: Record<string, unknown> = {
    seq: action.seq,
    kind: action.kind,
    params: action.params,
    amountPaise: action.amountPaise,
    payeeRef: action.payeeRef,
    subjectRef: action.subjectRef,
    idempotencyKey: action.idempotencyKey,
    idempotencySource: action.idempotencySource,
    taint: action.taint,
    gateDecision: action.gateDecision,
    gateReasons: action.gateReasons,
    ruleTrace: action.ruleTrace,
    railResult: action.railResult,
    railError: action.railError,
  };

  if (opts.includeTimestamps) projected['ts'] = action.ts;
  if (opts.includeRailRefs) projected['railRef'] = action.railRef;
  if (opts.includeRationale) projected['agentRationale'] = action.agentRationale;

  return projected;
}

/**
 * SHA-256 over the canonical projection of a run's actions, ordered by `seq`.
 *
 * Two runs are ledger-identical exactly when their digests match.
 */
export function ledgerDigest(
  actions: readonly MoneyAction[],
  options: DigestOptions = {},
): string {
  const ordered = [...actions].sort((a, b) => a.seq - b.seq);
  return sha256Hex(canonicalJson(ordered.map((a) => projectAction(a, options))));
}

/**
 * The first field on which two ledgers differ, as a human-readable path.
 *
 * "Digests differ" is not a debuggable error message, and the determinism gate
 * is the one check most likely to fail on a change nobody expected to matter.
 * This is what the CLI prints when it does.
 */
export function firstDifference(
  left: readonly MoneyAction[],
  right: readonly MoneyAction[],
  options: DigestOptions = {},
): string | null {
  const a = [...left].sort((x, y) => x.seq - y.seq);
  const b = [...right].sort((x, y) => x.seq - y.seq);

  if (a.length !== b.length) {
    return `action count: ${a.length} vs ${b.length}`;
  }

  for (let i = 0; i < a.length; i += 1) {
    const pa = projectAction(a[i] as MoneyAction, options);
    const pb = projectAction(b[i] as MoneyAction, options);

    for (const key of Object.keys(pa).sort()) {
      const va = canonicalJson(pa[key]);
      const vb = canonicalJson(pb[key]);
      if (va !== vb) return `action[${i}].${key}: ${va} vs ${vb}`;
    }
  }

  return null;
}
