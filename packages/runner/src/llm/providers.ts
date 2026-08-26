/**
 * Provider adapters.
 *
 * Two of them, because "the harness is model-agnostic" is a claim, and a claim
 * with one implementation behind it is untested. Both satisfy the same
 * `LlmClient` interface, and no agent ever names a provider - it is handed a
 * client (docs/ARCHITECTURE.md 6.7).
 *
 * `fetch` is injectable so the request shaping can be tested without a network
 * or a key: what these adapters get wrong is almost never the HTTP, it is the
 * translation between our message shape and theirs.
 *
 * Failure handling follows the taxonomy in ARCHITECTURE 14: a rate limit gets a
 * bounded, fixed backoff; everything else fails immediately with a typed error.
 * Never a silent retry, never an unbounded one.
 */

import type {
  LlmClient,
  LlmCompletion,
  LlmRequest,
  LlmStopReason,
  LlmToolCall,
} from '@adversary/core';

export class LlmError extends Error {
  override readonly name = 'LlmError';
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** At most this many retries on a rate limit. Default 3. Never unbounded. */
  readonly maxRetries?: number;
  /** Base backoff in ms; doubles per attempt, capped. Default 500. */
  readonly backoffMs?: number;
}

abstract class HttpLlm implements LlmClient {
  readonly model: string;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #backoffMs: number;

  constructor(options: ProviderOptions, defaultBaseUrl: string) {
    if (!options.apiKey) {
      throw new LlmError(`${this.constructor.name} needs an API key.`, null, false);
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? defaultBaseUrl;
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#maxRetries = options.maxRetries ?? 3;
    this.#backoffMs = options.backoffMs ?? 500;
  }

  abstract complete(request: LlmRequest): Promise<LlmCompletion>;

  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let lastError: LlmError | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (response.ok) return JSON.parse(await response.text()) as unknown;

      const text = await response.text();
      // 429 and 5xx are the only retryable statuses. A 400 is a bug in our
      // request shaping and retrying it just makes the same mistake again.
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new LlmError(
        `${this.model}: HTTP ${response.status} ${truncate(text)}`,
        response.status,
        retryable,
      );

      if (!retryable || attempt === this.#maxRetries) break;

      // Fixed exponential backoff, no jitter: jitter would need randomness, and
      // randomness in the run path is banned. The cap keeps a pathological
      // provider from stalling a corpus run.
      await sleep(Math.min(this.#backoffMs * 2 ** attempt, 8_000));
    }

    throw lastError ?? new LlmError(`${this.model}: request failed`, null, false);
  }
}

// --- Anthropic --------------------------------------------------------------

export class AnthropicLlm extends HttpLlm {
  constructor(options: ProviderOptions) {
    super(options, 'https://api.anthropic.com');
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const body = {
      model: this.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    };

    const raw = (await this.post(
      `${this.baseUrl}/v1/messages`,
      {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      request.signal,
    )) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      stop_reason?: string;
    };

    const blocks = raw.content ?? [];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const toolCalls: LlmToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: String(b.id),
        name: String(b.name),
        args: (b.input ?? {}) as Record<string, unknown>,
      }));

    return { text, toolCalls, stopReason: anthropicStop(raw.stop_reason) };
  }
}

function toAnthropicMessage(message: {
  role: string;
  content: string;
  toolCalls?: readonly LlmToolCall[] | undefined;
  toolCallId?: string | undefined;
}): unknown {
  if (message.role === 'tool') {
    // Anthropic carries tool results on a *user* turn, not a `tool` role.
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    const content: unknown[] = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    }
    return { role: 'assistant', content };
  }

  return { role: message.role, content: message.content };
}

function anthropicStop(reason: string | undefined): LlmStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

// --- OpenAI -----------------------------------------------------------------

export class OpenAiLlm extends HttpLlm {
  constructor(options: ProviderOptions) {
    super(options, 'https://api.openai.com');
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const body = {
      model: this.model,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map(toOpenAiMessage),
      ],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    };

    const raw = (await this.post(
      `${this.baseUrl}/v1/chat/completions`,
      {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body,
      request.signal,
    )) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
        finish_reason?: string;
      }[];
    };

    const choice = raw.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      // Arguments arrive as a JSON *string*. A model that emits malformed JSON
      // is agent behaviour worth recording, so it becomes an empty argument set
      // that the tool will reject with a 400-shaped result rather than a throw
      // that would end the run.
      args: parseArgs(call.function.arguments),
    }));

    return {
      text: choice?.message?.content ?? '',
      toolCalls,
      stopReason: openAiStop(choice?.finish_reason),
    };
  }
}

function toOpenAiMessage(message: {
  role: string;
  content: string;
  toolCalls?: readonly LlmToolCall[] | undefined;
  toolCallId?: string | undefined;
}): unknown {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }

  return { role: message.role, content: message.content };
}

function openAiStop(reason: string | undefined): LlmStopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// --- helpers ----------------------------------------------------------------

function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}
