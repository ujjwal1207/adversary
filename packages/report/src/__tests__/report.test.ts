/**
 * The report.
 *
 * Two assertions here are the Phase 9 gate, and both are about honesty rather
 * than appearance:
 *
 *   the two headline numbers are rendered in STRUCTURALLY IDENTICAL markup, so
 *   neither can drift into looking like the headline while the other becomes a
 *   footnote;
 *
 *   every number carries the rail it was measured on, so a reader who scrolls
 *   past the header can still tell simulator figures from provider figures.
 */

import { describe, expect, it } from 'vitest';

import type { MoneyActionDraft, RunRecord } from '@adversary/core';
import { InMemoryLedger, compareGate, paise, scorecardFor } from '@adversary/core';

import { renderReport } from '../report.js';

const HASH = 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

function actions(specs: readonly Partial<MoneyActionDraft>[]) {
  const ledger = new InMemoryLedger();
  specs.forEach((spec, i) =>
    ledger.append({
      id: `ma_${i}`,
      runId: 'run',
      ts: 1_760_000_000_000 + i * 100,
      kind: 'transfer',
      params: {},
      amountPaise: paise(120000),
      payeeRef: 'acct_vendor_acme',
      subjectRef: null,
      idempotencyKey: `k${i}`,
      idempotencySource: 'auto',
      taint: [],
      gateDecision: 'allow',
      gateReasons: [],
      ruleTrace: [],
      agentRationale: '',
      railResult: 'ok',
      railRef: 'pout_mock_1',
      railError: null,
      ...spec,
    }),
  );
  return [...ledger.getRun('run')];
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scenarioId: 'B1_invoice_borne_redirect',
    scenarioKind: 'attack',
    family: 'B',
    rail: 'mock',
    gateEnabled: true,
    verdict: 'blocked',
    turnsUsed: 3,
    reproducibility: 'scripted',
    agentName: 'scripted',
    agentVersion: '1.0.0',
    model: null,
    actions: [],
    verdicts: [],
    ...overrides,
  };
}

function build(overrides: { ungated?: RunRecord[]; gated?: RunRecord[] } = {}) {
  const gatedRuns = overrides.gated ?? [
    run({
      actions: actions([
        {
          amountPaise: paise(480000),
          payeeRef: 'acct_vendor_acme_new',
          gateDecision: 'block',
          gateReasons: ['Payee acct_vendor_acme_new is not on the approved payee list.'],
          railResult: 'not_executed',
          railRef: null,
        },
      ]),
      verdicts: [
        {
          id: 'payee_allowlist',
          status: 'blocked',
          observed: null,
          expected: null,
          blastRadiusPaise: paise(0),
          witnessIds: ['ma_0'],
        },
      ],
    }),
    run({
      scenarioId: 'B1_benign_confirmed_account_change',
      scenarioKind: 'benign',
      verdict: 'pass',
      actions: actions([{ amountPaise: paise(289900) }]),
    }),
  ];

  const ungatedRuns = overrides.ungated ?? [
    run({ gateEnabled: false, verdict: 'violated', actions: actions([{ gateDecision: 'bypassed' }]) }),
    run({
      scenarioId: 'B1_benign_confirmed_account_change',
      scenarioKind: 'benign',
      gateEnabled: false,
      verdict: 'pass',
      actions: actions([{ gateDecision: 'bypassed' }]),
    }),
  ];

  const comparison = compareGate(
    scorecardFor(ungatedRuns, { corpusHash: HASH, seeds: [42] }),
    scorecardFor(gatedRuns, { corpusHash: HASH, seeds: [42] }),
  );

  return { html: renderReport({ comparison, runs: gatedRuns }), comparison, gatedRuns };
}

/** Tags and classes only, with all text removed. */
function skeleton(fragment: string): string {
  return (fragment.match(/<[a-z]+[^>]*>/g) ?? [])
    .map((tag) => {
      const name = /^<([a-z]+)/.exec(tag)?.[1] ?? '';
      const cls = /class="([^"]*)"/.exec(tag)?.[1] ?? '';
      return `${name}.${cls}`;
    })
    .join(' > ');
}

function cards(html: string): string[] {
  const section = /<section class="headlines">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
  return section.split('<div class="card">').slice(1).map((c) => `<div class="card">${c}`);
}

// --- the gate ---------------------------------------------------------------

describe('the two numbers', () => {
  const { html } = build();

  it('both appear', () => {
    expect(html).toContain('Attack success rate');
    expect(html).toContain('False-positive cost');
  });

  it('are rendered in structurally identical markup', () => {
    // Not "similar". Identical - both come from one function called twice, and
    // this test is what stops them drifting apart.
    const [first, second] = cards(html);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(skeleton(first as string)).toBe(skeleton(second as string));
  });

  it('sit in the same container, so neither can be scrolled past', () => {
    expect(cards(html)).toHaveLength(2);
  });

  it('are captioned with the reason both are needed', () => {
    expect(html).toContain('A gate that refuses everything scores a');
  });

  it('report the actual computed values', () => {
    // One attack, blocked: success rate 0%. One benign, nothing withheld: cost
    // zero rupees.
    expect(html).toContain('0.0%');
    expect(html).toContain('₹0.00');
  });
});

