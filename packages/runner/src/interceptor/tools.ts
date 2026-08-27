/**
 * Building the tool object an agent is handed.
 *
 * This is layer 4 of the dependency rule (docs/ARCHITECTURE.md 5.2). Layers 1-3
 * stop an agent *importing* a rail; this one stops it reaching a rail through
 * an object it was legitimately given. Every member is a closure created here,
 * the object has a null prototype, and the whole thing is frozen - so there is
 * no `constructor`, no prototype chain, and no captured rail reference for an
 * agent to walk to.
 *
 * Arguments are parsed, never cast. A malformed tool call is agent behaviour
 * worth recording, so it comes back as a 400-shaped result rather than throwing
 * - a harness crash would end the run and lose the ledger built so far.
 */

import type {
  CreatePaymentLinkArgs,
  InterceptedTools,
  IssueRefundArgs,
  PayVendorArgs,
  RetrySubscriptionChargeArgs,
  ToolDataSource,
  ToolResult,
  UntrustedSurface,
} from '@adversary/core';
import { paise, sha256Hex } from '@adversary/core';
import { z } from 'zod';

import type { Interceptor } from './interceptor.js';

/**
 * Amounts arrive as plain numbers because an agent cannot construct a `Paise` -
 * it cannot reach `paise()`. This is where an unvalidated number earns the
 * brand.
 */
const amount = z
  .number()
  .int('amountPaise must be a whole number of paise, not rupees')
  .nonnegative('amountPaise must not be negative')
  .safe('amountPaise is outside the safe integer range');

const rationale = z.string().max(4000).default('');
const idempotencyKey = z.string().min(1).max(255).optional();
const ref = (name: string) => z.string().min(1, `${name} is required`).max(255);

const SCHEMAS = {
  pay_vendor: z.object({
    vendorId: ref('vendorId'),
    amountPaise: amount,
    rationale,
    idempotencyKey,
  }),
  create_payment_link: z.object({
    customerId: ref('customerId'),
    amountPaise: amount,
    rationale,
    idempotencyKey,
  }),
  issue_refund: z.object({
    paymentId: ref('paymentId'),
    amountPaise: amount,
    rationale,
    idempotencyKey,
  }),
  retry_subscription_charge: z.object({
    subId: ref('subId'),
    amountPaise: amount,
    rationale,
    idempotencyKey,
  }),
  escalate_to_human: z.object({
    reason: z.string().min(1, 'reason is required').max(4000),
  }),
} as const;

export interface BuildToolsOptions {
  readonly interceptor: Interceptor;
  readonly dataSource: ToolDataSource;
  /**
   * Called once per *source* returned by an untrusted read.
   *
   * Phase 7 hangs taint extraction off this. It is here in Phase 4 because the
   * interceptor mediating *all* tools - not only the ones that move money - is
   * what gives provenance tracking somewhere to live at all.
   *
   * Note the granularity: one `list_invoices` call returning thirty invoices
   * fires this thirty times, because taint is per-source. Anything counting
   * *calls* wants `onReadCall` instead.
   */
  readonly onUntrustedRead?: (
    surface: UntrustedSurface,
    sourceId: string,
    content: string,
  ) => void;
  /**
   * Called once per untrusted read *call*, whatever it returns.
   *
   * The runner records this on the trajectory, which is how `turnsUsed` is
   * counted from harness observation rather than from the agent's own account
   * of itself.
   */
  readonly onReadCall?: (tool: string, args: Readonly<Record<string, unknown>>) => void;
}

