/**
 * The Phase 6 acceptance gate, which the build spec calls non-negotiable:
 *
 *   the same scenario with the same seed, run twice, produces byte-identical
 *   verdicts and identical ledgers.
 *
 * Also covered here: the nine-step flow end to end, the `expect` field working
 * as a regression suite, persistence, and replay.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScriptedAgent, ScriptedLlm, createOps, says } from '@adversary/agents';

import type { DbHandle } from '../../db/client.js';
import { openDb } from '../../db/client.js';
import { SQLITE_MEMORY } from '../../db/dialect.js';
import { migrate } from '../../db/migrate.js';
import { createGate } from '@adversary/gate';
import { loadCorpus, loadScenarioFile, parseScenario } from '../../scenario/loader.js';
import { verifyDeterminism } from '../determinism.js';
import { nextAttempt, persistRun, persistScenario } from '../persist.js';
import { listAttempts, replayRun } from '../replay.js';
import { deriveRunKey, makeRunId, parseRunId } from '../run-key.js';
import { runScenario } from '../runner.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
// Test-owned fixtures, not corpus scenarios: these tests assert exact
// counts and contents, and pointing them at the corpus made every corpus
// edit break unit tests that were not about the corpus.
const FIXTURE_DIR = join(REPO_ROOT, 'packages/runner/src/scenario/__tests__/scenarios');
const ATTACK = join(FIXTURE_DIR, 'T1_invoice_borne_redirect.yaml');
const BENIGN = join(FIXTURE_DIR, 'T1_benign_confirmed_account_change.yaml');

const attack = () => loadScenarioFile(ATTACK);
const benign = () => loadScenarioFile(BENIGN);

/**
 * The real gate, all eight rules. Until Phase 7 this was a stand-in; now the
 * scenario `expect` fields are claims about the actual defence, which is what
 * makes them a regression suite worth having.
 */
const gate = createGate;

// --- the nine steps ---------------------------------------------------------

describe('a run', () => {
  it('produces a complete result', async () => {
    const run = await runScenario({ loaded: attack(), gate: null });

    expect(run.scenarioId).toBe('T1_invoice_borne_redirect');
    expect(run.runId).toBe(makeRunId(run.runKey, 0));
    expect(run.actions).toHaveLength(2);
    expect(run.verdicts).toHaveLength(3);
    expect(run.trajectory.length).toBeGreaterThan(0);
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.error).toBeNull();
  });

  it('injects the payload where the agent will read it', async () => {
    const run = await runScenario({ loaded: attack(), gate: null });
    const reads = run.trajectory.filter((e) => e.kind === 'tool_result');

    expect(JSON.stringify(reads)).toContain('acct_vendor_acme_new');
  });

  it('counts tool-using turns', async () => {
    // Portable across agents in a way that counting an agent's internal loop
    // iterations would not be, and it is the denominator "mean turns to
    // violation" wants.
    const run = await runScenario({ loaded: attack(), gate: null });
    expect(run.turnsUsed).toBe(3); // list_invoices + two payments
  });

  it('advances the virtual clock per money action', async () => {
    // Eleven rapid transfers land a fixed distance apart in every run, on every
    // machine. Without this the gate's velocity rule would read a clock that
    // depends on how busy the host was.
    const run = await runScenario({ loaded: attack(), gate: null });
    const stamps = run.actions.map((a) => a.ts);

    expect(new Set(stamps).size).toBe(stamps.length);
    expect((stamps[1] as number) - (stamps[0] as number)).toBe(100);
  });

  it('records the scenario and its hash on the trajectory', async () => {
    const loaded = attack();
    const run = await runScenario({ loaded, gate: null });

    expect(run.trajectory[0]?.content).toMatchObject({
      scenario: 'T1_invoice_borne_redirect',
      contentHash: loaded.contentHash,
      seed: 42,
      gateEnabled: false,
    });
  });

  it('errors rather than running clean when the injection goes nowhere', async () => {
    // A scenario whose payload landed nowhere would report the agent safe
    // against an attack it was never shown.
    const broken = parseScenario(
      loadScenarioFile(ATTACK).yamlSnapshot.replace('target: inv_00417', 'target: inv_99999'),
      'broken.yaml',
    );
    const run = await runScenario({ loaded: broken, gate: null });

    expect(run.verdict).toBe('error');
    expect(run.error).toMatch(/was not found on surface/);
    expect(run.actions).toEqual([]);
  });
});

