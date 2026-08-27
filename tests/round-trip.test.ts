/**
 * The claim `adversary report` rests on: a scorecard read back from the
 * database is the same scorecard that was measured.
 *
 * `adversary run` writes and `adversary report` reads, which is what lets a
 * number be regenerated months later from stored evidence rather than from a
 * re-run. That separation is only worth anything if the round trip is lossless,
 * and "lossless" is not something a persistence layer can be assumed to be:
 * every money amount crosses a SQL boundary as a plain integer, and every taint
 * record and rule trace crosses it as JSON text. A single dropped field would
 * move a headline figure without moving a test.
 *
 * So the assertion is equality against the in-memory measurement rather than a
 * hand-written expectation. If the two disagree, one of them is wrong, and the
 * report is the one nobody would check.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunRecord } from '@adversary/core';
import { scorecardFor } from '@adversary/core';
import { createGate } from '@adversary/gate';
import type { DbHandle, LoadedScenario } from '@adversary/runner';
import {
  SQLITE_MEMORY,
  corpusHash,
  deriveRunKey,
  loadCorpus,
  migrate,
  nextAttempt,
  openDb,
  persistRun,
  persistScenario,
  readRunRecords,
  runScenario,
  toRunRecord,
} from '@adversary/runner';

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

/**
 * One scenario from each family.
 *
 * The full sixty run in `tests/scorecard.test.ts`. What is under test here is
 * the persistence round trip, which needs breadth of *shape* - a blocked run, a
 * violated run, a clean run, a run carrying taint, a run with several actions -
 * rather than breadth of corpus.
 */
const SAMPLE = [
  'A1_split_payment',
  'B1_invoice_borne_redirect',
  'B1_benign_confirmed_account_change',
  'C1_invoice_line_item_instruction',
  'D2_retry_after_timeout_without_key',
  'E1_mandate_retried_past_limit',
  'F1_refund_used_when_only_links_authorised',
  'G1_credential_echoed_into_outbound_field',
];

const CORPUS = loadCorpus(scenarioFiles(join(REPO_ROOT, 'scenarios')));
const CHOSEN: LoadedScenario[] = SAMPLE.map((id) => {
  const found = CORPUS.find((c) => c.scenario.id === id);
  if (found === undefined) throw new Error(`sample scenario ${id} is not in the corpus`);
  return found;
});
const HASH = corpusHash(CHOSEN);

/** Runs the sample both ways, persists everything, returns what was measured. */
async function runAndPersist(
  db: DbHandle,
  attempt: number,
): Promise<{ ungated: RunRecord[]; gated: RunRecord[] }> {
  const out = { ungated: [] as RunRecord[], gated: [] as RunRecord[] };

  for (const loaded of CHOSEN) {
    await persistScenario(db, loaded);

    for (const gateOn of [false, true]) {
      const result = await runScenario({
        loaded,
        gate: gateOn ? createGate() : null,
        attempt,
      });
      await persistRun(db, result);
      (gateOn ? out.gated : out.ungated).push(toRunRecord(result, loaded.scenario));
    }
  }

  return out;
}

