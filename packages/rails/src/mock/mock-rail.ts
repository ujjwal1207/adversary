/**
 * The mock rail: an in-process payment simulator.
 *
 * It exists so a 60-scenario corpus can run in seconds, on every push, with no
 * credentials and no network. Its numbers are simulator numbers and are
 * reported separately from live-test numbers, never merged
 * (docs/ARCHITECTURE.md P5).
 *
 * Everything stochastic here draws from an injected `Rng`, and every reference
 * it mints is a hash of `(runKey, seq, kind)`. There is no `Math.random`, no
 * `Date.now`, no `setTimeout`, and no network. A "timeout" is a returned
 * outcome, not an elapsed thirty seconds - the corpus is testing what the agent
 * does about a timeout, not how long it waits.
 */

import type { Clock, RailFailureKind, Rng } from '@adversary/core';
import { sha256Hex } from '@adversary/core';

import type {
  PreparedMoneyAction,
  Rail,
  RailOutcome,
  Unsubscribe,
  WebhookEvent,
  WebhookHandler,
} from '../rail.js';

/**
 * Which failures a caller could sensibly retry.
 *
 * `timeout` is the interesting one and the reason corpus family D2 exists: the
 * caller cannot tell whether the action took effect. Retrying without an
 * idempotency key is how a single obligation becomes two payments.
 */
const RETRYABLE: Readonly<Record<RailFailureKind, boolean>> = Object.freeze({
  insufficient_funds: false,
  bank_downtime: true,
  timeout: true,
  mandate_cancelled: false,
  rate_limited: true,
});

/** Reference prefixes, in the shape a payment provider would use. */
const PREFIX = {
  transfer: 'pout_mock',
  payment_link: 'plink_mock',
  refund: 'rfnd_mock',
  subscription_charge: 'inv_mock',
} as const;

export interface MockRailOptions {
  readonly rng: Rng;
  readonly clock: Clock;
  /** Probability that any given action fails. 0 disables failure injection. */
  readonly failureRate?: number;
  /** Which failures may be drawn. Defaults to all five. */
  readonly failureKinds?: readonly RailFailureKind[];
  /** Probability that a delivered webhook is delivered twice. */
  readonly duplicateWebhookRate?: number;
  /** Probability that a flush delivers its queue out of order. */
  readonly outOfOrderWebhookRate?: number;
}

const ALL_FAILURES: readonly RailFailureKind[] = [
  'insufficient_funds',
  'bank_downtime',
  'timeout',
  'mandate_cancelled',
  'rate_limited',
];

export class MockRail implements Rail {
  readonly kind = 'mock' as const;

  readonly #rng: Rng;
  readonly #clock: Clock;
  readonly #failureRate: number;
  readonly #failureKinds: readonly RailFailureKind[];
  readonly #duplicateRate: number;
  readonly #outOfOrderRate: number;

  readonly #handlers = new Set<WebhookHandler>();
  #queue: WebhookEvent[] = [];
  #provisioned: string | null = null;

  constructor(options: MockRailOptions) {
    this.#rng = options.rng;
    this.#clock = options.clock;
    this.#failureRate = options.failureRate ?? 0;
    this.#failureKinds = options.failureKinds ?? ALL_FAILURES;
    this.#duplicateRate = options.duplicateWebhookRate ?? 0;
    this.#outOfOrderRate = options.outOfOrderWebhookRate ?? 0;

    if (this.#failureKinds.length === 0 && this.#failureRate > 0) {
      throw new Error('failureRate is set but failureKinds is empty.');
    }
  }

  async provision(runKey: string): Promise<void> {
    this.#provisioned = runKey;
    this.#queue = [];
  }

  async teardown(_runKey: string): Promise<void> {
    this.#provisioned = null;
    this.#queue = [];
  }

  async execute(action: PreparedMoneyAction): Promise<RailOutcome> {
    // A per-action substream, so whether action 7 fails depends only on the
    // seed and on 7 - never on how many draws earlier actions happened to make.
    // Adding a rule that consumes randomness elsewhere therefore cannot shift
    // the failure pattern of an unrelated scenario.
    const rng = this.#rng.derive(`execute/${action.seq}`);

    if (rng.chance(this.#failureRate)) {
      const failure = rng.pick(this.#failureKinds);
      return {
        result: 'failed',
        railError: failure,
        retryable: RETRYABLE[failure],
      };
    }

    const railRef = this.reference(action);
    this.#enqueueWebhook(action, railRef);

    return { result: 'ok', railRef };
  }

  /**
   * The deterministic reference for an action.
   *
   * Public because the tests assert reproducibility against it directly, and
   * because `hash(runKey, seq, kind)` being the whole rule is easier to trust
   * when it can be checked from outside.
   */
  reference(action: PreparedMoneyAction): string {
    const digest = sha256Hex(`${action.runKey}|${action.seq}|${action.kind}`);
    return `${PREFIX[action.kind]}_${digest.slice(0, 14)}`;
  }

  flushWebhooks(): WebhookEvent[] {
    if (this.#queue.length === 0) return [];

    const rng = this.#rng.derive(`flush/${this.#queue.length}/${this.#clock.now()}`);
    let batch = this.#queue;
    this.#queue = [];

    // Out-of-order delivery. Real providers make no ordering promise, and an
    // agent that assumes one is corpus family D3.
    if (batch.length > 1 && rng.chance(this.#outOfOrderRate)) {
      batch = rng.shuffled(batch);
    }

    const delivered: WebhookEvent[] = [];
    for (const event of batch) {
      delivered.push(event);
      // Redelivery. At-least-once is the normal guarantee, and an agent that
      // charges twice on the second delivery is corpus family D1.
      if (rng.chance(this.#duplicateRate)) {
        delivered.push({ ...event, deliveryIndex: event.deliveryIndex + 1 });
      }
    }

    for (const event of delivered) {
      for (const handler of this.#handlers) handler(event);
    }

    return delivered;
  }

  onWebhook(handler: WebhookHandler): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Queued rather than delivered, so ordering is decided at flush time. */
  #enqueueWebhook(action: PreparedMoneyAction, railRef: string): void {
    this.#queue.push({
      id: `evt_mock_${sha256Hex(`${action.runKey}|${action.seq}|webhook`).slice(0, 14)}`,
      kind: `${action.kind}.processed`,
      railRef,
      deliveryIndex: 0,
      ts: this.#clock.now(),
      payload: Object.freeze({
        railRef,
        amountPaise: action.amountPaise,
        payeeRef: action.payeeRef,
        subjectRef: action.subjectRef,
        idempotencyKey: action.idempotencyKey,
        // Every synthetic event says so, in the data itself. The dashboard
        // renders a SYNTHETIC badge from this rather than from documentation.
        synthetic: true,
      }),
    });
  }

  /** Whether `provision` has run. Used by tests and by the runner's assertions. */
  get provisionedFor(): string | null {
    return this.#provisioned;
  }
}
