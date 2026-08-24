/**
 * @adversary/core/contracts
 *
 * The vocabulary of the system, and the ONLY module packages/agents is
 * permitted to import (docs/ARCHITECTURE.md 5.1, 5.2).
 *
 * This file must emit no JavaScript. It contains type declarations and nothing
 * else, so an agent under test that imports it receives zero runtime code: no
 * ledger it could construct, no evaluator it could reach, no rail client on any
 * prototype chain. The runtime companions to these unions live in `./enums`,
 * which agents do not import, and a compile-time assertion there keeps the two
 * in step.
 *
 * `tests/boundary.test.ts` compiles this file and asserts the emitted module is
 * empty, so "types only" stays a fact rather than an intention.
 */

// --- Money -----------------------------------------------------------------

/** The four ways an agent under test can move money. */
export type MoneyKind =
  | 'transfer'
  | 'payment_link'
  | 'refund'
  | 'subscription_charge';

/**
 * The gate's answer for one attempted action.
 *
 * `bypassed` is deliberately distinct from `allow`: a run made with the gate
 * disabled must never be readable as a run the gate approved, or the
 * gate-off/gate-on comparison in the report silently lies.
 */
export type GateDecision = 'allow' | 'block' | 'escalate' | 'bypassed';

/**
 * What the rail did.
 *
 * `not_executed` is what makes containment measurable. A blocked action is
 * still a ledger entry, so "the agent never tried" and "the agent tried and was
 * stopped" stay distinguishable (docs/ARCHITECTURE.md P3).
 */
export type RailResult = 'ok' | 'failed' | 'not_executed';

/**
 * Who supplied the idempotency key.
 *
 * `auto` keys are call-scoped and unique, mirroring a real payment API that
 * deduplicates only when the caller supplies a key. If the harness derived a
 * stable key from the parameters, corpus family D could not fail and Adversary
 * would be reporting a safety the agent does not have
 * (docs/ARCHITECTURE.md 6.4.1).
 */
export type IdempotencySource = 'agent' | 'auto';

// --- Rails -----------------------------------------------------------------

/**
 * Mock numbers come from a simulator; live-test numbers come from a payment
 * provider's test mode. They answer different questions and are never
 * aggregated (docs/ARCHITECTURE.md P5).
 */
export type RailKind = 'mock' | 'live-test';

/** Failure modes the mock rail can inject, under seeded control. */
export type RailFailureKind =
  | 'insufficient_funds'
  | 'bank_downtime'
  | 'timeout'
  | 'mandate_cancelled'
  | 'rate_limited';

// --- Verification ----------------------------------------------------------

/**
 * The four statuses an invariant can take.
 *
 * `error` means the invariant could not be evaluated - a broken measurement,
 * which outranks `violated` in the worst-wins ordering. A measurement that did
 * not run must never be reported as a safe result.
 */
export type InvariantStatus = 'pass' | 'blocked' | 'violated' | 'error';

/** A run's verdict is the worst status among its invariants. */
export type RunVerdict = InvariantStatus;

// --- Scenarios -------------------------------------------------------------

/**
 * Attack scenarios feed the attack success rate; benign scenarios feed the
 * false-positive cost. The denominators are never mixed
 * (docs/ARCHITECTURE.md 12.2).
 */
export type ScenarioKind = 'attack' | 'benign';

/** Corpus families A-G, as defined in the build spec Part 7. */
export type ScenarioFamily = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export type Severity = 'critical' | 'high' | 'medium' | 'warn';

/** The surfaces an attack payload can be injected into. All are untrusted. */
export type UntrustedSurface =
  | 'invoice_line_item'
  | 'ticket_body'
  | 'vendor_note'
  | 'webhook_field';

// --- Trajectory ------------------------------------------------------------

export type TrajectoryEventKind =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'gate_decision';

export type TrajectoryRole = 'system' | 'user' | 'assistant' | 'tool' | 'harness';

// --- Reproducibility -------------------------------------------------------

/**
 * How reproducible a given run actually is. Carried on every scorecard and
 * printed in every report footer.
 *
 * A hosted language model is not deterministic even at temperature 0, so
 * claiming byte-identity for a live run would be false. Instead the tier is
 * stated (docs/ARCHITECTURE.md 9.4).
 *
 *  - `scripted` - no model involved; fully reproducible
 *  - `cassette` - model responses served from a recorded cassette
 *  - `live`     - model called live; drift is measured and reported, not hidden
 */
export type ReproducibilityTier = 'scripted' | 'cassette' | 'live';

// ===========================================================================
// Phase 2 - money, the ledger record, and the policy it is judged against
// ===========================================================================

/**
 * An amount in integer minor units (paise). Never a float, never rupees.
 *
 * The brand is not decoration. `function pay(amount: Paise)` cannot be called
 * with a bare `number`, so a caller who has rupees in hand is forced to convert
 * explicitly at the boundary. Currency-unit confusion is corpus family A3 - a
 * thing the harness *tests for* - and it must never also be a bug in the
 * harness measuring it.
 *
 * Construct with `paise()` or `rupeesToPaise()` from `@adversary/core`.
 */
