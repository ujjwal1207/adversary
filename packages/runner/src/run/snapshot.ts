/**
 * The evidence export the viewer reads.
 *
 * `apps/dashboard` is a static viewer over a JSON snapshot rather than a client
 * for a server, and that is a safety decision as much as a convenience one: a
 * dashboard that queried a live database would need a process listening on a
 * port, and this repository does not open ports. A snapshot can also be
 * attached to a pull request, archived beside a scorecard, or opened on a
 * machine that has never run the harness.
 *
 * Everything here comes from the database, never from a re-run. If the snapshot
 * and the report disagree, one of them is reading the evidence wrongly, and
 * both must be able to be checked against it.
 */

import type { GateComparison, RailKind } from '@adversary/core';

import type { DbHandle } from '../db/client.js';
import { parseScenario } from '../scenario/loader.js';
import type { ReplayedRun } from './replay.js';
import { replayRun } from './replay.js';

/** The scenario a run was measured against, as it was when it ran. */
export interface SnapshotScenario {
  readonly id: string;
  readonly contentHash: string;
  readonly title: string;
  readonly family: string;
  readonly kind: string;
}

export interface SnapshotRun extends ReplayedRun {
  /**
   * Whether any part of this run's evidence is manufactured.
   *
   * Disputes and chargebacks cannot be created in a payment provider's test
   * mode, so a scenario that needs one carries `synthetic: true` in the event
   * payload itself. The viewer renders its badge from this field, which means a
   * reader looking at a dispute trajectory sees that the dispute was
   * manufactured without having read docs/THREAT-MODEL.md first.
   *
   * Computed from the payloads, never asserted by hand.
   */
  readonly synthetic: boolean;
}

export interface Snapshot {
  readonly version: 1;
  readonly comparison: GateComparison;
  readonly scenarios: readonly SnapshotScenario[];
  readonly runs: readonly SnapshotRun[];
}

const ph = (dialect: DbHandle['dialect'], n: number): string =>
  dialect === 'postgres' ? `$${n}` : '?';

export async function buildSnapshot(
  db: DbHandle,
  comparison: GateComparison,
  rail: RailKind,
): Promise<Snapshot> {
  const scenarioRows = await db.all<Record<string, unknown>>(
    'SELECT id, content_hash, kind, family, yaml_snapshot FROM scenarios',
  );

  const runRows = await db.all<Record<string, unknown>>(
    `SELECT id FROM runs WHERE rail = ${ph(db.dialect, 1)} ORDER BY scenario_id, gate_enabled, attempt`,
    [rail],
  );

  const runs: SnapshotRun[] = [];
  for (const row of runRows) {
    const run = await replayRun(db, String(row['id']));
    runs.push({ ...run, synthetic: containsSynthetic(run) });
  }

  return {
    version: 1,
    comparison,
    scenarios: scenarioRows.map((s) => ({
      id: String(s['id']),
      contentHash: String(s['content_hash']),
      title: titleOf(s),
      family: String(s['family']),
      kind: String(s['kind']),
    })),
    runs,
  };
}

/**
 * The scenario's title, read out of the stored YAML rather than off the file.
 *
 * The table keeps a snapshot of the source, not a title column, and that is the
 * better place to read it from: a viewer showing a run from last month should
 * name the scenario as it was then, not as somebody has since retitled it.
 *
 * A snapshot that will not parse falls back to the id. A title is presentation
 * rather than evidence, and refusing to export sixty runs over one unreadable
 * heading would be the wrong trade - but nothing here invents one.
 */
function titleOf(row: Record<string, unknown>): string {
  const yaml = row['yaml_snapshot'];
  if (typeof yaml !== 'string') return String(row['id']);

  try {
    return parseScenario(yaml, '<stored>').scenario.title;
  } catch {
    return String(row['id']);
  }
}

/**
 * Does anything in this run's evidence carry `synthetic: true`?
 *
 * A walk rather than a lookup at a known path, because the flag travels inside
 * whatever payload shape the rail produced, and a viewer that only looked in
 * the place it expected would quietly stop badging the day that shape changed.
 * Over-reporting here is safe; under-reporting is the failure that matters.
 */
function containsSynthetic(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) return value.some((v) => containsSynthetic(v, depth + 1));

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'synthetic' && entry === true) return true;
    if (containsSynthetic(entry, depth + 1)) return true;
  }

  return false;
}
