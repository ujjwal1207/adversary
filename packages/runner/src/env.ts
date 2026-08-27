/**
 * Reading a `.env` file, without a dependency and without surprises.
 *
 * Node has `--env-file`, but it throws when the file is absent on the versions
 * this project supports, and the whole point of the default path is that it
 * works with no credentials at all. So: read it if it is there, ignore it if it
 * is not.
 *
 * Two rules the parser will not bend on.
 *
 * **A real environment variable always wins.** A value already set in the
 * process is never overwritten by the file. CI sets secrets as environment
 * variables and a stray `.env` in a working copy must not quietly replace one -
 * and when a run misbehaves, "what was actually set" should have one answer,
 * not two competing ones.
 *
 * **Nothing is interpolated.** No `${OTHER}` expansion, no command
 * substitution, no escape sequences beyond quote stripping. A file that can
 * reference other variables is a file whose meaning depends on load order, and
 * this one holds API keys.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LoadEnvResult {
  /** Absolute path read, or null when no file was found. */
  readonly path: string | null;
  /** Names set from the file. Never the values - these are credentials. */
  readonly applied: readonly string[];
  /** Names present in the file but already set in the environment. */
  readonly skipped: readonly string[];
}

/**
 * Parses `.env` text into key/value pairs.
 *
 * Exported for the tests, which is the only way to check the parsing without a
 * file system.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `export FOO=bar` is what people paste out of a shell history.
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    // Quotes are stripped, and only then is an unquoted trailing comment
    // removed - so a `#` inside a quoted value survives, which matters because
    // it appears in real keys.
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'");
    if (quoted && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out.set(key, value);
  }

  return out;
}

/**
 * Loads `.env` from `cwd` into `env`, without overwriting anything already set.
 *
 * Returns what it did rather than logging, so a caller can say so in whatever
 * form suits it - and so a test can assert on it.
 */
export function loadEnvFile(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  fileName = '.env',
): LoadEnvResult {
  const path = resolve(cwd, fileName);
  if (!existsSync(path)) return { path: null, applied: [], skipped: [] };

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of parseEnv(readFileSync(path, 'utf8'))) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { path, applied, skipped };
}
