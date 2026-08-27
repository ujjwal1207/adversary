/**
 * Screen 2 - the run list.
 *
 * Filterable, because the interesting question is almost never "how did all
 * sixty do" but "show me the attacks that still succeeded with the gate on".
 * The filters are plain state and plain selects; there is no URL router,
 * because a viewer that fits on one screen does not need one.
 */

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { Snapshot, SnapshotRun, SnapshotScenario } from './types';
import { Money, Pill, SyntheticBadge } from './ui';

export interface Filters {
  family: string;
  kind: string;
  gate: string;
  verdict: string;
  text: string;
}

export const NO_FILTER = 'all';

export const EMPTY_FILTERS: Filters = {
  family: NO_FILTER,
  kind: NO_FILTER,
  gate: 'on',
  verdict: NO_FILTER,
  text: '',
};

export function RunList({
  snapshot,
  onOpen,
}: {
  snapshot: Snapshot;
  onOpen: (runId: string) => void;
}): ReactNode {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // A run cites the exact scenario version it ran against, so the lookup is by
  // (id, contentHash): a scorecard from last month must stay explainable by the
  // corpus that produced it, not by whatever the file says today.
  const scenarios = useMemo(
    () => new Map(snapshot.scenarios.map((s) => [`${s.id}|${s.contentHash}`, s])),
    [snapshot],
  );

  const latest = useMemo(() => newestAttempts(snapshot.runs), [snapshot]);
  const rows = latest
    .map((run) => ({ run, scenario: scenarios.get(`${run.scenarioId}|${run.scenarioContentHash}`) }))
    .filter(({ run, scenario }) => matches(run, scenario, filters));

  const families = [...new Set(snapshot.scenarios.map((s) => s.family))].sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Family"
          value={filters.family}
          options={[NO_FILTER, ...families]}
          onChange={(family) => setFilters({ ...filters, family })}
        />
        <Select
          label="Kind"
          value={filters.kind}
          options={[NO_FILTER, 'attack', 'benign']}
          onChange={(kind) => setFilters({ ...filters, kind })}
        />
        <Select
          label="Gate"
          value={filters.gate}
          options={[NO_FILTER, 'on', 'off']}
          onChange={(gate) => setFilters({ ...filters, gate })}
        />
        <Select
          label="Verdict"
          value={filters.verdict}
          options={[NO_FILTER, 'pass', 'blocked', 'violated', 'error']}
          onChange={(verdict) => setFilters({ ...filters, verdict })}
        />
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Search</span>
          <input
            type="search"
            value={filters.text}
            placeholder="scenario id or title"
            onChange={(e) => setFilters({ ...filters, text: e.target.value })}
            className="w-64 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
        >
          Reset
        </button>
        <span className="ml-auto text-sm text-slate-500">
          {rows.length} of {latest.length} runs
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Scenario</th>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Gate</th>
              <th className="px-3 py-2 font-medium">Verdict</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="Actions the rail actually carried out. Everything else was blocked, escalated, or failed."
              >
                Executed
              </th>
              <th
                className="px-3 py-2 text-right font-medium"
                title="What actually left, read off the ledger. On a benign run this is legitimate spend, which is why the scorecard counts blast radius on attack scenarios only."
              >
                Moved
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, scenario }) => (
              <tr key={run.runId} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {/* A real button, not a click handler on the row: a <tr>
                        carries no role, so a keyboard user could not open a
                        run and neither could anything reading the page
                        structurally. */}
                    <button
                      type="button"
                      onClick={() => onOpen(run.runId)}
                      className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                    >
                      {run.scenarioId}
                    </button>
                    {run.synthetic ? <SyntheticBadge /> : null}
                    {run.error === null ? null : <Pill value="error" title={run.error} />}
                  </div>
                  <div className="text-xs text-slate-500">{scenario?.title ?? '—'}</div>
                </td>
                <td className="px-3 py-2 text-slate-600">{scenario?.family ?? '—'}</td>
                <td className="px-3 py-2 text-slate-600">{scenario?.kind ?? '—'}</td>
                <td className="px-3 py-2 text-slate-600">{run.gateEnabled ? 'on' : 'off'}</td>
                <td className="px-3 py-2">
                  <Pill value={run.verdict ?? 'error'} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                  {run.actions.length}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                  {run.actions.filter((a) => a.railResult === 'ok').length}
                </td>
                <td className="px-3 py-2 text-right">
                  <Money paise={moved(run)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            No runs match these filters.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function matches(
  run: SnapshotRun,
  scenario: SnapshotScenario | undefined,
  f: Filters,
): boolean {
  if (f.family !== NO_FILTER && scenario?.family !== f.family) return false;
  if (f.kind !== NO_FILTER && scenario?.kind !== f.kind) return false;
  if (f.gate !== NO_FILTER && run.gateEnabled !== (f.gate === 'on')) return false;
  if (f.verdict !== NO_FILTER && (run.verdict ?? 'error') !== f.verdict) return false;

  if (f.text.trim() !== '') {
    const needle = f.text.trim().toLowerCase();
    const hay = `${run.scenarioId} ${scenario?.title ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }

  return true;
}

/**
 * The newest attempt of each experiment.
 *
 * The same rule the scorecard reader uses: re-running a scenario should replace
 * its row, not add a second one, or a list of sixty scenarios would show a
 * hundred and twenty the second time anyone pressed the button. Older attempts
 * are still in the snapshot; nothing is deleted.
 */
function newestAttempts(runs: readonly SnapshotRun[]): SnapshotRun[] {
  const best = new Map<string, SnapshotRun>();
  for (const run of runs) {
    const seen = best.get(run.runKey);
    if (seen === undefined || run.attempt > seen.attempt) best.set(run.runKey, run);
  }
  return [...best.values()].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

/**
 * What actually moved, read off the ledger rather than off any verdict's claim.
 *
 * Not called blast radius: on a benign run this is money the agent was supposed
 * to move. The scorecard's blast radius counts attack scenarios only.
 */
function moved(run: SnapshotRun): number {
  return run.actions
    .filter((a) => a.railResult === 'ok')
    .reduce((sum, a) => sum + a.amountPaise, 0);
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
