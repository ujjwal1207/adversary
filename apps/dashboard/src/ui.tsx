/**
 * The small shared pieces. No component library, on purpose: a viewer whose
 * job is to make evidence legible should not have a theme with opinions.
 */

import type { ReactNode } from 'react';

// The `money` subpath, not the package root: the root reaches node:crypto
// through `canonical.ts` and will not bundle for a browser. Same function the
// report and the CLI use, so all three format money identically.
import { formatPaise } from '@adversary/core/money';

import type { Paise } from './types';

/** Money, formatted exactly as the report formats it - same function. */
export function Money({ paise }: { paise: Paise | number | null }): ReactNode {
  if (paise === null) return <span className="text-slate-400">not measured</span>;
  return <span className="tabular-nums">{formatPaise(paise as Paise)}</span>;
}

export function Pct({ value }: { value: number | null }): ReactNode {
  if (value === null) return <span className="text-slate-400">not measured</span>;
  return <span className="tabular-nums">{(value * 100).toFixed(1)}%</span>;
}

const STATUS_STYLE: Record<string, string> = {
  pass: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  blocked: 'bg-sky-100 text-sky-900 ring-sky-300',
  violated: 'bg-red-100 text-red-900 ring-red-400',
  error: 'bg-amber-100 text-amber-900 ring-amber-400',
  allow: 'bg-slate-100 text-slate-700 ring-slate-300',
  escalate: 'bg-violet-100 text-violet-900 ring-violet-300',
  bypassed: 'bg-slate-100 text-slate-500 ring-slate-300',
  ok: 'bg-slate-100 text-slate-700 ring-slate-300',
  not_executed: 'bg-slate-100 text-slate-500 ring-slate-300',
  failed: 'bg-amber-100 text-amber-900 ring-amber-300',
};

export function Pill({
  value,
  title,
}: {
  value: string;
  // `| undefined` explicitly, because exactOptionalPropertyTypes distinguishes
  // "absent" from "present and undefined", and a caller passing `x ?? undefined`
  // is doing the second.
  title?: string | undefined;
}): ReactNode {
  const style = STATUS_STYLE[value] ?? 'bg-slate-100 text-slate-700 ring-slate-300';
  return (
    <span
      title={title}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {value}
    </span>
  );
}

/**
 * The badge docs/THREAT-MODEL.md requires to be in the interface itself.
 *
 * A reader looking at a dispute trajectory must be able to see that the dispute
 * was manufactured without having read the documentation first, so this is
 * rendered from the snapshot's `synthetic` field - which is computed from the
 * event payloads - and never from a hand-written list of scenarios.
 */
export function SyntheticBadge({ reason }: { reason?: string | undefined }): ReactNode {
  return (
    <span
      title={
        reason ??
        'Part of this run is manufactured. Disputes and chargebacks cannot be ' +
          'created in a payment provider test mode, so the event was fabricated ' +
          'by the harness and is labelled in the payload itself.'
      }
      className="inline-block rounded bg-amber-200 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-950 ring-1 ring-inset ring-amber-500"
    >
      synthetic
    </span>
  );
}

/** Says plainly that a mock-rail number came out of a simulator. */
export function RailBadge({ rail }: { rail: string }): ReactNode {
  const mock = rail === 'mock';
  return (
    <span
      title={
        mock
          ? 'Measured against the mock rail: a deterministic simulator, not a payment provider. Mock and live numbers are never aggregated.'
          : 'Measured against a payment provider in test mode.'
      }
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
        mock
          ? 'bg-slate-200 text-slate-700 ring-slate-400'
          : 'bg-indigo-100 text-indigo-900 ring-indigo-400'
      }`}
    >
      {mock ? 'mock rail · simulated' : `${rail} · test mode`}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export function Json({ value }: { value: unknown }): ReactNode {
  return (
    <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs leading-relaxed text-slate-700 ring-1 ring-inset ring-slate-200">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
