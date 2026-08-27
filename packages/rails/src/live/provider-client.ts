/**
 * The provider transport.
 *
 * The build spec asks for a local MCP server preferred and a REST SDK fallback
 * "behind the same interface, selectable by config". This is that interface.
 * `LiveTestRail` never learns which one it has, so switching is configuration
 * rather than code - and the rail's own tests do not need either.
 *
 * Both implementations map provider failures onto the same closed set of
 * outcomes. That mapping is the interesting part: the corpus asks what an agent
 * does after an *ambiguous* failure, so a transport that flattened "timed out"
 * into "failed" would delete the distinction the scenarios are about.
 */

import type { MoneyKind } from '@adversary/core';

export interface ProviderRequest {
  readonly runKey: string;
  readonly seq: number;
  readonly kind: MoneyKind;
  readonly amountPaise: number;
  readonly payeeRef: string | null;
  readonly subjectRef: string | null;
  readonly idempotencyKey: string;
  /**
   * Written to the provider entity's notes field.
   *
   * Every entity this harness creates is tagged with its `runKey`, so a test
   * account that accumulates them can be traced back to the run that made each
   * one. Required by docs/ARCHITECTURE.md 6.6.
   */
  readonly notes: Readonly<Record<string, string>>;
}

export type ProviderOutcome =
  | { readonly ok: true; readonly ref: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /**
       * Whether a caller *could* retry - advice about the failure, not
       * permission. Whether the agent retries is what the corpus measures.
       */
      readonly retryable: boolean;
      /**
       * True when the request may or may not have taken effect. A timeout is
       * the case corpus family D2 is built around, and collapsing it into
       * `ok: false` would assert knowledge nobody has.
       */
      readonly ambiguous: boolean;
    };

export interface ProviderClient {
  readonly transport: 'mcp' | 'rest';
  execute(request: ProviderRequest): Promise<ProviderOutcome>;
  close(): Promise<void>;
}

/**
 * Maps an HTTP status onto an outcome.
 *
 * Shared by both transports so they cannot disagree about what a 429 means.
 */
export function outcomeForStatus(
  status: number,
  code: string,
  message: string,
): Extract<ProviderOutcome, { ok: false }> {
  // 408 and 504 are the ambiguous ones: the request reached the provider and
  // the answer did not reach us.
  const ambiguous = status === 408 || status === 504 || status === 0;
  const retryable = ambiguous || status === 429 || status >= 500;

  return { ok: false, code, message, retryable, ambiguous };
}

/** A network-level failure, which is always ambiguous. */
export function outcomeForTransportError(error: unknown): Extract<
  ProviderOutcome,
  { ok: false }
> {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /timeout|abort|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message);

  return {
    ok: false,
    code: timedOut ? 'timeout' : 'network_error',
    message,
    retryable: true,
    // The request may have been received. Saying otherwise would be a claim
    // about something we did not observe.
    ambiguous: true,
  };
}
