/**
 * The idempotency store.
 *
 * This is one of *two* idempotency mechanisms in the system, and confusing them
 * is easy, so the distinction is worth stating plainly
 * (docs/ARCHITECTURE.md 6.4.1):
 *
 *   **This store** keys on the literal `idempotencyKey` and answers "is this the
 *   same API call I already made?". It models what a payment provider does. It
 *   is infrastructure, not a defence.
 *
 *   **The gate's `idempotency` rule** keys on the economic act - kind, subject,
 *   amount - and answers "is this the same *payment* twice?". That is a policy
 *   choice with a false-positive cost, and every policy choice with a
 *   false-positive cost belongs in the thing being measured.
 *
 * The consequence that matters: when the agent supplies no key, the interceptor
 * synthesises a call-scoped one that can never collide. If it derived a stable
 * key from the parameters instead, corpus family D could not fail - the harness
 * would be quietly defending the agent and then reporting a safety the agent
 * does not have.
 */

import type { RailResult } from '@adversary/core';

export interface IdempotentOutcome {
  readonly railResult: RailResult;
  readonly railRef: string | null;
  readonly railError: string | null;
  /** The seq of the action that first claimed this key. */
  readonly firstSeq: number;
}

/**
 * Asynchronous so a Redis-backed implementation fits behind the same interface
 * without changing a caller. The default is in-memory, which keeps the
 * zero-dependency run path working.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotentOutcome | undefined>;
  set(key: string, outcome: IdempotentOutcome): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, IdempotentOutcome>();

  async get(key: string): Promise<IdempotentOutcome | undefined> {
    return this.#entries.get(key);
  }

  async set(key: string, outcome: IdempotentOutcome): Promise<void> {
    this.#entries.set(key, Object.freeze(outcome));
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * The minimum a Redis client must provide.
 *
 * Declared structurally rather than by importing a client library, so the
 * production shape is demonstrated without adding a dependency that the
 * zero-services run path would then have to carry. Any of `redis`, `ioredis` or
 * a test double satisfies it.
 */
export interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  readonly #redis: MinimalRedis;
  readonly #prefix: string;
  readonly #ttlSeconds: number;

  constructor(redis: MinimalRedis, prefix = 'adversary:idem', ttlSeconds = 86_400) {
    this.#redis = redis;
    this.#prefix = prefix;
    this.#ttlSeconds = ttlSeconds;
  }

  async get(key: string): Promise<IdempotentOutcome | undefined> {
    const raw = await this.#redis.get(this.#key(key));
    if (raw === null) return undefined;
    return JSON.parse(raw) as IdempotentOutcome;
  }

  async set(key: string, outcome: IdempotentOutcome): Promise<void> {
    // A TTL rather than an unbounded key: a real deployment must not accumulate
    // idempotency keys forever, and the window only has to outlive a retry.
    await this.#redis.set(
      this.#key(key),
      JSON.stringify(outcome),
      'EX',
      this.#ttlSeconds,
    );
  }

  async clear(): Promise<void> {
    const keys = await this.#redis.keys(`${this.#prefix}:*`);
    if (keys.length > 0) await this.#redis.del(...keys);
  }

  #key(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}
