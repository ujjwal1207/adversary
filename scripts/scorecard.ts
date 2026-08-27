/**
 * Generates the scorecard from the corpus.
 *
 * A stopgap until `adversary report` lands in Phase 11. It runs the whole
 * corpus twice - gate off, gate on - and writes a single self-contained HTML
 * file. No key, no network, no services.
 *
 *   pnpm scorecard [--out report.html]
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunRecord, Scorecard } from '@adversary/core';
import { compareGate, formatPaise, scorecardFor } from '@adversary/core';
import { createGate } from '@adversary/gate';
import { renderReport } from '@adversary/report';
import { corpusHash, loadCorpus, runScenario, toRunRecord } from '@adversary/runner';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function scenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scenarioFiles(full));
    else if (entry.endsWith('.yaml')) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = resolve(ROOT, outIndex > 0 ? (process.argv[outIndex + 1] as string) : 'report.html');

  const corpus = loadCorpus(scenarioFiles(join(ROOT, 'scenarios')));
  const hash = corpusHash(corpus);
  console.log(`corpus: ${corpus.length} scenarios, hash ${hash.slice(0, 16)}...`);

  const collect = async (gateOn: boolean): Promise<RunRecord[]> => {
    const records: RunRecord[] = [];
    for (const loaded of corpus) {
      const result = await runScenario({ loaded, gate: gateOn ? createGate() : null });
      records.push(toRunRecord(result, loaded.scenario));
    }
    return records;
  };

  const ungatedRuns = await collect(false);
  const gatedRuns = await collect(true);

  const ungated = scorecardFor(ungatedRuns, { corpusHash: hash, seeds: [42] });
  const gated = scorecardFor(gatedRuns, { corpusHash: hash, seeds: [42] });

  writeFileSync(out, renderReport({ comparison: compareGate(ungated, gated), runs: gatedRuns }), 'utf8');

  const line = (label: string, c: Scorecard): string =>
    `  ${label.padEnd(9)} attack success ${pct(c.effectiveness.attackSuccessRate).padStart(6)}` +
    `   blast ${formatPaise(c.effectiveness.blastRadiusPaise).padStart(14)}` +
    `   false-positive cost ${(c.cost.falsePositiveCostPaise === null ? 'not measured' : formatPaise(c.cost.falsePositiveCostPaise)).padStart(14)}`;

  console.log(line('gate off:', ungated));
  console.log(line('gate on:', gated));
  console.log(`\nwrote ${out}`);
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
