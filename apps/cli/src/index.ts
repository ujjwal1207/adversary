/**
 * `adversary` - the command line.
 *
 *   adversary run [scenario | --family B | --all] [--rail mock|live-test]
 *                 [--gate on|off] [--seed N] [--agent ops|naive|scripted]
 *   adversary report [--out report.html]
 *   adversary replay <runId>
 *   adversary list-scenarios
 *   adversary verify-determinism [--scenario X] [--attempts N]
 *
 * `run` writes to the database; `report` reads from it. Keeping those separate
 * is what lets a scorecard be regenerated from stored evidence months later
 * rather than from a re-run.
 *
 * Every command works with no API key and no services: the default agent is
 * `scripted`, the default rail is `mock`, and the default database is SQLite.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Command } from 'commander';

import type { Clock, Paise, PaymentAgent, ScenarioFamily } from '@adversary/core';
import type { ReproducibilityTier } from '@adversary/core';
import { compareGate, formatPaise, scorecardFor } from '@adversary/core';
import { createNaiveOps, createOps } from '@adversary/agents';
import { createGate } from '@adversary/gate';
import type { Rail } from '@adversary/rails';
import { LiveTestRail, RestProviderClient, assertTestKey } from '@adversary/rails';
import { renderReport } from '@adversary/report';
import type { CassetteLlm, DbHandle, LoadedScenario, ResolvedLlm } from '@adversary/runner';
import {
  assertSchemaComplete,
  buildSnapshot,
  corpusHash,
  createLlmClient,
  dbConfigFromEnv,
  deriveRunKey,
  describeConfig,
  llmConfigFromEnv,
  loadEnvFile,
  loadCorpus,
  migrate,
  nextAttempt,
  openDb,
  parseScenario,
  replayFromCassette,
  persistRun,
  persistScenario,
  readRunRecords,
  replayRun,
  reset,
  runScenario,
  scriptFor,
  verifyDeterminism,
} from '@adversary/runner';

// Before anything reads a variable. A real environment variable always wins, so
// `GEMINI_API_KEY=... pnpm adversary ...` overrides the file rather than
// fighting it.
const env = loadEnvFile();

const program = new Command();

program
  .name('adversary')
  .description('An evaluation and red-team harness for AI agents with payment authority.')
  .version('0.1.0');

// --- shared helpers ---------------------------------------------------------

function scenarioRoot(): string {
  return resolve(process.cwd(), process.env['ADVERSARY_SCENARIOS'] ?? 'scenarios');
}

function scenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scenarioFiles(full));
    else if (entry.endsWith('.yaml')) out.push(full);
  }
  return out;
}

/**
 * The scenarios a command should act on.
 *
 * The whole corpus is always loaded first, even when one scenario was asked
 * for, because pairing is a property of the corpus: an attack whose benign twin
 * is missing is a coherence error, and finding that out only when someone runs
 * the full set would be finding out too late.
 */
function select(target: string | undefined, family: string | undefined, all: boolean): LoadedScenario[] {
  const corpus = loadCorpus(scenarioFiles(scenarioRoot()));

  if (all || (target === undefined && family === undefined)) return corpus;

  if (family !== undefined) {
    const chosen = corpus.filter((c) => c.scenario.family === (family as ScenarioFamily));
    if (chosen.length === 0) fail(`No scenarios in family ${family}.`);
    return chosen;
  }

  const chosen = corpus.filter((c) => c.scenario.id === target);
  if (chosen.length === 0) fail(`No scenario with id "${target}". Try list-scenarios.`);
  return chosen;
}

