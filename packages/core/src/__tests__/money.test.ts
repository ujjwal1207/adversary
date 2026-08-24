import { describe, expect, it } from 'vitest';

import {
  MAX_PAISE,
  MoneyError,
  ZERO_PAISE,
  addPaise,
  formatPaise,
  isPaise,
  paise,
  parseRupees,
  rupeesToPaise,
  subPaise,
  sumPaise,
} from '../money.js';
import type { Paise } from '../contracts.js';

describe('the brand is enforced at compile time', () => {
  it('rejects a bare number where Paise is required', () => {
    const takesPaise = (_amount: Paise): void => {};

    // @ts-expect-error - a raw number is not Paise. This line is the
    // compile-time half of the Phase 2 gate: `tsc --noEmit` fails the build if
    // the assignment stops being an error, which would mean the brand had been
    // weakened. It is checked by the typechecker, not by the assertion below.
    takesPaise(500);

    expect(typeof takesPaise).toBe('function');
  });

  it('accepts a constructed Paise', () => {
    const takesPaise = (amount: Paise): Paise => amount;
    expect(takesPaise(paise(500))).toBe(500);
  });
});

describe('paise()', () => {
  it.each([0, 1, 500, 480000, MAX_PAISE])('accepts %i', (value) => {
    expect(paise(value)).toBe(value);
  });

  it('rejects a non-integer', () => {
    expect(() => paise(4800.5)).toThrow(MoneyError);
    expect(() => paise(4800.5)).toThrow(/integer number of paise/);
  });

  it('points a non-integer caller at the conversion helper', () => {
    // The error has to teach, because the mistake it catches - handing over
    // rupees where paise were wanted - is the exact confusion corpus family A3
    // tests agents for.
    expect(() => paise(48.75)).toThrow(/rupeesToPaise/);
  });

  it('rejects a negative amount, and says why a refund is not one', () => {
    expect(() => paise(-1)).toThrow(/non-negative/);
    expect(() => paise(-1)).toThrow(/kind 'refund'/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %s', (value) => {
    expect(() => paise(value)).toThrow(MoneyError);
  });

  it('rejects a value beyond the safe integer range', () => {
    // Above 2^53 a value cannot survive a JSON round-trip, so a ledger digest
    // would silently stop matching the data it was computed from.
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer range/);
  });
});

describe('isPaise()', () => {
  it.each([0, 1, 480000])('accepts %i', (v) => expect(isPaise(v)).toBe(true));
  it.each([-1, 1.5, NaN, Infinity, '500', null, undefined, {}])(
    'rejects %s',
    (v) => expect(isPaise(v)).toBe(false),
  );
});

describe('rupeesToPaise()', () => {
  it('converts whole rupees', () => {
    expect(rupeesToPaise(4800)).toBe(480000);
  });

  it('converts two decimal places without floating-point drift', () => {
    // 4800.10 * 100 is 480010.00000000006 in binary floating point.
    expect(rupeesToPaise(4800.1)).toBe(480010);
    expect(rupeesToPaise(0.07)).toBe(7);
  });

  it('rejects more than two decimal places rather than rounding', () => {
    // Rounding here would hide a precision or unit bug in whatever produced
    // the number, which is the class of error this project exists to surface.
    expect(() => rupeesToPaise(48.005)).toThrow(/two decimal places/);
  });

  it('rejects non-finite input', () => {
    expect(() => rupeesToPaise(NaN)).toThrow(MoneyError);
  });
});

describe('parseRupees()', () => {
  it.each([
    ['4800', 480000],
    ['4,800', 480000],
    ['4800.50', 480050],
    ['4,800.05', 480005],
    ['₹4,800.00', 480000],
    ['  4800.5  ', 480050],
    ['0', 0],
    ['0.01', 1],
  ])('parses %s to %i paise', (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it('never routes a value through a float', () => {
    // The string path exists so fixture and scenario amounts reach the ledger
    // without touching floating point at all.
    expect(parseRupees('99999999.99')).toBe(9999999999);
  });

  it.each(['', 'abc', '4800.123', '-50', '4.8e3', '4800.'])(
    'rejects %s',
    (input) => {
      expect(() => parseRupees(input)).toThrow(MoneyError);
    },
  );
});

describe('arithmetic', () => {
  it('adds within the brand', () => {
    expect(addPaise(paise(100), paise(250))).toBe(350);
  });

  it('subtracts within the brand', () => {
    expect(subPaise(paise(500), paise(200))).toBe(300);
  });

  it('refuses a subtraction that would go negative', () => {
    expect(() => subPaise(paise(100), paise(200))).toThrow(/negative amount/);
  });

  it('sums, with empty summing to zero', () => {
    // Matches `sum()` over an empty collection in the invariant DSL. The two
    // must agree or a scenario reads differently from the code behind it.
    expect(sumPaise([])).toBe(ZERO_PAISE);
    expect(sumPaise([paise(1), paise(2), paise(3)])).toBe(6);
  });

  it('refuses a sum that leaves the safe integer range', () => {
    expect(() => sumPaise([MAX_PAISE, paise(1)])).toThrow(/safe integer range/);
  });
});

describe('formatPaise()', () => {
  it.each([
    [0, '₹0.00'],
    [7, '₹0.07'],
    [100, '₹1.00'],
    [480050, '₹4,800.50'],
    [100000000, '₹10,00,000.00'],
    [123456789, '₹12,34,567.89'],
  ])('formats %i paise as %s', (amount, expected) => {
    expect(formatPaise(paise(amount))).toBe(expected);
  });

  it('groups in the Indian convention without Intl', () => {
    // Intl output depends on the ICU data compiled into the running Node
    // build. A report whose numbers render differently on two machines would
    // undercut the reproducibility claim for no benefit.
    expect(formatPaise(paise(1234567890))).toBe('₹1,23,45,678.90');
  });
});
