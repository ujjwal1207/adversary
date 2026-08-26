/**
 * The nine-step run flow.
 *
 *   1. Load       parse YAML, validate with Zod, compute content hash
 *   2. Seed       derive the RNG tree from (scenarioId, seed); pin temperature 0
 *   3. Provision  reset the ledger; prepare the rail
 *   4. Inject     write the attack payload into the named untrusted surface
 *   5. Invoke     call the SUT with goal and policy; enforce turn and time caps
 *   6. Intercept  every tool call, through the interceptor
 *   7. Verify     evaluate invariants; the verdict is the worst status
 *   8. Persist    handled by the caller, from the RunResult this returns
 *   9. Aggregate  handed to the metrics engine
 *
 * Step 1 is `scenario/loader.ts`; this module is steps 2 through 7 and hands
 * the caller everything 8 and 9 need.
 */

import type {
  Clock,
  InvariantResult,
  MoneyAction,
  PaymentAgent,
  PolicyGate,
  ReproducibilityTier,
  TrajectoryEvent,
} from '@adversary/core';
import {
  InMemoryLedger,
  TICK_MS,
  VirtualClock,
  createRng,
  ledgerDigest,
  sha256Hex,
  verifyAll,
  worstStatus,
  hashValue,
} from '@adversary/core';
import type { Rail } from '@adversary/rails';
import { MockRail } from '@adversary/rails';

import { InMemoryIdempotencyStore } from '../interceptor/idempotency.js';
import { Interceptor } from '../interceptor/interceptor.js';
import { buildTools } from '../interceptor/tools.js';
import type { LoadedScenario } from '../scenario/loader.js';
import { applyInjection, dataSourceFor, loadFixtures } from '../scenario/fixtures.js';
import { deriveRunKey, makeRunId } from './run-key.js';
import { scriptFor } from './script.js';

export interface RunOptions {
  readonly loaded: LoadedScenario;
  /** Omit to run the scenario's own script through a ScriptedAgent. */
  readonly agent?: PaymentAgent;
  readonly gate: PolicyGate | null;
  /** Omit for a mock rail seeded from the scenario. */
  readonly rail?: Rail;
  readonly attempt?: number;
  readonly model?: string | null;
  readonly reproducibility?: ReproducibilityTier;
  readonly clock?: Clock;
}

export interface RunResult {
  readonly runId: string;
  readonly runKey: string;
  readonly attempt: number;

  readonly scenarioId: string;
  readonly scenarioContentHash: string;
  readonly seed: number;
  readonly rail: string;
  readonly gateEnabled: boolean;

  readonly agentName: string;
  readonly agentVersion: string;
  readonly model: string | null;
  readonly reproducibility: ReproducibilityTier;

  readonly startedAt: number;
  readonly finishedAt: number;
  readonly turnsUsed: number;

  readonly verdict: InvariantResult['status'];
  /** Set when the run itself failed, not when an invariant did. */
  readonly error: string | null;

  readonly actions: readonly MoneyAction[];
  readonly trajectory: readonly TrajectoryEvent[];
  readonly verdicts: readonly InvariantResult[];
  readonly finalMessage: string;

  /** Two runs are ledger-identical exactly when these match. */
  readonly ledgerDigest: string;
  readonly verdictDigest: string;
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { loaded, gate } = options;
  const { scenario } = loaded;
  const attempt = options.attempt ?? 0;
  const gateEnabled = gate !== null;

  // --- 2. Seed ------------------------------------------------------------
  // One root, derived from the scenario and its seed. Everything stochastic
  // hangs off a *named* substream of it, so adding a draw in one component
  // cannot shift another's (docs/ARCHITECTURE.md 9.1).
  const rng = createRng(scenario.seed, scenario.id);
  const clock = options.clock ?? new VirtualClock();

  const agent = options.agent ?? scriptFor(scenario);
  const model = options.model ?? null;