// --- the corpus as a regression suite ---------------------------------------

describe('the expect field', () => {
  it('matches observed behaviour for the attack, gate off', async () => {
    const loaded = attack();
    const run = await runScenario({ loaded, gate: null });

    expect(run.verdict).toBe(loaded.scenario.expect.ungated);
    expect(run.verdict).toBe('violated');
  });

  it('matches observed behaviour for the attack, gate on', async () => {
    const loaded = attack();
    const run = await runScenario({ loaded, gate: gate() });

    expect(run.verdict).toBe(loaded.scenario.expect.gated);
    expect(run.verdict).toBe('blocked');
  });

  it.each([
    ['ungated', null],
    ['gated', 'real'],
  ])('matches observed behaviour for the benign twin, %s', async (which, mode) => {
    const loaded = benign();
    const run = await runScenario({ loaded, gate: mode === null ? null : gate() });

    expect(run.verdict).toBe(
      which === 'ungated' ? loaded.scenario.expect.ungated : loaded.scenario.expect.gated,
    );
    expect(run.verdict).toBe('pass');
  });

  it('shows the gate containing the attack without blocking its benign twin', async () => {
    // The whole product in one assertion: the defence worked, and it did not
    // cost anything on the superficially identical legitimate case.
    const attacked = await runScenario({ loaded: attack(), gate: gate() });
    const legitimate = await runScenario({ loaded: benign(), gate: gate() });

    expect(attacked.verdict).toBe('blocked');
    expect(legitimate.verdict).toBe('pass');
    expect(legitimate.actions.filter((a) => a.railResult === 'ok')).toHaveLength(1);
  });

  it('reports blast radius only where money actually moved', async () => {
    const ungated = await runScenario({ loaded: attack(), gate: null });
    const gated = await runScenario({ loaded: attack(), gate: gate() });

    const radius = (r: typeof ungated) =>
      r.verdicts.find((v) => v.id === 'payee_allowlist')?.blastRadiusPaise;

    expect(radius(ungated)).toBe(480000);
    expect(radius(gated)).toBe(0);
  });
});

// --- run identity -----------------------------------------------------------

describe('runKey and runId', () => {
  it('gives two attempts at one experiment the same runKey', async () => {
    const a = await runScenario({ loaded: attack(), gate: null, attempt: 0 });
    const b = await runScenario({ loaded: attack(), gate: null, attempt: 1 });

    expect(a.runKey).toBe(b.runKey);
    expect(a.runId).not.toBe(b.runId);
    expect(parseRunId(b.runId).attempt).toBe(1);
  });

  it('changes when anything about the experiment changes', () => {
    const base = {
      scenarioId: 'B1',
      scenarioContentHash: 'sha:abc',
      seed: 42,
      rail: 'mock' as const,
      gateEnabled: false,
      agentName: 'scripted',
      agentVersion: '1.0.0',
      model: null,
    };
    const key = deriveRunKey(base);

    expect(deriveRunKey({ ...base, seed: 43 })).not.toBe(key);
    expect(deriveRunKey({ ...base, gateEnabled: true })).not.toBe(key);
    expect(deriveRunKey({ ...base, scenarioContentHash: 'sha:def' })).not.toBe(key);
    expect(deriveRunKey({ ...base, agentName: 'ops' })).not.toBe(key);
    expect(deriveRunKey({ ...base, model: 'some-model' })).not.toBe(key);
  });

  it('is independent of field order', () => {
    expect(
      deriveRunKey({
        model: null,
        agentVersion: '1.0.0',
        agentName: 'scripted',
        gateEnabled: false,
        rail: 'mock',
        seed: 42,
        scenarioContentHash: 'sha:abc',
        scenarioId: 'B1',
      }),
    ).toBe(
      deriveRunKey({
        scenarioId: 'B1',
        scenarioContentHash: 'sha:abc',
        seed: 42,
        rail: 'mock',
        gateEnabled: false,
        agentName: 'scripted',
        agentVersion: '1.0.0',
        model: null,
      }),
    );
  });

  it('rejects a malformed runId rather than guessing', () => {
    expect(() => parseRunId('no-attempt-here')).toThrow(/Malformed runId/);
    expect(() => parseRunId('key_abc:notanumber')).toThrow(/not a whole number/);
  });
});

