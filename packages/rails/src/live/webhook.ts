/**
 * The webhook receiver.
 *
 * Three properties the Phase 10 gate asks for, and one it does not but which
 * the corpus needs:
 *
 *   **HMAC verification, compared in constant time.** A signature check that
 *   short-circuits on the first differing byte leaks the expected signature to
 *   anyone who can measure it.
 *
 *   **Replay tolerance.** At-least-once delivery is the normal guarantee, so a
 *   redelivery is not an attack and must not be rejected. It is *recorded* as a
 *   redelivery, because corpus family D1 is about an agent that charges twice
 *   on the second one.
 *
 *   **Out-of-order handling.** Providers make no ordering promise. An event
 *   older than one already seen for the same subject is delivered anyway, and
 *   flagged stale - dropping it would be inventing an ordering the provider
 *   never offered.
 *
 * And: every event this receiver emits carries `synthetic: false`, so the
 * dashboard's SYNTHETIC badge distinguishes a real provider event from one the
 * harness manufactured. That distinction has to live in the data, not in the
 * documentation.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Clock } from '@adversary/core';

import type { WebhookEvent } from '../rail.js';

export type WebhookRejection =
  | 'missing_signature'
  | 'malformed_signature'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'malformed_body';

export interface WebhookAccepted {
  readonly ok: true;
  readonly event: WebhookEvent;
  /** True when this event id has been seen before. Not an error. */
  readonly redelivery: boolean;
  /** True when an event for this subject arrived with an older timestamp. */
  readonly stale: boolean;
}

export interface WebhookRejected {
  readonly ok: false;
  readonly reason: WebhookRejection;
  readonly detail: string;
}

export type WebhookOutcome = WebhookAccepted | WebhookRejected;

export interface WebhookReceiverOptions {
  readonly secret: string;
  readonly clock: Clock;
  /**
   * How far in the past a signed timestamp may be. Defaults to five minutes,
   * the usual provider window. Zero disables the check.
   */
  readonly toleranceMs?: number;
}

export class WebhookReceiver {
  readonly #secret: string;
  readonly #clock: Clock;
  readonly #toleranceMs: number;

  /** Event ids already delivered, so a redelivery can be labelled as one. */
  readonly #seen = new Map<string, number>();
  /** Latest timestamp seen per subject, for staleness. */
  readonly #latest = new Map<string, number>();

  constructor(options: WebhookReceiverOptions) {
    if (!options.secret) {
      throw new Error('WebhookReceiver needs a signing secret.');
    }
    this.#secret = options.secret;
    this.#clock = options.clock;
    this.#toleranceMs = options.toleranceMs ?? 5 * 60 * 1000;
  }

  /** The signature a given body should carry. Exported for tests and fixtures. */
  sign(rawBody: string): string {
    return createHmac('sha256', this.#secret).update(rawBody, 'utf8').digest('hex');
  }

  /**
   * Verifies and accepts one delivery.
   *
   * `rawBody` must be the bytes as received. Re-serialising a parsed object
   * before verifying is the classic way to break signature checks, because key
   * order and whitespace are not preserved.
   */
  accept(rawBody: string, signature: string | undefined): WebhookOutcome {
    if (signature === undefined || signature.trim() === '') {
      return reject('missing_signature', 'No signature header was supplied.');
    }

    const expected = this.sign(rawBody);
    if (!constantTimeEquals(signature.trim(), expected)) {
      // The same message whether the signature was the wrong length or simply
      // wrong. Distinguishing them tells an attacker which half to work on.
      return reject('bad_signature', 'The signature does not match the body.');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (err) {
      return reject(
        'malformed_body',
        `Signature verified but the body is not JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const id = String(parsed['id'] ?? '');
    const kind = String(parsed['kind'] ?? parsed['event'] ?? 'unknown');
    const railRef = String(parsed['railRef'] ?? parsed['payment_id'] ?? '');
    const ts = Number(parsed['ts'] ?? parsed['created_at'] ?? this.#clock.now());

    if (id === '') {
      return reject('malformed_body', 'Signature verified but the body has no id.');
    }

    if (this.#toleranceMs > 0 && this.#clock.now() - ts > this.#toleranceMs) {
      // A correctly signed but very old delivery is a replay of a captured
      // request, which is different from a provider's own redelivery.
      return reject(
        'stale_timestamp',
        `Signed timestamp is older than the ${this.#toleranceMs}ms tolerance.`,
      );
    }

    const deliveryIndex = this.#seen.get(id) ?? 0;
    this.#seen.set(id, deliveryIndex + 1);

    const subject = railRef || id;
    const previous = this.#latest.get(subject);
    const stale = previous !== undefined && ts < previous;
    if (previous === undefined || ts > previous) this.#latest.set(subject, ts);

    return {
      ok: true,
      redelivery: deliveryIndex > 0,
      stale,
      event: {
        id,
        kind,
        railRef,
        deliveryIndex,
        ts,
        payload: Object.freeze({
          ...parsed,
          // Real provider event. The mock rail marks its own `synthetic: true`,
          // and the dashboard renders its badge from this field rather than
          // from anything a reader has to be told.
          synthetic: false,
        }),
      },
    };
  }

  /** Deliveries accepted so far, by event id. Used by the runner's summary. */
  get deliveryCounts(): ReadonlyMap<string, number> {
    return this.#seen;
  }

  reset(): void {
    this.#seen.clear();
    this.#latest.clear();
  }
}

function reject(reason: WebhookRejection, detail: string): WebhookRejected {
  return { ok: false, reason, detail };
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself be a timing
 * signal, so both sides are hashed to a fixed width first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHmac('sha256', 'compare').update(a).digest();
  const right = createHmac('sha256', 'compare').update(b).digest();
  return timingSafeEqual(left, right);
}
