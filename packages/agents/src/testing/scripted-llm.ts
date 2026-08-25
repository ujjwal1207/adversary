/**
 * A model client that returns canned completions.
 *
 * Shipped rather than kept in a test folder, because anyone implementing
 * `PaymentAgent` for their own agent needs exactly this to test it without
 * burning tokens or requiring a key. It is also how `Ops` and `NaiveOps` are
 * exercised in CI, where there is no API key by design.
 *
 * It records every request it receives, so a test can assert what the agent
 * actually asked for - that temperature was pinned to 0, that tool results were
 * threaded back correctly, that the system prompt said what it should.
 */

import type {
  LlmClient,
  LlmCompletion,
  LlmRequest,
  LlmToolCall,
} from '@adversary/core/contracts';

export class ScriptedLlmError extends Error {
  override readonly name = 'ScriptedLlmError';
}

export interface ScriptedLlmOptions {
  readonly completions: readonly LlmCompletion[];
  readonly model?: string;
  /** Throw on the nth call (0-based), to exercise the bounded fallback. */
  readonly failOnCall?: number;
}

export class ScriptedLlm implements LlmClient {
  readonly model: string;
  readonly requests: LlmRequest[] = [];

  readonly #completions: readonly LlmCompletion[];
  readonly #failOnCall: number | null;
  #calls = 0;

  constructor(options: ScriptedLlmOptions) {
    this.model = options.model ?? 'scripted-model';
    this.#completions = options.completions;
    this.#failOnCall = options.failOnCall ?? null;
  }

  get callCount(): number {
    return this.#calls;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const index = this.#calls;
    this.#calls += 1;
    this.requests.push(request);

    if (this.#failOnCall === index) {
      throw new ScriptedLlmError(`scripted failure on call ${index}`);
    }

    const completion = this.#completions[index];
    if (completion === undefined) {
      // Running off the end is a test bug, and a silent empty completion would
      // look like the agent choosing to stop.
      throw new ScriptedLlmError(
        `ScriptedLlm ran out of completions at call ${index}; ` +
          `${this.#completions.length} were provided.`,
      );
    }
    return completion;
  }
}

/** A completion that calls one tool and says nothing else. */
export function callsTool(
  name: string,
  args: Record<string, unknown>,
  text = '',
): LlmCompletion {
  const call: LlmToolCall = { id: `call_${name}_${JSON.stringify(args).length}`, name, args };
  return { text, toolCalls: [call], stopReason: 'tool_use' };
}

/** A completion that ends the turn with a message and no tool call. */
export function says(text: string): LlmCompletion {
  return { text, toolCalls: [], stopReason: 'end_turn' };
}
