/**
 * Screen 3 - the trajectory viewer.
 *
 * Messages and tool calls in the order they happened, with every money action
 * expanded where it occurred: what the agent asked for, what the gate decided
 * and which rules fired, what the rail did, and what the value was traced back
 * to. Violations are marked, and so is anything manufactured.
 *
 * This is the screen that has to survive being read by someone sceptical, so it
 * shows the evidence rather than a summary of it. Where a field is raw JSON it
 * is rendered as raw JSON.
 */

import type { ReactNode } from 'react';

import type { SnapshotAction, SnapshotEvent, SnapshotRun, SnapshotScenario } from './types';
import { Field, Json, Money, Pill, RailBadge, SyntheticBadge } from './ui';

export function TrajectoryView({
  run,
  scenario,
  onBack,
}: {
  run: SnapshotRun;
  scenario: SnapshotScenario | undefined;
  onBack: () => void;
}): ReactNode {
  const actionsById = new Map(run.actions.map((a) => [a.id, a]));
  const shown = new Set<string>();

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-slate-600 hover:text-slate-900"
      >
        ← All runs
      </button>

      <header className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900">{run.scenarioId}</h2>
          <Pill value={run.verdict ?? 'error'} />
          <RailBadge rail={run.rail} />
          {run.synthetic ? <SyntheticBadge /> : null}
          {run.error === null ? null : <Pill value="error" title={run.error} />}
        </div>
        <p className="mt-1 text-sm text-slate-600">{scenario?.title ?? ''}</p>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Gate">{run.gateEnabled ? 'on' : 'off'}</Field>
          <Field label="Agent">
            {run.agentName}@{run.agentVersion}
            {run.model === null ? '' : ` · ${run.model}`}
          </Field>
          <Field label="Reproducibility">{run.reproducibility}</Field>
          <Field label="Seed">{run.seed}</Field>
          <Field label="Turns used">{run.turnsUsed}</Field>
          <Field label="Attempt">{run.attempt}</Field>
          <div className="sm:col-span-2">
            <Field label="Scenario version">
              <code className="break-all text-xs">{run.scenarioContentHash}</code>
            </Field>
          </div>
        </dl>
      </header>

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Trajectory
        </h3>
        <ol className="mt-3 space-y-2">
          {run.trajectory.map((event) => {
            const action = linkedAction(event, actionsById);
            if (action !== undefined) shown.add(action.id);
            return (
              <li key={event.seq}>
                <Event event={event} />
                {action === undefined ? null : <Action action={action} />}
              </li>
            );
          })}
        </ol>
        {run.trajectory.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No trajectory was recorded.</p>
        ) : null}
      </section>

      {/* Anything the trajectory did not account for. A money action with no
          event beside it would otherwise be invisible here while still counting
          toward every number on the scorecard. */}
      {run.actions.some((a) => !shown.has(a.id)) ? (
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Money actions not linked to a trajectory event
          </h3>
          <div className="mt-3 space-y-2">
            {run.actions
              .filter((a) => !shown.has(a.id))
              .map((action) => (
                <Action key={action.id} action={action} />
              ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
          Invariants
        </h3>
        <div className="mt-3 overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-medium">Invariant</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Blast radius</th>
                <th className="px-3 py-2 font-medium">Witnesses</th>
              </tr>
            </thead>
            <tbody>
              {run.verdicts.map((verdict) => (
                <tr key={verdict.invariantId} className="border-b border-slate-100">
                  <td className="px-3 py-2 font-medium text-slate-900">{verdict.invariantId}</td>
                  <td className="px-3 py-2">
                    <Pill value={verdict.status} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money paise={verdict.blastRadiusPaise} />
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {verdict.witnessIds.length === 0 ? '—' : verdict.witnessIds.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The run verdict is the worst of these. Every one was decided by the invariant
          evaluator against the ledger — never by a language model.
        </p>
      </section>
    </div>
  );
}

/** The money action an event refers to, when it refers to one. */
function linkedAction(
  event: SnapshotEvent,
  byId: ReadonlyMap<string, SnapshotAction>,
): SnapshotAction | undefined {
  const id = event.content['actionId'];
  return typeof id === 'string' ? byId.get(id) : undefined;
}

const ROLE_STYLE: Record<string, string> = {
  system: 'border-slate-300 bg-slate-50',
  user: 'border-blue-200 bg-blue-50',
  assistant: 'border-emerald-200 bg-emerald-50',
  tool: 'border-violet-200 bg-violet-50',
  harness: 'border-slate-200 bg-white',
};

function Event({ event }: { event: SnapshotEvent }): ReactNode {
  const style = ROLE_STYLE[event.role] ?? 'border-slate-200 bg-white';

  return (
    <div className={`rounded border-l-4 p-3 ring-1 ring-slate-200 ${style}`}>
      <div className="flex items-baseline gap-2 text-xs text-slate-500">
        <span className="tabular-nums">{String(event.seq).padStart(2, '0')}</span>
        <span className="font-medium uppercase tracking-wide">{event.role}</span>
        <span>·</span>
        <span>{event.kind}</span>
      </div>
      <div className="mt-2">
        <Content content={event.content} />
      </div>
    </div>
  );
}

/**
 * Free text as text, everything else as JSON.
 *
 * Prose is what a reader is here to read; a `content` shaped like a tool call
 * is data, and prettifying it would mean deciding which fields matter.
 */
function Content({ content }: { content: Record<string, unknown> }): ReactNode {
  const text = content['text'] ?? content['message'] ?? content['reason'];
  const rest = Object.fromEntries(
    Object.entries(content).filter(([k]) => k !== 'text' && k !== 'message'),
  );

  return (
    <>
      {typeof text === 'string' ? (
        <p className="whitespace-pre-wrap text-sm text-slate-800">{text}</p>
      ) : null}
      {Object.keys(rest).length > 0 ? (
        <div className={typeof text === 'string' ? 'mt-2' : ''}>
          <Json value={rest} />
        </div>
      ) : null}
    </>
  );
}

function Action({ action }: { action: SnapshotAction }): ReactNode {
  // Money that moved despite the gate saying otherwise. `ok` is the only rail
  // result that means the money moved; the other two mean it did not.
  const escaped = action.railResult === 'ok' && action.gateDecision !== 'allow';

  return (
    <div
      className={`ml-6 mt-2 rounded-lg p-3 ring-1 ${
        escaped ? 'bg-red-50 ring-red-300' : 'bg-white ring-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">money action</span>
        <span className="font-medium text-slate-900">{action.kind}</span>
        <span className="text-lg font-semibold text-slate-900">
          <Money paise={action.amountPaise} />
        </span>
        <Pill value={action.gateDecision} />
        <Pill value={action.railResult} title={action.railError ?? undefined} />
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Payee">
          <code className="text-xs">{action.payeeRef ?? '—'}</code>
        </Field>
        <Field label="Subject">
          <code className="text-xs">{action.subjectRef ?? '—'}</code>
        </Field>
        <Field label="Rail reference">
          <code className="text-xs">{action.railRef ?? '—'}</code>
        </Field>
        <Field label="Idempotency key">
          <code className="break-all text-xs">{action.idempotencyKey}</code>
        </Field>
        <Field label="Key source">{action.idempotencySource}</Field>
        <Field label="Sequence">{action.seq}</Field>
      </dl>

      {action.agentRationale === '' ? null : (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Agent&rsquo;s stated reason
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-sm italic text-slate-700">
            {action.agentRationale}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Evidence about the agent, never evidence about what happened. Only the
            recognition–execution heuristic reads this field.
          </p>
        </div>
      )}

      {action.gateReasons.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">Gate reasons</div>
          <ul className="mt-1 list-inside list-disc text-sm text-slate-800">
            {action.gateReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-500">
          Rule trace ({action.ruleTrace.length}) · taint ({action.taint.length}) · params
        </summary>
        <div className="mt-2 space-y-2">
          <Json value={action.ruleTrace} />
          <Json value={action.taint} />
          <Json value={action.params} />
        </div>
      </details>
    </div>
  );
}
