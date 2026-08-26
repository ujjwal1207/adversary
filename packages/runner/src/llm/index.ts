/**
 * Choosing a model client, and saying honestly how reproducible it makes a run.
 *
 * The tier is decided here, once, rather than inferred at each call site. A
 * caller that had to work out whether its runs were reproducible would
 * eventually work it out wrongly, and the failure mode is a scorecard that
 * claims reproducibility it does not have.
 */

import type { LlmClient, ReproducibilityTier } from '@adversary/core';

import type { CassetteMode } from './cassette.js';
import { CassetteLlm } from './cassette.js';
import { AnthropicLlm, LlmError, OpenAiLlm } from './providers.js';
import type { FetchLike } from './providers.js';

export type { CassetteEntry, CassetteFile, CassetteMode } from './cassette.js';
export { CassetteError, CassetteLlm, cassetteKey } from './cassette.js';
export type { FetchLike, ProviderOptions } from './providers.js';
export { AnthropicLlm, LlmError, OpenAiLlm } from './providers.js';

export type LlmProviderName = 'anthropic' | 'openai';

export interface LlmConfig {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly apiKey: string;
  readonly cassette?: { readonly mode: CassetteMode; readonly path: string };
  readonly fetchImpl?: FetchLike;
}

export interface ResolvedLlm {
  readonly client: LlmClient;
  readonly model: string;
  /**
   * What can honestly be claimed about repeating this run.
   *
   *  - `cassette` - responses come from a recording; repeating is exact
   *  - `live`     - the provider is called; repeating is not exact, and the
   *                 determinism check refuses to compare such runs rather than
   *                 asserting an identity that does not hold
   */
  readonly reproducibility: ReproducibilityTier;
  /** Present when a cassette is in play, so its hash reaches the report footer. */
  readonly cassette: CassetteLlm | null;
}

export function createLlmClient(config: LlmConfig): ResolvedLlm {
  const provider = buildProvider(config);

  if (config.cassette === undefined) {
    return {
      client: provider,
      model: provider.model,
      reproducibility: 'live',
      cassette: null,
    };
  }

  const cassette = new CassetteLlm({
    mode: config.cassette.mode,
    path: config.cassette.path,
    inner: provider,
  });

  return {
    client: cassette,
    model: cassette.model,
    // Recording calls the provider live, so the *recording pass* is not itself
    // reproducible - only replays from it are. Saying otherwise would let a
    // record run be reported as exactly repeatable when it is not.
    reproducibility: config.cassette.mode === 'replay' ? 'cassette' : 'live',
    cassette,
  };
}

/** Replays a cassette with no provider and no key at all. */
export function replayFromCassette(path: string, model?: string): ResolvedLlm {
  const cassette = new CassetteLlm({
    mode: 'replay',
    path,
    ...(model === undefined ? {} : { model }),
  });
  return {
    client: cassette,
    model: cassette.model,
    reproducibility: 'cassette',
    cassette,
  };
}

function buildProvider(config: LlmConfig): LlmClient {
  const options = {
    apiKey: config.apiKey,
    model: config.model,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
  };

  switch (config.provider) {
    case 'anthropic':
      return new AnthropicLlm(options);
    case 'openai':
      return new OpenAiLlm(options);
  }
}

/**
 * Reads model configuration from the environment.
 *
 * Returns `null` when no key is set, which is not an error: it is the normal
 * state of CI, and it selects `ScriptedAgent`. The whole corpus runs in that
 * state, which is what makes the determinism gate a required check.
 */
export function llmConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig | null {
  const anthropic = env['ANTHROPIC_API_KEY']?.trim();
  const openai = env['OPENAI_API_KEY']?.trim();

  const cassettePath = env['ADVERSARY_CASSETTE']?.trim();
  const cassetteMode = env['ADVERSARY_CASSETTE_MODE']?.trim() as CassetteMode | undefined;

  if (cassettePath && cassetteMode !== 'record' && cassetteMode !== 'replay') {
    throw new LlmError(
      'ADVERSARY_CASSETTE is set but ADVERSARY_CASSETTE_MODE is not "record" or ' +
        '"replay". Guessing would risk overwriting a recording.',
      null,
      false,
    );
  }

  const cassette =
    cassettePath && cassetteMode ? { mode: cassetteMode, path: cassettePath } : undefined;

  if (anthropic) {
    return {
      provider: 'anthropic',
      apiKey: anthropic,
      model: env['ADVERSARY_MODEL']?.trim() || 'claude-sonnet-4-5',
      ...(cassette === undefined ? {} : { cassette }),
    };
  }

  if (openai) {
    return {
      provider: 'openai',
      apiKey: openai,
      model: env['ADVERSARY_MODEL']?.trim() || 'gpt-4o',
      ...(cassette === undefined ? {} : { cassette }),
    };
  }

  return null;
}
