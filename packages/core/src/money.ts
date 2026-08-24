/**
 * Money.
 *
 * One rule, applied without exception: amounts are integer minor units, and
 * they carry a brand so the compiler can tell an amount from an arbitrary
 * number. There are no floats in this module's output and no float arithmetic
 * on any path that produces a `Paise`.
 *
 * The reason is narrower than "floats are bad at money". Currency-unit
 * confusion - reading 4,800 as paise when it meant rupees - is corpus family
 * A3, a thing Adversary tests agents for. If the harness could make the same
 * mistake, a scenario would be measuring the harness. So conversion is
 * explicit, one-way, and validated.
 */

import type { Paise } from './contracts.js';

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export const ZERO_PAISE = 0 as Paise;

/**
 * The largest amount this system will represent: 2^53 - 1 paise, about
 * 90 trillion rupees. Anything above it cannot survive JSON round-tripping
 * through `Number`, so it is rejected at the boundary rather than silently
 * losing precision in a ledger digest.
 */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER as Paise;

/**
 * Constructs a `Paise` from a number, or throws.
 *
 * The brand already stops a bare `number` at compile time. This is the runtime
 * half: values arriving from YAML, JSON, a tool call or a provider response
 * were never type-checked, and this is where they are made to earn the brand.
 */
export function paise(value: number): Paise {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new MoneyError(`Amount must be a number, got ${describe(value)}.`);
  }
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Amount must be finite, got ${String(value)}.`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be an integer number of paise, got ${value}. ` +
        'If this is rupees, convert with rupeesToPaise().',
    );
  }
  if (value < 0) {
    throw new MoneyError(
      `Amount must be non-negative, got ${value}. A refund is a positive ` +
        "amount with kind 'refund', not a negative transfer.",
    );
  }
  if (value > MAX_PAISE) {
    throw new MoneyError(`Amount exceeds the safe integer range: ${value}.`);
  }
  return value as Paise;
}

/** Runtime predicate. Used at trust boundaries and in tests. */
export function isPaise(value: unknown): value is Paise {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/**
 * Converts rupees to paise.
 *
 * Rejects anything with more than two decimal places rather than rounding it.
 * A third decimal place in a money amount means the caller has a unit or a
 * precision bug, and quietly rounding it away would hide exactly the class of
 * error this project exists to surface.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new MoneyError(`Rupee amount must be a finite number, got ${describe(rupees)}.`);
  }

  const scaled = Math.round(rupees * 100);
  // 4800.10 * 100 is 480010.00000000006 in binary floating point, so the
  // comparison needs a tolerance. 1e-6 of a paise is far below any real
  // rounding error and far above float noise at these magnitudes.
  if (Math.abs(rupees * 100 - scaled) > 1e-6) {
    throw new MoneyError(
      `Rupee amount ${rupees} has more than two decimal places. ` +
        'Money in this system is exact; state the amount in paise instead.',
    );
  }

  return paise(scaled);
}

/**
 * Parses a decimal string into paise without any floating-point arithmetic.
 *
 * This is the right primitive for fixture and scenario data: "4,800.50" from a
 * YAML file becomes 480050 by string manipulation, so no value ever passes
 * through a float on its way into the ledger.
 */
export function parseRupees(input: string): Paise {
  const cleaned = input.trim().replace(/[\s,₹]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);

  if (!match) {
    throw new MoneyError(
      `Cannot parse "${input}" as a rupee amount. Expected digits with at ` +
        'most two decimal places, optionally grouped with commas.',
    );
  }

  const whole = match[1] as string;
  const fraction = (match[2] ?? '').padEnd(2, '0');

  return paise(Number(whole) * 100 + Number(fraction));
}

/** Addition that stays inside the brand and inside the safe range. */
export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

/**
 * Subtraction. Throws if the result would be negative, because a negative
 * amount is not representable and silently clamping one would corrupt a total.
 */
export function subPaise(a: Paise, b: Paise): Paise {
  if (b > a) {
    throw new MoneyError(
      `Subtracting ${b} from ${a} would produce a negative amount.`,
    );
  }
  return paise(a - b);
}

/** Sum. Empty is zero - the additive identity, matching `sum()` in the DSL. */
export function sumPaise(amounts: Iterable<Paise>): Paise {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (total > MAX_PAISE) {
      throw new MoneyError('Sum exceeds the safe integer range.');
    }
  }
  return paise(total);
}

/**
 * Formats for display only. Never parse this back.
 *
 * Grouping is hand-rolled in the Indian convention (last three digits, then
 * pairs) rather than delegated to `Intl.NumberFormat`. Intl output depends on
 * the ICU data compiled into the running Node build, and a report whose numbers
 * render differently on two machines undermines the reproducibility claim for
 * no benefit.
 */
export function formatPaise(amount: Paise): string {
  const whole = Math.floor(amount / 100);
  const fraction = String(amount % 100).padStart(2, '0');
  return `₹${groupIndian(whole)}.${fraction}`;
}

function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;

  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${last3}`;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `string "${value}"`;
  if (value === null) return 'null';
  return `${typeof value} ${String(value)}`;
}
