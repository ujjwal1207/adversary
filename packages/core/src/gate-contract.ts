/**
 * The shape of the policy gate, declared here so the interceptor can depend on
 * a gate without depending on `@adversary/gate`.
 *
 * Deliberately not in `./contracts`: agents must never see this. An agent that
 * could construct a gate could construct one that allows everything.
 *
 * Phase 7 implements it. Phase 4 needs only the interface and the
 * gate-disabled behaviour below.
 */

import type {
  GateDecision,
  GateVerdict,
  MoneyKind,
  Paise,
  Policy,
  TaintRecord,
} from './contracts.js';
import type { LedgerView } from './ledger/view.js';

export interface GateInput {
  readonly kind: MoneyKind;
  readonly amountPaise: Paise;
  readonly payeeRef: string | null;
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  readonly taint: readonly TaintRecord[];
  readonly policy: Policy;
  /** From the injected Clock. The velocity rule reads it. */
  readonly ts: number;
  /** Everything recorded so far this run. Gate state derives from evidence. */
  readonly view: LedgerView;
}

export interface PolicyGate {
  readonly name: string;
  evaluate(input: GateInput): GateVerdict;
}

/**
 * What the interceptor records when the gate is switched off.
 *
 * `bypassed`, never `allow`. A gate-off run must not be readable as a run the
 * gate approved, or the gate-off/gate-on comparison in the report - which is
 * the entire point of running both - silently lies.
 */
export const BYPASSED_VERDICT: GateVerdict = Object.freeze({
  decision: 'bypassed' as GateDecision,
  reasons: Object.freeze(['gate disabled for this run']),
  ruleTrace: Object.freeze([]),
});
