/**
 * The shell.
 *
 * Three screens, one piece of state to choose between them, and no router. A
 * viewer, not a product: boring and legible beats designed
 * (docs/ARCHITECTURE.md 13.3).
 */

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { RunList } from './RunList';
import { ScorecardView } from './ScorecardView';
import { TrajectoryView } from './TrajectoryView';
import type { Snapshot } from './types';

type Screen = { name: 'scorecard' } | { name: 'runs' } | { name: 'run'; runId: string };

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'scorecard' });

  useEffect(() => {
    fetch('snapshot.json')
      .then(async (res) => {
        if (!res.ok) throw new Error(`snapshot.json returned ${res.status}`);
        return (await res.json()) as Snapshot;
      })
      .then((loaded) => {
        // Refuse rather than half-render. A viewer that guessed at an unknown
        // snapshot version would show numbers whose meaning it does not know.
        if (loaded.version !== 1) {
          throw new Error(
            `This viewer reads snapshot version 1; the file is version ${String(loaded.version)}.`,
          );
        }
        setSnapshot(loaded);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const scenarios = useMemo(
    () =>
      new Map((snapshot?.scenarios ?? []).map((s) => [`${s.id}|${s.contentHash}`, s])),
    [snapshot],
  );

  if (error !== null) return <Problem message={error} />;
  if (snapshot === null) return <Centered>Loading the snapshot…</Centered>;

  const run =
    screen.name === 'run' ? snapshot.runs.find((r) => r.runId === screen.runId) : undefined;

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-baseline gap-4 px-6 py-4">
          <h1 className="text-base font-semibold text-slate-900">Adversary</h1>
          <p className="text-sm text-slate-500">
            Evidence viewer · {snapshot.runs.length} stored runs
          </p>
          <nav className="ml-auto flex gap-1">
            <Tab
              active={screen.name === 'scorecard'}
              onClick={() => setScreen({ name: 'scorecard' })}
            >
              Scorecard
            </Tab>
            <Tab
              active={screen.name === 'runs' || screen.name === 'run'}
              onClick={() => setScreen({ name: 'runs' })}
            >
              Runs
            </Tab>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {screen.name === 'scorecard' ? (
          <ScorecardView comparison={snapshot.comparison} />
        ) : null}

        {screen.name === 'runs' ? (
          <RunList snapshot={snapshot} onOpen={(runId) => setScreen({ name: 'run', runId })} />
        ) : null}

        {screen.name === 'run' ? (
          run === undefined ? (
            <Problem message={`No run with id ${screen.runId} is in this snapshot.`} />
          ) : (
            <TrajectoryView
              run={run}
              scenario={scenarios.get(`${run.scenarioId}|${run.scenarioContentHash}`)}
              onBack={() => setScreen({ name: 'runs' })}
            />
          )
        ) : null}
      </main>

      <footer className="mx-auto max-w-7xl px-6 pb-10 text-xs text-slate-500">
        Every vendor, customer, invoice and account identifier in this data is synthetic. No
        real payment instrument, business identity or personal detail appears anywhere in
        this project. See <code>docs/THREAT-MODEL.md</code>.
      </footer>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1.5 text-sm ${
        active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-500">
      {children}
    </div>
  );
}

function Problem({ message }: { message: string }): ReactNode {
  return (
    <Centered>
      <div className="max-w-lg rounded-lg bg-white p-6 text-left ring-1 ring-slate-200">
        <h1 className="font-semibold text-slate-900">No evidence to show</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
        <p className="mt-4 text-sm text-slate-600">
          This viewer reads a snapshot written by the CLI. Produce one with:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-3 text-xs text-slate-800 ring-1 ring-inset ring-slate-200">
          pnpm demo
        </pre>
        <p className="mt-3 text-xs text-slate-500">
          It runs the corpus with the gate off and on, writes the report, and puts{' '}
          <code>snapshot.json</code> where this page looks for it.
        </p>
      </div>
    </Centered>
  );
}
