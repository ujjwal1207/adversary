/**
 * Runtime companions to the type unions in `./contracts`.
 *
 * These arrays are the single source of truth for the database CHECK
 * constraints and (from Phase 3 onward) for schema validation. The type-level
 * assertions at the bottom of this file make it a compile error for an array
 * and its union to drift apart in either direction - adding a member to one
 * without the other does not type-check.
 *
 * This module is deliberately NOT part of the `@adversary/core/contracts`
 * subpath: agents get the types with no runtime code attached.
 */

import type {
  GateDecision,
  IdempotencySource,
  InvariantStatus,
  MoneyKind,
  RailFailureKind,
  RailKind,
  RailResult,
  ReproducibilityTier,
  ScenarioFamily,
  ScenarioKind,
  Severity,
  TrajectoryEventKind,
  TrajectoryRole,
  UntrustedSurface,
} from './contracts.js';

export const MONEY_KINDS = [
  'transfer',
  'payment_link',
  'refund',
  'subscription_charge',
] as const;

export const GATE_DECISIONS = ['allow', 'block', 'escalate', 'bypassed'] as const;

export const RAIL_RESULTS = ['ok', 'failed', 'not_executed'] as const;

export const IDEMPOTENCY_SOURCES = ['agent', 'auto'] as const;

export const RAIL_KINDS = ['mock', 'live-test'] as const;

export const RAIL_FAILURE_KINDS = [
  'insufficient_funds',
  'bank_downtime',
  'timeout',
  'mandate_cancelled',
  'rate_limited',
] as const;

export const INVARIANT_STATUSES = ['pass', 'blocked', 'violated', 'error'] as const;

export const SCENARIO_KINDS = ['attack', 'benign'] as const;

export const SCENARIO_FAMILIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

export const SEVERITIES = ['critical', 'high', 'medium', 'warn'] as const;

export const UNTRUSTED_SURFACES = [
  'invoice_line_item',
  'ticket_body',
  'vendor_note',
  'webhook_field',
] as const;

export const TRAJECTORY_EVENT_KINDS = [
  'system',
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'gate_decision',
] as const;

export const TRAJECTORY_ROLES = [
  'system',
  'user',
  'assistant',
  'tool',
  'harness',
] as const;

export const REPRODUCIBILITY_TIERS = ['scripted', 'cassette', 'live'] as const;

/**
 * Worst-wins ordering for verdicts, lowest to highest severity.
 *
 * `error` outranks `violated` on purpose: an invariant that could not be
 * evaluated is a broken measurement, and a broken measurement must never be
 * reported as a safe result (docs/ARCHITECTURE.md 6.8).
 */
export const INVARIANT_STATUS_SEVERITY: Readonly<Record<InvariantStatus, number>> =
  Object.freeze({
    pass: 0,
    blocked: 1,
    violated: 2,
    error: 3,
  });

// --- Compile-time parity ---------------------------------------------------
//
// `Equals` is the standard bivariance trick: two conditional types are only
// assignable to one another when their check types are mutually identical, so
// this is a true equality test rather than an assignability test. That matters
// here - assignability alone would let an array narrower than its union pass.

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

type Members<T extends readonly unknown[]> = T[number];

// These aliases are never referenced, and are not meant to be: each one is a
// constraint that fails to compile if its array and its union drift apart.

type _MoneyKind = Assert<Equals<Members<typeof MONEY_KINDS>, MoneyKind>>;
type _GateDecision = Assert<Equals<Members<typeof GATE_DECISIONS>, GateDecision>>;
type _IdempotencySource = Assert<
  Equals<Members<typeof IDEMPOTENCY_SOURCES>, IdempotencySource>
>;
type _RailKind = Assert<Equals<Members<typeof RAIL_KINDS>, RailKind>>;
type _RailResult = Assert<Equals<Members<typeof RAIL_RESULTS>, RailResult>>;
type _RailFailureKind = Assert<
  Equals<Members<typeof RAIL_FAILURE_KINDS>, RailFailureKind>
>;
type _InvariantStatus = Assert<
  Equals<Members<typeof INVARIANT_STATUSES>, InvariantStatus>
>;
type _ScenarioKind = Assert<Equals<Members<typeof SCENARIO_KINDS>, ScenarioKind>>;
type _ScenarioFamily = Assert<
  Equals<Members<typeof SCENARIO_FAMILIES>, ScenarioFamily>
>;
type _Severity = Assert<Equals<Members<typeof SEVERITIES>, Severity>>;
type _UntrustedSurface = Assert<
  Equals<Members<typeof UNTRUSTED_SURFACES>, UntrustedSurface>
>;
type _TrajectoryEventKind = Assert<
  Equals<Members<typeof TRAJECTORY_EVENT_KINDS>, TrajectoryEventKind>
>;
type _TrajectoryRole = Assert<
  Equals<Members<typeof TRAJECTORY_ROLES>, TrajectoryRole>
>;
type _ReproducibilityTier = Assert<
  Equals<Members<typeof REPRODUCIBILITY_TIERS>, ReproducibilityTier>
>;
