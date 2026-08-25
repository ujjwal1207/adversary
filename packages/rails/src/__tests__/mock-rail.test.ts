/**
 * The mock rail.
 *
 * The Phase 4 gate asks that an identical seed produce identical mock
 * behaviour. That is asserted three ways here: identical reference sequences,
 * identical failure placement, and reproducible duplicate delivery.
 */

import { describe, expect, it } from 'vitest';

import { VirtualClock, createRng, paise } from '@adversary/core';

import type { MockRailOptions } from '../mock/mock-rail.js';
import { MockRail } from '../mock/mock-rail.js';
import type { PreparedMoneyAction } from '../rail.js';

/** Everything MockRail takes except the two injected primitives. */
type RailKnobs = Omit<MockRailOptions, 'rng' | 'clock'>;

function railWith(seed: number, knobs: RailKnobs = {}): MockRail {
  return new MockRail({
    rng: createRng(seed).derive('rail'),
    clock: new VirtualClock(),
    ...knobs,
  });
}

function action(seq: number, overrides: Partial<PreparedMoneyAction> = {}): PreparedMoneyAction {
  return {
    runKey: 'key_b1',
    seq,
    kind: 'transfer',
    params: { vendorId: 'acct_vendor_acme' },
    amountPaise: paise(480000),
    payeeRef: 'acct_vendor_acme',
    subjectRef: null,
    idempotencyKey: `auto:key_b1:${seq}`,
    ts: 1_760_000_000_000,
    ...overrides,
  };
}

async function executeAll(rail: MockRail, count: number) {
  const outcomes = [];
  for (let seq = 0; seq < count; seq += 1) {
    outcomes.push(await rail.execute(action(seq)));
  }
  return outcomes;
}

describe('deterministic references', () => {
  it('mints the same reference sequence for the same seed', async () => {
    const a = await executeAll(railWith(42), 10);
    const b = await executeAll(railWith(42), 10);

    expect(a).toEqual(b);
  });

  it('derives the reference from runKey, seq and kind - not from the seed', async () => {
    // Rail references must be stable across attempts at the same experiment,
    // so they key off runKey. A rail seeded differently still mints the same
    // reference for the same action; only failure placement varies.
    const first = railWith(1);
    const second = railWith(999);

    expect(first.reference(action(3))).toBe(second.reference(action(3)));
  });

  it('gives different references to different runs, seqs and kinds', () => {
    const rail = railWith(1);

    expect(rail.reference(action(3))).not.toBe(rail.reference(action(4)));
    expect(rail.reference(action(3))).not.toBe(
      rail.reference(action(3, { runKey: 'key_other' })),
    );
    expect(rail.reference(action(3))).not.toBe(
      rail.reference(action(3, { kind: 'refund' })),
    );
  });

  it('uses a prefix matching the action kind', async () => {
    const rail = railWith(1);
    expect(rail.reference(action(0))).toMatch(/^pout_mock_/);
    expect(rail.reference(action(0, { kind: 'refund' }))).toMatch(/^rfnd_mock_/);
    expect(rail.reference(action(0, { kind: 'payment_link' }))).toMatch(/^plink_mock_/);
    expect(rail.reference(action(0, { kind: 'subscription_charge' }))).toMatch(
      /^inv_mock_/,
    );
  });
});

describe('failure injection', () => {
  it('injects nothing at all when the rate is zero', async () => {
    const outcomes = await executeAll(railWith(42, { failureRate: 0 }), 200);
    expect(outcomes.every((o) => o.result === 'ok')).toBe(true);
  });

  it('fails everything when the rate is one', async () => {
    const outcomes = await executeAll(railWith(42, { failureRate: 1 }), 50);
    expect(outcomes.every((o) => o.result === 'failed')).toBe(true);
  });

  it('places failures identically for the same seed', async () => {
    const a = await executeAll(railWith(42, { failureRate: 0.3 }), 60);
    const b = await executeAll(railWith(42, { failureRate: 0.3 }), 60);

    expect(a.map((o) => o.result)).toEqual(b.map((o) => o.result));
    expect(a).toEqual(b);
  });

  it('places failures differently for a different seed', async () => {
    const a = await executeAll(railWith(42, { failureRate: 0.3 }), 60);
    const b = await executeAll(railWith(7, { failureRate: 0.3 }), 60);

    expect(a.map((o) => o.result)).not.toEqual(b.map((o) => o.result));
  });

  it('decides each action from its own substream', async () => {
    // Whether action 7 fails depends only on the seed and on 7. If it depended
    // on how many draws earlier actions made, adding a rule that consumes
    // randomness elsewhere would shift failures across the whole corpus.
    const full = await executeAll(railWith(42, { failureRate: 0.5 }), 20);

    const rail = railWith(42, { failureRate: 0.5 });
    const isolated = await rail.execute(action(7));

    expect(isolated).toEqual(full[7]);
  });

  it('draws only from the configured failure kinds', async () => {
    const outcomes = await executeAll(
      railWith(42, { failureRate: 1, failureKinds: ['timeout'] }),
      20,
    );

    expect(
      outcomes.every((o) => o.result === 'failed' && o.railError === 'timeout'),
    ).toBe(true);
  });

  it('marks a timeout retryable and insufficient funds not', async () => {
    // The distinction corpus family D2 turns on: after an ambiguous timeout the
    // caller cannot tell whether the action took effect.
    const timeout = await railWith(1, {
      failureRate: 1,
      failureKinds: ['timeout'],
    }).execute(action(0));
    const funds = await railWith(1, {
      failureRate: 1,
      failureKinds: ['insufficient_funds'],
    }).execute(action(0));

    expect(timeout).toMatchObject({ result: 'failed', retryable: true });
    expect(funds).toMatchObject({ result: 'failed', retryable: false });
  });

  it('rejects a failure rate with no failure kinds to draw from', () => {
    expect(
      () =>
        new MockRail({
          rng: createRng(1),
          clock: new VirtualClock(),
          failureRate: 0.5,
          failureKinds: [],
        }),
    ).toThrow(/failureKinds is empty/);
  });
});

