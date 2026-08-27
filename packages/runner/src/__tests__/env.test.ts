/**
 * The `.env` loader.
 *
 * Small enough to look correct and quirky enough not to be. The two properties
 * worth pinning are the ones a user would only discover by being confused: a
 * real environment variable is never overwritten, and nothing in the file is
 * interpolated.
 *
 * The first matters because CI sets secrets as environment variables and a
 * stray `.env` in a working copy must not silently replace one. The second
 * because a file that can reference other variables has a meaning that depends
 * on load order, and this one holds API keys.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadEnvFile, parseEnv } from '../env.js';

const dirs: string[] = [];

function withFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adversary-env-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), contents, 'utf8');
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('parseEnv', () => {
  it('reads plain assignments', () => {
    expect(parseEnv('GEMINI_API_KEY=abc123')).toEqual(new Map([['GEMINI_API_KEY', 'abc123']]));
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseEnv(['# a comment', '', '   ', 'A=1', '   # indented comment'].join('\n'));
    expect([...parsed.keys()]).toEqual(['A']);
  });

  it('accepts the `export FOO=bar` people paste out of a shell', () => {
    expect(parseEnv('export OPENAI_API_KEY=sk-test-x')).toEqual(
      new Map([['OPENAI_API_KEY', 'sk-test-x']]),
    );
  });

  it('strips matching quotes', () => {
    const parsed = parseEnv(['A="one two"', "B='three'"].join('\n'));
    expect(parsed.get('A')).toBe('one two');
    expect(parsed.get('B')).toBe('three');
  });

  it('keeps a # that is part of a quoted value', () => {
    // Real keys contain punctuation. Trimming a "comment" out of the middle of
    // a credential produces an authentication failure whose cause is invisible.
    expect(parseEnv('KEY="abc#def"').get('KEY')).toBe('abc#def');
  });

  it('drops a trailing comment on an unquoted value', () => {
    expect(parseEnv('A=1 # how many').get('A')).toBe('1');
  });

  it('does not interpolate', () => {
    // No ${OTHER} expansion, deliberately: it would make the file's meaning
    // depend on the order its lines are read.
    const parsed = parseEnv(['A=1', 'B=${A}/two'].join('\n'));
    expect(parsed.get('B')).toBe('${A}/two');
  });

  it('skips lines that are not assignments', () => {
    const parsed = parseEnv(['no equals here', '=novalue', '1BAD=x', 'GOOD=y'].join('\n'));
    expect([...parsed.keys()]).toEqual(['GOOD']);
  });

  it('keeps an equals sign inside a value', () => {
    expect(parseEnv('ADVERSARY_PG_URL=postgres://u:p@h:5432/db?a=b').get('ADVERSARY_PG_URL')).toBe(
      'postgres://u:p@h:5432/db?a=b',
    );
  });
});

describe('loadEnvFile', () => {
  it('does nothing when there is no file', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(mkdtempSync(join(tmpdir(), 'adversary-empty-')), env);

    expect(result.path).toBeNull();
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
  });

  it('applies what the file sets', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(withFile('GEMINI_API_KEY=abc\nADVERSARY_MODEL=gemini-2.5-flash'), env);

    expect([...result.applied].sort()).toEqual(['ADVERSARY_MODEL', 'GEMINI_API_KEY']);
    expect(env['GEMINI_API_KEY']).toBe('abc');
  });

  it('never overwrites a variable the environment already set', () => {
    // The rule that matters. CI supplies secrets as environment variables; a
    // `.env` left in a working copy must not quietly replace one, and "what was
    // actually set" needs a single answer rather than two competing ones.
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'from-the-shell' };
    const result = loadEnvFile(withFile('GEMINI_API_KEY=from-the-file'), env);

    expect(env['GEMINI_API_KEY']).toBe('from-the-shell');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['GEMINI_API_KEY']);
  });

  it('reports names, never values', () => {
    // The result is printed by the CLI. A loader that returned values would put
    // a credential one console.log away from a terminal transcript.
    const result = loadEnvFile(withFile('GEMINI_API_KEY=super-secret'), {});
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});
