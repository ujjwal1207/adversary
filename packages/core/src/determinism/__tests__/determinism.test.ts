/**
 * The two primitives every reproducible thing in the system rests on.
 *
 * The substream test is the one that matters most: it pins down that deriving a
 * named stream depends on its label path and not on the parent's consumption.
 * Without that, adding a single `rng` call inside one component would silently
 * shift every other component's output and invalidate a whole corpus - the kind
 * of failure that shows up forty scenarios later and takes a day to find.
 */

import { describe, expect, it } from 'vitest';

import { ClockError, TICK_MS, VIRTUAL_EPOCH_MS, VirtualClock } from '../clock.js';
import { RngError, createRng } from '../rng.js';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);

    const draw = (r: ReturnType<typeof createRng>) =>
      Array.from({ length: 20 }, () => r.nextUint32());

    expect(draw(a)).toEqual(draw(b));
  });

  it('produces a different sequence for a different seed', () => {
    expect(createRng(42).nextUint32()).not.toBe(createRng(43).nextUint32());
  });

  it('accepts string seeds as well as numbers', () => {
    expect(createRng('B1_invoice_borne_redirect').nextUint32()).toBe(
      createRng('B1_invoice_borne_redirect').nextUint32(),
    );
  });

  it('stays in [0, 1) for floats', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('stays within bounds for integers', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextInt(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(9);
    }
  });

  it('rejects an empty or inverted integer range', () => {
    expect(() => createRng(1).nextInt(5, 5)).toThrow(RngError);
    expect(() => createRng(1).nextInt(9, 5)).toThrow(RngError);
    expect(() => createRng(1).nextInt(0.5, 5)).toThrow(/integers/);
  });

  it('treats chance(0) as never and chance(1) as always', () => {
    // Failure injection is configured with a rate, and `failureRate: 0` must
    // mean *no failures at all* rather than very few.
    const rng = createRng(11);
    for (let i = 0; i < 500; i += 1) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('has roughly the requested probability', () => {
    const rng = createRng(3);
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) if (rng.chance(0.25)) hits += 1;

    expect(hits / 20_000).toBeGreaterThan(0.23);
    expect(hits / 20_000).toBeLessThan(0.27);
  });

  it('refuses to pick from an empty list', () => {
    expect(() => createRng(1).pick([])).toThrow(RngError);
  });

  it('shuffles reproducibly and keeps every element', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    expect(createRng(9).shuffled(items)).toEqual(createRng(9).shuffled(items));
    expect([...createRng(9).shuffled(items)].sort((a, b) => a - b)).toEqual(items);
  });

  it('does not mutate the list it shuffles', () => {
    const items = [1, 2, 3, 4];
    createRng(9).shuffled(items);
    expect(items).toEqual([1, 2, 3, 4]);
  });
});

describe('Rng substreams', () => {
  it('gives independent streams different sequences', () => {
    const root = createRng(42);
    expect(root.derive('rail').nextUint32()).not.toBe(
      root.derive('webhook').nextUint32(),
    );
  });

  it('derives from the label path, not from the parent state', () => {
    // The property that matters. A component that consumes 100 numbers must not
    // move any other component's stream, or adding one call to the gate would
    // change the mock rail's failure placement across the whole corpus.
    const quiet = createRng(42);
    const busy = createRng(42);
    for (let i = 0; i < 100; i += 1) busy.nextUint32();

    expect(quiet.derive('rail').nextUint32()).toBe(busy.derive('rail').nextUint32());
  });

  it('is stable at depth', () => {
    const path = (seed: number) =>
      createRng(seed).derive('rail').derive('execute').derive('7').nextUint32();

    expect(path(42)).toBe(path(42));
    expect(path(42)).not.toBe(path(43));
  });

  it('reports its label path', () => {
    expect(createRng(42).derive('rail').derive('execute/7').label).toBe(
      '42/root/rail/execute/7',
    );
  });
});

describe('VirtualClock', () => {
  it('starts at the fixed epoch', () => {
    expect(new VirtualClock().now()).toBe(VIRTUAL_EPOCH_MS);
  });

  it('advances only when told to', () => {
    const clock = new VirtualClock();
    const before = clock.now();

    for (let i = 0; i < 1_000_000; i += 1) {
      // Burning real time must not move virtual time. This is the whole point:
      // the gate's velocity rule reads the clock, so under a real clock a
      // security verdict would depend on how busy the machine was.
    }

    expect(clock.now()).toBe(before);
    clock.advance(TICK_MS.turn);
    expect(clock.now()).toBe(before + 1000);
  });

  it('refuses to run backwards', () => {
    // A negative advance would let a caller manufacture a velocity window that
    // never happened.
    expect(() => new VirtualClock().advance(-1)).toThrow(/backwards/);
  });

  it('refuses a non-integer advance', () => {
    expect(() => new VirtualClock().advance(1.5)).toThrow(ClockError);
  });

  it('produces the same timeline for the same sequence of ticks', () => {
    const play = () => {
      const clock = new VirtualClock();
      const stamps: number[] = [];
      for (let turn = 0; turn < 3; turn += 1) {
        clock.advance(TICK_MS.turn);
        stamps.push(clock.now());
        clock.advance(TICK_MS.toolCall);
        stamps.push(clock.now());
      }
      return stamps;
    };

    expect(play()).toEqual(play());
  });
});
