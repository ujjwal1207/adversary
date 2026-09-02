/**
 * Model clients: cassettes and the three provider adapters.
 *
 * None of this touches a network. The adapters take an injected `fetch`,
 * because what an adapter gets wrong is almost never the HTTP - it is the
 * translation between our message shape and the provider's.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LlmCompletion, LlmRequest } from '@adversary/core';
import { ScriptedLlm, callsTool, says } from '@adversary/agents';

import { CassetteError, CassetteLlm, cassetteKey } from '../cassette.js';
import { AnthropicLlm, GeminiLlm, LlmError, OpenAiLlm } from '../providers.js';
import type { FetchLike } from '../providers.js';
import { createLlmClient, llmConfigFromEnv, replayFromCassette } from '../index.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'adversary-cassette-'));

const REQUEST: LlmRequest = {
  system: 'You are the back-office payments assistant.',
  messages: [{ role: 'user', content: 'Pay the outstanding invoices.' }],
  tools: [
    {
      name: 'pay_vendor',
      description: 'Send a payment to a vendor. This moves money.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ],
  temperature: 0,
  maxTokens: 2048,
};

const next = (request: LlmRequest, content: string): LlmRequest => ({
  ...request,
  messages: [...request.messages, { role: 'user', content }],
});

/** A fetch that returns a canned body and records what it was asked. */
function fakeFetch(body: unknown, status = 200): FetchLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  const impl = (async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }) as FetchLike & { calls: unknown[] };
  impl.calls = calls;
  return impl;
}

// --- cassette keys ----------------------------------------------------------

describe('cassetteKey', () => {
  it('is stable for the same request', () => {
    expect(cassetteKey(REQUEST, 'm')).toBe(cassetteKey(REQUEST, 'm'));
  });

  it('ignores field order inside the request', () => {
    const reordered: LlmRequest = {
      maxTokens: REQUEST.maxTokens,
      temperature: REQUEST.temperature,
      tools: REQUEST.tools,
      messages: REQUEST.messages,
      system: REQUEST.system,
    };
    expect(cassetteKey(reordered, 'm')).toBe(cassetteKey(REQUEST, 'm'));
  });

  it('changes with the model, the prompt, the tools and the temperature', () => {
    const base = cassetteKey(REQUEST, 'm');
    expect(cassetteKey(REQUEST, 'other-model')).not.toBe(base);
    expect(cassetteKey({ ...REQUEST, system: 'different' }, 'm')).not.toBe(base);
    expect(cassetteKey({ ...REQUEST, temperature: 1 }, 'm')).not.toBe(base);
    expect(cassetteKey({ ...REQUEST, tools: [] }, 'm')).not.toBe(base);
    expect(cassetteKey(next(REQUEST, 'and one more thing'), 'm')).not.toBe(base);
  });

  it('ignores the abort signal, which is not part of the question', () => {
    const withSignal = { ...REQUEST, signal: new AbortController().signal };
    expect(cassetteKey(withSignal, 'm')).toBe(cassetteKey(REQUEST, 'm'));
  });
});

// --- record and replay ------------------------------------------------------

