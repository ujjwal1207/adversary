/**
 * Provider adapters.
 *
 * Three of them, because "the harness is model-agnostic" is a claim, and a
 * claim with one implementation behind it is untested. All three satisfy the
 * same `LlmClient` interface, and no agent ever names a provider - it is handed
 * a client (docs/ARCHITECTURE.md 6.7).
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

// --- Gemini -----------------------------------------------------------------

/**
 * Google's Generative Language API.
 *
 * Three differences from the other two are worth naming, because each is a
 * place a translation can be silently wrong rather than loudly broken.
 *
 * **Tool calls carry no id.** Anthropic and OpenAI both identify a tool call
 * with an opaque id and expect the result to quote it back. Gemini matches a
 * `functionResponse` to its `functionCall` by *name*. Our `LlmToolCall` needs
 * an id, so this adapter mints one - `name#index` - and decodes the name back
 * out when the result returns. Deterministic, stateless, and it survives a
 * model calling the same tool twice in one turn, which a bare name would not.
 *
 * **There is no tool-use stop reason.** Gemini finishes with `STOP` whether it
 * wrote prose or asked for a tool. The stop reason is therefore derived from
 * whether any function call came back, because the agent loop branches on it -
 * reporting `end_turn` on a turn that requested a tool would end the run one
 * step early and record it as the agent choosing to stop.
 *
 * **The assistant is called `model`.** Trivial, but a wrong role name comes
 * back as a 400 rather than as a misunderstanding, and it is the first thing to
 * check if this ever fails against the real API.
 *
 * Never exercised against Google's servers. See docs/LIMITATIONS.md.
 */
export class GeminiLlm extends HttpLlm {
  constructor(options: ProviderOptions) {
    super(options, 'https://generativelanguage.googleapis.com');
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const declarations = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // A function with no arguments must omit `parameters` entirely rather
      // than declare an empty property bag, which the API rejects. Three of
      // this project's read tools take no arguments, so this is not a corner.
      ...(hasProperties(tool.parameters) ? { parameters: tool.parameters } : {}),
    }));

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map(toGeminiContent),
      // An empty `tools` array is rejected, so the key is omitted instead.
      ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      },
    };

    const raw = (await this.post(
      `${this.baseUrl}/v1beta/models/${this.model}:generateContent`,
      {
        'content-type': 'application/json',
        // A header, never a `?key=` query parameter: a credential in a URL ends
        // up in proxy logs, browser history and error messages.
        'x-goog-api-key': this.apiKey,
      },
      body,
      request.signal,
    )) as {
      candidates?: {
        content?: {
          parts?: {
            text?: string;
            thought?: boolean;
            thoughtSignature?: string;
            functionCall?: { name?: string; args?: unknown };
          }[];
        };
        finishReason?: string;
      }[];
    };

    const parts = raw.candidates?.[0]?.content?.parts ?? [];
    // Thought summaries are the model talking to itself, not to the merchant;
    // they are excluded from the text the agent treats as the reply.
    const text = parts
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .join('');

    const toolCalls: LlmToolCall[] = parts
      .filter((part) => part.functionCall !== undefined)
      .map((part, index) => ({
        id: encodeGeminiCallId(String(part.functionCall?.name ?? ''), index),
        name: String(part.functionCall?.name ?? ''),
        args: (part.functionCall?.args ?? {}) as Record<string, unknown>,
        // Gemini 3 rejects a later request whose history omits this - HTTP
        // 400, "Function call is missing a thought_signature" - so it rides
        // the call as opaque providerData and toGeminiContent echoes it.
        ...(part.thoughtSignature === undefined
          ? {}
          : { providerData: { thoughtSignature: part.thoughtSignature } }),
      }));

    return {
      text,
      toolCalls,
      stopReason: geminiStop(raw.candidates?.[0]?.finishReason, toolCalls.length > 0),
    };
  }
}

/**
 * A tool-call id that carries the tool's name.
 *
 * `#` rather than `:` because tool names never contain one, so the decode can
 * split on the last occurrence without ambiguity.
 */
function encodeGeminiCallId(name: string, index: number): string {
  return `${name}#${index}`;
}

function decodeGeminiCallName(id: string | undefined): string {
  if (id === undefined) return '';
  const hash = id.lastIndexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

function toGeminiContent(message: {
  role: string;
  content: string;
  toolCalls?: readonly LlmToolCall[] | undefined;
  toolCallId?: string | undefined;
}): unknown {
  if (message.role === 'tool') {
    // Like Anthropic, a tool result rides on a user turn. Unlike Anthropic, it
    // is matched by name - which is why the name had to survive the round trip
    // inside the id.
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: decodeGeminiCallName(message.toolCallId),
            // The API expects an object, not a string. Tool output is already
            // JSON, so it passes through when it parses and is wrapped when it
            // does not: a result the model cannot read is worse than an
            // oddly-shaped one.
            response: asObject(message.content),
          },
        },
      ],
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    const parts: unknown[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls) {
      const signature = call.providerData?.['thoughtSignature'];
      parts.push({
        functionCall: { name: call.name, args: call.args },
        // Echoed verbatim when present, omitted when not: an empty or invented
        // signature is worse than none.
        ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
      });
    }
    return { role: 'model', parts };
  }

  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  };
}

function geminiStop(reason: string | undefined, calledTool: boolean): LlmStopReason {
  // Checked first: Gemini reports STOP for a turn that asked for a tool, and
  // treating that as end_turn would end the run a step early and record it as
  // the agent deciding to stop.
  if (calledTool) return 'tool_use';
  return reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
}

function hasProperties(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const properties = (schema as { properties?: unknown }).properties;
  return (
    properties !== null &&
    typeof properties === 'object' &&
    Object.keys(properties as object).length > 0
  );
}

function asObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

// --- helpers ----------------------------------------------------------------

function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * The retry backoff.
 *
 * The timer is deliberately NOT unref'd, and that is the whole point of this
 * comment. An unref'd timer does not hold the event loop open, and during a
 * backoff it is frequently the only pending handle: the 429 has been received,
 * the socket is closed, and nothing else is waiting. Node then exits - cleanly,
 * with status 0, in the middle of a corpus run.
 *
 * That is exactly what happened the first time Gemini rate-limited a family E
 * run: four of eight scenarios completed, the process exited 0, and
 * `adversary report` would have built a scorecard over half a corpus without
 * anything saying so. A partial measurement presented as a whole one is the
 * failure this project exists to prevent, so it must not be able to happen to
 * the project itself.
 *
 * The wall-clock deadline in `runner.ts` *is* unref'd, correctly - a pending
 * deadline should never keep a finished process alive. Copying that line here
 * is how this got in.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
