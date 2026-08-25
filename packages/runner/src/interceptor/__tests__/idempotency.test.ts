/**
 * The idempotency store.
 *
 * The Redis adapter is exercised against a fake client rather than a real
 * server, so `pnpm test` still runs with no services. What is being tested is
 * that the adapter satisfies the same contract as the in-memory one and sets a
 * TTL - not that Redis works.
 */

import { describe, expect, it } from 'vitest';

import type { IdempotencyStore, MinimalRedis } from '../idempotency.js';
import { InMemoryIdempotencyStore, RedisIdempotencyStore } from '../idempotency.js';

const OUTCOME = {
  railResult: 'ok' as const,
  railRef: 'pout_mock_abc',
  railError: null,
  firstSeq: 3,
};

/** An in-memory stand-in that records the arguments it was called with. */
function fakeRedis(): MinimalRedis & { store: Map<string, string>; ttls: number[] } {
  const store = new Map<string, string>();
  const ttls: number[] = [];

  return {
    store,
    ttls,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, _mode, seconds) {
      ttls.push(seconds);
      store.set(key, value);
    },
    async del(...keys) {
      for (const key of keys) store.delete(key);
    },
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

const IMPLEMENTATIONS: [string, () => IdempotencyStore][] = [
  ['InMemoryIdempotencyStore', () => new InMemoryIdempotencyStore()],
  ['RedisIdempotencyStore', () => new RedisIdempotencyStore(fakeRedis())],
];

describe.each(IMPLEMENTATIONS)('%s', (_name, create) => {
  it('returns undefined for an unseen key', async () => {
    expect(await create().get('nope')).toBeUndefined();
  });

  it('round-trips an outcome', async () => {
    const store = create();
    await store.set('inv_00417', OUTCOME);

    expect(await store.get('inv_00417')).toEqual(OUTCOME);
  });

  it('keeps keys separate', async () => {
    const store = create();
    await store.set('a', OUTCOME);

    expect(await store.get('b')).toBeUndefined();
  });

  it('preserves a failed outcome, so a retry does not replay as success', async () => {
    const store = create();
    const failed = {
      railResult: 'failed' as const,
      railRef: null,
      railError: 'bank_downtime',
      firstSeq: 0,
    };
    await store.set('k', failed);

    expect(await store.get('k')).toEqual(failed);
  });

  it('clears', async () => {
    const store = create();
    await store.set('a', OUTCOME);
    await store.clear();

    expect(await store.get('a')).toBeUndefined();
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('freezes what it stores', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('k', { ...OUTCOME });

    const read = await store.get('k');
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('reports its size', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.size).toBe(0);

    await store.set('a', OUTCOME);
    await store.set('b', OUTCOME);
    expect(store.size).toBe(2);
  });
});

describe('RedisIdempotencyStore', () => {
  it('namespaces its keys', async () => {
    const redis = fakeRedis();
    await new RedisIdempotencyStore(redis).set('inv_00417', OUTCOME);

    expect([...redis.store.keys()]).toEqual(['adversary:idem:inv_00417']);
  });

  it('sets a TTL rather than writing an unbounded key', async () => {
    // A real deployment must not accumulate idempotency keys forever, and the
    // window only has to outlive a retry.
    const redis = fakeRedis();
    await new RedisIdempotencyStore(redis, 'adversary:idem', 3600).set('k', OUTCOME);

    expect(redis.ttls).toEqual([3600]);
  });

  it('clears only its own namespace', async () => {
    const redis = fakeRedis();
    redis.store.set('someone-elses-key', 'value');

    const store = new RedisIdempotencyStore(redis);
    await store.set('mine', OUTCOME);
    await store.clear();

    expect([...redis.store.keys()]).toEqual(['someone-elses-key']);
  });
});
