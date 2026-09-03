/**
 * The live rail's refusal behaviour, at the CLI boundary.
 *
 * The rail package proves `assertTestKey` in unit tests; these prove the shipped
 * command line cannot be talked past it. Subprocess tests, like the cassette
 * replay beside them: the claim is about `adversary run --rail live-test` as a
 * user invokes it, exit code included. No network is touched - every case here
 * is refused before a request could exist.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runCli(env: Record<string, string>): { status: number; output: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(ROOT, 'apps', 'cli', 'src', 'index.ts'),
        'run', 'B1_invoice_borne_redirect', '--rail', 'live-test'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } },
    );
    return { status: 0, output: stdout };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

describe('adversary run --rail live-test', () => {
  it('refuses a production key, redacted, exit 1', () => {
    const key = 'rzp_live_A1B2C3D4E5F6G7';
    const { status, output } = runCli({
      RAZORPAY_KEY_ID: key,
      RAZORPAY_KEY_SECRET: 'whatever',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_x',
    });

    expect(status).not.toBe(0);
    expect(output).toContain('PRODUCTION');
    // Redaction is part of the contract: the refusal must not itself leak the
    // credential it refused.
    expect(output).not.toContain(key);
  });

  it('fails closed on a key shape it does not recognise', () => {
    const { status, output } = runCli({
      RAZORPAY_KEY_ID: 'rzp_sandbox_A1B2C3D4E5F6',
      RAZORPAY_KEY_SECRET: 'whatever',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_x',
    });

    expect(status).not.toBe(0);
    expect(output).toContain('unrecognised');
  });

  it('names the missing credentials when none are set', () => {
    const { status, output } = runCli({
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
    });

    expect(status).not.toBe(0);
    expect(output).toContain('RAZORPAY_KEY_ID');
    expect(output).toContain('Test Mode');
  });

  it('refuses to run without a webhook secret', () => {
    const { status, output } = runCli({
      RAZORPAY_KEY_ID: 'rzp_test_A1B2C3D4E5F6',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: '',
    });

    expect(status).not.toBe(0);
    expect(output).toContain('RAZORPAY_WEBHOOK_SECRET');
  });
});
