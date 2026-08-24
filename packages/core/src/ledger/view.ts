/**
 * The typed view the invariant evaluator sees.
 *
 * The evaluator never touches the ledger directly. It is handed one of these,
 * which exposes selection and aggregation and nothing else - no append, no
 * access to another run, no way to reach the store. Narrowing the surface is
 * what keeps the evaluator small enough to be fully tested, which is the whole
 * argument for hand-rolling it (docs/ARCHITECTURE.md 6.3).
 */

import type { LedgerFilter, MoneyAction, MoneyKind, Paise } from '../contracts.js';
import { sumPaise } from '../money.js';

export interface LedgerView {
  /** Every action in the run, ordered by seq. */
  actions(): readonly MoneyAction[];
  actionsOfKind(kind: MoneyKind): readonly MoneyAction[];
  /** Sum over the given actions, or over all of them. Empty sums to zero. */
  totalAmount(actions?: readonly MoneyAction[]): Paise;
  /** Distinct non-null payees, in first-seen order. */
  payees(): readonly string[];
  /** How many actions of a kind targeted each subject. Drives retry_limit. */
  countBySubject(kind: MoneyKind): ReadonlyMap<string, number>;
  select(filter: LedgerFilter): readonly MoneyAction[];
  /**
   * The same run restricted to actions that actually executed.
   *
   * This is the second half of the dual evaluation: an invariant that fails
   * against the full ledger but holds against this view was not upheld, it was
   * *contained* - the gate stopped it before the money moved. That distinction
   * is the containment-rate metric (docs/ARCHITECTURE.md 8.2).
   */
  executedOnly(): LedgerView;
}

export function createLedgerView(actions: readonly MoneyAction[]): LedgerView {
  const ordered = [...actions].sort((a, b) => a.seq - b.seq);

  return {
    actions: () => ordered,

    actionsOfKind: (kind) => ordered.filter((a) => a.kind === kind),

    totalAmount: (subset) => sumPaise((subset ?? ordered).map((a) => a.amountPaise)),

    payees: () => {
      const seen = new Set<string>();
      for (const action of ordered) {
        if (action.payeeRef !== null) seen.add(action.payeeRef);
      }
      return [...seen];
    },

    countBySubject: (kind) => {
      const counts = new Map<string, number>();
      for (const action of ordered) {
        if (action.kind !== kind || action.subjectRef === null) continue;
        counts.set(action.subjectRef, (counts.get(action.subjectRef) ?? 0) + 1);
      }
      return counts;
    },

    select: (filter) => ordered.filter((action) => matches(action, filter)),

    // Note this filters on railResult, not on gateDecision. An action the gate
    // allowed can still have failed at the rail, and money that never moved is
    // not blast radius regardless of why it did not move.
    executedOnly: () =>
      createLedgerView(ordered.filter((a) => a.railResult === 'ok')),
  };
}

function matches(action: MoneyAction, filter: LedgerFilter): boolean {
  if (filter.kind !== undefined && action.kind !== filter.kind) return false;
  if (filter.gateDecision !== undefined && action.gateDecision !== filter.gateDecision) {
    return false;
  }
  if (filter.railResult !== undefined && action.railResult !== filter.railResult) {
    return false;
  }
  if (filter.payeeRef !== undefined && action.payeeRef !== filter.payeeRef) return false;
  if (filter.subjectRef !== undefined && action.subjectRef !== filter.subjectRef) {
    return false;
  }
  if (filter.tainted !== undefined && action.taint.length > 0 !== filter.tainted) {
    return false;
  }
  return true;
}
