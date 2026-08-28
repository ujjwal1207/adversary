/**
 * The scenario schema.
 *
 * Every scenario is parsed, never cast. A malformed scenario fails at load with
 * a path into the YAML, not at turn nine with a TypeError - which matters
 * because a scenario that cannot be evaluated produces a verdict of `error`,
 * and a corpus full of those would report perfect safety.
 */

import {
  RAIL_FAILURE_KINDS,
  SCENARIO_FAMILIES,
  SCENARIO_KINDS,
  SEVERITIES,
  UNTRUSTED_SURFACES,
  paise,
} from '@adversary/core';
import { z } from 'zod';

/**
 * Integer paise, branded on the way through.
 *
 * The scenario file is the boundary where an untyped number from YAML becomes a
 * `Paise`. Validating and branding in one step means nothing downstream has to
 * decide whether a policy value was checked - if it type-checks as `Paise`, it
 * went through here. A decimal is rejected rather than rounded, because a
 * decimal in a policy almost always means someone wrote rupees.
 */
const paiseValue = z
  .number()
  .int('amounts are integer paise, not rupees')
  .nonnegative()
  .safe()
  .transform((value) => paise(value));

export const policySchema = z.object({
  perTxnCapPaise: paiseValue,
  sessionCapPaise: paiseValue,
  allowlist: z.array(z.string().min(1)),
  maxRetries: z.number().int().nonnegative(),
  escalationThresholdPaise: paiseValue,
  velocityWindowMs: z.number().int().positive(),
  velocityMaxActions: z.number().int().positive(),
});

export const injectionSchema = z.object({
  surface: z.enum(UNTRUSTED_SURFACES),
  /** The fixture id the payload is written into. */
  target: z.string().min(1),
  payload: z.string().min(1),
});

export const invariantSchema = z.object({
  id: z.string().min(1),
  assert: z.string().min(1),
  /**
   * Defaulted rather than optional, so every invariant carries a severity by
   * the time anything reads one. An absent severity would otherwise have to be
   * interpreted at each call site, and two call sites would eventually
   * interpret it differently.
   */
  severity: z.enum(SEVERITIES).default('high'),
});

/**
 * A script step's amount stays a plain number.
 *
 * It is going to the tool surface, which an agent reaches, and an agent cannot
 * construct a `Paise`. The interceptor brands it after validation - that is the
 * trust boundary, and moving the branding earlier would blur it.
 */
const moneyArgs = z.object({
  amountPaise: z.number().int('amounts are integer paise, not rupees').nonnegative().safe(),
  rationale: z.string().default(''),
  idempotencyKey: z.string().min(1).optional(),
});

/**
 * A scripted agent's steps, declared in the scenario itself.
 *
 * An addition to the build spec's schema (docs/ARCHITECTURE.md 17 A11). The
 * spec says ScriptedAgent "replays a fixed tool-call sequence" without saying
 * where the sequence comes from, and it has to come from the scenario: CI runs
 * the scripted corpus, and the determinism gate needs a system under test with
 * no source of variation at all.
 */
export const scriptStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('say'), text: z.string() }),
  z.object({ kind: z.literal('list_invoices') }),
  z.object({ kind: z.literal('read_tickets') }),
  z.object({ kind: z.literal('read_vendor_note'), vendorId: z.string().min(1) }),
  z.object({ kind: z.literal('read_disputes') }),
  z.object({ kind: z.literal('read_subscriptions') }),
  z.object({ kind: z.literal('read_payments') }),
  z.object({
    kind: z.literal('pay_vendor'),
    args: moneyArgs.extend({ vendorId: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('create_payment_link'),
    args: moneyArgs.extend({ customerId: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('issue_refund'),
    args: moneyArgs.extend({ paymentId: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('retry_subscription_charge'),
    args: moneyArgs.extend({ subId: z.string().min(1) }),
  }),
  z.object({ kind: z.literal('escalate_to_human'), reason: z.string().min(1) }),
]);

/**
 * What the scenario claims should happen, with the gate off and on.
 *
 * This is what turns the corpus into a regression suite: if a gated run
 * produces `violated` where it previously produced `blocked`, CI fails.
 */
export const expectSchema = z.object({
  ungated: z.enum(['pass', 'blocked', 'violated', 'error']),
  gated: z.enum(['pass', 'blocked', 'violated', 'error']),
});

/**
 * Rail failures at named positions.
 *
 * A scenario about what an agent does after an ambiguous timeout has to be able
 * to say *which* action timed out. A failure rate would make that scenario
 * arrive sometimes, which is not a scenario.
 */
export const railFailureSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.enum(RAIL_FAILURE_KINDS),
});

export const fixtureRefsSchema = z.object({
  vendors: z.string().optional(),
  invoices: z.string().optional(),
  tickets: z.string().optional(),
  subscriptions: z.string().optional(),
  customers: z.string().optional(),
  disputes: z.string().optional(),
  payments: z.string().optional(),
});

export const scenarioSchema = z
  .object({
    id: z.string().min(1),
    family: z.enum(SCENARIO_FAMILIES),
    title: z.string().min(1),
    severity: z.enum(SEVERITIES).default('high'),
    kind: z.enum(SCENARIO_KINDS),
    version: z.string().default('1.0.0'),
    /**
     * The paired scenario of the opposite kind.
     *
     * Required on attacks, because false-positive cost is only a comparable
     * number when each attack has a superficially similar benign twin. The
     * loader checks the pair resolves and is of the opposite kind.
     */
    pair: z.string().min(1).optional(),

    policy: policySchema,
    fixtures: fixtureRefsSchema.default({}),
    injection: injectionSchema.optional(),

    goal: z.string().min(1),
    script: z.array(scriptStepSchema).default([]),

    invariants: z.array(invariantSchema).min(1, 'a scenario must assert something'),
    expect: expectSchema,

    railFailures: z.array(railFailureSchema).default([]),

    seed: z.number().int().nonnegative().default(42),
    maxTurns: z.number().int().positive().default(12),
    maxWallClockMs: z.number().int().positive().default(90_000),
    rail: z.enum(['mock', 'live-test']).default('mock'),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (scenario.kind === 'attack' && scenario.injection === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['injection'],
        message:
          'an attack scenario needs an injection: without one it is not testing anything adversarial',
      });
    }
    if (scenario.kind === 'attack' && scenario.pair === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pair'],
        message:
          'an attack scenario needs a benign pair, or its false-positive cost cannot be computed',
      });
    }
    const ids = scenario.invariants.map((i) => i.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invariants'],
        message: 'invariant ids must be unique within a scenario',
      });
    }
  });

export type ScenarioInput = z.input<typeof scenarioSchema>;
export type Scenario = z.output<typeof scenarioSchema>;
export type ScenarioInjection = z.output<typeof injectionSchema>;
export type ScriptStep = z.output<typeof scriptStepSchema>;
export type RailFailure = z.output<typeof railFailureSchema>;
export type ScenarioExpectation = z.output<typeof expectSchema>;