describe('webhooks', () => {
  it('queues one event per successful execution and delivers on flush', async () => {
    const rail = railWith(42);
    await executeAll(rail, 3);

    const delivered = rail.flushWebhooks();

    expect(delivered).toHaveLength(3);
    expect(rail.flushWebhooks()).toEqual([]);
  });

  it('queues nothing for a failed execution', async () => {
    const rail = railWith(42, { failureRate: 1 });
    await executeAll(rail, 3);

    expect(rail.flushWebhooks()).toEqual([]);
  });

  it('marks every event synthetic in the payload, not only in the docs', async () => {
    // The dashboard renders its SYNTHETIC badge from this. A reader looking at
    // a trajectory must be able to see that an event was manufactured without
    // having read the documentation first.
    const rail = railWith(42);
    await executeAll(rail, 1);

    expect(rail.flushWebhooks()[0]?.payload['synthetic']).toBe(true);
  });

  it('delivers to subscribers, and stops after unsubscribe', async () => {
    const rail = railWith(42);
    const seen: string[] = [];
    const off = rail.onWebhook((e) => seen.push(e.railRef));

    await executeAll(rail, 2);
    rail.flushWebhooks();
    expect(seen).toHaveLength(2);

    off();
    await rail.execute(action(2));
    rail.flushWebhooks();
    expect(seen).toHaveLength(2);
  });

  it('reproduces duplicate delivery for the same seed', async () => {
    // Corpus family D1 - an agent that charges twice on a redelivery. It must
    // be reproducible, or the scenario is flaky rather than adversarial.
    const play = async () => {
      const rail = railWith(42, { duplicateWebhookRate: 0.5 });
      await executeAll(rail, 12);
      return rail.flushWebhooks().map((e) => `${e.railRef}#${e.deliveryIndex}`);
    };

    const a = await play();
    const b = await play();

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(12); // some were delivered twice
    expect(a.some((s) => s.endsWith('#1'))).toBe(true);
  });

  it('never duplicates when the rate is zero', async () => {
    const rail = railWith(42, { duplicateWebhookRate: 0 });
    await executeAll(rail, 20);

    expect(rail.flushWebhooks().every((e) => e.deliveryIndex === 0)).toBe(true);
  });

  it('reproduces out-of-order delivery for the same seed', async () => {
    const play = async () => {
      const rail = railWith(5, { outOfOrderWebhookRate: 1 });
      await executeAll(rail, 8);
      return rail.flushWebhooks().map((e) => e.railRef);
    };

    const a = await play();
    const b = await play();
    const ordered = await (async () => {
      const rail = railWith(5, { outOfOrderWebhookRate: 0 });
      await executeAll(rail, 8);
      return rail.flushWebhooks().map((e) => e.railRef);
    })();

    expect(a).toEqual(b);
    expect(a).not.toEqual(ordered);
    expect([...a].sort()).toEqual([...ordered].sort());
  });
});

describe('lifecycle', () => {
  it('records what it was provisioned for and clears on teardown', async () => {
    const rail = railWith(1);

    await rail.provision('key_b1');
    expect(rail.provisionedFor).toBe('key_b1');

    await rail.teardown('key_b1');
    expect(rail.provisionedFor).toBeNull();
  });

  it('drops queued webhooks on teardown', async () => {
    const rail = railWith(1);
    await rail.provision('key_b1');
    await executeAll(rail, 2);
    await rail.teardown('key_b1');

    expect(rail.flushWebhooks()).toEqual([]);
  });

  it('identifies itself as the mock rail', () => {
    // Every number in a report carries the rail it was measured on, and mock
    // and live numbers are never aggregated.
    expect(railWith(1).kind).toBe('mock');
  });
});
