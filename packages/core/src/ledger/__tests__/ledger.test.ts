/**
 * The Phase 2 acceptance gate: monotonic seq under concurrency, non-integer
 * amounts rejected at runtime, returned records immutable.
 *
 * The compile-time half of "rejected at compile time" lives in
 * `__tests__/money.test.ts`, where a `@ts-expect-error` makes `tsc --noEmit`
 * fail if the brand is ever weakened.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryLedger, LedgerError } from '../ledger.js';
import { paise } from '../../money.js';
import { draft } from './fixtures.js';

describe('append assigns seq', () => {
  it('starts at zero and increments', () => {
    const ledger = new InMemoryLedger();

    expect(ledger.append(draft()).seq).toBe(0);
    expect(ledger.append(draft()).seq).toBe(1);
    expect(ledger.append(draft()).seq).toBe(2);
  });

  it('counts each run independently', () => {
    const ledger = new InMemoryLedger();

    ledger.append(draft({ runId: 'run_a' }));
    ledger.append(draft({ runId: 'run_a' }));
    const b = ledger.append(draft({ runId: 'run_b' }));

    expect(b.seq).toBe(0);
    expect(ledger.size('run_a')).toBe(2);
    expect(ledger.size('run_b')).toBe(1);
  });

  it('refuses a caller-supplied seq', () => {
    const ledger = new InMemoryLedger();
    const withSeq = { ...draft(), seq: 99 };

    // Accepting one would make monotonicity a convention rather than a
    // guarantee, and the ledger is the only thing standing behind every
    // reported number.
    expect(() => ledger.append(withSeq)).toThrow(/assigned by the ledger/);
  });

  it('is monotonic and gapless under concurrent appends', async () => {
    // The gate. `append` is synchronous and never yields between reading the
    // counter and writing it back, so no interleaving of callers can produce a
    // duplicate or a hole. Driving it from many interleaved microtasks is what
    // would expose an accidental `await` inside that window.
    const ledger = new InMemoryLedger();
    const COUNT = 500;

    const results = await Promise.all(
      Array.from({ length: COUNT }, async (_unused, i) => {
        // Yield first, so the appends genuinely interleave rather than running
        // in creation order.
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, i % 3));
        return ledger.append(draft({ id: `ma_${i}` }));
      }),
    );

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);

    expect(new Set(seqs).size).toBe(COUNT);
    expect(seqs).toEqual(Array.from({ length: COUNT }, (_unused, i) => i));
    expect(ledger.size('run_1')).toBe(COUNT);
  });

  it('stores actions in seq order', async () => {
    const ledger = new InMemoryLedger();

    await Promise.all(
      Array.from({ length: 50 }, async (_unused, i) => {
        await new Promise((resolve) => setTimeout(resolve, i % 4));
        ledger.append(draft({ id: `ma_${i}` }));
      }),
    );

    const stored = ledger.getRun('run_1');
    expect(stored.map((a) => a.seq)).toEqual(
      Array.from({ length: 50 }, (_unused, i) => i),
    );
  });
});

describe('append validates', () => {
  const ledger = () => new InMemoryLedger();

  it('rejects a non-integer amount at runtime', () => {
    // The brand stops this in our code. Drafts are also assembled from tool
    // arguments and provider responses, which were never type-checked, so the
    // runtime check is not redundant.
    const bad = { ...draft(), amountPaise: 4800.5 as never };
    expect(() => ledger().append(bad)).toThrow(LedgerError);
    expect(() => ledger().append(bad)).toThrow(/non-negative safe integer/);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2])(
    'rejects amountPaise %s',
    (value) => {
      const bad = { ...draft(), amountPaise: value as never };
      expect(() => ledger().append(bad)).toThrow(LedgerError);
    },
  );

  it('rejects a missing runId', () => {
    expect(() => ledger().append({ ...draft(), runId: '' })).toThrow(/runId is required/);
  });

  it('rejects a blocked action recorded as executed', () => {
    // If this pair could be stored, containment rate would be computed from
    // rows asserting that an action both was stopped and moved money.
    expect(() =>
      ledger().append(draft({ gateDecision: 'block', railResult: 'ok' })),
    ).toThrow(/blocked action cannot have executed/);
  });

  it('accepts a blocked action recorded as not_executed', () => {
    const stored = ledger().append(
      draft({ gateDecision: 'block', railResult: 'not_executed', railRef: null }),
    );
    expect(stored.railResult).toBe('not_executed');
  });
});

describe('records are immutable', () => {
  it('freezes the returned record', () => {
    const stored = new InMemoryLedger().append(draft());

    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { seq: number }).seq = 99;
    }).toThrow(TypeError);
  });

  it('freezes nested values', () => {
    const stored = new InMemoryLedger().append(
      draft({
        params: { vendorId: 'acct_vendor_acme', nested: { deep: 'value' } },
        gateReasons: ['payee_allowlist'],
      }),
    );

    expect(Object.isFrozen(stored.params)).toBe(true);
    expect(Object.isFrozen(stored.params['nested'])).toBe(true);
    expect(Object.isFrozen(stored.gateReasons)).toBe(true);
  });

  it('a caller mutating the draft afterwards cannot change the stored record', () => {
    const ledger = new InMemoryLedger();
    const mutable = draft({ params: { vendorId: 'acct_vendor_acme' } });

    const stored = ledger.append(mutable);
    (mutable.params as Record<string, unknown>)['vendorId'] = 'acct_attacker';

    expect(stored.params['vendorId']).toBe('acct_vendor_acme');
    expect(ledger.getRun('run_1')[0]?.params['vendorId']).toBe('acct_vendor_acme');
  });

  it('a caller mutating a returned record cannot corrupt the store', () => {
    const ledger = new InMemoryLedger();
    const stored = ledger.append(draft());

    try {
      (stored as { amountPaise: number }).amountPaise = 1;
    } catch {
      // Frozen in strict mode - which is the point.
    }

    expect(ledger.getRun('run_1')[0]?.amountPaise).toBe(480000);
  });
});

describe('the ledger is append-only', () => {
  it('exposes no way to change or remove an action', () => {
    const ledger = new InMemoryLedger();
    const surface = new Set([
      ...Object.getOwnPropertyNames(ledger),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ledger) as object),
    ]);

    // Not "we agree not to call them" - they do not exist.
    for (const forbidden of ['update', 'delete', 'remove', 'set', 'clear', 'splice']) {
      expect(surface.has(forbidden), `Ledger must not expose ${forbidden}()`).toBe(
        false,
      );
    }
    expect(surface.has('append')).toBe(true);
  });

  it('hands back a frozen snapshot, not the internal array', () => {
    const ledger = new InMemoryLedger();
    ledger.append(draft());

    const run = ledger.getRun('run_1');
    expect(Object.isFrozen(run)).toBe(true);
    expect(() => (run as unknown as MutableArray).push(draft())).toThrow(TypeError);
    expect(ledger.size('run_1')).toBe(1);
  });
});

// Only so the negative assertion above can be written without an `any`.
type MutableArray = { push: (item: unknown) => number };

describe('query', () => {
  const build = () => {
    const ledger = new InMemoryLedger();
    ledger.append(draft({ id: 'a', kind: 'transfer', railResult: 'ok' }));
    ledger.append(
      draft({
        id: 'b',
        kind: 'refund',
        railResult: 'not_executed',
        gateDecision: 'block',
        railRef: null,
        payeeRef: 'acct_vendor_bolt',
      }),
    );
    ledger.append(
      draft({
        id: 'c',
        kind: 'transfer',
        railResult: 'ok',
        taint: [
          {
            sourceKind: 'invoice_line_item',
            sourceId: 'inv_00417',
            extractedValues: ['acct_vendor_acme_new'],
            matchedVia: 'normalized',
          },
        ],
      }),
    );
    return ledger;
  };

  it('filters by kind', () => {
    expect(build().query('run_1', { kind: 'transfer' }).map((a) => a.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('filters by rail result', () => {
    expect(
      build().query('run_1', { railResult: 'not_executed' }).map((a) => a.id),
    ).toEqual(['b']);
  });

  it('filters by taint presence', () => {
    expect(build().query('run_1', { tainted: true }).map((a) => a.id)).toEqual(['c']);
    expect(build().query('run_1', { tainted: false }).map((a) => a.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('ANDs its fields', () => {
    expect(
      build()
        .query('run_1', { kind: 'transfer', gateDecision: 'block' })
        .map((a) => a.id),
    ).toEqual([]);
  });

  it('returns an empty array for an unknown run rather than throwing', () => {
    expect(build().getRun('nope')).toEqual([]);
    expect(build().size('nope')).toBe(0);
  });
});

describe('digest', () => {
  it('is stable for the same actions', () => {
    const a = new InMemoryLedger();
    const b = new InMemoryLedger();
    for (const ledger of [a, b]) {
      ledger.append(draft({ id: 'x' }));
      ledger.append(draft({ id: 'y', amountPaise: paise(1000) }));
    }

    expect(a.digest('run_1')).toBe(b.digest('run_1'));
  });

  it('ignores the per-row id, which is bookkeeping rather than behaviour', () => {
    const a = new InMemoryLedger();
    const b = new InMemoryLedger();
    a.append(draft({ id: 'ma_0001' }));
    b.append(draft({ id: 'ma_9999' }));

    expect(a.digest('run_1')).toBe(b.digest('run_1'));
  });

  it('changes when an amount changes', () => {
    const a = new InMemoryLedger();
    const b = new InMemoryLedger();
    a.append(draft({ amountPaise: paise(480000) }));
    b.append(draft({ amountPaise: paise(480001) }));

    expect(a.digest('run_1')).not.toBe(b.digest('run_1'));
  });

  it('changes when a gate decision changes', () => {
    const a = new InMemoryLedger();
    const b = new InMemoryLedger();
    a.append(draft({ gateDecision: 'allow' }));
    b.append(draft({ gateDecision: 'bypassed' }));

    // A gate-off run must never digest the same as a gate-on run that allowed
    // everything, or the two columns of the comparison table would be
    // indistinguishable.
    expect(a.digest('run_1')).not.toBe(b.digest('run_1'));
  });
});