describe('CassetteLlm', () => {
  it('records what the inner client returned, then replays it exactly', async () => {
    const path = join(scratch(), 'b1.json');
    const inner = new ScriptedLlm({
      completions: [callsTool('pay_vendor', { vendorId: 'acct_vendor_acme' }), says('done')],
      model: 'test-model',
    });

    const recorder = new CassetteLlm({ mode: 'record', path, inner });
    const first = await recorder.complete(REQUEST);
    const second = await recorder.complete(next(REQUEST, 'anything else?'));
    recorder.save();

    const player = new CassetteLlm({ mode: 'replay', path });
    expect(await player.complete(REQUEST)).toEqual(first);
    expect(await player.complete(next(REQUEST, 'anything else?'))).toEqual(second);
  });

  it('makes a replay miss a hard error, never a live call', async () => {
    // The single most important behaviour in this file. Falling through would
    // turn a reproducibility guarantee into a coin flip, silently: the run
    // would still finish and still claim to be reproducible.
    const path = join(scratch(), 'thin.json');
    const inner = new ScriptedLlm({ completions: [says('recorded')] });

    const recorder = new CassetteLlm({ mode: 'record', path, inner });
    await recorder.complete(REQUEST);
    recorder.save();

    const player = new CassetteLlm({ mode: 'replay', path });
    await expect(player.complete(next(REQUEST, 'unrecorded'))).rejects.toThrow(
      CassetteError,
    );
    await expect(player.complete(next(REQUEST, 'unrecorded'))).rejects.toThrow(
      /coin flip/,
    );
  });

  it('names the cassette and the key in the miss', async () => {
    const path = join(scratch(), 'named.json');
    writeFileSync(path, JSON.stringify({ version: 1, model: 'm', entries: [] }));

    const player = new CassetteLlm({ mode: 'replay', path });
    await expect(player.complete(REQUEST)).rejects.toThrow(/named\.json/);
    await expect(player.complete(REQUEST)).rejects.toThrow(/0 entries/);
  });

  it('replays repeated identical requests in recorded order', async () => {
    // Two identical requests are legitimate - an agent can ask the same thing
    // twice. Serving the first recording both times would hide a divergence.
    const path = join(scratch(), 'repeat.json');
    const inner = new ScriptedLlm({ completions: [says('first'), says('second')] });

    const recorder = new CassetteLlm({ mode: 'record', path, inner });
    await recorder.complete(REQUEST);
    await recorder.complete(REQUEST);
    recorder.save();

    const player = new CassetteLlm({ mode: 'replay', path });
    expect((await player.complete(REQUEST)).text).toBe('first');
    expect((await player.complete(REQUEST)).text).toBe('second');
    await expect(player.complete(REQUEST)).rejects.toThrow(CassetteError);
  });

  it('needs no key and no provider to replay', async () => {
    const path = join(scratch(), 'keyless.json');
    const recorder = new CassetteLlm({
      mode: 'record',
      path,
      inner: new ScriptedLlm({ completions: [says('hello')], model: 'recorded-model' }),
    });
    await recorder.complete(REQUEST);
    recorder.save();

    const resolved = replayFromCassette(path);
    expect(resolved.reproducibility).toBe('cassette');
    expect(resolved.model).toBe('recorded-model');
    expect((await resolved.client.complete(REQUEST)).text).toBe('hello');
  });

  it('hashes its contents, so a scorecard can say which cassette', async () => {
    const dir = scratch();
    const record = async (text: string, file: string) => {
      const recorder = new CassetteLlm({
        mode: 'record',
        path: join(dir, file),
        inner: new ScriptedLlm({ completions: [says(text)] }),
      });
      await recorder.complete(REQUEST);
      return recorder.save();
    };

    const a = await record('same', 'a.json');
    const b = await record('same', 'b.json');
    const c = await record('different', 'c.json');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports entries it was never asked for', async () => {
    // A cassette holding recordings the run never used is a sign the run
    // changed since it was recorded.
    const path = join(scratch(), 'unused.json');
    const recorder = new CassetteLlm({
      mode: 'record',
      path,
      inner: new ScriptedLlm({ completions: [says('a'), says('b')] }),
    });
    await recorder.complete(REQUEST);
    await recorder.complete(next(REQUEST, 'second'));
    recorder.save();

    const player = new CassetteLlm({ mode: 'replay', path });
    await player.complete(REQUEST);
    expect(player.unusedEntries).toBe(1);
  });

  it('writes canonical JSON, so a cassette diffs cleanly', async () => {
    const path = join(scratch(), 'canonical.json');
    const recorder = new CassetteLlm({
      mode: 'record',
      path,
      inner: new ScriptedLlm({ completions: [says('x')] }),
    });
    await recorder.complete(REQUEST);
    recorder.save();

    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('{"entries"')).toBe(true);
  });

  it('refuses to record without an inner client', () => {
    expect(() => new CassetteLlm({ mode: 'record', path: 'x.json' })).toThrow(
      /needs an inner client/,
    );
  });

  it('reports a missing or malformed cassette clearly', () => {
    expect(() => new CassetteLlm({ mode: 'replay', path: '/nope/missing.json' })).toThrow(
      /could not be read/,
    );

    const path = join(scratch(), 'bad.json');
    writeFileSync(path, 'not json');
    expect(() => new CassetteLlm({ mode: 'replay', path })).toThrow(/not valid JSON/);

    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => new CassetteLlm({ mode: 'replay', path })).toThrow(/malformed/);
  });
});

