/**
 * The lexer.
 *
 * Hand-rolled, like the parser and evaluator that follow. The reason is not
 * craftsmanship for its own sake: this is the component every reported number
 * depends on, and it has to be small enough for one person to fully understand
 * and fully test. A general-purpose expression library would be larger, would
 * have semantics nobody on this project chose, and would put the correctness of
 * the headline metric behind someone else's changelog
 * (docs/ARCHITECTURE.md 6.3).
 *
 * It is also not `eval()`, and not a language model. The thing under test is a
 * model's judgment about money; a model judging it would fail in the same way,
 * at the same time, silently.
 */

export type TokenType =
  | 'ident'
  | 'number'
  | 'string'
  | 'boolean'
  | 'keyword' // and or not in
  | 'operator' // <= < >= > == != =
  | 'punct' // ( ) [ ] .
  | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** 0-based offset into the source, for error messages that point at things. */
  readonly pos: number;
}

export class LexError extends Error {
  override readonly name = 'LexError';
  constructor(
    message: string,
    readonly pos: number,
    readonly source: string,
  ) {
    super(message);
  }
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in']);
const BOOLEANS = new Set(['true', 'false']);

/**
 * Two-character operators come first, so `<=` is never read as `<` followed by
 * `=`. Order in this array is significant.
 */
const OPERATORS = ['<=', '>=', '==', '!=', '<', '>', '='] as const;

const PUNCT = new Set(['(', ')', '[', ']', '.']);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const fail = (message: string, at: number): never => {
    throw new LexError(message, at, source);
  };

  while (i < source.length) {
    const char = source[i] as string;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (PUNCT.has(char)) {
      tokens.push({ type: 'punct', value: char, pos: i });
      i += 1;
      continue;
    }

    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator !== undefined) {
      tokens.push({ type: 'operator', value: operator, pos: i });
      i += operator.length;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i] as string)) i += 1;

      // A decimal point here almost always means someone wrote an amount in
      // rupees. Money in this system is integer paise, so this is a mistake
      // worth naming rather than a value worth accepting.
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        fail(
          'Decimal numbers are not allowed. Amounts are integer paise, and ' +
            'every other number in this grammar is a count or a duration.',
          start,
        );
      }

      tokens.push({ type: 'number', value: source.slice(start, i), pos: start });
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const start = i;
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          const escaped = source[i + 1];
          if (escaped === undefined) fail('Unterminated escape sequence.', i);
          value += escaped;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      if (i >= source.length) fail(`Unterminated string literal.`, start);
      i += 1; // closing quote
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) i += 1;
      const word = source.slice(start, i);

      const type: TokenType = BOOLEANS.has(word)
        ? 'boolean'
        : KEYWORDS.has(word)
          ? 'keyword'
          : 'ident';

      tokens.push({ type, value: word, pos: start });
      continue;
    }

    fail(`Unexpected character ${JSON.stringify(char)}.`, i);
  }

  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}

/**
 * Renders a caret under the offending position.
 *
 * A scenario author who mistypes an invariant gets told where, because the
 * alternative - a silently unevaluable expression - would produce a verdict of
 * `error`, and a corpus full of those would report perfect safety.
 */
export function pointAt(source: string, pos: number): string {
  const clamped = Math.max(0, Math.min(pos, source.length));
  return `${source}\n${' '.repeat(clamped)}^`;
}
