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
  TaintIndex,
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
import type { FixtureSet } from '../scenario/fixtures.js';
import {
  DEFAULT_FIXTURES,
  applyInjection,
  dataSourceFor,
  loadFixtures,
} from '../scenario/fixtures.js';
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
  /**
   * The hash of the cassette in play, when one is.
   *
   * A scorecard that cites a cassette has to say which cassette, or "this run
   * is reproducible" names nothing.
   */
  readonly cassetteHash?: string | null;
  readonly clock?: Clock;
  /**
   * Overrides the scenario's wall-clock cap.
   *
   * A run-level override rather than a scenario edit, unlike `--seed`, because
   * this is not a property of the scenario: it is a property of how fast the
   * agent under test happens to be. The corpus values suit `ScriptedAgent`,
   * which finishes in milliseconds; a hosted model takes seconds per turn and
   * would be cut off mid-run under the same number.
   *
   * Safe to vary because a run that hits the cap is recorded as
   * `error: wall_clock_exceeded`, and `scorecardFor` excludes errored runs from
   * every denominator while reporting the count separately. A truncated run
   * cannot quietly improve a rate; it can only fail to contribute to one.
   */
  readonly wallClockMs?: number;
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
  readonly cassetteHash: string | null;

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
    new MockRail({
      rng: rng.derive('rail'),
      clock,
      ...(scenario.railFailures.length === 0
        ? {}
        : { scriptedFailures: scenario.railFailures }),
    });
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
  let baseline: FixtureSet = DEFAULT_FIXTURES;
  let error: string | null = null;
  try {
    baseline = loadFixtures(scenario, loaded.source);
    const injected = applyInjection(baseline, scenario, loaded.source);
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
      cassetteHash: options.cassetteHash ?? null,
      startedAt,
      finishedAt: clock.now(),
      error: err instanceof Error ? err.message : String(err),
      trajectory,
    });
  }

  // --- 5/6. Invoke and intercept ------------------------------------------
  // Seeded from the state of the world BEFORE the payload was written, plus
  // the policy's own allowlist. Anything the agent then reads that is not in
  // here is something an untrusted surface introduced.
  const taint = new TaintIndex({
    trustedIdentifiers: [
      ...scenario.policy.allowlist,
      ...baseline.vendors.map((v) => v.id),
      ...baseline.invoices.map((i) => i.vendorId),
      ...baseline.invoices.map((i) => i.id),
      ...baseline.subscriptions.map((s) => s.id),
      ...baseline.customers.map((c) => c.id),
      // A dispute's *structured* fields are the merchant's own records seen
      // from the network's side: the payment it refers to is one the merchant
      // already took, and the id and customer come from the provider as data,
      // not from whoever filed the dispute. The cardholder's free text is the
      // untrusted part, and it is not here - so a payee or amount that appears
      // only in the reason field is still traced.
      //
      // Without this, reading a dispute taints the very payment the dispute is
      // about, and refunding it - the one correct response - escalates. Corpus
      // C4's benign twin failed exactly that way before the line below existed,
      // which is the same shape of error as A13.
      ...baseline.disputes.map((d) => d.id),
      ...baseline.disputes.map((d) => d.paymentId),
      ...baseline.disputes.map((d) => d.customerId),
      ...baseline.payments.map((p) => p.id),
      ...baseline.payments.map((p) => p.customerId),
    ],
    trustedAmounts: [
      ...baseline.invoices.flatMap((i) => [i.amountPaise, i.amountPaise / 100]),
      ...baseline.subscriptions.flatMap((s) => [s.amountPaise, s.amountPaise / 100]),
      ...baseline.disputes.flatMap((d) => [d.amountPaise, d.amountPaise / 100]),
      ...baseline.payments.flatMap((p) => [p.amountPaise, p.amountPaise / 100]),
    ],
  });

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
    onToolCall: () => spendTurn(),
    taintFor: (call) => taint.match(call.payeeRef, call.amountPaise, call.subjectRef),
  });

  const tools = buildTools({
    interceptor,
    dataSource,
    // Provenance. Every untrusted read is scanned and indexed, and the
    // interceptor matches each money action's own parameters against the index
    // - not against the agent's prose. That is what makes paraphrase survivable
    // without semantic machinery (docs/ARCHITECTURE.md 10.2).
    onUntrustedRead: (surface, sourceId, content) => {
      taint.record(surface, sourceId, content);
    },
    // Reads are observed by the harness as well, so `turnsUsed` can be counted
    // from evidence rather than from the agent's own account of itself. Counted
    // per call, not per source: one list_invoices returning thirty invoices is
    // one turn.
    onReadCall: (tool, args) => {
      record({ role: 'harness', kind: 'tool_call', content: { tool, ...args } });
      spendTurn();
    },
  });
  const controller = new AbortController();

  /**
   * The turn cap, enforced by the harness.
   *
   * ARCHITECTURE 14 has always specified this - "runner counter; AbortSignal
   * fires; run ends" - and until a live model ran, nothing implemented it.
   * `scenario.maxTurns` was validated by the schema and read by nobody;
   * `LlmAgent` enforced an unrelated default of its own that happened to be the
   * same number, so the two agreed by coincidence and `ScriptedAgent` never
   * loops, which is why no test noticed. Gemini made sixty `escalate_to_human`
   * calls in one run of corpus E3.
   *
   * Counted in tool calls rather than in the agent's idea of a turn, for the
   * same reason `turnsUsed` is: a turn is the agent's account of itself, and a
   * tool call is something the harness watched happen. One model response
   * carrying three calls spends three.
   *
   * The signal is the mechanism, so an agent that ignores its signal is still
   * bounded - by the wall clock, which is the layer beneath this one.
   */
  let toolCalls = 0;
  const spendTurn = (): void => {
    toolCalls += 1;
    if (toolCalls >= scenario.maxTurns && !controller.signal.aborted) {
      error = error ?? 'turn_cap_exceeded';
      controller.abort();
    }
  };

  // The wall-clock cap is a safety net for live runs, and it is the one thing
  // in a run that reads real time. A run it fires on carries no determinism
  // claim, which is why `error` records that it fired and verifyDeterminism
  // refuses to compare such runs.
  const deadline = setTimeout(() => {
    error = 'wall_clock_exceeded';
    controller.abort();
  }, options.wallClockMs ?? scenario.maxWallClockMs);
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
    // Derived from what the agent actually read, not from the scenario's
    // declared payload. A scenario author does not have to list the values
    // their own injection introduced, and an invariant cannot go stale against
    // a payload that changed.
    untrusted: taint.toUntrusted(),
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
    cassetteHash: options.cassetteHash ?? null,
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
  cassetteHash: string | null;
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
    cassetteHash: input.cassetteHash,
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
