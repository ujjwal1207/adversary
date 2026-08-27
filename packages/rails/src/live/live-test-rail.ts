/**
 * The live-test rail.
 *
 * The same `Rail` interface the mock implements, against a payment provider's
 * test mode. The agent cannot tell the difference, which is the point of the
 * interface - and neither can the interceptor, the gate or the ledger.
 *
 * What it does NOT share with the mock rail is a determinism claim. It reads a
 * real clock, its references are assigned by the provider, and the network is
 * not reproducible. `verifyDeterminism` refuses to compare live runs rather
 * than asserting an identity that does not hold, and every number measured here
 * carries a `live-test` badge that is never aggregated with a mock one.
 */

import type { Clock, RailKind } from '@adversary/core';

import type {
  PreparedMoneyAction,
  Rail,
  RailOutcome,
  Unsubscribe,
  WebhookEvent,
  WebhookHandler,
} from '../rail.js';
import type { ProviderClient } from './provider-client.js';
import { assertTestKey } from './test-key.js';
import { WebhookReceiver } from './webhook.js';

export interface LiveTestRailOptions {
  /**
   * Checked again here even though both provider clients check it.
   *
   * Redundant on purpose. This is the one guarantee in the project whose
   * failure mode is moving real money, and a caller who constructs the rail
   * with a hand-rolled `ProviderClient` would otherwise skip the check
   * entirely.
   */
  readonly keyId: string;
  readonly client: ProviderClient;
  readonly clock: Clock;
  /** Required: an unsigned webhook endpoint is an open door. */
  readonly webhookSecret: string;
  readonly webhookToleranceMs?: number;
}

export class LiveTestRail implements Rail {
  readonly kind: RailKind = 'live-test';

  readonly #client: ProviderClient;
  readonly #clock: Clock;
  readonly #receiver: WebhookReceiver;
  readonly #handlers = new Set<WebhookHandler>();

  #queue: WebhookEvent[] = [];
  #runKey: string | null = null;
  /** Everything created this run, so teardown can report what it left behind. */
  readonly #created: { seq: number; ref: string }[] = [];

  constructor(options: LiveTestRailOptions) {
    assertTestKey(options.keyId, 'key id');

    this.#client = options.client;
    this.#clock = options.clock;
    this.#receiver = new WebhookReceiver({
      secret: options.webhookSecret,
      clock: options.clock,
      ...(options.webhookToleranceMs === undefined
        ? {}
        : { toleranceMs: options.webhookToleranceMs }),
    });
  }

  async provision(runKey: string): Promise<void> {
    this.#runKey = runKey;
    this.#queue = [];
    this.#created.length = 0;
    this.#receiver.reset();
  }

  async execute(action: PreparedMoneyAction): Promise<RailOutcome> {
    const outcome = await this.#client.execute({
      runKey: action.runKey,
      seq: action.seq,
      kind: action.kind,
      amountPaise: action.amountPaise,
      payeeRef: action.payeeRef,
      subjectRef: action.subjectRef,
      idempotencyKey: action.idempotencyKey,
      // Every entity carries its runKey. A shared test account accumulates
      // entities from many runs, and without this there is no way to say which
      // run made which - or to clean up after one.
      notes: {
        adversary_run: action.runKey,
        adversary_seq: String(action.seq),
        adversary_synthetic: 'true',
      },
    });

    if (outcome.ok) {
      this.#created.push({ seq: action.seq, ref: outcome.ref });
      return { result: 'ok', railRef: outcome.ref };
    }

    // An ambiguous failure is surfaced as such rather than flattened. Corpus
    // family D2 is precisely about what an agent does when it cannot tell
    // whether the money moved, and a rail that resolved the ambiguity for it
    // would delete the scenario.
    return {
      result: 'failed',
      railError: outcome.ambiguous ? `${outcome.code}:ambiguous` : outcome.code,
      retryable: outcome.retryable,
    };
  }

  /**
   * Receives one webhook delivery from the provider.
   *
   * Called by whatever HTTP surface the operator exposes. Returns the receiver's
   * outcome so the caller can answer the provider correctly: a rejection is a
   * 400, an acceptance a 200, and a redelivery is still a 200.
   */
  receiveWebhook(rawBody: string, signature: string | undefined): ReturnType<WebhookReceiver['accept']> {
    const outcome = this.#receiver.accept(rawBody, signature);
    if (outcome.ok) this.#queue.push(outcome.event);
    return outcome;
  }

  flushWebhooks(): WebhookEvent[] {
    const delivered = this.#queue;
    this.#queue = [];
    for (const event of delivered) {
      for (const handler of this.#handlers) handler(event);
    }
    return delivered;
  }

  onWebhook(handler: WebhookHandler): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async teardown(_runKey: string): Promise<void> {
    this.#runKey = null;
    this.#queue = [];
    this.#receiver.reset();
    await this.#client.close();
  }

  /** What this run created in the provider's test account, for traceability. */
  get created(): readonly { seq: number; ref: string }[] {
    return this.#created;
  }

  get provisionedFor(): string | null {
    return this.#runKey;
  }

  /** Signs a body the way the provider would. For fixtures and tests only. */
  signWebhook(rawBody: string): string {
    return this.#receiver.sign(rawBody);
  }

  /** Which transport is in play, for the report footer. */
  get transport(): 'mcp' | 'rest' {
    return this.#client.transport;
  }

  /** The clock this rail reads. Live runs carry no determinism claim. */
  get clock(): Clock {
    return this.#clock;
  }
}
