/**
 * The convenience implementation of `TranscriptCarryingError`
 * (packages/core/src/contracts.ts, where the contract and its history live).
 *
 * It lives on the agent side, not in core: agents may import only
 * `@adversary/core/contracts`, which carries no runtime values, so the
 * untrusted half can never construct trusted machinery. The runner never
 * imports this class either - it checks the shape structurally, which is what
 * lets a black-box SUT throw a plain object with a `transcript` array and get
 * the same treatment.
 */

import type { AgentTranscriptEvent } from '@adversary/core/contracts';

export class AgentRunError extends Error {
  override readonly name = 'AgentRunError';
  readonly transcript: readonly AgentTranscriptEvent[];

  constructor(message: string, transcript: readonly AgentTranscriptEvent[]) {
    super(message);
    this.transcript = transcript;
  }
}
