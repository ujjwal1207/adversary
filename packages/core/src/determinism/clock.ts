/**
 * Time.
 *
 * Wall-clock reads are banned across the run path by lint. This is why: the
 * gate's `velocity` rule reads a rolling time window, so under a real clock
 * whether a run trips that rule would depend on how busy the machine was. That
 * would make a *security verdict* a function of CPU load
 * (docs/ARCHITECTURE.md 9.3).
 *
 * The virtual clock advances only when the runner ticks it - once per agent
 * turn, once per tool call, with fixed increments. Time in a run is therefore a
 * property of what the agent did, not of how fast the hardware was.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  advance(ms: number): void;
}

export class ClockError extends Error {
  override readonly name = 'ClockError';
}

/**
 * A fixed, arbitrary epoch: 2025-10-09T08:53:20.000Z.
 *
 * Any constant would do. What matters is that it is the same on every machine
 * and every run, so timestamps land in ledger digests without perturbing them.
 */
export const VIRTUAL_EPOCH_MS = 1_760_000_000_000;

/** How far the runner advances the clock for each kind of step. */
export const TICK_MS = {
  turn: 1_000,
  toolCall: 100,
  railCall: 50,
} as const;

export class VirtualClock implements Clock {
  #now: number;

  constructor(startMs: number = VIRTUAL_EPOCH_MS) {
    if (!Number.isSafeInteger(startMs)) {
      throw new ClockError(`Clock start must be a safe integer, got ${startMs}.`);
    }
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms)) {
      throw new ClockError(`Clock advance must be a safe integer, got ${ms}.`);
    }
    // Time does not run backwards. A negative advance would let a caller
    // manufacture a velocity window that never happened.
    if (ms < 0) {
      throw new ClockError(`Clock cannot run backwards (advance ${ms}).`);
    }
    this.#now += ms;
  }
}
