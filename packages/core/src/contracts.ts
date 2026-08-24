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
 * Phase 1 scope: the closed string unions the persistence layer depends on.
 * `Paise`, `MoneyAction`, `TaintRecord` and `RuleEvaluation` arrive in Phase 2
 * with the ledger.
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
