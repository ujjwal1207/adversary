/**
 * The whole pipeline, on the real corpus: 60 scenarios, run twice, measured,
 * rendered.
 *
 * This is where the two numbers the product exists for get computed from actual
 * runs rather than from fixtures. The assertions are mostly about coherence -
 * that the gate helps on attacks, that it costs something on benign scenarios,
 * and that the report says both - because the exact figures will move as the
 * corpus and the gate change, and pinning them here would turn every
 * improvement into a test failure.
 *
 * What is pinned: the relationships that would indicate a broken measurement.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { RunRecord, Scorecard } from '@adversary/core';
import { compareGate, formatPaise, scorecardFor } from '@adversary/core';
import { createGate } from '@adversary/gate';
import { renderReport } from '@adversary/report';
import { corpusHash, loadCorpus, runScenario, toRunRecord } from '@adversary/runner';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function scenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scenarioFiles(full));
    else if (entry.endsWith('.yaml')) out.push(full);
  }
  return out;
}

const CORPUS = loadCorpus(scenarioFiles(join(REPO_ROOT, 'scenarios')));
const HASH = corpusHash(CORPUS);

let ungated: Scorecard;
let gated: Scorecard;
let gatedRuns: RunRecord[];
let html: string;

beforeAll(async () => {
  const collect = async (gateOn: boolean): Promise<RunRecord[]> => {
    const records: RunRecord[] = [];
    for (const loaded of CORPUS) {
      const result = await runScenario({ loaded, gate: gateOn ? createGate() : null });
      records.push(toRunRecord(result, loaded.scenario));
    }
    return records;
  };

  const off = await collect(false);
  gatedRuns = await collect(true);

  ungated = scorecardFor(off, { corpusHash: HASH, seeds: [42] });
  gated = scorecardFor(gatedRuns, { corpusHash: HASH, seeds: [42] });
  html = renderReport({ comparison: compareGate(ungated, gated), runs: gatedRuns });
}, 120_000);

describe('the corpus, measured', () => {
  it('measures every scenario without a broken measurement', () => {
    expect(ungated.provenance.errored).toBe(0);
    expect(gated.provenance.errored).toBe(0);
    expect(gated.provenance.scenarioCount).toBe(CORPUS.length);
  });

  it('keeps the two denominators separate and complete', () => {
    expect(gated.effectiveness.attackScenarios + gated.cost.benignScenarios).toBe(
      CORPUS.length,
    );
  });

  it('reports what the numbers actually are', () => {
    const line = (label: string, card: Scorecard): string =>
      `${label.padEnd(10)} attack success ${pct(card.effectiveness.attackSuccessRate)}` +
      `  containment ${pct(card.effectiveness.containmentRate)}` +
      `  blast ${formatPaise(card.effectiveness.blastRadiusPaise)}` +
      `  FP cost ${card.cost.falsePositiveCostPaise === null ? 'n/a' : formatPaise(card.cost.falsePositiveCostPaise)}` +
      `  over-refusal ${pct(card.cost.overRefusalRate)}`;

    console.log(line('gate off:', ungated));
    console.log(line('gate on: ', gated));

    // Derived from the corpus, not written down. A hardcoded count fails on
    // every scenario anybody adds, which trains people to edit the number
    // rather than to ask whether the denominators still line up.
    const attacks = CORPUS.filter((c) => c.scenario.kind === 'attack').length;
    const benign = CORPUS.length - attacks;

    expect(gated.effectiveness.attackScenarios).toBe(attacks);
    expect(gated.cost.benignScenarios).toBe(benign);
    expect(ungated.effectiveness.attackScenarios).toBe(attacks);

    // The property behind those denominators: one-to-one pairing (A16). Every
    // attack has its own benign twin, so a false-positive cost is measured
    // against a scenario chosen for that attack rather than shared across
    // several.
    expect(attacks).toBe(benign);
  });
});

describe('the gate helps, and it costs', () => {
  it('lowers the attack success rate', () => {
    // If turning the gate on did not reduce violations, the defence is not a
    // defence and the corpus is not exercising it.
    expect(gated.effectiveness.attackSuccessRate).toBeLessThan(
      ungated.effectiveness.attackSuccessRate as number,
    );
  });

  it('reduces blast radius to less than it was without the gate', () => {
    expect(gated.effectiveness.blastRadiusPaise).toBeLessThan(
      ungated.effectiveness.blastRadiusPaise,
    );
  });

  it('contains some but not all attempted violations', () => {
    // Not all: families E2 and F are attacks the eight rules have nothing to
    // say about, and a containment rate of 1.0 would mean the corpus had
    // stopped asking hard questions.
    expect(gated.effectiveness.containmentRate).toBeGreaterThan(0);
    expect(gated.effectiveness.containmentRate).toBeLessThan(1);
  });

  it('costs real money in legitimate business', () => {
    // The number that makes the scorecard honest. A gate whose measured cost
    // were zero would be one nobody had measured the cost of.
    expect(ungated.cost.falsePositiveCostPaise).toBe(0);
    expect(gated.cost.falsePositiveCostPaise).toBeGreaterThan(0);
    expect(gated.cost.overRefusalRate).toBeGreaterThan(0);
  });

  it('does not refuse most legitimate business', () => {
    // A sanity bound rather than a target. If the gate started refusing most
    // benign scenarios, the corpus should say so loudly.
    expect(gated.cost.overRefusalRate).toBeLessThan(0.5);
  });

  it('leaves attacks the gate cannot see', () => {
    // Families E2 and F expect `gated: violated` by design. If this reached
    // zero, either the gate had grown a scope rule or the corpus had lost its
    // hardest scenarios.
    expect(gated.effectiveness.violated).toBeGreaterThan(0);
  });
});

describe('the report', () => {
  it('renders both numbers, from real runs', () => {
    expect(html).toContain('Attack success rate');
    expect(html).toContain('False-positive cost');
    expect(html).toContain(HASH);
  });

  it('carries a rail badge on every headline', () => {
    const section = /<section class="headlines">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    expect(section.match(/class="rail"/g) ?? []).toHaveLength(2);
  });

  it('breaks down every family the corpus contains', () => {
    for (const family of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(gated.families.some((f) => f.family === family), family).toBe(true);
    }
  });

  it('includes a drill-down row for every run', () => {
    expect((html.match(/<details class="run">/g) ?? []).length).toBe(gatedRuns.length);
  });

  it('stays self-contained', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
