/**
 * Screen 1 - the scorecard.
 *
 * Both cards are rendered by one function called twice. That is not tidiness:
 * it is the reason no code path exists that can render effectiveness without
 * cost. The report does the same thing for the same reason
 * (docs/ARCHITECTURE.md P4).
 */

import type { ReactNode } from 'react';

import type { GateComparison, Scorecard } from './types';
import { Field, Money, Pct, RailBadge } from './ui';

export function ScorecardView({ comparison }: { comparison: GateComparison }): ReactNode {
  const { ungated, gated, rail } = comparison;

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold text-slate-900">The two numbers</h2>
          <RailBadge rail={rail} />
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Neither means anything alone. A gate that refuses every payment scores a perfect
          attack success rate, and a gate that allows every payment costs nothing in false
          positives. Read them together or not at all.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Card title="Gate off" subtitle="the same agent, unprotected" card={ungated} />
          <Card title="Gate on" subtitle="the deterministic policy gate" card={gated} />
        </div>
      </section>

      <Families ungated={ungated} gated={gated} />
      <Provenance ungated={ungated} gated={gated} />
    </div>
  );
}

function Card({
  title,
  subtitle,
  card,
}: {
  title: string;
  subtitle: string;
  card: Scorecard;
}): ReactNode {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <span className="text-xs text-slate-500">{subtitle}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Headline label="Attack success" value={<Pct value={card.effectiveness.attackSuccessRate} />} />
        <Headline
          label="False-positive cost"
          value={<Money paise={card.cost.falsePositiveCostPaise} />}
        />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
        <Field label="Containment">
          <Pct value={card.effectiveness.containmentRate} />
        </Field>
        <Field label="Over-refusal">
          <Pct value={card.cost.overRefusalRate} />
        </Field>
        <Field label="Blast radius">
          <Money paise={card.effectiveness.blastRadiusPaise} />
        </Field>
        <Field label="Mean actions to violation">
          {card.effectiveness.meanActionsToViolation === null ? (
            <span className="text-slate-400">not measured</span>
          ) : (
            card.effectiveness.meanActionsToViolation.toFixed(2)
          )}
        </Field>
        <Field label="Attacks">
          {card.effectiveness.violated} violated · {card.effectiveness.blocked} blocked ·{' '}
          {card.effectiveness.attackScenarios} total
        </Field>
        <Field label="Benign">
          {card.cost.refused} refused · {card.cost.benignScenarios} total
        </Field>
      </dl>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <Field label="Recognition–execution gap">
          <span className="flex items-baseline gap-2">
            <Pct value={card.heuristics.recognitionExecutionGap} />
            <span
              title="Substring matching over the agent's stated rationale. It cannot tell whether a model understood anything."
              className="rounded bg-amber-100 px-1 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300"
            >
              heuristic
            </span>
          </span>
        </Field>
      </div>
    </div>
  );
}

function Headline({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="rounded bg-slate-50 p-3 ring-1 ring-inset ring-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function Families({ ungated, gated }: { ungated: Scorecard; gated: Scorecard }): ReactNode {
  const byFamily = new Map(gated.families.map((f) => [f.family, f]));

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900">By family</h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Where the gate helps and where it does not. Families whose attacks survive with the
        gate on are the ones it has no rule for — scope and stop-rules — and they are in the
        corpus deliberately.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-3 font-medium">Family</th>
              <th className="py-2 pr-3 font-medium">Attacks</th>
              <th className="py-2 pr-3 font-medium">Success, gate off</th>
              <th className="py-2 pr-3 font-medium">Success, gate on</th>
              <th className="py-2 pr-3 font-medium">Blast, gate on</th>
              <th className="py-2 pr-3 font-medium">FP cost, gate on</th>
            </tr>
          </thead>
          <tbody>
            {ungated.families.map((off) => {
              const on = byFamily.get(off.family);
              return (
                <tr key={off.family} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium text-slate-900">{off.family}</td>
                  <td className="py-2 pr-3 tabular-nums text-slate-600">{off.attackScenarios}</td>
                  <td className="py-2 pr-3">
                    <Pct value={off.attackSuccessRate} />
                  </td>
                  <td className="py-2 pr-3">
                    <Pct value={on?.attackSuccessRate ?? null} />
                  </td>
                  <td className="py-2 pr-3">
                    <Money paise={on?.blastRadiusPaise ?? null} />
                  </td>
                  <td className="py-2 pr-3">
                    <Money paise={on?.falsePositiveCostPaise ?? null} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Provenance({ ungated, gated }: { ungated: Scorecard; gated: Scorecard }): ReactNode {
  const p = gated.provenance;

  return (
    <section className="rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
        Provenance
      </h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Scenarios">
          {p.scenarioCount} measured, both gate states
          {ungated.provenance.scenarioCount === p.scenarioCount ? '' : ' (counts differ)'}
        </Field>
        <Field label="Agent">
          {p.agentName}@{p.agentVersion}
          {p.model === null ? '' : ` · ${p.model}`}
        </Field>
        <Field label="Reproducibility">{p.reproducibility}</Field>
        <Field label="Errored runs">{p.errored}</Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <Field label="Corpus hash">
            <code className="break-all text-xs">{p.corpusHash}</code>
          </Field>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <Field label="Seeds">
            <code className="break-all text-xs">
              {p.seeds.length === 0 ? 'per-scenario' : p.seeds.join(', ')}
            </code>
          </Field>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        A scorecard with no corpus hash is not a result. These figures describe the set of
        scenarios named by that hash and nothing beyond it: absence of violations means the
        corpus found none, not that none exist.
      </p>
    </section>
  );
}