describe('rail badges', () => {
  const { html } = build();

  it('appear on every headline number', () => {
    for (const card of cards(html)) {
      expect(card).toMatch(/<span class="rail" data-rail="mock">/);
    }
  });

  it('appear on every cell of the gate comparison', () => {
    const table = /<h2>Gate off vs gate on<\/h2>([\s\S]*?)<h3>/.exec(html)?.[1] ?? '';
    const dataCells = table.match(/<td>(?!<)[\s\S]*?<\/td>/g) ?? [];

    expect(dataCells.length).toBeGreaterThan(0);
    for (const cell of dataCells) {
      expect(cell, cell).toContain('class="rail"');
    }
  });

  it('name the rail the runs were measured on', () => {
    expect(html).toContain('data-rail="mock"');
    expect(html).not.toContain('data-rail="live-test"');
  });
});

// --- unmeasured is not zero -------------------------------------------------

describe('unmeasured quantities', () => {
  it('render as "not measured", never as a number', () => {
    // A run set with no benign scenarios has no false-positive cost. Showing
    // zero would let a gate that blocks everything look free.
    const attacksOnly = build({
      gated: [run({ verdict: 'blocked' })],
      ungated: [run({ gateEnabled: false, verdict: 'violated' })],
    });

    const [, costCard] = cards(attacksOnly.html);
    expect(costCard).toContain('not measured');
    expect(costCard).not.toContain('₹0.00');
  });
});

// --- drill-down -------------------------------------------------------------

describe('per-run detail', () => {
  const { html } = build();

  it('lists each run with its verdict', () => {
    expect(html).toContain('B1_invoice_borne_redirect');
    expect(html).toContain('B1_benign_confirmed_account_change');
    expect(html).toMatch(/<span class="verdict blocked">/);
  });

  it('shows the money actions with the gate reason inline', () => {
    expect(html).toContain('acct_vendor_acme_new');
    expect(html).toContain('is not on the approved payee list');
    expect(html).toMatch(/<span class="gate block">/);
    expect(html).toMatch(/<span class="rail-result not_executed">/);
  });

  it('says so when a run attempted no money action', () => {
    const quiet = build({
      gated: [run({ verdict: 'pass' }), run({ scenarioId: 'b', scenarioKind: 'benign', verdict: 'pass' })],
    });
    expect(quiet.html).toContain('No money action was attempted.');
  });
});

// --- provenance -------------------------------------------------------------

describe('the footer', () => {
  const { html } = build();

  it('prints the corpus hash and the seed', () => {
    // A scorecard is only reproducible if you know which corpus produced it.
    expect(html).toContain(HASH);
    expect(html).toContain('42');
  });

  it('prints the agent, the model and the reproducibility tier', () => {
    expect(html).toContain('scripted@1.0.0');
    expect(html).toContain('none');
    expect(html).toContain('repeating this run reproduces it exactly');
  });

  it('says that rails are never aggregated', () => {
    expect(html).toContain('never aggregated');
  });

  it('reports runs whose measurement broke', () => {
    expect(html).toContain('Runs with a broken measurement');
  });
});

// --- the heuristic label ----------------------------------------------------

describe('the recognition-execution gap', () => {
  it('is labelled a heuristic wherever it appears', () => {
    const { html } = build();
    // Whitespace-normalised: the assertion is about what the report says, not
    // about where its prose happens to wrap.
    const section = (/<h3>Recognition-execution gap([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')
      .replace(/\s+/g, ' ');

    expect(section).toContain('heuristic');
    expect(section).toContain('not about what a model understood');
    expect(section).toContain('Keyword detection');
  });
});

// --- self-contained ---------------------------------------------------------

describe('the file stands alone', () => {
  const { html } = build();

  it('loads no external stylesheet or script', () => {
    // No build step, no network, opens from the filesystem.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('inlines its own dataset', () => {
    const data = /<script type="application\/json" id="adversary-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(data).toBeDefined();
    expect(JSON.parse(data as string)).toMatchObject({ rail: 'mock' });
  });

  it('escapes angle brackets so a payload cannot close the script block', () => {
    const nasty = build({
      gated: [
        run({
          scenarioId: '</script><img src=x>',
          actions: actions([{ gateReasons: ['<b>not</b> allowed'] }]),
        }),
        run({ scenarioId: 'b', scenarioKind: 'benign', verdict: 'pass' }),
      ],
    });

    expect(nasty.html).not.toContain('<img src=x>');
    expect(nasty.html).not.toContain('<b>not</b>');
    expect(nasty.html).toContain('&lt;b&gt;not&lt;/b&gt;');
  });

  it('carries a title', () => {
    expect(html).toContain('<title>Adversary scorecard</title>');
  });
});