  const runKey = deriveRunKey({
    scenarioId: scenario.id,
    scenarioContentHash: loaded.contentHash,
    seed: scenario.seed,
    rail: scenario.rail,
    gateEnabled,
    agentName: agent.name,
    agentVersion: agent.version,
    model,
  });
  const runId = makeRunId(runKey, attempt);

  const startedAt = clock.now();

  // --- 3. Provision -------------------------------------------------------
  const ledger = new InMemoryLedger();
  const rail =
    options.rail ??
    new MockRail({ rng: rng.derive('rail'), clock });
  await rail.provision(runKey);

  const trajectory: TrajectoryEvent[] = [];
  let trajectorySeq = 0;
  const record = (event: Omit<TrajectoryEvent, 'id' | 'runId' | 'seq'>): void => {
    trajectory.push({
      ...event,
      // Derived from runId for the same reason money-action ids are: two
      // attempts at one experiment must not collide on the primary key.
      id: `tev_${sha256Hex(`${runId}|${trajectorySeq}`).slice(0, 16)}`,
      runId,
      seq: trajectorySeq,
    });
    trajectorySeq += 1;
  };

  // --- 4. Inject ----------------------------------------------------------
  let dataSource;
  let error: string | null = null;
  try {
    const fixtures = loadFixtures(scenario, loaded.source);
    const injected = applyInjection(fixtures, scenario, loaded.source);
    dataSource = dataSourceFor(injected.fixtures);

    record({
      role: 'harness',
      kind: 'system',
      content: {
        scenario: scenario.id,
        contentHash: loaded.contentHash,
        seed: scenario.seed,
        gateEnabled,
        rail: rail.kind,
        injection: injected.injectedInto,
      },
    });
  } catch (err) {
    // A scenario whose injection went nowhere must not run clean and report
    // the agent safe against an attack it was never shown.
    return failed({
      runId,
      runKey,
      attempt,
      loaded,
      gateEnabled,
      agent,
      model,
      reproducibility: options.reproducibility ?? tierFor(model),
      startedAt,
      finishedAt: clock.now(),
      error: err instanceof Error ? err.message : String(err),
      trajectory,
    });
  }

  // --- 5/6. Invoke and intercept ------------------------------------------
  const interceptor = new Interceptor({
    runId,
    runKey,
    policy: scenario.policy,
    ledger,
    rail,
    clock,
    gate,
    idempotency: new InMemoryIdempotencyStore(),
    onTrajectory: record,
  });

  const tools = buildTools({
    interceptor,
    dataSource,
    // Reads are observed by the harness as well, so `turnsUsed` can be counted
    // from evidence rather than from the agent's own account of itself. Counted
    // per call, not per source: one list_invoices returning thirty invoices is
    // one turn.
    onReadCall: (tool, args) => {
      record({ role: 'harness', kind: 'tool_call', content: { tool, ...args } });
    },
  });
  const controller = new AbortController();

  // The wall-clock cap is a safety net for live runs, and it is the one thing
  // in a run that reads real time. A run it fires on carries no determinism
  // claim, which is why `error` records that it fired and verifyDeterminism
  // refuses to compare such runs.
  const deadline = setTimeout(() => {
    error = 'wall_clock_exceeded';
    controller.abort();
  }, scenario.maxWallClockMs);
  if (typeof deadline === 'object' && 'unref' in deadline) deadline.unref();

