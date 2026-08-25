/**
 * The real clock.
 *
 * The only file in the run path permitted to read wall-clock time - the lint
 * opt-out in eslint.config.js names it explicitly, and the opt-out is narrow so
 * that adding another one is uncomfortable.
 *
 * Used only by the live-test rail, where entities are created against a real
 * provider and their timestamps are the provider's, not ours. Live runs
 * therefore carry no determinism claim, which is stated in the report rather
 * than papered over.
 */

import type { Clock } from './clock.js';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  /**
   * A no-op. The system clock advances on its own, and letting a caller push it
   * would produce timestamps that disagree with the provider's.
   */
  advance(_ms: number): void {
    // intentionally empty
  }
}
