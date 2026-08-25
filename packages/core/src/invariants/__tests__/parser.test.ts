/**
 * Lexing and parsing.
 *
 * Precedence is asserted through `unparse`, which re-renders the tree fully
 * parenthesised. That makes the assertion say what shape the parser built,
 * rather than what it evaluated to - two different claims, and only the first
 * one belongs here.
 */

import { describe, expect, it } from 'vitest';

import { unparse } from '../ast.js';
import { LexError, tokenize } from '../lexer.js';
import { ParseError, parse } from '../parser.js';

const shape = (source: string): string => unparse(parse(source));

describe('lexer', () => {
  it('tokenises a full expression', () => {
    const kinds = tokenize('sum(actions.amountPaise) <= policy.sessionCapPaise').map(
      (t) => `${t.type}:${t.value}`,
    );

    expect(kinds).toEqual([
      'ident:sum',
      'punct:(',
      'ident:actions',
      'punct:.',
      'ident:amountPaise',
      'punct:)',
      'operator:<=',
      'ident:policy',
      'punct:.',
      'ident:sessionCapPaise',
      'eof:',
    ]);
  });

  it('reads two-character operators before one-character ones', () => {
    // `<=` must never lex as `<` then `=`, or `a <= b` would parse as a
    // comparison against an assignment and mean something else entirely.
    expect(tokenize('a <= b')[1]).toMatchObject({ type: 'operator', value: '<=' });
    expect(tokenize('a != b')[1]).toMatchObject({ type: 'operator', value: '!=' });
    expect(tokenize('a == b')[1]).toMatchObject({ type: 'operator', value: '==' });
    expect(tokenize('a < b')[1]).toMatchObject({ type: 'operator', value: '<' });
  });

  it('distinguishes keywords, booleans and identifiers', () => {
    expect(tokenize('and')[0]?.type).toBe('keyword');
    expect(tokenize('in')[0]?.type).toBe('keyword');
    expect(tokenize('true')[0]?.type).toBe('boolean');
    expect(tokenize('actions')[0]?.type).toBe('ident');
    // `android` starts with `and` but is not a keyword.
    expect(tokenize('android')[0]?.type).toBe('ident');
  });

  it('reads quoted strings, with escapes', () => {
    expect(tokenize('"acct_x"')[0]).toMatchObject({ type: 'string', value: 'acct_x' });
    expect(tokenize("'acct_x'")[0]).toMatchObject({ type: 'string', value: 'acct_x' });
    expect(tokenize('"a\\"b"')[0]?.value).toBe('a"b');
  });

  it('rejects a decimal number, and says why', () => {
    // A decimal here almost always means someone wrote an amount in rupees.
    expect(() => tokenize('sum(x) <= 5000.50')).toThrow(LexError);
    expect(() => tokenize('sum(x) <= 5000.50')).toThrow(/integer paise/);
  });

  it('rejects an unterminated string', () => {
    expect(() => tokenize('"unclosed')).toThrow(/Unterminated string/);
  });

  it('rejects a character with no meaning in the grammar', () => {
    expect(() => tokenize('a + b')).toThrow(/Unexpected character/);
  });
});

describe('precedence', () => {
  it('binds `and` tighter than `or`', () => {
    expect(shape('count(actions) == 0 or count(actions) == 1 and count(actions) == 2')).toBe(
      '((count(actions) == 0) or ((count(actions) == 1) and (count(actions) == 2)))',
    );
  });

  it('binds `not` tighter than `and`', () => {
    expect(shape('not count(actions) == 0 and count(actions) == 1')).toBe(
      '((not (count(actions) == 0)) and (count(actions) == 1))',
    );
  });

  it('binds comparison tighter than `not`', () => {
    expect(shape('not count(actions) == 0')).toBe('(not (count(actions) == 0))');
  });

  it('is left-associative for `or`', () => {
    expect(
      shape('count(actions) == 1 or count(actions) == 2 or count(actions) == 3'),
    ).toBe(
      '(((count(actions) == 1) or (count(actions) == 2)) or (count(actions) == 3))',
    );
  });

  it('lets parentheses override precedence', () => {
    expect(shape('(count(actions) == 0 or count(actions) == 1)')).toBe(
      '((count(actions) == 0) or (count(actions) == 1))',
    );
  });
});

describe('paths', () => {
  it('parses a filtered projection', () => {
    expect(shape('actions[kind=transfer].payeeRef')).toBe(
      'actions[kind=transfer].payeeRef',
    );
  });

  it('parses nested field access', () => {
    expect(shape('actions[kind=subscription_charge].params.subId')).toBe(
      'actions[kind=subscription_charge].params.subId',
    );
  });

  it('treats a bare word in a filter as a string', () => {
    // So `[kind=transfer]` reads the way a scenario author writes it, without
    // quotes around every enum member.
    const node = parse('actions[kind=transfer]');
    expect(node).toMatchObject({
      type: 'path',
      steps: [{ kind: 'filter', key: 'kind', value: 'transfer' }],
    });
  });

  it('rejects a root that is not in scope', () => {
    expect(() => parse('ledger.amountPaise')).toThrow(/Unknown root/);
    expect(() => parse('ledger.amountPaise')).toThrow(/actions, policy, untrusted/);
  });
});

describe('parse errors point at the problem', () => {
  it('rejects an empty expression', () => {
    expect(() => parse('')).toThrow(/must assert something/);
  });

  it('rejects an unknown function', () => {
    expect(() => parse('median(actions.amountPaise)')).toThrow(/Unknown function/);
    expect(() => parse('median(actions.amountPaise)')).toThrow(
      /sum, count, all, any, unique/,
    );
  });

  it('rejects a call with no argument', () => {
    expect(() => parse('count()')).toThrow(/needs an argument/);
  });

  it('rejects an unclosed parenthesis', () => {
    expect(() => parse('count(actions')).toThrow(ParseError);
  });

  it('rejects trailing junk', () => {
    expect(() => parse('count(actions) 5')).toThrow(/Unexpected '5'/);
  });

  it('rejects a chained comparison rather than guessing', () => {
    // `a < b < c` reads as (a<b)<c in most languages, which is never what a
    // scenario author means.
    expect(() => parse('count(actions) < 5 < 9')).toThrow(/Chained comparison/);
  });

  it('explains a single `=` used as a comparison', () => {
    expect(() => parse('count(actions) = 5')).toThrow(/Use `==` to compare/);
  });

  it('includes a caret pointing at the offending position', () => {
    try {
      parse('count(actions) 5');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('^');
    }
  });
});