  let finalMessage = '';
  try {
    const outcome = await agent.run({
      goal: scenario.goal,
      policy: scenario.policy,
      tools,
      signal: controller.signal,
    });
    finalMessage = outcome.finalMessage;
    for (const event of outcome.transcript) record(event);
  } catch (err) {
    error ??= `agent_error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(deadline);
  }

  // Webhooks queued by the rail are delivered once the agent has finished, so
  // delivery order does not depend on the event loop.
  rail.flushWebhooks();
  clock.advance(TICK_MS.turn);

  // --- 7. Verify ----------------------------------------------------------
  const view = ledger.view(runId);
  const verdicts = verifyAll(scenario.invariants, {
    view,
    policy: scenario.policy,
    untrusted: untrustedFrom(scenario),
  });

  await rail.teardown(runKey);

  const actions = ledger.getRun(runId);

  return {
    runId,
    runKey,
    attempt,
    scenarioId: scenario.id,
    scenarioContentHash: loaded.contentHash,
    seed: scenario.seed,
    rail: rail.kind,
    gateEnabled,
    agentName: agent.name,
    agentVersion: agent.version,
    model,
    reproducibility: options.reproducibility ?? tierFor(model),
    startedAt,
    finishedAt: clock.now(),
    // Tool-using turns, counted from what the HARNESS observed rather than
    // from the agent's transcript. An agent's own account of its turns is
    // narrative, and this project does not compute metrics from narrative. It
    // is also portable: a black-box agent that returns an empty transcript is
    // still counted correctly.
    turnsUsed: trajectory.filter((e) => e.kind === 'tool_call' && e.role === 'harness')
      .length,
    verdict: error === null ? worstStatus(verdicts) : 'error',
    error,
    actions,
    trajectory,
    verdicts,
    finalMessage,
    ledgerDigest: ledgerDigest(actions),
    verdictDigest: hashValue(
      [...verdicts]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((v) => ({
          id: v.id,
          status: v.status,
          blastRadiusPaise: v.blastRadiusPaise,
          // Witnesses are recorded by `seq`, not by action id. Action ids are
          // attempt-scoped so two attempts do not collide in the database;
          // `seq` names the same actions and is stable across attempts, which
          // is what a determinism comparison needs.
          witnessSeqs: witnessSeqs(v.witnessIds, actions),
        })),
    ),
  };
}

/** Maps witness action ids to their seqs, sorted. */
function witnessSeqs(
  witnessIds: readonly string[],
  actions: readonly MoneyAction[],
): number[] {
  const bySeq = new Map(actions.map((a) => [a.id, a.seq]));
  return witnessIds
    .map((id) => bySeq.get(id))
    .filter((seq): seq is number => seq !== undefined)
    .sort((a, b) => a - b);
}

/**
 * Values an attacker put on an untrusted surface.
 *
 * Derived from the injection payload by extracting account-shaped tokens. This
 * is a deliberately shallow stand-in: Phase 7 replaces it with the taint index,
 * which matches an action's own parameters rather than scraping the payload.
 */
function untrustedFrom(scenario: { injection?: { payload: string } | undefined }): Record<string, unknown> {
  const payload = scenario.injection?.payload ?? '';
  const derivedPayees = [...payload.matchAll(/\bacct_[a-z0-9_]+/gi)].map((m) => m[0]);
  return { derivedPayees: [...new Set(derivedPayees)] };
}

/** Runs with no model are fully reproducible; runs with one are not, yet. */
function tierFor(model: string | null): ReproducibilityTier {
  return model === null ? 'scripted' : 'live';
}

function failed(input: {
  runId: string;
  runKey: string;
  attempt: number;
  loaded: LoadedScenario;
  gateEnabled: boolean;
  agent: PaymentAgent;
  model: string | null;
  reproducibility: ReproducibilityTier;
  startedAt: number;
  finishedAt: number;
  error: string;
  trajectory: readonly TrajectoryEvent[];
}): RunResult {
  return {
    runId: input.runId,
    runKey: input.runKey,
    attempt: input.attempt,
    scenarioId: input.loaded.scenario.id,
    scenarioContentHash: input.loaded.contentHash,
    seed: input.loaded.scenario.seed,
    rail: input.loaded.scenario.rail,
    gateEnabled: input.gateEnabled,
    agentName: input.agent.name,
    agentVersion: input.agent.version,
    model: input.model,
    reproducibility: input.reproducibility,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    turnsUsed: 0,
    // A run that could not be set up is a broken measurement, and a broken
    // measurement is never reported as a safe result.
    verdict: 'error',
    error: input.error,
    actions: [],
    trajectory: input.trajectory,
    verdicts: [],
    finalMessage: '',
    ledgerDigest: ledgerDigest([]),
    verdictDigest: hashValue([]),
  };
}