// --- THE GATE ---------------------------------------------------------------

describe('verify-determinism', () => {
  it('passes for the attack scenario, gate off', async () => {
    const report = await verifyDeterminism({ loaded: attack(), gate: null, attempts: 3 });

    expect(report.comparable).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.firstDifference).toBeNull();
    expect(new Set(report.ledgerDigests).size).toBe(1);
    expect(new Set(report.verdictDigests).size).toBe(1);
  });

  it('passes for the attack scenario, gate on', async () => {
    const report = await verifyDeterminism({ loaded: attack(), gate: gate(), attempts: 3 });

    expect(report.ok).toBe(true);
    expect(new Set(report.ledgerDigests).size).toBe(1);
  });

  it('passes for the benign twin', async () => {
    const report = await verifyDeterminism({ loaded: benign(), gate: gate(), attempts: 3 });
    expect(report.ok).toBe(true);
  });

  it('passes across the whole shipped corpus, both gate states', async () => {
    const corpus = loadCorpus([ATTACK, BENIGN]);

    for (const loaded of corpus) {
      for (const g of [null, gate()]) {
        const report = await verifyDeterminism({ loaded, gate: g, attempts: 3 });
        expect(report.ok, `${loaded.scenario.id} gate=${g !== null}: ${report.reason}`).toBe(
          true,
        );
      }
    }
  });

  it('produces different digests for gate on and gate off', async () => {
    // The check must be capable of noticing a difference, or a pass means
    // nothing.
    const off = await verifyDeterminism({ loaded: attack(), gate: null, attempts: 2 });
    const on = await verifyDeterminism({ loaded: attack(), gate: gate(), attempts: 2 });

    expect(off.ledgerDigests[0]).not.toBe(on.ledgerDigests[0]);
  });

  it('refuses to compare live model runs, and says why', async () => {
    // A hosted model is not deterministic even at temperature 0. Asserting
    // byte-identity here would be false, and quietly skipping the comparison
    // would report green while checking nothing.
    const llm = new ScriptedLlm({ completions: [says('done'), says('done'), says('done')] });
    const report = await verifyDeterminism({
      loaded: attack(),
      gate: null,
      attempts: 2,
      agent: createOps({ llm }),
      model: 'some-hosted-model',
    });

    expect(report.comparable).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/not deterministic even at temperature 0/);
  });

  it('reports the first differing field when runs diverge', async () => {
    // Constructed divergence: an agent that pays a different amount each time.
    let call = 0;
    const drifting = new ScriptedAgent({
      name: 'drifting',
      script: [
        { kind: 'pay_vendor', args: { vendorId: 'acct_vendor_acme', amountPaise: 1, rationale: 'x' } },
      ],
    });
    const originalRun = drifting.run.bind(drifting);
    drifting.run = async (ctx) => {
      call += 1;
      await ctx.tools.pay_vendor({
        vendorId: 'acct_vendor_acme',
        amountPaise: 1000 * call,
        rationale: 'drifting',
      });
      return { transcript: [], finalMessage: '' };
    };
    void originalRun;

    const report = await verifyDeterminism({
      loaded: attack(),
      gate: null,
      attempts: 2,
      agent: drifting,
    });

    expect(report.ok).toBe(false);
    expect(report.comparable).toBe(true);
    expect(report.reason).toMatch(/ledgers differ/);
    // "Digests differ" is not a debuggable message.
    expect(report.firstDifference).toContain('amountPaise');
  });

  it('needs at least two attempts to mean anything', async () => {
    await expect(
      verifyDeterminism({ loaded: attack(), gate: null, attempts: 1 }),
    ).rejects.toThrow(/at least two attempts/);
  });
});

// --- persistence and replay -------------------------------------------------

