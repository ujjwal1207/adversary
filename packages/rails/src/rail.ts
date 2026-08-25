/**
 * The rail interface.
 *
 * Two implementations sit behind it: an in-process simulator that makes a
 * 60-scenario corpus deterministic and fast, and a real payment provider's test
 * mode that proves the actions are genuine API calls. Their numbers answer
 * different questions and are never aggregated (docs/ARCHITECTURE.md P5).
 *
 * Nothing in `packages/agents` may import this module. The only path from an
 * agent to a payment rail is through interceptor-provided tools, and that is
 * enforced by module resolution rather than by discipline
 * (docs/ARCHITECTURE.md 5.2).
 */

import type { MoneyKind, Paise, RailKind } from '@adversary/core';

/**
 * A money action that has passed validation and the gate, ready to execute.
 *
 * It carries `runKey`, not `runId`. Every determinism-bearing derivation keys
 * off `runKey` - which identifies *the experiment* - so that a second attempt
 * at the same experiment produces the same rail references. Using `runId`, which
 * carries an attempt counter, would make the determinism check fail for a
 * bookkeeping reason that says nothing about behaviour
 * (docs/ARCHITECTURE.md 9.2).
 */
export interface PreparedMoneyAction {
  readonly runKey: string;
  readonly seq: number;
  readonly kind: MoneyKind;
  readonly params: Readonly<Record<string, unknown>>;
  readonly amountPaise: Paise;
  readonly payeeRef: string | null;
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  readonly ts: number;
}

export type RailOutcome =
  | { readonly result: 'ok'; readonly railRef: string }
  | {
      readonly result: 'failed';
      readonly railError: string;
      /**
       * Whether a caller *could* retry. Note this is advice about the failure,
       * not permission: whether the agent retries, and how often, is part of
       * what the corpus measures.
       */
      readonly retryable: boolean;
    };

export interface WebhookEvent {
  readonly id: string;
  readonly kind: string;
  readonly railRef: string;
  /** 0 for first delivery, 1+ for a redelivery of the same event. */
  readonly deliveryIndex: number;
  readonly ts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type WebhookHandler = (event: WebhookEvent) => void;
export type Unsubscribe = () => void;

export interface Rail {
  readonly kind: RailKind;

  /** Prepares the rail for a run. On the live rail, creates test-mode entities. */
  provision(runKey: string): Promise<void>;

  execute(action: PreparedMoneyAction): Promise<RailOutcome>;

  /**
   * Delivers any webhooks queued by executions since the last flush.
   *
   * Explicit rather than timer-driven, because a timer would make delivery
   * order depend on the event loop and there is nothing to gain from that.
   * Duplicate and out-of-order delivery are seed-controlled, so `D1` (duplicate
   * webhook to double charge) and `D3` (out-of-order state confusion) are
   * reproducible rather than flaky.
   */
  flushWebhooks(): WebhookEvent[];

  onWebhook(handler: WebhookHandler): Unsubscribe;

  teardown(runKey: string): Promise<void>;
}

export class RailError extends Error {
  override readonly name = 'RailError';
}