// --- provider adapters ------------------------------------------------------

describe('AnthropicLlm', () => {
  const body = {
    content: [
      { type: 'text', text: 'Paying the first invoice.' },
      { type: 'tool_use', id: 'toolu_1', name: 'pay_vendor', input: { vendorId: 'acct_vendor_acme' } },
    ],
    stop_reason: 'tool_use',
  };

  it('translates a completion', async () => {
    const fetchImpl = fakeFetch(body);
    const result = await new AnthropicLlm({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchImpl,
    }).complete(REQUEST);

    expect(result).toEqual<LlmCompletion>({
      text: 'Paying the first invoice.',
      toolCalls: [{ id: 'toolu_1', name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } }],
      stopReason: 'tool_use',
    });
  });

  it('sends tools as input_schema and passes temperature through', async () => {
    const fetchImpl = fakeFetch(body);
    await new AnthropicLlm({ apiKey: 'sk-test', model: 'm', fetchImpl }).complete(REQUEST);

    const sent = (fetchImpl.calls[0] as { body: Record<string, unknown> }).body;
    expect(sent['temperature']).toBe(0);
    expect(sent['system']).toBe(REQUEST.system);
    expect(sent['tools']).toEqual([
      {
        name: 'pay_vendor',
        description: 'Send a payment to a vendor. This moves money.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]);
  });

  it('carries a tool result on a user turn, as the API requires', async () => {
    const fetchImpl = fakeFetch(body);
    await new AnthropicLlm({ apiKey: 'sk-test', model: 'm', fetchImpl }).complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'pay_vendor', args: {} }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 't1' },
      ],
    });

    const sent = (fetchImpl.calls[0] as { body: { messages: { role: string; content: unknown }[] } }).body;
    expect(sent.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }],
    });
  });

  it('sets the version and key headers', async () => {
    const fetchImpl = fakeFetch(body);
    await new AnthropicLlm({ apiKey: 'sk-test', model: 'm', fetchImpl }).complete(REQUEST);

    const headers = (fetchImpl.calls[0] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('OpenAiLlm', () => {
  const body = {
    choices: [
      {
        message: {
          content: 'Paying now.',
          tool_calls: [
            { id: 'call_1', function: { name: 'pay_vendor', arguments: '{"vendorId":"acct_vendor_acme"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };

  it('translates a completion', async () => {
    const result = await new OpenAiLlm({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      fetchImpl: fakeFetch(body),
    }).complete(REQUEST);

    expect(result).toEqual<LlmCompletion>({
      text: 'Paying now.',
      toolCalls: [{ id: 'call_1', name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } }],
      stopReason: 'tool_use',
    });
  });

  it('puts the system prompt in the message list, as the API requires', async () => {
    const fetchImpl = fakeFetch(body);
    await new OpenAiLlm({ apiKey: 'sk-test', model: 'm', fetchImpl }).complete(REQUEST);

    const sent = (fetchImpl.calls[0] as { body: { messages: { role: string }[] } }).body;
    expect(sent.messages[0]).toEqual({ role: 'system', content: REQUEST.system });
  });

  it('survives malformed tool arguments rather than throwing', async () => {
    // A model emitting broken JSON is agent behaviour worth recording. The
    // empty argument set reaches the tool, which rejects it with a 400-shaped
    // result - a throw here would end the run and lose the ledger.
    const broken = {
      choices: [
        {
          message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'pay_vendor', arguments: '{oops' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const result = await new OpenAiLlm({
      apiKey: 'sk-test',
      model: 'm',
      fetchImpl: fakeFetch(broken),
    }).complete(REQUEST);

    expect(result.toolCalls[0]?.args).toEqual({});
  });

  it('produces the same shape as the Anthropic adapter', async () => {
    // "Model-agnostic" is a claim, and a claim with one implementation behind
    // it is untested.
    const anthropic = await new AnthropicLlm({
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({
        content: [{ type: 'tool_use', id: 'x', name: 'pay_vendor', input: { a: 1 } }],
        stop_reason: 'tool_use',
      }),
    }).complete(REQUEST);

    const openai = await new OpenAiLlm({
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({
        choices: [
          {
            message: { content: '', tool_calls: [{ id: 'x', function: { name: 'pay_vendor', arguments: '{"a":1}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    }).complete(REQUEST);

    expect(anthropic).toEqual(openai);
  });
});

describe('GeminiLlm', () => {
  const body = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { text: 'Paying now.' },
            { functionCall: { name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } } },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  };

  it('translates a completion', async () => {
    const result = await new GeminiLlm({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      fetchImpl: fakeFetch(body),
    }).complete(REQUEST);

    expect(result).toEqual<LlmCompletion>({
      text: 'Paying now.',
      // Gemini gives tool calls no id, so the adapter mints one carrying the
      // name - which is how the result finds its way back to the right call.
      toolCalls: [
        { id: 'pay_vendor#0', name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } },
      ],
      stopReason: 'tool_use',
    });
  });

  it('reports tool_use even though Gemini says STOP', async () => {
    // The difference that would break a run rather than a test. Gemini finishes
    // with STOP whether it wrote prose or asked for a tool; taking that at face
    // value would end the loop a step early and record it as the agent choosing
    // to stop.
    const result = await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(body) })
      .complete(REQUEST);
    expect(result.stopReason).toBe('tool_use');
  });

  it('reports end_turn when nothing was called', async () => {
    const prose = {
      candidates: [{ content: { parts: [{ text: 'I cannot do that safely.' }] }, finishReason: 'STOP' }],
    };
    const result = await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(prose) })
      .complete(REQUEST);

    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls).toEqual([]);
  });

  it('distinguishes two calls to the same tool in one turn', async () => {
    // A bare name as the id would collapse these into one, and the second tool
    // result would be matched to the first call.
    const twice = {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'pay_vendor', args: { amountPaise: 1 } } },
              { functionCall: { name: 'pay_vendor', args: { amountPaise: 2 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };

    const result = await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(twice) })
      .complete(REQUEST);

    expect(result.toolCalls.map((c) => c.id)).toEqual(['pay_vendor#0', 'pay_vendor#1']);
  });

  it('sends the tool result back under the tool name, recovered from the id', async () => {
    const fetchImpl = fakeFetch(body);
    await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl }).complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'Pay them.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'pay_vendor#0', name: 'pay_vendor', args: {} }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'pay_vendor#0' },
      ],
    });

    const sent = (fetchImpl.calls[0] as { body: { contents: Record<string, unknown>[] } }).body;

    // The assistant turn is `model`, not `assistant`.
    expect(sent.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'pay_vendor', args: {} } }],
    });

    // The result rides on a user turn, matched by name, with an object payload.
    expect(sent.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'pay_vendor', response: { ok: true } } }],
    });
  });

  it('wraps a tool result that is not JSON rather than dropping it', async () => {
    const fetchImpl = fakeFetch(body);
    await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl }).complete({
      ...REQUEST,
      messages: [{ role: 'tool', content: 'not json at all', toolCallId: 'pay_vendor#0' }],
    });

    const sent = (fetchImpl.calls[0] as { body: { contents: { parts: unknown[] }[] } }).body;
    expect(sent.contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'pay_vendor', response: { result: 'not json at all' } },
    });
  });

  it('omits parameters for a tool that takes none', async () => {
    // The API rejects an empty property bag. Three of this project's read tools
    // take no arguments, so this is the common case rather than a corner.
    const fetchImpl = fakeFetch(body);
    await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl }).complete(REQUEST);

    const sent = (
      fetchImpl.calls[0] as { body: { tools: { functionDeclarations: object[] }[] } }
    ).body;
    expect(sent.tools[0]?.functionDeclarations[0]).toEqual({
      name: 'pay_vendor',
      description: 'Send a payment to a vendor. This moves money.',
    });
  });

  it('keeps parameters for a tool that takes some', async () => {
    const fetchImpl = fakeFetch(body);
    const parameters = {
      type: 'object',
      properties: { vendorId: { type: 'string' } },
      required: ['vendorId'],
    };

    await new GeminiLlm({ apiKey: 'k', model: 'm', fetchImpl }).complete({
      ...REQUEST,
      tools: [{ name: 'pay_vendor', description: 'Pays.', parameters }],
    });

    const sent = (
      fetchImpl.calls[0] as { body: { tools: { functionDeclarations: { parameters?: unknown }[] }[] } }
    ).body;
    expect(sent.tools[0]?.functionDeclarations[0]?.parameters).toEqual(parameters);
  });

  it('sends the key as a header, never in the URL', async () => {
    // A credential in a query string ends up in proxy logs, browser history and
    // error messages. This is the one place the adapter could get that wrong.
    const fetchImpl = fakeFetch(body);
    await new GeminiLlm({ apiKey: 'super-secret', model: 'm', fetchImpl }).complete(REQUEST);

    const call = fetchImpl.calls[0] as { url: string; headers: Record<string, string> };
    expect(call.url).not.toContain('super-secret');
    expect(call.url).not.toContain('key=');
    expect(call.headers['x-goog-api-key']).toBe('super-secret');
  });

  it('produces the same shape as the other two adapters', async () => {
    // The parity that makes "model-agnostic" a checked claim rather than an
    // aspiration. Three wire formats, one completion object.
    const anthropic = await new AnthropicLlm({
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({
        content: [{ type: 'tool_use', id: 'pay_vendor#0', name: 'pay_vendor', input: { a: 1 } }],
        stop_reason: 'tool_use',
      }),
    }).complete(REQUEST);

    const gemini = await new GeminiLlm({
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'pay_vendor', args: { a: 1 } } }] },
            finishReason: 'STOP',
          },
        ],
      }),
    }).complete(REQUEST);

    expect(gemini).toEqual(anthropic);
  });
});

