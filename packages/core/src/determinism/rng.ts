/**
 * Seeded randomness.
 *
 * `Math.random` is banned across the run path by lint. Every stochastic
 * component takes one of these instead, and the seed tree is derived from
 * `(scenarioId, seed)` so a run is reproducible end to end
 * (docs/ARCHITECTURE.md 9.1).
 *
 * The one design decision worth understanding here is how `derive()` works.
 * A substream is seeded from its **label path**, not from the parent's current
 * state. That means the rail's stream is unaffected by how many numbers the
 * webhook scheduler happened to consume before it - so adding a single call
 * inside one component cannot silently shift every other component's output and
 * invalidate an entire corpus. Naming a substream is cheap; a determinism
 * failure that only shows up 40 scenarios later is not.
 */

import { sha256Hex } from '../canonical.js';

export interface Rng {
  /** The full label path, e.g. `42/rail/failures`. Useful in test output. */
  readonly label: string;
  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number;
  /** Uniform float in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** True with the given probability. `chance(0)` is never, `chance(1)` always. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy. Fisher-Yates, drawing from this stream. */
  shuffled<T>(items: readonly T[]): T[];
  /** An independent substream, seeded from the label path. */
  derive(label: string): Rng;
}

export class RngError extends Error {
  override readonly name = 'RngError';
}

/**
 * splitmix32: small, fast, and good enough for failure injection and delivery
 * ordering. Written out rather than imported because it is nine lines and this
 * project prefers a component it fully understands over a dependency it does
 * not.
 *
 * All arithmetic is 32-bit integer arithmetic via `Math.imul` and `|0`, so the
 * sequence is bit-identical on every platform. A float-based generator would
 * not be.
 */
function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

/** First 32 bits of the SHA-256 of the label path. */
function seedFromLabel(label: string): number {
  return Number.parseInt(sha256Hex(label).slice(0, 8), 16) | 0;
}

export function createRng(seed: number | string, label = 'root'): Rng {
  const path = `${String(seed)}/${label}`;
  return makeRng(path);
}

function makeRng(path: string): Rng {
  const next = splitmix32(seedFromLabel(path));

  const rng: Rng = {
    label: path,

    nextUint32: () => next(),

    // Divided by 2^32 rather than multiplied by a reciprocal, so the mapping
    // from integer to float is exact.
    nextFloat: () => next() / 0x1_0000_0000,

    nextInt: (minInclusive, maxExclusive) => {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
        throw new RngError('nextInt bounds must be integers.');
      }
      if (maxExclusive <= minInclusive) {
        throw new RngError(
          `nextInt needs max > min, got [${minInclusive}, ${maxExclusive}).`,
        );
      }
      return minInclusive + (next() % (maxExclusive - minInclusive));
    },

    chance: (probability) => {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return rng.nextFloat() < probability;
    },

    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RngError('pick() needs a non-empty list.');
      return items[rng.nextInt(0, items.length)] as T;
    },

    shuffled: <T,>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rng.nextInt(0, i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },

    derive: (label) => makeRng(`${path}/${label}`),
  };

  return rng;
}
