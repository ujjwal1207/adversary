/**
 * Canonical serialization and hashing.
 *
 * Everything reproducible in this system bottoms out here. A scenario content
 * hash, a ledger digest and a verdict digest are all "canonicalise, then
 * SHA-256", and if canonicalisation is not deterministic then neither is
 * anything built on it (docs/ARCHITECTURE.md 9.5).
 *
 * `node:crypto` is computation, not I/O, so importing it does not breach the
 * purity rule for this package.
 */

import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

/** A value that can be canonicalised. Deliberately narrower than `unknown`. */
export type Canonical =
  | null
  | boolean
  | number
  | string
  | readonly Canonical[]
  | { readonly [key: string]: Canonical | undefined };

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace,
 * `undefined` properties omitted.
 *
 * Object key order in JavaScript is insertion order, which means two runs that
 * built the same record in a different order would serialise differently and
 * hash differently. Sorting removes that as a source of false drift.
 *
 * Non-finite numbers throw rather than serialising. `JSON.stringify` turns NaN
 * and Infinity into `null`, which would silently equate a broken amount with a
 * missing one - exactly the kind of quiet coercion this project exists to
 * catch elsewhere.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new WeakSet(), '$');
}

function write(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `Cannot canonicalise non-finite number at ${path}: ${String(value)}`,
        );
      }
      // -0 and 0 are the same amount of money and must hash the same.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);

    case 'string':
      return JSON.stringify(value);

    case 'undefined':
      throw new CanonicalizationError(
        `Cannot canonicalise undefined at ${path}. Omit the key instead.`,
      );

    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(
        `Cannot canonicalise ${typeof value} at ${path}.`,
      );

    case 'object':
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new CanonicalizationError(`Circular reference at ${path}.`);
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      const parts = object.map((item, i) =>
        item === undefined ? 'null' : write(item, seen, `${path}[${i}]`),
      );
      return `[${parts.join(',')}]`;
    }

    if (object instanceof Date || object instanceof Map || object instanceof Set) {
      throw new CanonicalizationError(
        `Cannot canonicalise ${object.constructor.name} at ${path}. ` +
          'Convert to a plain value first, so the encoding is explicit.',
      );
    }

    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const parts = entries.map(
      ([key, v]) => `${JSON.stringify(key)}:${write(v, seen, `${path}.${key}`)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonicalise, then hash. The two always travel together. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Normalises text before it is hashed.
 *
 * `.gitattributes` sets `eol=lf` so a checkout is LF everywhere, but content
 * can reach the harness by other routes - a scenario piped in, a fixture
 * generated on Windows. A payload written as a YAML block scalar carries its
 * line endings into the hashed text, so a stray CRLF would otherwise make the
 * same scenario hash differently on two machines and no scorecard would
 * reproduce across them.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
