/**
 * Recursive-descent parser.
 *
 * One function per precedence level, loosest first, exactly matching the
 * grammar in docs/ARCHITECTURE.md 11.1:
 *
 *   expr       = or_expr
 *   or_expr    = and_expr { "or" and_expr }
 *   and_expr   = not_expr { "and" not_expr }
 *   not_expr   = [ "not" ] comparison
 *   comparison = primary [ ("<=" | "<" | ">=" | ">" | "==" | "!=" | "in") primary ]
 *   primary    = literal | call | path | "(" expr ")"
 *   path       = ident { "." ident | filter }
 *   filter     = "[" ident "=" ( ident | literal ) "]"
 *
 * Comparison is deliberately non-associative: `a < b < c` is a parse error
 * rather than something with a surprising meaning. Nothing in the corpus needs
 * chained comparison, and the reading a chain would get in most languages is
 * not the one a scenario author would expect.
 */

import type {
  BinaryOp,
  FnName,
  LiteralValue,
  Node,
  PathStep,
  RootName,
} from './ast.js';
import { FN_NAMES, ROOT_NAMES } from './ast.js';
import type { Token } from './lexer.js';
import { pointAt, tokenize } from './lexer.js';

export class ParseError extends Error {
  override readonly name = 'ParseError';
  constructor(
    message: string,
    readonly pos: number,
    readonly source: string,
  ) {
    super(`${message}\n${pointAt(source, pos)}`);
  }
}

const COMPARISON_OPS = new Set(['<=', '<', '>=', '>', '==', '!=']);

export function parse(source: string): Node {
  return new Parser(source).parseComplete();
}

