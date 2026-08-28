/**
 * ScriptedAgent - a fixed sequence of tool calls, replayed.
 *
 * This is not a convenience. It is the component that makes the rest of the
 * project checkable:
 *
 *   - the determinism gate can test *the harness* rather than the model, since
 *     a scripted run has no source of variation at all
 *   - CI runs the entire corpus on every push with no API key and no network
 *   - a scenario author can reproduce an attack exactly, rather than hoping a
 *     model chooses to attempt it
 *
 * It is deliberately incapable of reacting to what it sees. A scripted step
 * that failed is followed by the next scripted step, because a script that
 * branched on results would be a small agent, and then determinism would depend
 * on the branch conditions rather than on the script.
 */

import type {
  AgentContext,
  AgentRunResult,
  AgentTranscriptEvent,
  CreatePaymentLinkArgs,
  IssueRefundArgs,
  PaymentAgent,
  PayVendorArgs,
  RetrySubscriptionChargeArgs,
  ToolResult,
} from '@adversary/core/contracts';

export type ScriptedStep =
  /** A message the agent "says". Recorded, never trusted. */
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'list_invoices' }
  | { readonly kind: 'read_tickets' }
  | { readonly kind: 'read_vendor_note'; readonly vendorId: string }
  | { readonly kind: 'read_disputes' }
  | { readonly kind: 'read_subscriptions' }
  | { readonly kind: 'read_payments' }
  | { readonly kind: 'pay_vendor'; readonly args: PayVendorArgs }
  | { readonly kind: 'create_payment_link'; readonly args: CreatePaymentLinkArgs }
  | { readonly kind: 'issue_refund'; readonly args: IssueRefundArgs }
  | {
      readonly kind: 'retry_subscription_charge';
      readonly args: RetrySubscriptionChargeArgs;
    }
  | { readonly kind: 'escalate_to_human'; readonly reason: string };

export interface ScriptedAgentOptions {
  readonly script: readonly ScriptedStep[];
  /** Defaults to `scripted`. Named runs make a report easier to read. */
  readonly name?: string;
  readonly finalMessage?: string;
}

export class ScriptedAgent implements PaymentAgent {
  readonly name: string;
  readonly version = '1.0.0';

  readonly #script: readonly ScriptedStep[];
  readonly #finalMessage: string;

  constructor(options: ScriptedAgentOptions) {
    this.name = options.name ?? 'scripted';
    this.#script = options.script;
    this.#finalMessage = options.finalMessage ?? 'Script complete.';
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const transcript: AgentTranscriptEvent[] = [
      {
        role: 'user',
        kind: 'user',
        content: { goal: ctx.goal },
      },
    ];

    for (const step of this.#script) {
      // The runner's turn and wall-clock caps reach the agent as an abort
      // signal. A scripted agent honours it like any other, so a script longer
      // than the cap is truncated rather than silently exceeding it.
      if (ctx.signal.aborted) {
        transcript.push({
          role: 'harness',
          kind: 'assistant',
          content: { aborted: true, reason: 'run cap reached before script finished' },
        });
        break;
      }

      transcript.push(...(await this.#step(ctx, step)));
    }

    return { transcript, finalMessage: this.#finalMessage };
  }

  async #step(ctx: AgentContext, step: ScriptedStep): Promise<AgentTranscriptEvent[]> {
    const { tools } = ctx;

    switch (step.kind) {
      case 'say':
        return [{ role: 'assistant', kind: 'assistant', content: { text: step.text } }];

      case 'list_invoices':
        return this.#read('list_invoices', {}, await tools.list_invoices());

      case 'read_tickets':
        return this.#read('read_tickets', {}, await tools.read_tickets());

      case 'read_disputes':
        return this.#read('read_disputes', {}, await tools.read_disputes());

      case 'read_subscriptions':
        return this.#read('read_subscriptions', {}, await tools.read_subscriptions());

      case 'read_payments':
        return this.#read('read_payments', {}, await tools.read_payments());

      case 'read_vendor_note':
        return this.#read(
          'read_vendor_note',
          { vendorId: step.vendorId },
          await tools.read_vendor_note(step.vendorId),
        );

      case 'pay_vendor':
        return this.#call('pay_vendor', step.args, await tools.pay_vendor(step.args));

      case 'create_payment_link':
        return this.#call(
          'create_payment_link',
          step.args,
          await tools.create_payment_link(step.args),
        );

      case 'issue_refund':
        return this.#call('issue_refund', step.args, await tools.issue_refund(step.args));

      case 'retry_subscription_charge':
        return this.#call(
          'retry_subscription_charge',
          step.args,
          await tools.retry_subscription_charge(step.args),
        );

      case 'escalate_to_human':
        return this.#call(
          'escalate_to_human',
          { reason: step.reason },
          await tools.escalate_to_human({ reason: step.reason }),
        );
    }
  }

  #call(tool: string, args: unknown, result: ToolResult): AgentTranscriptEvent[] {
    return [
      { role: 'assistant', kind: 'tool_call', content: { tool, args } },
      { role: 'tool', kind: 'tool_result', content: { tool, result } },
    ];
  }

  #read(tool: string, args: unknown, content: unknown): AgentTranscriptEvent[] {
    return [
      { role: 'assistant', kind: 'tool_call', content: { tool, args } },
      { role: 'tool', kind: 'tool_result', content: { tool, content } },
    ];
  }
}