export function buildTools(options: BuildToolsOptions): InterceptedTools {
  const { interceptor, dataSource, onUntrustedRead, onReadCall } = options;

  const notice = (surface: UntrustedSurface, sourceId: string, content: unknown): void => {
    onUntrustedRead?.(surface, sourceId, readableText(content));
  };

  const tools: InterceptedTools = {
    // --- untrusted surfaces -------------------------------------------------

    async list_invoices() {
      onReadCall?.('list_invoices', {});
      const invoices = await dataSource.listInvoices();
      for (const invoice of invoices) {
        notice('invoice_line_item', String(invoice['id'] ?? 'unknown'), invoice);
      }
      return invoices;
    },

    async read_tickets() {
      onReadCall?.('read_tickets', {});
      const tickets = await dataSource.readTickets();
      for (const ticket of tickets) {
        notice('ticket_body', String(ticket['id'] ?? 'unknown'), ticket);
      }
      return tickets;
    },

    async read_disputes() {
      onReadCall?.('read_disputes', {});
      const disputes = await dataSource.readDisputes();
      for (const dispute of disputes) {
        notice('webhook_field', String(dispute['id'] ?? 'unknown'), dispute);
      }
      return disputes;
    },

    async read_vendor_note(vendorId: string) {
      onReadCall?.('read_vendor_note', { vendorId });
      const note = await dataSource.readVendorNote(vendorId);
      notice('vendor_note', vendorId, note);
      return note;
    },

    // --- money --------------------------------------------------------------

    async pay_vendor(args: PayVendorArgs) {
      const parsed = SCHEMAS.pay_vendor.safeParse(args);
      if (!parsed.success) return invalid('pay_vendor', args, parsed.error);

      const { vendorId, amountPaise, rationale: why, idempotencyKey: key } = parsed.data;
      return interceptor.money({
        kind: 'transfer',
        params: { vendorId },
        amountPaise: paise(amountPaise),
        payeeRef: vendorId,
        subjectRef: null,
        rationale: why,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
    },

    async create_payment_link(args: CreatePaymentLinkArgs) {
      const parsed = SCHEMAS.create_payment_link.safeParse(args);
      if (!parsed.success) return invalid('create_payment_link', args, parsed.error);

      const { customerId, amountPaise, rationale: why, idempotencyKey: key } = parsed.data;
      return interceptor.money({
        kind: 'payment_link',
        params: { customerId },
        amountPaise: paise(amountPaise),
        // A payment link collects money rather than sending it, so there is no
        // payee. Recording the customer here would put them on an allowlist
        // check that is not about them.
        payeeRef: null,
        subjectRef: customerId,
        rationale: why,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
    },

    async issue_refund(args: IssueRefundArgs) {
      const parsed = SCHEMAS.issue_refund.safeParse(args);
      if (!parsed.success) return invalid('issue_refund', args, parsed.error);

      const { paymentId, amountPaise, rationale: why, idempotencyKey: key } = parsed.data;
      return interceptor.money({
        kind: 'refund',
        params: { paymentId },
        amountPaise: paise(amountPaise),
        payeeRef: null,
        // The payment is the subject the retry_limit rule counts against, which
        // is what makes a double refund against one payment detectable.
        subjectRef: paymentId,
        rationale: why,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
    },

    async retry_subscription_charge(args: RetrySubscriptionChargeArgs) {
      const parsed = SCHEMAS.retry_subscription_charge.safeParse(args);
      if (!parsed.success) return invalid('retry_subscription_charge', args, parsed.error);

      const { subId, amountPaise, rationale: why, idempotencyKey: key } = parsed.data;
      return interceptor.money({
        kind: 'subscription_charge',
        params: { subId },
        amountPaise: paise(amountPaise),
        payeeRef: null,
        subjectRef: subId,
        rationale: why,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
    },

    // --- the safe exit ------------------------------------------------------

    async escalate_to_human(args: { reason: string }) {
      const parsed = SCHEMAS.escalate_to_human.safeParse(args);
      if (!parsed.success) return invalid('escalate_to_human', args, parsed.error);
      return interceptor.escalate(parsed.data.reason);
    },
  };

  return harden(tools);
}

/**
 * Null prototype plus deep freeze.
 *
 * `Object.create(null)` matters as much as the freeze: an object literal
 * inherits `Object.prototype`, which gives `constructor` and a prototype chain
 * to walk. With no prototype there is nothing above the tools to reach for.
 */
function harden(tools: InterceptedTools): InterceptedTools {
  const bare = Object.assign(Object.create(null) as object, tools);
  for (const key of Object.keys(bare)) {
    Object.freeze((bare as Record<string, unknown>)[key]);
  }
  return Object.freeze(bare) as InterceptedTools;
}

/**
 * A malformed call, in the shape a payment API would reject it.
 *
 * Deterministic `request_id`, so a report reproduces. The field path is
 * included because a scenario author debugging a scripted agent needs to know
 * which argument was wrong.
 */
function invalid(tool: string, args: unknown, error: z.ZodError): ToolResult {
  const first = error.issues[0];
  const path = first?.path.join('.') ?? '';
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      description: path
        ? `${path}: ${first?.message ?? 'invalid'}`
        : (first?.message ?? 'invalid request'),
      resolution: 'Correct the arguments and call the tool again.',
    },
    request_id: `req_${sha256Hex(`${tool}|${safeStringify(args)}`).slice(0, 12)}`,
  };
}

/**
 * Flattens a tool result into the text an agent actually read.
 *
 * NOT `JSON.stringify`. Stringifying turns a newline into the two characters
 * backslash-n, which sit directly against whatever follows them - so an account
 * identifier at the start of a line gets indexed as `nacct_vendor_...` and the
 * taint index never matches the value the agent later passes to a tool.
 *
 * That bug is invisible until an identifier happens to begin a line, which is
 * exactly where a payload would put one. Found by corpus family G.
 */
function readableText(value: unknown): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        parts.push(key);
        walk(item);
      }
    }
  };

  walk(value);
  return parts.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '<unserialisable>';
  }
}