class Parser {
  readonly #tokens: Token[];
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
    this.#tokens = tokenize(source);
  }

  parseComplete(): Node {
    if (this.#peek().type === 'eof') {
      this.#fail('Empty expression. An invariant must assert something.', 0);
    }
    const node = this.#parseOr();
    const trailing = this.#peek();
    if (trailing.type !== 'eof') {
      this.#fail(`Unexpected ${describe(trailing)} after the expression.`, trailing.pos);
    }
    return node;
  }

  // --- precedence levels, loosest first ------------------------------------

  #parseOr(): Node {
    let left = this.#parseAnd();
    while (this.#matchKeyword('or')) {
      const pos = this.#previous().pos;
      left = { type: 'binary', op: 'or', left, right: this.#parseAnd(), pos };
    }
    return left;
  }

  #parseAnd(): Node {
    let left = this.#parseNot();
    while (this.#matchKeyword('and')) {
      const pos = this.#previous().pos;
      left = { type: 'binary', op: 'and', left, right: this.#parseNot(), pos };
    }
    return left;
  }

  #parseNot(): Node {
    if (this.#matchKeyword('not')) {
      const pos = this.#previous().pos;
      return { type: 'not', operand: this.#parseNot(), pos };
    }
    return this.#parseComparison();
  }

  #parseComparison(): Node {
    const left = this.#parsePrimary();
    const token = this.#peek();

    const isComparison =
      (token.type === 'operator' && COMPARISON_OPS.has(token.value)) ||
      (token.type === 'keyword' && token.value === 'in');

    if (!isComparison) {
      if (token.type === 'operator' && token.value === '=') {
        this.#fail(
          'Single `=` is assignment-shaped and means nothing here. Use `==` ' +
            'to compare, or `[key=value]` to filter.',
          token.pos,
        );
      }
      return left;
    }

    this.#advance();
    const right = this.#parsePrimary();
    const node: Node = {
      type: 'binary',
      op: token.value as BinaryOp,
      left,
      right,
      pos: token.pos,
    };

    const next = this.#peek();
    if (
      (next.type === 'operator' && COMPARISON_OPS.has(next.value)) ||
      (next.type === 'keyword' && next.value === 'in')
    ) {
      this.#fail(
        `Chained comparison. \`a ${token.value} b ${next.value} c\` has no ` +
          'meaning here; write it as two comparisons joined with `and`.',
        next.pos,
      );
    }

    return node;
  }

  #parsePrimary(): Node {
    const token = this.#peek();

    if (token.type === 'punct' && token.value === '(') {
      this.#advance();
      const inner = this.#parseOr();
      this.#expectPunct(')');
      return inner;
    }

    if (token.type === 'number') {
      this.#advance();
      return { type: 'literal', value: Number(token.value), pos: token.pos };
    }

    if (token.type === 'string') {
      this.#advance();
      return { type: 'literal', value: token.value, pos: token.pos };
    }

    if (token.type === 'boolean') {
      this.#advance();
      return { type: 'literal', value: token.value === 'true', pos: token.pos };
    }

    if (token.type === 'ident') {
      // A call is an identifier followed immediately by `(`.
      const next = this.#tokens[this.#index + 1];
      if (next?.type === 'punct' && next.value === '(') {
        return this.#parseCall();
      }
      return this.#parsePath();
    }

    this.#fail(`Expected a value, got ${describe(token)}.`, token.pos);
  }

  #parseCall(): Node {
    const name = this.#advance();
    if (!isFnName(name.value)) {
      this.#fail(
        `Unknown function \`${name.value}\`. Available: ${FN_NAMES.join(', ')}.`,
        name.pos,
      );
    }
    this.#expectPunct('(');
    if (this.#peek().type === 'punct' && this.#peek().value === ')') {
      this.#fail(`\`${name.value}()\` needs an argument.`, this.#peek().pos);
    }
    const arg = this.#parseOr();
    this.#expectPunct(')');
    return { type: 'call', fn: name.value, arg, pos: name.pos };
  }

  #parsePath(): Node {
    const root = this.#advance();
    if (!isRootName(root.value)) {
      this.#fail(
        `Unknown root \`${root.value}\`. An expression may name ` +
          `${ROOT_NAMES.join(', ')} and nothing else.`,
        root.pos,
      );
    }

    const steps: PathStep[] = [];

    for (;;) {
      const token = this.#peek();

      if (token.type === 'punct' && token.value === '.') {
        this.#advance();
        const field = this.#peek();
        if (field.type !== 'ident') {
          this.#fail(`Expected a field name after '.', got ${describe(field)}.`, field.pos);
        }
        this.#advance();
        steps.push({ kind: 'field', name: field.value, pos: field.pos });
        continue;
      }

      if (token.type === 'punct' && token.value === '[') {
        this.#advance();
        const key = this.#peek();
        if (key.type !== 'ident') {
          this.#fail(`Expected a field name in the filter, got ${describe(key)}.`, key.pos);
        }
        this.#advance();

        const eq = this.#peek();
        if (eq.type !== 'operator' || (eq.value !== '=' && eq.value !== '==')) {
          this.#fail(`Expected '=' in the filter, got ${describe(eq)}.`, eq.pos);
        }
        this.#advance();

        const value = this.#parseFilterValue();
        this.#expectPunct(']');
        steps.push({ kind: 'filter', key: key.value, value, pos: token.pos });
        continue;
      }

      break;
    }

    return { type: 'path', root: root.value, steps, pos: root.pos };
  }

  /**
   * A bare word inside a filter is a string, so `[kind=transfer]` reads the way
   * a scenario author expects rather than needing quotes around every enum
   * member.
   */
  #parseFilterValue(): LiteralValue {
    const token = this.#peek();

    switch (token.type) {
      case 'ident':
        this.#advance();
        return token.value;
      case 'string':
        this.#advance();
        return token.value;
      case 'number':
        this.#advance();
        return Number(token.value);
      case 'boolean':
        this.#advance();
        return token.value === 'true';
      default:
        this.#fail(`Expected a filter value, got ${describe(token)}.`, token.pos);
    }
  }

  // --- token helpers --------------------------------------------------------

  #peek(): Token {
    return this.#tokens[this.#index] as Token;
  }

  #previous(): Token {
    return this.#tokens[this.#index - 1] as Token;
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.type !== 'eof') this.#index += 1;
    return token;
  }

  #matchKeyword(word: string): boolean {
    const token = this.#peek();
    if (token.type === 'keyword' && token.value === word) {
      this.#advance();
      return true;
    }
    return false;
  }

  #expectPunct(value: string): void {
    const token = this.#peek();
    if (token.type !== 'punct' || token.value !== value) {
      this.#fail(`Expected '${value}', got ${describe(token)}.`, token.pos);
    }
    this.#advance();
  }

  #fail(message: string, pos: number): never {
    throw new ParseError(message, pos, this.#source);
  }
}

function describe(token: Token): string {
  return token.type === 'eof' ? 'end of expression' : `'${token.value}'`;
}

function isFnName(value: string): value is FnName {
  return (FN_NAMES as readonly string[]).includes(value);
}

function isRootName(value: string): value is RootName {
  return (ROOT_NAMES as readonly string[]).includes(value);
}