describe('persisted runs read back as the runs that were measured', () => {
  let db: DbHandle;

  beforeEach(async () => {
    db = await openDb({ dialect: 'sqlite', path: SQLITE_MEMORY });
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('rehydrates every field of every run record', async () => {
    const measured = await runAndPersist(db, 0);

    const readBack = await readRunRecords(db, { rail: 'mock', gateEnabled: true });
    const byId = new Map(readBack.map((r) => [r.scenarioId, r]));

    expect(readBack).toHaveLength(measured.gated.length);

    for (const expected of measured.gated) {
      const actual = byId.get(expected.scenarioId);
      expect(actual, `${expected.scenarioId} missing from the database`).toBeDefined();
      // Deep equality, not a field-by-field spot check: a spot check would pass
      // for exactly as long as nobody added a field.
      expect(actual).toEqual(expected);
    }
  });

  it('produces an identical scorecard from the database and from memory', async () => {
    const measured = await runAndPersist(db, 0);

    for (const gateOn of [false, true]) {
      const fromMemory = scorecardFor(gateOn ? measured.gated : measured.ungated, {
        corpusHash: HASH,
      });
      const fromDb = scorecardFor(
        await readRunRecords(db, { rail: 'mock', gateEnabled: gateOn }),
        { corpusHash: HASH },
      );

      expect(fromDb, `gate ${gateOn ? 'on' : 'off'}`).toEqual(fromMemory);
    }
  });

  it('keeps money exact across the SQL boundary', async () => {
    const measured = await runAndPersist(db, 0);
    const readBack = await readRunRecords(db, { rail: 'mock', gateEnabled: false });

    const total = (records: readonly RunRecord[]): number =>
      records.flatMap((r) => r.actions).reduce((sum, a) => sum + a.amountPaise, 0);

    // Integer minor units the whole way, so this is equality rather than a
    // tolerance. A tolerance here would be an admission that a float got in.
    expect(total(readBack)).toBe(total(measured.ungated));
    expect(Number.isInteger(total(readBack))).toBe(true);
  });

  it('does not double the denominator when a scenario is run again', async () => {
    await runAndPersist(db, 0);
    const first = await readRunRecords(db, { rail: 'mock', gateEnabled: true });

    // A second attempt at the same experiment. Counting both would halve every
    // rate the second time anyone pressed the button.
    await runAndPersist(db, 1);
    const second = await readRunRecords(db, { rail: 'mock', gateEnabled: true });

    expect(second).toHaveLength(first.length);
    expect(scorecardFor(second, { corpusHash: HASH }).provenance.scenarioCount).toBe(
      scorecardFor(first, { corpusHash: HASH }).provenance.scenarioCount,
    );

    // ...and every attempt is still on disk. Superseding is a reading policy,
    // not a deletion: the evidence store is append-only.
    const all = await readRunRecords(db, {
      rail: 'mock',
      gateEnabled: true,
      latestAttemptOnly: false,
    });
    expect(all).toHaveLength(first.length * 2);
  });

  it('refuses to score a run whose scenario it cannot identify', async () => {
    await runAndPersist(db, 0);

    // The scenario row is what says whether a run was an attack or benign.
    // Without it the run cannot be placed in a denominator, and guessing would
    // place it in one it may not belong to.
    await db.run('DELETE FROM scenarios', []);

    await expect(readRunRecords(db, { rail: 'mock' })).rejects.toThrow(
      /not in the scenarios table/i,
    );
  });

  it('separates gate-on from gate-off runs', async () => {
    await runAndPersist(db, 0);

    const ungated = await readRunRecords(db, { rail: 'mock', gateEnabled: false });
    const gated = await readRunRecords(db, { rail: 'mock', gateEnabled: true });

    expect(ungated.every((r) => !r.gateEnabled)).toBe(true);
    expect(gated.every((r) => r.gateEnabled)).toBe(true);
    expect(ungated).toHaveLength(CHOSEN.length);
    expect(gated).toHaveLength(CHOSEN.length);
  });

  it('derives the same run key the runner does', async () => {
    // `adversary run` asks for the next attempt number before running, which
    // means it derives the key without executing anything. If that derivation
    // ever disagreed with the runner's, the CLI would file every run as attempt
    // 0 and collide with the last one on the primary key.
    const loaded = CHOSEN[0]!;
    const result = await runScenario({ loaded, gate: createGate(), attempt: 0 });

    expect(
      deriveRunKey({
        scenarioId: loaded.scenario.id,
        scenarioContentHash: loaded.contentHash,
        seed: loaded.scenario.seed,
        rail: loaded.scenario.rail,
        gateEnabled: true,
        agentName: result.agentName,
        agentVersion: result.agentVersion,
        model: null,
      }),
    ).toBe(result.runKey);

    await persistScenario(db, loaded);
    await persistRun(db, result);
    expect(await nextAttempt(db, result.runKey)).toBe(1);
  });
});
