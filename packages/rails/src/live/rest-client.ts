/**
 * The REST transport.
 *
 * The fallback when a local MCP server is not available. `fetch` is injectable
 * for the same reason the model adapters take one: what a transport gets wrong
 * is almost never the HTTP, it is the mapping between our shapes and theirs.
 *
 * Endpoint paths follow a payment provider's usual layout. They have NOT been
 * exercised against a live endpoint - see docs/LIMITATIONS.md.
 */

import { assertTestKey } from './test-key.js';
import type { ProviderClient, ProviderOutcome, ProviderRequest } from './provider-client.js';
import { outcomeForStatus, outcomeForTransportError } from './provider-client.js';

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RestClientOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** Bounded, and never unbounded. Default 2 retries on a retryable status. */
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  readonly timeoutMs?: number;
}

/** Where each money kind is created. */
const ENDPOINT: Readonly<Record<string, string>> = Object.freeze({
  transfer: '/v1/payouts',
  payment_link: '/v1/payment_links',
  refund: '/v1/refunds',
  subscription_charge: '/v1/subscriptions/charge',
});

export class RestProviderClient implements ProviderClient {
  readonly transport = 'rest' as const;

  readonly #auth: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #backoffMs: number;
  readonly #timeoutMs: number;

  constructor(options: RestClientOptions) {
    // The guard runs before anything else, in the constructor, so a
    // misconfigured client cannot exist as an object.
    assertTestKey(options.keyId, 'key id');

    this.#auth = Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64');
    this.#baseUrl = options.baseUrl ?? 'https://api.razorpay.com';
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#maxRetries = options.maxRetries ?? 2;
    this.#backoffMs = options.backoffMs ?? 400;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async execute(request: ProviderRequest): Promise<ProviderOutcome> {
    const path = ENDPOINT[request.kind];
    if (path === undefined) {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `No endpoint for ${request.kind}.`,
        retryable: false,
        ambiguous: false,
      };
    }

    const body = {
      amount: request.amountPaise,
      currency: 'INR',
      ...(request.payeeRef === null ? {} : { fund_account_id: request.payeeRef }),
      ...(request.subjectRef === null ? {} : { reference_id: request.subjectRef }),
      notes: request.notes,
    };

    let last: Extract<ProviderOutcome, { ok: false }> | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();

      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${this.#auth}`,
            // The provider deduplicates on this. It is the agent's own key when
            // the agent supplied one - see docs/ARCHITECTURE.md 6.4.1.
            'x-payout-idempotency': request.idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();

        if (response.ok) {
          const parsed = JSON.parse(text) as { id?: string };
          if (parsed.id) return { ok: true, ref: parsed.id };

          return {
            ok: false,
            code: 'malformed_response',
            message: 'Provider returned 2xx with no id.',
            retryable: false,
            // It succeeded and we cannot name what it created, which is worse
            // than a failure: something exists that we cannot trace back.
            ambiguous: true,
          };
        }

        last = outcomeForStatus(response.status, errorCode(text), truncate(text));
      } catch (err) {
        last = outcomeForTransportError(err);
      } finally {
        clearTimeout(timer);
      }

      if (!last.retryable || attempt === this.#maxRetries) break;
      await sleep(Math.min(this.#backoffMs * 2 ** attempt, 4000));
    }

    return (
      last ?? {
        ok: false,
        code: 'unknown',
        message: 'request failed with no outcome',
        retryable: false,
        ambiguous: true,
      }
    );
  }

  async close(): Promise<void> {
    // Nothing to release: fetch holds no connection this client owns.
  }
}

function errorCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string } };
    return parsed.error?.code ?? 'provider_error';
  } catch {
    return 'provider_error';
  }
}

function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}
