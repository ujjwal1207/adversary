/**
 * The test-mode guard.
 *
 * Hard constraint 1 of docs/THREAT-MODEL.md: the live rail must refuse to
 * initialise on a production key, and this must be impossible to misconfigure
 * rather than merely discouraged.
 *
 * Three properties make that true rather than aspirational:
 *
 *   **It throws at construction.** Not at first use. A misconfigured rail
 *   cannot exist as an object, so there is no window in which one is sitting in
 *   a variable waiting to be called.
 *
 *   **It fails closed.** A key matching no known test pattern is refused, not
 *   assumed safe. The failure mode of the opposite choice is moving real money,
 *   and "we did not recognise the format" is not a reason to try.
 *
 *   **There is no bypass.** No flag, no environment variable, no options field.
 *   Adding one would be the single most dangerous line of code in this project.
 */

/** Key shapes that unambiguously denote a provider's test mode. */
export const TEST_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^rzp_test_[A-Za-z0-9]{8,}$/,
  /^sk_test_[A-Za-z0-9]{8,}$/,
  /^pk_test_[A-Za-z0-9]{8,}$/,
  /^test_[A-Za-z0-9]{8,}$/,
]);

/**
 * Shapes that unambiguously denote production.
 *
 * Redundant - anything not matching a test pattern is already refused - but
 * worth having so the error can say *why* rather than "unrecognised", and so a
 * live key is refused even if someone later loosens the test patterns.
 */
export const LIVE_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^rzp_live_/,
  /^sk_live_/,
  /^pk_live_/,
  /^live_/,
  /^prod_/,
]);

export class ProductionKeyError extends Error {
  override readonly name = 'ProductionKeyError';
}

/** Redacts a key for an error message. Never print one in full. */
export function redactKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 12)}...${key.slice(-2)}`;
}

/**
 * Throws unless the key is recognisably a test-mode key.
 *
 * Called from `LiveTestRail`'s constructor. There is no variant that returns a
 * boolean, because a caller holding a boolean is a caller who can ignore it.
 */
export function assertTestKey(key: string, label = 'API key'): void {
  const trimmed = key.trim();

  if (trimmed.length === 0) {
    throw new ProductionKeyError(
      `The live-test rail needs a ${label}, and none was supplied.`,
    );
  }

  if (LIVE_KEY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new ProductionKeyError(
      `Refusing to initialise the live rail with what looks like a PRODUCTION ` +
        `${label} (${redactKey(trimmed)}). Adversary runs adversarial ` +
        'scenarios against a payment agent; it moves money on purpose. It must ' +
        "only ever be pointed at a provider's test mode. See " +
        'docs/THREAT-MODEL.md.',
    );
  }

  if (!TEST_KEY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    // Fails closed. The cost of being wrong in the other direction is moving
    // real money, and an unrecognised format is not evidence of safety.
    throw new ProductionKeyError(
      `Refusing to initialise the live rail with an unrecognised ${label} ` +
        `format (${redactKey(trimmed)}). Expected a test-mode key such as ` +
        `rzp_test_... or sk_test_.... If your provider uses a different test ` +
        'prefix, add it to TEST_KEY_PATTERNS deliberately - the guard fails ' +
        'closed so that an unknown format is never assumed safe.',
    );
  }
}

/** Whether a key is test-mode, for callers that must branch rather than throw. */
export function isTestKey(key: string): boolean {
  try {
    assertTestKey(key);
    return true;
  } catch {
    return false;
  }
}
