/**
 * Step 1 of the nine: load, validate, hash.
 *
 * The content hash is load-bearing. A scorecard is only reproducible if you
 * know which version of each scenario produced it, and every report footer
 * prints the corpus hash set beside the seed (docs/ARCHITECTURE.md P6).
 *
 * It is computed over the *canonical* form - parse the YAML, normalise line
 * endings, canonicalise to sorted-key JSON, then SHA-256. Reformatting a
 * scenario, or checking it out on a different platform, does not change its
 * hash. Changing a payload, a policy value or an invariant does.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { hashValue, normalizeText } from '@adversary/core';
import { parse as parseYaml } from 'yaml';

import type { Scenario } from './schema.js';
import { scenarioSchema } from './schema.js';

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${source}: ${message}`);
  }
}

export interface LoadedScenario {
  readonly scenario: Scenario;
  /** SHA-256 over the canonical form. Identifies the scenario's content. */
  readonly contentHash: string;
  /** The YAML exactly as read, stored so an old scorecard stays explainable. */
  readonly yamlSnapshot: string;
  /** Absolute path, or `<inline>` when parsed from a string. */
  readonly source: string;
}

export function parseScenario(yamlText: string, source = '<inline>'): LoadedScenario {
  const normalized = normalizeText(yamlText);

  let raw: unknown;
  try {
    raw = parseYaml(normalized);
  } catch (err) {
    throw new ScenarioError(
      `could not be parsed as YAML: ${err instanceof Error ? err.message : String(err)}`,
      source,
    );
  }

  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ScenarioError(`failed validation\n${issues}`, source);
  }

  return {
    scenario: parsed.data,
    // Hashed after validation, so defaults are included: two scenarios that
    // differ only in whether they spelled out `seed: 42` are the same scenario
    // and must hash the same.
    contentHash: hashValue(parsed.data),
    yamlSnapshot: normalized,
    source,
  };
}

export function loadScenarioFile(path: string): LoadedScenario {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (err) {
    throw new ScenarioError(
      `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      absolute,
    );
  }
  return parseScenario(text, absolute);
}

/**
 * Loads a set of scenarios and checks the properties that only hold across the
 * whole corpus.
 *
 * Pairing is checked here rather than per-scenario because a pair is a
 * relationship: an attack naming a benign twin that does not exist, or that is
 * itself an attack, breaks false-positive cost without breaking either file on
 * its own.
 */
export function loadCorpus(paths: readonly string[]): LoadedScenario[] {
  const loaded = [...paths].sort().map(loadScenarioFile);
  assertCorpusCoherent(loaded);
  return loaded;
}

export function assertCorpusCoherent(loaded: readonly LoadedScenario[]): void {
  const byId = new Map<string, LoadedScenario>();

  for (const entry of loaded) {
    const existing = byId.get(entry.scenario.id);
    if (existing) {
      throw new ScenarioError(
        `duplicate scenario id "${entry.scenario.id}", also defined in ${existing.source}`,
        entry.source,
      );
    }
    byId.set(entry.scenario.id, entry);
  }

  for (const entry of loaded) {
    const { pair, id, kind } = entry.scenario;
    if (pair === undefined) continue;

    const twin = byId.get(pair);
    if (!twin) {
      throw new ScenarioError(
        `names pair "${pair}", which is not in the corpus`,
        entry.source,
      );
    }
    if (twin.scenario.kind === kind) {
      throw new ScenarioError(
        `names pair "${pair}", but both are ${kind} scenarios. A pair is an ` +
          'attack and its superficially similar benign twin; two attacks ' +
          'measure effectiveness twice and cost never.',
        entry.source,
      );
    }
    if (twin.scenario.pair !== undefined && twin.scenario.pair !== id) {
      throw new ScenarioError(
        `names pair "${pair}", but "${pair}" names "${twin.scenario.pair}"`,
        entry.source,
      );
    }
  }
}

/**
 * The corpus hash: a hash of every scenario's content hash, sorted.
 *
 * Printed in every report footer. Two scorecards claiming to describe the same
 * corpus must carry the same value here, or one of them is describing something
 * else.
 */
export function corpusHash(loaded: readonly LoadedScenario[]): string {
  return hashValue([...loaded.map((l) => l.contentHash)].sort());
}

/** Resolves a fixture path declared in a scenario, relative to its own file. */
export function resolveFixturePath(scenarioSource: string, fixturePath: string): string {
  if (isAbsolute(fixturePath)) return fixturePath;
  const base = scenarioSource === '<inline>' ? process.cwd() : dirname(scenarioSource);
  return resolve(base, fixturePath);
}
