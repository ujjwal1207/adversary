/**
 * The MCP transport.
 *
 * Preferred over REST because some provider tools are restricted on hosted or
 * remote MCP servers, and running the provider's server locally gets the full
 * tool set (docs/ARCHITECTURE.md 3).
 *
 * The session itself is injected. Wiring a stdio child process to a specific
 * vendor's MCP server is deployment detail that would make this module
 * untestable without that vendor installed; what belongs here is the mapping
 * between a money action and a tool call, which is the part that can be wrong.
 *
 * NOT exercised against a real MCP server - see docs/LIMITATIONS.md.
 */

import { assertTestKey } from './test-key.js';
import type { ProviderClient, ProviderOutcome, ProviderRequest } from './provider-client.js';
import { outcomeForTransportError } from './provider-client.js';

/** The one thing this client needs from an MCP session. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  readonly keyId: string;
  readonly session: McpTransport;
  /** Overrides for a provider whose tool names differ. */
  readonly toolNames?: Readonly<Record<string, string>>;
}

const DEFAULT_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  transfer: 'payouts.create',
  payment_link: 'payment_links.create',
  refund: 'refunds.create',
  subscription_charge: 'subscriptions.charge',
});

export class McpProviderClient implements ProviderClient {
  readonly transport = 'mcp' as const;

  readonly #session: McpTransport;
  readonly #tools: Readonly<Record<string, string>>;

  constructor(options: McpClientOptions) {
    // Same guard as the REST client, in the constructor, for the same reason.
    assertTestKey(options.keyId, 'key id');

    this.#session = options.session;
    this.#tools = { ...DEFAULT_TOOLS, ...options.toolNames };
  }

  async execute(request: ProviderRequest): Promise<ProviderOutcome> {
    const tool = this.#tools[request.kind];
    if (tool === undefined) {
      return {
        ok: false,
        code: 'unsupported_kind',
        message: `No MCP tool mapped for ${request.kind}.`,
        retryable: false,
        ambiguous: false,
      };
    }

    try {
      const result = (await this.#session.callTool(tool, {
        amount: request.amountPaise,
        currency: 'INR',
        ...(request.payeeRef === null ? {} : { fund_account_id: request.payeeRef }),
        ...(request.subjectRef === null ? {} : { reference_id: request.subjectRef }),
        idempotency_key: request.idempotencyKey,
        notes: request.notes,
      })) as { id?: string; error?: { code?: string; message?: string } } | null;

      if (result?.error) {
        return {
          ok: false,
          code: result.error.code ?? 'provider_error',
          message: result.error.message ?? 'MCP tool returned an error.',
          retryable: false,
          ambiguous: false,
        };
      }

      if (result?.id) return { ok: true, ref: result.id };

      return {
        ok: false,
        code: 'malformed_response',
        message: 'MCP tool returned no id.',
        retryable: false,
        ambiguous: true,
      };
    } catch (err) {
      return outcomeForTransportError(err);
    }
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}