describe('failure handling', () => {
  it('retries a rate limit a bounded number of times', async () => {
    const fetchImpl = fakeFetch({ error: 'rate limited' }, 429);

    await expect(
      new AnthropicLlm({
        apiKey: 'k',
        model: 'm',
        fetchImpl,
        maxRetries: 2,
        backoffMs: 1,
      }).complete(REQUEST),
    ).rejects.toThrow(LlmError);

    // Initial attempt plus exactly two retries. Never unbounded.
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('does not retry a 400, because retrying repeats the same mistake', async () => {
    const fetchImpl = fakeFetch({ error: 'bad request' }, 400);

    await expect(
      new OpenAiLlm({ apiKey: 'k', model: 'm', fetchImpl, backoffMs: 1 }).complete(REQUEST),
    ).rejects.toThrow(/HTTP 400/);

    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('marks a rate limit retryable and a bad request not', async () => {
    const attempt = async (status: number) => {
      try {
        await new OpenAiLlm({
          apiKey: 'k',
          model: 'm',
          fetchImpl: fakeFetch({}, status),
          maxRetries: 0,
        }).complete(REQUEST);
        return null;
      } catch (err) {
        return err as LlmError;
      }
    };

    expect((await attempt(429))?.retryable).toBe(true);
    expect((await attempt(400))?.retryable).toBe(false);
  });

  it('refuses to construct without a key', () => {
    expect(() => new AnthropicLlm({ apiKey: '', model: 'm' })).toThrow(/needs an API key/);
  });
});

// --- configuration ----------------------------------------------------------

describe('llmConfigFromEnv', () => {
  it('returns null with no key, which selects ScriptedAgent', () => {
    // Not an error: it is the normal state of CI, and it is what makes the
    // determinism gate a required check.
    expect(llmConfigFromEnv({})).toBeNull();
  });

  it('prefers an Anthropic key when both are present', () => {
    const config = llmConfigFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' });
    expect(config?.provider).toBe('anthropic');
  });

  it('takes the model from the environment', () => {
    expect(llmConfigFromEnv({ OPENAI_API_KEY: 'b', ADVERSARY_MODEL: 'gpt-x' })?.model).toBe(
      'gpt-x',
    );
  });

  it('accepts a Gemini key under either of the names Google publishes', () => {
    // The console hands out one or the other depending on where you got it.
    expect(llmConfigFromEnv({ GEMINI_API_KEY: 'g' })?.provider).toBe('gemini');
    expect(llmConfigFromEnv({ GOOGLE_API_KEY: 'g' })?.provider).toBe('gemini');
    expect(llmConfigFromEnv({ GEMINI_API_KEY: 'g' })?.model).toBe('gemini-3.6-flash');
  });

  it('checks the three providers in a fixed order', () => {
    // Documented rather than clever. Setting two keys is usually a mistake, and
    // a stable order at least makes the mistake reproducible.
    const all = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', GEMINI_API_KEY: 'g' };
    expect(llmConfigFromEnv(all)?.provider).toBe('anthropic');
    expect(llmConfigFromEnv({ OPENAI_API_KEY: 'b', GEMINI_API_KEY: 'g' })?.provider).toBe('openai');
  });

  it('refuses a cassette path with no mode rather than guessing', () => {
    // Guessing `record` would overwrite a recording; guessing `replay` would
    // fail confusingly. Neither is worth the convenience.
    expect(() => llmConfigFromEnv({ ANTHROPIC_API_KEY: 'a', ADVERSARY_CASSETTE: 'c.json' })).toThrow(
      /"record" or "replay"/,
    );
  });
});

describe('createLlmClient', () => {
  const base = { provider: 'openai' as const, apiKey: 'k', model: 'm' };

  it('reports a bare provider as live', () => {
    expect(createLlmClient(base).reproducibility).toBe('live');
  });

  it('reports a replay as cassette-reproducible', async () => {
    const path = join(scratch(), 'ready.json');
    const recorder = new CassetteLlm({
      mode: 'record',
      path,
      inner: new ScriptedLlm({ completions: [says('x')] }),
    });
    await recorder.complete(REQUEST);
    recorder.save();

    const resolved = createLlmClient({ ...base, cassette: { mode: 'replay', path } });
    expect(resolved.reproducibility).toBe('cassette');
    expect(resolved.cassette).not.toBeNull();
  });

  it('reports a recording pass as live, not as reproducible', () => {
    // Recording calls the provider. The recording pass is not itself
    // repeatable - only replays from it are.
    const resolved = createLlmClient({
      ...base,
      cassette: { mode: 'record', path: join(scratch(), 'new.json') },
    });
    expect(resolved.reproducibility).toBe('live');
  });
});

describe('Gemini thought signatures', () => {
  /**
   * Found on this project's first successful model turn, ever. Gemini 3
   * attaches a `thoughtSignature` to the function calls of a thinking model
   * and rejects any later request whose history omits it - HTTP 400, at
   * "position 2", meaning the first turn worked and the second could never
   * be sent. The signature rides the tool call as opaque `providerData`: the
   * agent echoes the call object back untouched, so the round trip needs no
   * agent knowledge, and the cassette stores completions whole, so recordings
   * preserve it for free.
   */
  const signedBody = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { text: 'Reasoning to myself.', thought: true },
            { text: 'Paying now.' },
            {
              functionCall: { name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } },
              thoughtSignature: 'sig_abc',
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  };

  it('captures the signature and keeps thought text out of the reply', async () => {
    const result = await new GeminiLlm({
      apiKey: 'k',
      model: 'gemini-3.6-flash',
      fetchImpl: fakeFetch(signedBody),
    }).complete(REQUEST);

    expect(result.text).toBe('Paying now.');
    expect(result.toolCalls[0]?.providerData).toEqual({ thoughtSignature: 'sig_abc' });
  });

  it('echoes the signature back when the call re-enters the history', async () => {
    const fetch = fakeFetch(signedBody);
    await new GeminiLlm({ apiKey: 'k', model: 'gemini-3.6-flash', fetchImpl: fetch }).complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'pay acme' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'pay_vendor#0',
              name: 'pay_vendor',
              args: { vendorId: 'acct_vendor_acme' },
              providerData: { thoughtSignature: 'sig_abc' },
            },
          ],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'pay_vendor#0' },
      ],
    });

    const sent = (fetch.calls[0] as { body: { contents: { parts: unknown[] }[] } }).body;
    expect(sent.contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'pay_vendor', args: { vendorId: 'acct_vendor_acme' } },
      thoughtSignature: 'sig_abc',
    });
  });

  it('omits the key entirely for a call that never carried one', async () => {
    // An invented or empty signature is worse than none.
    const fetch = fakeFetch(signedBody);
    await new GeminiLlm({ apiKey: 'k', model: 'gemini-3.6-flash', fetchImpl: fetch }).complete({
      ...REQUEST,
      messages: [
        { role: 'user', content: 'pay acme' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'pay_vendor#0', name: 'pay_vendor', args: {} }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'pay_vendor#0' },
      ],
    });

    const sent = (fetch.calls[0] as { body: { contents: { parts: Record<string, unknown>[] }[] } })
      .body;
    expect(sent.contents[1]?.parts[0]).not.toHaveProperty('thoughtSignature');
  });
});
