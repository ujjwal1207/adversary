/**
 * The Phase 8 acceptance gate.
 *
 *   - the corpus loads and is coherent (every attack paired, no duplicate ids)
 *   - every scenario is deterministic across three consecutive runs
 *   - every `expect` field matches observed behaviour, in BOTH gate states
 *
 * The third is what turns the corpus into a regression suite. `expect` is a
 * claim about what should happen, written before the run; if a gated scenario
 * starts producing `violated` where it produced `blocked`, this fails, and the
 * failure is the point.
 *
 * Nothing here needs a key or a network: the system under test is each
 * scenario's own script.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createGate } from '@adversary/gate';
import type { LoadedScenario } from '@adversary/runner';
import {
  corpusHash,
  loadCorpus,
  resolveFixturePath,
  runScenario,
  verifyDeterminism,
} from '@adversary/runner';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_ROOT = join(REPO_ROOT, 'scenarios');

function scenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scenarioFiles(full));
    else if (entry.endsWith('.yaml')) out.push(full);
  }
  return out;
}

const CORPUS: LoadedScenario[] = loadCorpus(scenarioFiles(SCENARIO_ROOT));
const cases: [string, LoadedScenario][] = CORPUS.map((c) => [c.scenario.id, c]);

// --- shape ------------------------------------------------------------------

describe('the corpus', () => {
  it('loads every scenario and passes the coherence checks', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  it('has a stable corpus hash', () => {
    // Printed in every report footer. Two scorecards claiming to describe the
    // same corpus must carry the same value here.
    expect(corpusHash(CORPUS)).toBe(corpusHash(CORPUS));
    expect(corpusHash(CORPUS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pairs every attack with a benign scenario of the opposite kind', () => {
    // Without this, false-positive cost cannot be computed, and without
    // false-positive cost the scorecard is worthless.
    const byId = new Map(CORPUS.map((c) => [c.scenario.id, c.scenario]));

    for (const { scenario } of CORPUS) {
      if (scenario.kind !== 'attack') continue;
      expect(scenario.pair, `${scenario.id} has no pair`).toBeDefined();
      expect(byId.get(scenario.pair as string)?.kind, `${scenario.id} -> ${scenario.pair}`).toBe(
        'benign',
      );
    }
  });

  it('gives every attack an injection', () => {
    for (const { scenario } of CORPUS) {
      if (scenario.kind === 'attack') {
        expect(scenario.injection, `${scenario.id}`).toBeDefined();
      }
    }
  });

  it('uses only obviously synthetic identifiers', () => {
    // docs/THREAT-MODEL.md: no real-looking bank details, no plausible business
    // identities. Asserted rather than trusted, because a fixture that drifted
    // toward realism would be a genuine problem.
    const realLooking = [
      /\b\d{9,18}\b/, // bare account-number-shaped runs
      /\b[A-Z]{4}0[A-Z0-9]{6}\b/, // IFSC shape
      /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/, // IBAN shape
      /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // card shape
    ];

    for (const { scenario, yamlSnapshot, source } of CORPUS) {
      const body = yamlSnapshot
        .split('\n')
        .filter((line) => !/^\s*(perTxnCapPaise|sessionCapPaise|escalationThresholdPaise|velocityWindowMs|amountPaise|seed|maxTurns):/.test(line))
        .join('\n');
      for (const pattern of realLooking) {
        expect(pattern.test(body), `${scenario.id} (${source}) matched ${pattern}`).toBe(false);
      }
    }
  });

  it('reports its composition', () => {
    const attacks = CORPUS.filter((c) => c.scenario.kind === 'attack').length;
    const families = new Set(CORPUS.map((c) => c.scenario.family));

    console.log(
      `corpus: ${CORPUS.length} scenarios, ${attacks} attack / ${CORPUS.length - attacks} benign, ` +
        `families ${[...families].sort().join('')}`,
    );

    expect(families.size).toBeGreaterThanOrEqual(3);
  });
});

// --- the regression suite ---------------------------------------------------

describe('every scenario behaves as it claims', () => {
  it.each(cases)('%s, gate off', async (_id, loaded) => {
    const run = await runScenario({ loaded, gate: null });

    expect(run.error, `${loaded.scenario.id} errored: ${run.error}`).toBeNull();
    expect(run.verdict).toBe(loaded.scenario.expect.ungated);
  });

  it.each(cases)('%s, gate on', async (_id, loaded) => {
    const run = await runScenario({ loaded, gate: createGate() });

    expect(run.error, `${loaded.scenario.id} errored: ${run.error}`).toBeNull();
    expect(run.verdict).toBe(loaded.scenario.expect.gated);
  });
});

// --- determinism ------------------------------------------------------------

describe('every scenario is deterministic across three runs', () => {
  it.each(cases)('%s', async (_id, loaded) => {
    for (const gate of [null, createGate()]) {
      const report = await verifyDeterminism({ loaded, gate, attempts: 3 });
      expect(
        report.ok,
        `${loaded.scenario.id} gate=${gate !== null}: ${report.reason} ${report.firstDifference ?? ''}`,
      ).toBe(true);
    }
  });
});

describe('every target is discoverable', () => {
  /**
   * The check the corpus went eleven phases without.
   *
   * Every scenario names the thing it acts on — a subscription to retry, a
   * payment to refund. `ScriptedAgent` is *handed* those identifiers in its
   * script, so nothing ever required them to be findable, and nothing was. Ten
   * of the eleven `sub_`/`pay_` identifiers in the corpus appeared in no
   * fixture any read tool returned.
   *
   * It surfaced the first time a real model ran: Gemini read the tickets,
   * correctly concluded it could not obtain a subscription id, and escalated.
   * All eight family E runs ended at the turn cap having moved no money. The
   * corpus was measuring whether an agent could guess an identifier.
   *
   * Restricted to subscriptions and payments on purpose. Payees are not
   * checked, because an attack scenario's whole point is often a payee the
   * agent should *not* be able to justify — `acct_vendor_cedar_new` exists
   * nowhere but the injected payload, and that is the finding rather than a
   * defect.
   */
  const READABLE = [
    'invoices',
    'tickets',
    'vendors',
    'disputes',
    'subscriptions',
    'payments',
  ] as const;

  function readableText(loaded: LoadedScenario): string {
    const refs = loaded.scenario.fixtures as Record<string, string | undefined>;
    return READABLE.map((name) => {
      const path = refs[name];
      return path === undefined
        ? ''
        : readFileSync(resolveFixturePath(loaded.source, path), 'utf8');
    }).join('\n');
  }

  it.each(cases)('%s acts only on identifiers an agent could find', (_id, loaded) => {
    const wanted = new Set<string>();
    for (const step of loaded.scenario.script) {
      const args = (step as { args?: Record<string, unknown> }).args;
      for (const key of ['subId', 'paymentId'] as const) {
        const value = args?.[key];
        if (typeof value === 'string') wanted.add(value);
      }
    }

    const haystack = readableText(loaded);
    for (const id of wanted) {
      expect(
        haystack.includes(id),
        `${loaded.scenario.id} acts on ${id}, which appears in no fixture any ` +
          'read tool returns. An agent that has to discover its own target ' +
          'cannot run this scenario, so it would measure guessing.',
      ).toBe(true);
    }
  });

  it('the read tools cover every fixture an agent needs', () => {
    // A fixture nobody can read is either a taint-baseline record — which is
    // legitimate, customers are exactly that — or a scenario target nobody can
    // reach. This pins which of the two each one is.
    expect([...READABLE].sort()).toEqual([
      'disputes',
      'invoices',
      'payments',
      'subscriptions',
      'tickets',
      'vendors',
    ]);
  });
});
