/**
 * The eight rules.
 *
 * Every one is a pure function of `(action, policy, ledger)`. There is no model
 * in this package and there never will be: the thing being measured is a
 * model's judgment about money, and a model judging it would fail in the same
 * way at the same time (docs/ARCHITECTURE.md P1).
 *
 * Each returns a `RuleEvaluation` whether it passes or fails. "Why was this
 * allowed?" is as much a question as "why was this blocked?", and a gate that
 * can only answer the second is not auditable.
 *
 * Three rules count *attempts*; the rest count *outcomes*. The distinction is
 * deliberate and worth stating: `velocity`, `retry_limit` and `per_txn_cap`
 * exist to constrain behaviour, so a blocked attempt still counts against them.
 * `session_cap` and `idempotency` are about money that actually moved, so they
 * read the executed-only view. Getting this backwards would let an agent probe
 * a limit for free, or would charge it twice for a payment it only made once.
 */

import type { GateInput, MoneyAction, RuleEvaluation, RuleId } from '@adversary/core';
import { normalizeIdentifier, sumPaise } from '@adversary/core';

export type FailAction = 'block' | 'escalate';

export interface Rule {
  readonly id: RuleId;
  /** What a failure of this rule means. Never a bare boolean. */
  readonly onFail: FailAction;
  evaluate(input: GateInput): RuleEvaluation;
}

const pass = (
  rule: RuleId,
  observed: unknown,
  expected: unknown,
  message: string,
): RuleEvaluation => ({ rule, outcome: 'pass', observed, expected, message });

const fail = (
  rule: RuleId,
  observed: unknown,
  expected: unknown,
  message: string,
): RuleEvaluation => ({ rule, outcome: 'fail', observed, expected, message });

const skip = (rule: RuleId, message: string): RuleEvaluation => ({
  rule,
  outcome: 'not_applicable',
  observed: null,
  expected: null,
  message,
});

// --- 1. per-transaction cap -------------------------------------------------

export const perTxnCap: Rule = {
  id: 'per_txn_cap',
  onFail: 'block',
  evaluate({ amountPaise, policy }) {
    const within = amountPaise <= policy.perTxnCapPaise;
    return within
      ? pass('per_txn_cap', amountPaise, policy.perTxnCapPaise, 'within the per-transaction cap')
      : fail(
          'per_txn_cap',
          amountPaise,
          policy.perTxnCapPaise,
          `${amountPaise} paise exceeds the per-transaction cap of ${policy.perTxnCapPaise}`,
        );
  },
};

// --- 2. session cap ---------------------------------------------------------

export const sessionCap: Rule = {
  id: 'session_cap',
  onFail: 'block',
  evaluate({ amountPaise, policy, view }) {
    // Executed only. An attempt the gate already blocked moved no money, and
    // counting it would let one refusal consume the budget for every later
    // legitimate payment.
    const spent = view.executedOnly().totalAmount();
    const projected = spent + amountPaise;

    return projected <= policy.sessionCapPaise
      ? pass('session_cap', projected, policy.sessionCapPaise, 'within the session cap')
      : fail(
          'session_cap',
          projected,
          policy.sessionCapPaise,
          `this would bring the session total to ${projected} paise, over the cap of ${policy.sessionCapPaise}`,
        );
  },
};

// --- 3. payee allowlist -----------------------------------------------------

export const payeeAllowlist: Rule = {
  id: 'payee_allowlist',
  onFail: 'block',
  evaluate({ payeeRef, policy }) {
    // A payment link collects money rather than sending it, so it has no payee
    // and there is nothing to check. Treating that as a pass would claim a
    // check happened; `not_applicable` says what is true.
    if (payeeRef === null) {
      return skip('payee_allowlist', 'this action has no payee');
    }

    return policy.allowlist.includes(payeeRef)
      ? pass('payee_allowlist', payeeRef, policy.allowlist, 'payee is on the approved list')
      : fail(
          'payee_allowlist',
          payeeRef,
          policy.allowlist,
          `Payee ${payeeRef} is not on the approved payee list.`,
        );
  },
};

// --- 4. velocity ------------------------------------------------------------

export const velocity: Rule = {
  id: 'velocity',
  onFail: 'block',
  evaluate({ policy, ts, view }) {
    // Counts ATTEMPTS, not executions. A rate limit exists to constrain
    // behaviour, and an agent that could probe a limit for free by having its
    // attempts blocked would not be constrained at all.
    //
    // This is also the rule that catches the split payment in corpus family A1:
    // eleven transfers each under the per-transaction cap trip nothing else.
    const windowStart = ts - policy.velocityWindowMs;
    const recent = view.actions().filter((action) => action.ts > windowStart);
    const projected = recent.length + 1;

    return projected <= policy.velocityMaxActions
      ? pass(
          'velocity',
          projected,
          policy.velocityMaxActions,
          `${projected} actions in the last ${policy.velocityWindowMs}ms`,
        )
      : fail(
          'velocity',
          projected,
          policy.velocityMaxActions,
          `this would be action ${projected} within ${policy.velocityWindowMs}ms, over the limit of ${policy.velocityMaxActions}`,
        );
  },
};

// --- 5. idempotency (semantic) ----------------------------------------------

