/**
 * Run identity.
 *
 * Two identifiers, because they answer different questions
 * (docs/ARCHITECTURE.md 9.2):
 *
 *   `runKey` identifies **the experiment** - this scenario, at this seed, on
 *   this rail, with this gate setting, against this agent and model. Two
 *   attempts at the same experiment share it.
 *
 *   `runId` identifies **this execution of it**: `runKey:attempt`. It is the
 *   database key.
 *
 * Every determinism-bearing derivation keys off `runKey`. Mock-rail references
 * are `hash(runKey, seq, kind)`; auto idempotency keys are `auto:runKey:seq`;
 * the RNG tree roots at the seed and the scenario id. If any of those used
 * `runId`, a second attempt would mint different identifiers and the
 * determinism check would fail for a bookkeeping reason that says nothing about
 * behaviour. It is a small decision that is easy to get wrong and expensive to
 * debug later.
 */

import type { RailKind } from '@adversary/core';
import { hashValue } from '@adversary/core';

export interface RunKeyInput {
  readonly scenarioId: string;
  readonly scenarioContentHash: string;
  readonly seed: number;
  readonly rail: RailKind;
  readonly gateEnabled: boolean;
  readonly agentName: string;
  readonly agentVersion: string;
  /** null for an agent with no model, such as ScriptedAgent. */
  readonly model: string | null;
}

export function deriveRunKey(input: RunKeyInput): string {
  // Hashed over the canonical form, so field order in this object cannot
  // change the key.
  return `key_${hashValue({
    scenarioId: input.scenarioId,
    scenarioContentHash: input.scenarioContentHash,
    seed: input.seed,
    rail: input.rail,
    gateEnabled: input.gateEnabled,
    agentName: input.agentName,
    agentVersion: input.agentVersion,
    model: input.model,
  }).slice(0, 24)}`;
}

export function makeRunId(runKey: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
  }
  return `${runKey}:${attempt}`;
}

export function parseRunId(runId: string): { runKey: string; attempt: number } {
  const separator = runId.lastIndexOf(':');
  if (separator < 0) {
    throw new Error(`Malformed runId "${runId}": expected "<runKey>:<attempt>".`);
  }
  const runKey = runId.slice(0, separator);
  const attempt = Number(runId.slice(separator + 1));
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`Malformed runId "${runId}": attempt is not a whole number.`);
  }
  return { runKey, attempt };
}
