/**
 * The type-level parity between each array and its union is asserted at compile
 * time in `enums.ts` and needs no runtime test. What compilation cannot check
 * is that the arrays are well-formed and that the verdict ordering says what
 * the architecture claims it says.
 */

import { describe, expect, it } from 'vitest';

import {
  GATE_DECISIONS,
  INVARIANT_STATUSES,
  INVARIANT_STATUS_SEVERITY,
  MONEY_KINDS,
  RAIL_KINDS,
  RAIL_RESULTS,
  SCENARIO_FAMILIES,
} from '../enums.js';

const ALL_ARRAYS = {
  MONEY_KINDS,
  GATE_DECISIONS,
  RAIL_RESULTS,
  RAIL_KINDS,
  INVARIANT_STATUSES,
  SCENARIO_FAMILIES,
};

describe('enum arrays', () => {
  it.each(Object.entries(ALL_ARRAYS))('%s contains no duplicates', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(Object.entries(ALL_ARRAYS))('%s contains no empty members', (_n, values) => {
    for (const value of values) expect(value.trim()).not.toBe('');
  });

  it('distinguishes bypassed from allow', () => {
    // A gate-off run records `bypassed`. If it recorded `allow`, the
    // gate-off/gate-on comparison in the report would read as though the gate
    // had approved every action it never saw.
    expect(GATE_DECISIONS).toContain('bypassed');
    expect(GATE_DECISIONS).toContain('allow');
  });

  it('can express an action that was recorded but never executed', () => {
    // The containment-rate metric is exactly the difference between "the agent
    // never tried" and "the agent tried and was stopped".
    expect(RAIL_RESULTS).toContain('not_executed');
  });
});

describe('verdict ordering', () => {
  it('scores every status', () => {
    expect(Object.keys(INVARIANT_STATUS_SEVERITY).sort()).toEqual(
      [...INVARIANT_STATUSES].sort(),
    );
  });

  it('ranks error above violated', () => {
    // An invariant that could not be evaluated is a broken measurement, and a
    // broken measurement must never be reported as a safe result. This is the
    // one ordering choice in the system that is counterintuitive on purpose.
    expect(INVARIANT_STATUS_SEVERITY.error).toBeGreaterThan(
      INVARIANT_STATUS_SEVERITY.violated,
    );
  });

  it('ranks violated above blocked above pass', () => {
    expect(INVARIANT_STATUS_SEVERITY.violated).toBeGreaterThan(
      INVARIANT_STATUS_SEVERITY.blocked,
    );
    expect(INVARIANT_STATUS_SEVERITY.blocked).toBeGreaterThan(
      INVARIANT_STATUS_SEVERITY.pass,
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INVARIANT_STATUS_SEVERITY)).toBe(true);
  });
});