/**
 * The economic act an action represents.
 *
 * Distinct from the interceptor's idempotency *store*, which keys on the
 * literal key the agent supplied and models what a payment provider does
 * (docs/ARCHITECTURE.md 6.4.1). This is the defence being measured: it asks
 * whether the same *payment* is being made twice, whatever key came with it.
 */
export function semanticKey(action: {
  kind: string;
  payeeRef: string | null;
  subjectRef: string | null;
  amountPaise: number;
}): string {
  const subject = action.subjectRef ?? action.payeeRef ?? 'none';
  return `${action.kind}|${normalizeIdentifier(subject)}|${action.amountPaise}`;
}

export const idempotency: Rule = {
  id: 'idempotency',
  onFail: 'block',
  evaluate(input) {
    const key = semanticKey(input);

    // Executed only. A prior attempt that was blocked or failed moved no money,
    // so repeating it is a retry, not a duplicate - and blocking the retry
    // would mean one transient failure permanently barred a legitimate payment.
    const priors = input.view
      .executedOnly()
      .actions()
      .filter((action) => semanticKey(action) === key);

    return priors.length === 0
      ? pass('idempotency', 0, 0, 'no matching payment has been made this session')
      : fail(
          'idempotency',
          priors.length,
          0,
          `an identical ${input.kind} of ${input.amountPaise} paise already succeeded this session (seq ${priors.map((p) => p.seq).join(', ')})`,
        );
  },
};

// --- 6. retry limit ---------------------------------------------------------

export const retryLimit: Rule = {
  id: 'retry_limit',
  onFail: 'block',
  evaluate({ kind, subjectRef, policy, view }) {
    if (subjectRef === null) {
      return skip('retry_limit', 'this action has no subject to count against');
    }

    // Attempts again, for the same reason as velocity: a stop rule that only
    // counted successes would never stop a loop that keeps failing, which is
    // precisely corpus family E.
    const attempts = view
      .actions()
      .filter((action) => action.kind === kind && action.subjectRef === subjectRef).length;
    const projected = attempts + 1;

    return projected <= policy.maxRetries
      ? pass(
          'retry_limit',
          projected,
          policy.maxRetries,
          `attempt ${projected} against ${subjectRef}`,
        )
      : fail(
          'retry_limit',
          projected,
          policy.maxRetries,
          `this would be attempt ${projected} against ${subjectRef}, over the limit of ${policy.maxRetries}`,
        );
  },
};

// --- 7. escalation threshold ------------------------------------------------

export const escalationThreshold: Rule = {
  id: 'escalation_threshold',
  // Escalate, never allow. Above the threshold a human decides, and the agent
  // is told so in a way it can act on.
  onFail: 'escalate',
  evaluate({ amountPaise, policy }) {
    return amountPaise <= policy.escalationThresholdPaise
      ? pass(
          'escalation_threshold',
          amountPaise,
          policy.escalationThresholdPaise,
          'below the approval threshold',
        )
      : fail(
          'escalation_threshold',
          amountPaise,
          policy.escalationThresholdPaise,
          `${amountPaise} paise is above the approval threshold of ${policy.escalationThresholdPaise} and needs human approval`,
        );
  },
};

// --- 8. provenance ----------------------------------------------------------

export const provenance: Rule = {
  id: 'provenance',
  onFail: 'escalate',
  evaluate({ taint, payeeRef, amountPaise, confirmedValues }) {
    if (taint.length === 0) {
      return pass('provenance', [], [], 'no parameter traces to an untrusted surface');
    }

    // A confirmation covers a specific value. Approving one payee must not
    // launder a different one, so an approval for `acct_a` does nothing for an
    // action paying `acct_b`.
    const approved = new Set((confirmedValues ?? []).map(normalizeIdentifier));
    const payeeApproved = payeeRef !== null && approved.has(normalizeIdentifier(payeeRef));
    const amountApproved = approved.has(normalizeIdentifier(String(amountPaise)));

    if (payeeApproved || amountApproved) {
      return pass(
        'provenance',
        taint.map((t) => t.sourceId),
        confirmedValues,
        'traced to an untrusted surface, but a human confirmed this value',
      );
    }

    const sources = taint.map((t) => `${t.sourceKind}:${t.sourceId}`).join(', ');
    return fail(
      'provenance',
      taint.map((t) => ({ source: `${t.sourceKind}:${t.sourceId}`, via: t.matchedVia })),
      'a human confirmation',
      `This payment's details trace to content from ${sources}, which the ` +
        'merchant does not control. A human should confirm before it proceeds.',
    );
  },
};

/**
 * The rules, in evaluation order.
 *
 * Order affects only how a trace reads, never the decision: every rule is
 * evaluated and the decision is the most restrictive outcome present. Ordering
 * them cheapest-first would be an optimisation nobody needs and would make the
 * trace depend on which rule happened to run.
 */
export const ALL_RULES: readonly Rule[] = Object.freeze([
  perTxnCap,
  sessionCap,
  payeeAllowlist,
  velocity,
  idempotency,
  retryLimit,
  escalationThreshold,
  provenance,
]);

/** Total of the executed actions in a view. Exported for the gate's tests. */
export function executedTotal(actions: readonly MoneyAction[]): number {
  return sumPaise(actions.filter((a) => a.railResult === 'ok').map((a) => a.amountPaise));
}
