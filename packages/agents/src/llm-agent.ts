/**
 * The loop `Ops` and `NaiveOps` share.
 *
 * One class, parameterised by name and system prompt. That is not code reuse
 * for its own sake: if the two agents differed in loop mechanics as well as in
 * prompt, the comparison between them would confound the two and the baseline
 * would stop being a baseline.
 *
 * The loop is deliberately unremarkable, and this is the repeated instruction
 * in the build spec worth taking seriously. There is no planning phase, no
 * reflection step, no self-critique, no retry heuristic, no summarisation. The
 * reference agents are test fixtures: every improvement to their capability
 * makes the evaluation less informative, because a corpus that only a weak
 * agent fails measures nothing once agents improve
 * (docs/ARCHITECTURE.md P7).
 *
 * Agent sophistication is a variable the *user* supplies, through the
 * PaymentAgent interface. It is not something this package ships.
 */

import type {
  AgentContext,
  AgentRunResult,
  AgentTranscriptEvent,
  InterceptedTools,
  LlmClient,
  LlmMessage,
  LlmToolCall,
  PaymentAgent,
} from '@adversary/core/contracts';

import { TOOL_SPECS } from './tool-specs.js';

export interface LlmAgentOptions {
  readonly name: string;
  readonly version: string;
  readonly llm: LlmClient;
  readonly systemPrompt: (ctx: AgentContext) => string;
  /** Safety net beneath the runner's own cap. */
  readonly maxTurns?: number;
  readonly maxTokens?: number;
}

export class LlmAgent implements PaymentAgent {
  readonly name: string;
  readonly version: string;

  readonly #llm: LlmClient;
  readonly #systemPrompt: (ctx: AgentContext) => string;
  readonly #maxTurns: number;
  readonly #maxTokens: number;

  constructor(options: LlmAgentOptions) {
    this.name = options.name;
    this.version = options.version;
    this.#llm = options.llm;
    this.#systemPrompt = options.systemPrompt;
    this.#maxTurns = options.maxTurns ?? 12;
    this.#maxTokens = options.maxTokens ?? 2048;
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const system = this.#systemPrompt(ctx);
    const messages: LlmMessage[] = [{ role: 'user', content: ctx.goal }];

    const transcript: AgentTranscriptEvent[] = [
      { role: 'system', kind: 'system', content: { system, model: this.#llm.model } },
      { role: 'user', kind: 'user', content: { goal: ctx.goal } },
    ];

    let finalMessage = '';

    for (let turn = 0; turn < this.#maxTurns; turn += 1) {
      if (ctx.signal.aborted) {
        transcript.push({
          role: 'harness',
          kind: 'assistant',
          content: { aborted: true, reason: 'run cap reached', turn },
        });
        break;
      }

      let completion;
      try {
        completion = await this.#llm.complete({
          system,
          messages,
          tools: TOOL_SPECS,
          // Pinned by the harness, not chosen by the agent.
          temperature: 0,
          maxTokens: this.#maxTokens,
          signal: ctx.signal,
        });
      } catch (err) {
        // A bounded, logged fallback. Never a silent retry, never an unbounded
        // one - the run ends and says why (docs/ARCHITECTURE.md 14).
        transcript.push({
          role: 'harness',
          kind: 'assistant',
          content: {
            error: 'llm_error',
            detail: err instanceof Error ? err.message : String(err),
            turn,
          },
        });
        finalMessage = 'The model call failed; stopping.';
        break;
      }

      if (completion.text) {
        transcript.push({
          role: 'assistant',
          kind: 'assistant',
          content: { text: completion.text },
        });
        finalMessage = completion.text;
      }

      if (completion.toolCalls.length === 0) break;

      for (const call of completion.toolCalls) {
        const result = await this.#dispatch(ctx.tools, call);

        transcript.push({
          role: 'assistant',
          kind: 'tool_call',
          content: { tool: call.name, args: call.args },
        });
        transcript.push({
          role: 'tool',
          kind: 'tool_result',
          content: { tool: call.name, result },
        });

        messages.push({
          role: 'assistant',
          content: completion.text,
          toolCalls: [call],
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }
    }

    return { transcript, finalMessage };
  }

  /**
   * Routes a model tool call to the intercepted tool.
   *
   * An unknown name comes back as a tool result rather than throwing, because
   * a model naming a tool that does not exist is agent behaviour worth
   * recording - and because a throw here would end the run and lose the ledger.
   */
  async #dispatch(tools: InterceptedTools, call: LlmToolCall): Promise<unknown> {
    const args = call.args as never;

    switch (call.name) {
      case 'list_invoices':
        return tools.list_invoices();
      case 'read_tickets':
        return tools.read_tickets();
      case 'read_subscriptions':
        return tools.read_subscriptions();
      case 'read_payments':
        return tools.read_payments();
      case 'read_vendor_note':
        return tools.read_vendor_note(String((call.args as { vendorId?: unknown }).vendorId));
      case 'pay_vendor':
        return tools.pay_vendor(args);
      case 'create_payment_link':
        return tools.create_payment_link(args);
      case 'issue_refund':
        return tools.issue_refund(args);
      case 'retry_subscription_charge':
        return tools.retry_subscription_charge(args);
      case 'escalate_to_human':
        return tools.escalate_to_human(args);
      default:
        return {
          ok: false,
          error: {
            code: 'unknown_tool',
            description: `No tool named ${call.name}.`,
          },
          request_id: 'req_unknown_tool',
        };
    }
  }
}
