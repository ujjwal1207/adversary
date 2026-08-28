/**
 * The retry backoff must keep the process alive.
 *
 * This is a subprocess test, and it has to be. The bug it guards against is not
 * visible in-process: under vitest the event loop always has other handles, so
 * an unref'd backoff timer resolves perfectly and every unit test passes. The
 * failure only appears when the backoff is the *last* pending thing, which is
 * exactly the situation in a real corpus run — the 429 has arrived, the socket
 * is closed, and nothing else is waiting.
 *
 * When that happened, Node exited with status 0 in the middle of a family E
 * run. Four scenarios of eight were persisted, the CLI reported no error, and
 * `adversary report` would have built a scorecard over half a corpus without
 * anything saying so.
 *
 * So the assertion is about a process, not a promise: run one, make it back off,
 * and check it lived long enough to finish.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// A file:// URL, not a path: Node's ESM loader rejects a bare Windows absolute
// path because the drive letter reads as a protocol.
const PROVIDERS = pathToFileURL(resolve(HERE, '../providers.ts')).href;
const TSX = resolve(HERE, '../../../../../node_modules/tsx/dist/cli.mjs');

/**
 * A child that rate-limits once, then succeeds.
 *
 * Nothing else is pending while it backs off, which is the condition the bug
 * needs. `maxTokens`/`temperature` are irrelevant here; the 429 is the point.
 */
const CHILD = `
import { AnthropicLlm } from '${PROVIDERS}';

let calls = 0;
const fetchImpl = async () => {
  calls += 1;
  if (calls === 1) return { ok: false, status: 429, text: async () => 'slow down' };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
  };
};

const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', fetchImpl, backoffMs: 400 });
const result = await llm.complete({
  system: 's',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  temperature: 0,
  maxTokens: 16,
});

console.log('SETTLED:' + result.text + ':' + calls);
`;

describe('the retry backoff', () => {
  it('does not let the process exit while it is waiting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adversary-backoff-'));
    const script = join(dir, 'child.mjs');
    writeFileSync(script, CHILD, 'utf8');

    // Throws on a non-zero exit, so a crash fails loudly. The subtler failure —
    // exiting 0 without settling — is caught by the assertion below, because a
    // process that died during the backoff prints nothing.
    const stdout = execFileSync(process.execPath, [TSX, script], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(stdout).toContain('SETTLED:done:2');
  }, 60_000);
});