async function withDb<T>(fn: (db: DbHandle) => Promise<T>): Promise<T> {
  const db = await openDb(dbConfigFromEnv());
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Says what was loaded, without ever printing a value. */
function describeEnv(): string {
  if (env.path === null) return '';
  const parts = [`${env.applied.length} from .env`];
  if (env.skipped.length > 0) {
    parts.push(`${env.skipped.length} already set in the environment`);
  }
  return `  (${parts.join(', ')})`;
}

function fail(message: string): never {
  console.error(`adversary: ${message}`);
  process.exit(1);
}

function pct(value: number | null): string {
  return value === null ? 'not measured' : `${(value * 100).toFixed(1)}%`;
}

function money(value: Paise | null): string {
  return value === null ? 'not measured' : formatPaise(value);
}

// --- run --------------------------------------------------------------------

program
  .command('run')
  .description('Run scenarios and record what the agent did.')
  .argument('[scenario]', 'scenario id; omit to run the whole corpus')
  .option('--family <letter>', 'run one family (A-G)')
  .option('--all', 'run the whole corpus', false)
  .option('--rail <rail>', 'mock | live-test', 'mock')
  .option('--gate <state>', 'on | off | both', 'both')
  .option('--seed <n>', 'override every scenario seed')
  .option('--agent <name>', 'scripted | ops | naive', 'scripted')
  .option('--timeout <ms>', "wall-clock cap per run; a live model needs far more than a scenario's default")
  .option('--fresh', 'drop and recreate the database first', false)
  .action(async (target: string | undefined, options: Record<string, unknown>) => {
    const rail = String(options['rail']);
    if (rail !== 'mock' && rail !== 'live-test') {
      fail(`--rail expects mock or live-test; got "${rail}".`);
    }
    // Constructed before anything else so a refused key stops the run before a
    // single scenario loads. All the guards live in the rail's own
    // constructors (fails closed, redacts, no bypass); the CLI only adds
    // legible errors for credentials that are absent entirely.
    const liveRail = rail === 'live-test' ? buildLiveRail() : null;

    const seed = options['seed'] === undefined ? undefined : Number(options['seed']);
    const scenarios = select(target, options['family'] as string | undefined, options['all'] === true)
      .map((loaded) => withSeed(loaded, seed));
    const gateStates = gateStatesFor(String(options['gate']));
    const { agent, model, reproducibility, cassette } = buildAgent(String(options['agent']));

    // In replay the hash is fixed up front and every run row carries it, so a
    // scorecard can cite which recording produced its numbers. A recording
    // pass gets null: its runs are live-tier, and stamping the hash of a
    // cassette that does not exist yet would name nothing.
    const recording = cassette !== null && reproducibility !== 'cassette';
    const cassetteHash = cassette !== null && !recording ? cassette.hash : null;

    // A live model is far slower than the scripted agent the corpus caps were
    // written for, so the default is raised when one is in play rather than
    // leaving every run to be cut off mid-flight.
    const timeoutMs =
      options['timeout'] !== undefined
        ? Number(options['timeout'])
        : agent === null
          ? undefined
          : 600_000;

    await withDb(async (db) => {
      if (options['fresh'] === true) await reset(db);
      assertSchemaComplete(await migrate(db));

      console.log(
        `running ${scenarios.length} scenario(s) on the ${rail} rail, ` +
          `gate ${gateStates.map((g) => (g ? 'on' : 'off')).join(' and ')}, ` +
          `agent ${agent === null ? 'per-scenario script' : agent.name}` +
          (model === null ? '' : ` · ${model}`) +
          (agent === null ? '' : describeEnv()) +
          (cassette === null
            ? ''
            : recording
              ? ` · recording ${cassette.path}`
              : ` · replaying ${cassette.path}`),
      );

      for (const loaded of scenarios) {
        await persistScenario(db, loaded);
        const sut = agent ?? scriptFor(loaded.scenario);

        for (const gateOn of gateStates) {
          // Derived, not discovered by running. Working the key out by
          // executing the scenario first would double every run.
          const runKey = deriveRunKey({
            scenarioId: loaded.scenario.id,
            scenarioContentHash: loaded.contentHash,
            seed: loaded.scenario.seed,
            rail: loaded.scenario.rail,
            gateEnabled: gateOn,
            agentName: sut.name,
            agentVersion: sut.version,
            model,
          });

          const result = await runScenario({
            loaded,
            agent: sut,
            gate: gateOn ? createGate() : null,
            attempt: await nextAttempt(db, runKey),
            model,
            // A run that touched a real provider is `live` whatever the agent
            // was: the network is not reproducible, and a scripted agent on
            // the live rail must not inherit the scripted tier's determinism
            // claim. verifyDeterminism refuses to compare live runs, and this
            // is what makes that refusal reach the right rows.
            reproducibility: liveRail === null ? reproducibility : 'live',
            ...(liveRail === null ? {} : { rail: liveRail }),
            ...(timeoutMs === undefined ? {} : { wallClockMs: timeoutMs }),
            cassetteHash,
          });
          await persistRun(db, result);

          // After every run, not once at the end: the recording is the
          // expensive artefact, and a crash mid-corpus must not discard the
          // completions already paid for. Until this call existed, record mode
          // accumulated everything in memory and wrote nothing at all - the
          // CLI dropped the handle, and a "recording" run exited 0 having
          // recorded nothing anyone could replay.
          if (recording) (cassette as CassetteLlm).save();

          console.log(
            `  ${result.verdict.padEnd(8)} ${loaded.scenario.id}` +
              ` (gate ${gateOn ? 'on ' : 'off'}, ${result.actions.length} action(s))` +
              (result.error === null ? '' : `  ERROR ${result.error}`),
          );
        }
      }

      if (recording) {
        const hash = (cassette as CassetteLlm).save();
        if ((cassette as CassetteLlm).entryCount === 0) {
          // Every model call failed, so there is nothing to replay. The first
          // real recording attempt hit exactly this - an invalid key - and
          // printing the replay invitation for a cassette of nothing would
          // send someone to a guaranteed hard error with instructions
          // attached.
          console.log(`
cassette ${(cassette as CassetteLlm).path} holds 0 completions - every model ` +
            `call failed. Fix the failure above and re-record; there is nothing to replay.`);
        } else {
          printReplayHint(cassette as CassetteLlm, hash);
        }
      } else if (cassette !== null && cassette.unusedEntries > 0) {

        console.log(`
note: ${cassette.unusedEntries} cassette entr${
          cassette.unusedEntries === 1 ? 'y was' : 'ies were'
        } never requested. The scenarios have drifted from what was recorded; ` +
          're-record before trusting a full-corpus replay.');
      }

      console.log(`
stored in ${describeConfig(dbConfigFromEnv())}`);
      console.log('run `adversary report` to build a scorecard.');
    });
  });

/**
 * Constructs the live-test rail from the environment, or explains what is
 * missing.
 *
 * Every guard it relies on lives below this function and cannot be reached
 * around: `RestProviderClient` and `LiveTestRail` both call `assertTestKey` in
 * their constructors, which throws on a production-shaped key, throws on an
 * unrecognised shape (fails closed), and redacts the key in its message. This
 * function adds nothing but legible errors for the one case the guard cannot
 * see - credentials that are absent entirely.
 */
function buildLiveRail(): Rail {
  const keyId = process.env['RAZORPAY_KEY_ID']?.trim() ?? '';
  const keySecret = process.env['RAZORPAY_KEY_SECRET']?.trim() ?? '';
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET']?.trim() ?? '';

  if (keyId === '' || keySecret === '') {
    fail(
      'The live-test rail needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET - ' +
        'TEST-mode credentials (rzp_test_...), never live ones. Generate them ' +
        'with the Razorpay dashboard switched to Test Mode, and put them in ' +
        '.env beside package.json.',
    );
  }
  // The key-shape guard runs BEFORE the webhook-secret check on purpose. A
  // user holding a production key must hear about the production key first -
  // it is the refusal that concerns money - not be walked through fixing
  // lesser configuration around a credential that will never be accepted.
  try {
    assertTestKey(keyId, 'key id');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (webhookSecret === '') {
    fail(
      'The live-test rail needs RAZORPAY_WEBHOOK_SECRET: an unsigned webhook ' +
        'endpoint is an open door, so the rail refuses to run without a ' +
        'secret to verify signatures against.',
    );
  }

  try {
    return new LiveTestRail({
      keyId,
      client: new RestProviderClient({ keyId, keySecret }),
      clock: wallClock(),
      webhookSecret,
    });
  } catch (err) {
    // ProductionKeyError, already redacted by the guard. The CLI's job here is
    // exit code 1 and the guard's own words, nothing more.
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A real clock for the one rail that is allowed to read one.
 *
 * `advance` throws rather than no-ops: the only callers of advance are
 * deterministic components, and a deterministic component that has been handed
 * a wall clock is a wiring mistake that must not pass silently.
 */
function wallClock(): Clock {
  return {
    // The single sanctioned wall-clock read in the project. The live rail is
    // defined by touching reality - provider-assigned refs, real network, real
    // time - and its runs carry the `live` tier precisely because of reads
    // like this one. Everything else takes an injected deterministic Clock,
    // and the lint rule stays on to keep it that way.
    // eslint-disable-next-line no-restricted-properties
    now: () => Date.now(),
    advance: () => {
      throw new Error(
        "A wall clock cannot be advanced. A deterministic component was handed the live rail's clock.",
      );
    },
  };
}

function printReplayHint(cassette: CassetteLlm, hash: string): void {
  console.log(`
cassette written to ${cassette.path} (${hash.slice(0, 16)}…)
replay it - no key needed - with:
  ADVERSARY_CASSETTE=${cassette.path} ADVERSARY_CASSETTE_MODE=replay`);
}

function gateStatesFor(value: string): boolean[] {
  if (value === 'on') return [true];
  if (value === 'off') return [false];
  if (value === 'both') return [false, true];
  return fail(`--gate expects on, off or both; got "${value}".`);
}

/**
 * Overrides a scenario's seed by rewriting its source and re-parsing.
 *
 * Not by mutating the loaded object: the seed is part of the content hash, and
 * a run whose seed differed from the hash it cited would be unreproducible in
 * the one way the hash exists to prevent.
 */
function withSeed(loaded: LoadedScenario, seed: number | undefined): LoadedScenario {
  if (seed === undefined) return loaded;
  if (!Number.isInteger(seed) || seed < 0) fail(`--seed expects a whole number, got "${seed}".`);

  const yaml = /^seed:/m.test(loaded.yamlSnapshot)
    ? loaded.yamlSnapshot.replace(/^seed:.*$/m, `seed: ${seed}`)
    : `${loaded.yamlSnapshot}
seed: ${seed}
`;

  return parseScenario(yaml, loaded.source);
}

/**
 * The system under test.
 *
 * `scripted` returns null so each scenario runs its own script - the default,
 * and the only agent that needs no credentials. `ops` and `naive` need a model,
 * and a run using one carries the `live` reproducibility tier because a hosted
 * model is not deterministic.
 */
function buildAgent(name: string): {
  agent: PaymentAgent | null;
  model: string | null;
  reproducibility: ReproducibilityTier;
  cassette: CassetteLlm | null;
} {
  if (name === 'scripted')
    return { agent: null, model: null, reproducibility: 'scripted', cassette: null };
  if (name !== 'ops' && name !== 'naive') {
    fail(`--agent expects scripted, ops or naive; got "${name}".`);
  }

  const llm = resolveLlm();
  const agent =
    name === 'ops' ? createOps({ llm: llm.client }) : createNaiveOps({ llm: llm.client });

  return {
    agent,
    model: llm.model,
    reproducibility: llm.reproducibility,
    cassette: llm.cassette,
  };
}

/**
 * A model client, or an explanation of what is missing.
 *
 * Replaying a cassette needs no credentials at all, so that path is tried
 * first: someone reproducing a published LLM run should not have to hold an
 * account with the provider that produced it.
 */
function resolveLlm(): ResolvedLlm {
  const cassette = process.env['ADVERSARY_CASSETTE']?.trim();
  const mode = process.env['ADVERSARY_CASSETTE_MODE']?.trim();

  const config = llmConfigFromEnv();
  if (config === null) {
    if (cassette && mode === 'replay') return replayFromCassette(cassette);

    fail(
      'That agent needs a model. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY ' +
        'or GEMINI_API_KEY - in your shell or in a .env file beside ' +
        'package.json - or replay a cassette with ADVERSARY_CASSETTE and ' +
        'ADVERSARY_CASSETTE_MODE=replay, or use --agent scripted, which needs ' +
        'no credentials and is what CI runs.' +
        (env.path === null
          ? '\n  No .env file was found in this directory.'
          : `\n  Read ${env.path}${describeEnv()}, but no model key was among them.`),
    );
  }

  return createLlmClient(config);
}

// --- report -----------------------------------------------------------------

program
  .command('report')
  .description('Build a scorecard from recorded runs.')
  .option('--out <path>', 'where to write the HTML', 'report.html')
  .option('--json <path>', 'where to write the evidence snapshot the viewer reads')
  .option('--rail <rail>', 'mock | live-test', 'mock')
  .action(async (options: Record<string, unknown>) => {
    const out = resolve(process.cwd(), String(options['out']));
    const rail = String(options['rail']) as 'mock' | 'live-test';

    await withDb(async (db) => {
      assertSchemaComplete(await migrate(db));

      const ungatedRuns = await readRunRecords(db, { rail, gateEnabled: false });
      const gatedRuns = await readRunRecords(db, { rail, gateEnabled: true });

      if (ungatedRuns.length === 0 || gatedRuns.length === 0) {
        // A one-sided report would show effectiveness with nothing to compare
        // it against, which is the failure this project exists to avoid.
        fail(
          'Need runs with the gate both off and on to build a scorecard ' +
            `(found ${ungatedRuns.length} off, ${gatedRuns.length} on). ` +
            'Run `adversary run --gate both` first.',
        );
      }

      // The hash names the set that was *measured*, not the set on disk. A
      // scorecard built from ten stored runs that cited the sixty-scenario
      // hash would be claiming coverage it does not have.
      const whole = loadCorpus(scenarioFiles(scenarioRoot()));
      const measured = new Set([...ungatedRuns, ...gatedRuns].map((r) => r.scenarioId));
      const hash = corpusHash(whole.filter((c) => measured.has(c.scenario.id)));

      // The seeds are known here, so they are stated rather than left to the
      // reader to infer. Every scenario carries its own; a scorecard that
      // listed none would be quietly less reproducible than it is.
      const seeds = [
        ...new Set(
          whole.filter((c) => measured.has(c.scenario.id)).map((c) => c.scenario.seed),
        ),
      ].sort((a, b) => a - b);

      const ungated = scorecardFor(ungatedRuns, { corpusHash: hash, seeds });
      const gated = scorecardFor(gatedRuns, { corpusHash: hash, seeds });

      if (measured.size < whole.length) {
        console.warn(
          `note: ${measured.size} of ${whole.length} scenarios are in the ` +
            'database, so this scorecard covers a subset and its corpus hash ' +
            'differs from the full-corpus one. `adversary run --all` first for ' +
            'a comparable number.',
        );
      }

      const comparison = compareGate(ungated, gated);
      write(out, renderReport({ comparison, runs: gatedRuns }));

      // Both artefacts come out of the same read, so the viewer and the report
      // can never be looking at different evidence.
      const jsonOut =
        options['json'] === undefined
          ? `${out.replace(/\.html?$/i, '')}.json`
          : resolve(process.cwd(), String(options['json']));
      write(jsonOut, JSON.stringify(await buildSnapshot(db, comparison, rail), null, 2));

      printHeadline(ungated, gated);
      console.log(`\nwrote ${out}`);
      console.log(`wrote ${jsonOut}`);
    });
  });

/**
 * Writes a file, creating its directory first.
 *
 * `--out` and `--json` may point anywhere, and the default json path is inside
 * `apps/dashboard/public/` - a directory whose only file is gitignored, which
 * means git does not track it and a fresh checkout does not have it.
 *
 * Found by the `demo` CI job on its first run, and only there: every machine
 * that had ever produced a snapshot already had the directory, so the failure
 * was invisible to exactly the people who would have looked for it. That is the
 * whole argument for testing a clean checkout on a machine nobody has warmed
 * up, rather than trusting that it works because it works here.
 */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function printHeadline(
  ungated: ReturnType<typeof scorecardFor>,
  gated: ReturnType<typeof scorecardFor>,
): void {
  const line = (label: string, card: typeof gated): string =>
    `  ${label.padEnd(9)} attack success ${pct(card.effectiveness.attackSuccessRate).padStart(12)}` +
    `   false-positive cost ${money(card.cost.falsePositiveCostPaise).padStart(14)}`;

  console.log(
    `
${gated.provenance.scenarioCount} scenarios · ${gated.rail} rail · ` +
      `agent ${gated.provenance.agentName} · repeatable: ${gated.provenance.reproducibility} · ` +
      `corpus ${gated.provenance.corpusHash.slice(0, 12)}…` +
      (gated.provenance.errored > 0 ? ` · ${gated.provenance.errored} errored` : ''),
  );
  console.log(line('gate off:', ungated));
  console.log(line('gate on:', gated));
  console.log(
    '\n  Neither number means anything alone. A gate that refuses everything\n' +
      '  scores a perfect attack success rate.',
  );
}

// --- replay -----------------------------------------------------------------

program
  .command('replay')
  .description('Re-render a stored run. Reads only; executes nothing.')
  .argument('<runId>')
  .action(async (runId: string) => {
    await withDb(async (db) => {
      const run = await replayRun(db, runId);

      console.log(`${run.scenarioId}  ${run.verdict ?? 'no verdict'}`);
      console.log(
        `  rail ${run.rail} · gate ${run.gateEnabled ? 'on' : 'off'} · ` +
          `agent ${run.agentName}@${run.agentVersion} · ${run.reproducibility}`,
      );
      console.log(`  corpus ${run.scenarioContentHash.slice(0, 16)}… · seed ${run.seed}`);

      console.log('\n  money actions');
      if (run.actions.length === 0) console.log('    (none attempted)');
      for (const action of run.actions) {
        console.log(
          `    ${String(action.seq).padStart(2)}  ${action.kind.padEnd(20)}` +
            ` ${formatPaise(action.amountPaise).padStart(14)}` +
            `  ${(action.payeeRef ?? action.subjectRef ?? '-').padEnd(28)}` +
            `  ${action.gateDecision.padEnd(9)} ${action.railResult}`,
        );
        for (const reason of action.gateReasons) console.log(`        ${reason}`);
      }

      console.log('\n  verdicts');
      for (const verdict of run.verdicts) {
        console.log(
          `    ${verdict.status.padEnd(9)} ${verdict.invariantId}` +
            (verdict.blastRadiusPaise > 0
              ? `  blast ${formatPaise(verdict.blastRadiusPaise)}`
              : ''),
        );
      }
    });
  });

// --- list-scenarios ---------------------------------------------------------

program
  .command('list-scenarios')
  .description('List the corpus.')
  .option('--family <letter>', 'one family only')
  .action((options: Record<string, unknown>) => {
    const corpus = select(undefined, options['family'] as string | undefined, false);

    for (const { scenario } of corpus) {
      console.log(
        `${scenario.family}  ${scenario.kind.padEnd(7)} ${scenario.id.padEnd(46)} ` +
          `${scenario.expect.ungated.padEnd(9)}/${scenario.expect.gated.padEnd(9)} ${scenario.title}`,
      );
    }

    const attacks = corpus.filter((c) => c.scenario.kind === 'attack').length;

    // The hash is always of the whole corpus, never of the filtered view: it is
    // the identifier a scorecard cites, and one computed over six scenarios
    // printed under the same label would silently mean something else.
    const whole = loadCorpus(scenarioFiles(scenarioRoot()));

    console.log(
      `\nshowing ${corpus.length} · ${attacks} attack · ${corpus.length - attacks} benign` +
        `\ncorpus hash ${corpusHash(whole)} (${whole.length} scenarios)`,
    );
  });

// --- verify-determinism -----------------------------------------------------

program
  .command('verify-determinism')
  .description('Run each scenario N times and compare ledgers and verdicts.')
  .option('--scenario <id>', 'one scenario only')
  .option('--family <letter>', 'one family only')
  .option('--attempts <n>', 'how many runs to compare', '3')
  .action(async (options: Record<string, unknown>) => {
    const scenarios = select(
      options['scenario'] as string | undefined,
      options['family'] as string | undefined,
      false,
    );
    const attempts = Number(options['attempts']);
    let failures = 0;

    for (const loaded of scenarios) {
      for (const gateOn of [false, true]) {
        const report = await verifyDeterminism({
          loaded,
          gate: gateOn ? createGate() : null,
          attempts,
        });
        if (report.ok) continue;

        failures += 1;
        console.error(
          `FAIL ${loaded.scenario.id} (gate ${gateOn ? 'on' : 'off'}): ${report.reason}`,
        );
      }
    }

    if (failures > 0) fail(`${failures} determinism check(s) failed.`);

    console.log(
      `determinism verified: ${scenarios.length} scenario(s) × 2 gate states × ` +
        `${attempts} attempts, identical ledgers and verdicts.`,
    );
  });

// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