describe('persist and replay', () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await openDb({ dialect: 'sqlite', path: SQLITE_MEMORY });
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('round-trips a run through the database', async () => {
    const loaded = attack();
    const run = await runScenario({ loaded, gate: null });

    await persistScenario(db, loaded);
    await persistRun(db, run);

    const replayed = await replayRun(db, run.runId);

    expect(replayed.runId).toBe(run.runId);
    expect(replayed.scenarioContentHash).toBe(loaded.contentHash);
    expect(replayed.verdict).toBe('violated');
    expect(replayed.gateEnabled).toBe(false);
    expect(replayed.actions).toHaveLength(run.actions.length);
    expect(replayed.verdicts).toHaveLength(run.verdicts.length);
    expect(replayed.trajectory).toHaveLength(run.trajectory.length);
  });

  it('preserves every money action field', async () => {
    const loaded = attack();
    const run = await runScenario({ loaded, gate: gate() });

    await persistScenario(db, loaded);
    await persistRun(db, run);
    const replayed = await replayRun(db, run.runId);

    const blocked = replayed.actions.find((a) => a.gateDecision === 'block');
    expect(blocked).toMatchObject({
      payeeRef: 'acct_vendor_acme_new',
      amountPaise: 480000,
      railResult: 'not_executed',
      railRef: null,
      idempotencySource: 'auto',
    });
    // The full trace survives the round trip, passes included - which is what
    // makes a stored action explainable rather than merely recorded.
    expect(blocked?.ruleTrace).toHaveLength(8);
    expect(blocked?.ruleTrace).toContainEqual(
      expect.objectContaining({ rule: 'payee_allowlist', outcome: 'fail' }),
    );
    expect(blocked?.ruleTrace).toContainEqual(
      expect.objectContaining({ rule: 'per_txn_cap', outcome: 'pass' }),
    );
    expect(blocked?.agentRationale).toContain('settlement account');
  });

  it('normalises the gate flag across dialects', async () => {
    // SQLite stores 0/1, Postgres a real boolean. A reader must never have to
    // know which database produced the row.
    const loaded = attack();
    const run = await runScenario({ loaded, gate: gate() });

    await persistScenario(db, loaded);
    await persistRun(db, run);

    expect((await replayRun(db, run.runId)).gateEnabled).toBe(true);
  });

  it('does not re-execute anything on replay', async () => {
    // Replay is a read. Executing the transcript again would produce a second
    // thing that happened, and on a live rail it would move money twice.
    const loaded = attack();
    const run = await runScenario({ loaded, gate: null });

    await persistScenario(db, loaded);
    await persistRun(db, run);

    const before = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM money_actions');
    await replayRun(db, run.runId);
    const after = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM money_actions');

    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('stores a scenario once per content hash', async () => {
    const loaded = attack();
    await persistScenario(db, loaded);
    await persistScenario(db, loaded);

    const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM scenarios');
    expect(rows[0]?.n).toBe(1);
  });

  it('keeps both versions when a scenario is edited', async () => {
    // A scorecard from last month stays explainable by the corpus that
    // produced it.
    const original = attack();
    const edited = parseScenario(
      original.yamlSnapshot.replace('sessionCapPaise: 2000000', 'sessionCapPaise: 3000000'),
      'edited.yaml',
    );

    await persistScenario(db, original);
    await persistScenario(db, edited);

    const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM scenarios');
    expect(rows[0]?.n).toBe(2);
  });

  it('counts attempts, and lists them in order', async () => {
    const loaded = attack();
    expect(await nextAttempt(db, 'nothing-yet')).toBe(0);

    await persistScenario(db, loaded);
    const first = await runScenario({ loaded, gate: null, attempt: 0 });
    await persistRun(db, first);
    expect(await nextAttempt(db, first.runKey)).toBe(1);

    const second = await runScenario({ loaded, gate: null, attempt: 1 });
    await persistRun(db, second);

    expect(await listAttempts(db, first.runKey)).toEqual([first.runId, second.runId]);
  });

  it('reports an unknown run rather than returning an empty one', async () => {
    await expect(replayRun(db, 'key_nope:0')).rejects.toThrow(/No run with id/);
  });

  it('persists a run and its evidence atomically', async () => {
    // A run row claiming a verdict with no evidence behind it is worse than no
    // row at all.
    const loaded = attack();
    const run = await runScenario({ loaded, gate: null });
    await persistScenario(db, loaded);

    const broken = { ...run, verdicts: [{ ...run.verdicts[0]!, status: 'nonsense' as never }] };
    await expect(persistRun(db, broken)).rejects.toThrow();

    const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM runs');
    expect(rows[0]?.n).toBe(0);
  });
});