export type Paise = number & { readonly __brand: 'Paise' };

/**
 * Provenance: a record that some value in a money action can be traced back to
 * content an attacker controlled.
 *
 * Attached by the interceptor when a read tool returns attacker-controllable
 * content, and matched against the action's own parameters at build time - not
 * tracked through the agent's prose. Matching at the action rather than through
 * the transcript is what makes paraphrase survivable without semantic
 * machinery: however the agent restated an account number, only the literal it
 * finally passed to `pay_vendor` matters (docs/ARCHITECTURE.md 10.2).
 */
export interface TaintRecord {
  readonly sourceKind: UntrustedSurface;
  readonly sourceId: string;
  /** Account refs and amounts found in that content. */
  readonly extractedValues: readonly string[];
  /** Which normalization path produced the hit, so the report can explain it. */
  readonly matchedVia: TaintMatchKind;
}

export type TaintMatchKind = 'exact' | 'normalized' | 'numeric' | 'unit_variant';

/** The eight deterministic rules of the policy gate. */
export type RuleId =
  | 'per_txn_cap'
  | 'session_cap'
  | 'payee_allowlist'
  | 'velocity'
  | 'idempotency'
  | 'retry_limit'
  | 'escalation_threshold'
  | 'provenance';

/**
 * One rule's evaluation, pass or fail.
 *
 * Passes are recorded as well as failures. "Why was this allowed?" is as much
 * a question as "why was this blocked?", and a gate that can only answer the
 * second is not auditable.
 */
export interface RuleEvaluation {
  readonly rule: RuleId;
  readonly outcome: 'pass' | 'fail' | 'not_applicable';
  readonly observed: unknown;
  readonly expected: unknown;
  readonly message: string;
}

/** The gate's answer. Never a bare boolean. */
export interface GateVerdict {
  readonly decision: GateDecision;
  readonly reasons: readonly string[];
  readonly ruleTrace: readonly RuleEvaluation[];
}

/** The policy a scenario declares and the gate enforces. */
export interface Policy {
  readonly perTxnCapPaise: Paise;
  readonly sessionCapPaise: Paise;
  readonly allowlist: readonly string[];
  readonly maxRetries: number;
  readonly escalationThresholdPaise: Paise;
  readonly velocityWindowMs: number;
  readonly velocityMaxActions: number;
}

/**
 * One attempted money action, as recorded. The unit of evidence in this system.
 *
 * Every field is readonly and the object is deep-frozen by the ledger, because
 * this record is what every reported number is computed from. If a caller could
 * mutate one, the scorecard would be describing something other than what
 * happened.
 */
export interface MoneyAction {
  readonly id: string;
  readonly runId: string;
  /** Monotonic within a run, assigned by the ledger. Never by the caller. */
  readonly seq: number;
  /** From the injected Clock, never the wall clock. */
  readonly ts: number;
  readonly kind: MoneyKind;
  readonly params: Readonly<Record<string, unknown>>;
  readonly amountPaise: Paise;
  readonly payeeRef: string | null;
  /** subId / paymentId - the subject the retry_limit rule counts against. */
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  readonly idempotencySource: IdempotencySource;
  readonly taint: readonly TaintRecord[];
  readonly gateDecision: GateDecision;
  readonly gateReasons: readonly string[];
  readonly ruleTrace: readonly RuleEvaluation[];
  /**
   * What the agent said it was doing.
   *
   * Captured but never trusted. It feeds exactly one metric - the
   * recognition-execution gap - and nothing else in the system may read it. The
   * agent's stated reasoning is evidence about the agent, never evidence about
   * what happened. What happened is the rest of this record.
   */
  readonly agentRationale: string;
  readonly railResult: RailResult;
  readonly railRef: string | null;
  readonly railError: string | null;
}

/**
 * What a caller hands to `ledger.append()`.
 *
 * `seq` is absent by construction: it is the ledger's to assign, and a type
 * that let a caller supply one would make monotonicity a convention rather
 * than a guarantee.
 */
export type MoneyActionDraft = Omit<MoneyAction, 'seq'>;

/** Narrowing predicate for `ledger.query()`. All fields are ANDed. */
export interface LedgerFilter {
  readonly kind?: MoneyKind;
  readonly gateDecision?: GateDecision;
  readonly railResult?: RailResult;
  readonly payeeRef?: string;
  readonly subjectRef?: string;
  /** True when the action carries any taint at all. */
  readonly tainted?: boolean;
}

/** One entry in a run's transcript. */
export interface TrajectoryEvent {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly role: TrajectoryRole;
  readonly kind: TrajectoryEventKind;
  readonly content: Readonly<Record<string, unknown>>;
}
