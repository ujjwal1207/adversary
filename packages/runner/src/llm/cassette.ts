/**
 * Record/replay for model calls.
 *
 * This exists because of a fact the build spec's Phase 6 gate does not account
 * for: **a hosted model is not deterministic even at temperature 0.** Batching,
 * hardware routing and provider-side updates all produce different outputs from
 * identical inputs. Any claim that an LLM-backed run is byte-reproducible is
 * false (docs/ARCHITECTURE.md 9.4, 17 A1).
 *
 * A cassette closes that gap honestly rather than by pretending. Record once
 * against a live provider; replay from the recording forever after. The run is
 * then reproducible *given that cassette*, which is a true statement, and the
 * cassette's hash goes in the report footer so a reader knows which recording
 * produced the numbers.
 *
 * The single most important behaviour here: **a replay miss is a hard error.**
 * Falling through to a live call would turn a reproducibility guarantee into a
 * coin flip, and it would do so silently - the run would still finish, still
 * produce a scorecard, and still claim to be reproducible.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LlmClient, LlmCompletion, LlmRequest } from '@adversary/core';
import { canonicalJson, hashValue, sha256Hex } from '@adversary/core';

export type CassetteMode = 'record' | 'replay';

export class CassetteError extends Error {
  override readonly name = 'CassetteError';
}

export interface CassetteEntry {
  /** Hash of the canonical request. Stable across machines. */
  readonly key: string;
  readonly completion: LlmCompletion;
}

export interface CassetteFile {
  readonly version: 1;
  readonly model: string;
  readonly entries: readonly CassetteEntry[];
}

/**
 * The key for a request.
 *
 * Everything that could change the answer is in it, and nothing else is. The
 * `signal` is excluded because an AbortSignal is not part of the question being
 * asked; the model name is included because two models given the same prompt
 * are two different questions.
 */
export function cassetteKey(request: LlmRequest, model: string): string {
  return sha256Hex(
    canonicalJson({
      model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    }),
  );
}

export interface CassetteOptions {
  readonly mode: CassetteMode;
  readonly path: string;
  /** Required in `record` mode; unused in `replay`. */
  readonly inner?: LlmClient;
  /** Overrides the model name in replay mode. Defaults to the cassette's. */
  readonly model?: string;
}

export class CassetteLlm implements LlmClient {
  readonly model: string;

  readonly #mode: CassetteMode;
  readonly #path: string;
  readonly #inner: LlmClient | undefined;
  readonly #recorded: CassetteEntry[] = [];
  readonly #available: CassetteEntry[];
  /** Indices already served, so a repeated identical request replays in order. */
  readonly #consumed = new Set<number>();

  constructor(options: CassetteOptions) {
    this.#mode = options.mode;
    this.#path = options.path;
    this.#inner = options.inner;

    if (options.mode === 'record') {
      if (!options.inner) {
        throw new CassetteError('record mode needs an inner client to record from.');
      }
      this.#available = [];
      this.model = options.inner.model;
    } else {
      const file = readCassette(options.path);
      this.#available = [...file.entries];
      this.model = options.model ?? file.model;
    }
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const key = cassetteKey(request, this.model);

    if (this.#mode === 'replay') {
      const index = this.#available.findIndex(
        (entry, i) => entry.key === key && !this.#consumed.has(i),
      );
      if (index < 0) {
        // Deliberately fatal. See the note at the top of this file.
        throw new CassetteError(
          `No recording for this request in ${this.#path}.\n` +
            `  key: ${key}\n` +
            `  The cassette holds ${this.#available.length} entries, ` +
            `${this.#consumed.size} already replayed.\n` +
            '  Re-record the cassette. Falling through to a live call would ' +
            'turn a reproducibility guarantee into a coin flip, silently.',
        );
      }
      this.#consumed.add(index);
      return (this.#available[index] as CassetteEntry).completion;
    }

    const completion = await (this.#inner as LlmClient).complete(request);
    this.#recorded.push({ key, completion });
    return completion;
  }

  /**
   * Writes everything recorded so far. Safe to call repeatedly - each call
   * rewrites the whole file with the cumulative recording, so calling it after
   * every scenario means a crash mid-corpus keeps what was already paid for.
   * That is not hypothetical: an unref'd backoff timer once ended a corpus run
   * four scenarios in.
   */
  save(): string {
    if (this.#mode !== 'record') {
      throw new CassetteError('save() is only meaningful in record mode.');
    }
    const file: CassetteFile = {
      version: 1,
      model: this.model,
      entries: this.#recorded,
    };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${canonicalJson(file)}\n`, 'utf8');
    return hashValue(file);
  }

  /**
   * The hash of the cassette in play, for `runs.cassette_hash`.
   *
   * A scorecard that cites a cassette has to say *which* cassette, or "this run
   * is reproducible" names nothing.
   */
  get hash(): string {
    return hashValue({
      version: 1,
      model: this.model,
      entries: this.#mode === 'record' ? this.#recorded : this.#available,
    });
  }

  /** Where the recording lives, for messages that tell the user about it. */
  get path(): string {
    return this.#path;
  }

  /** How many completions this cassette holds. */
  get entryCount(): number {
    return this.#mode === 'record' ? this.#recorded.length : this.#available.length;
  }

  /** Entries the cassette holds but this run never asked for. */
  get unusedEntries(): number {
    return this.#mode === 'replay' ? this.#available.length - this.#consumed.size : 0;
  }
}

function readCassette(path: string): CassetteFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CassetteError(
      `Cassette ${path} could not be read: ${
        err instanceof Error ? err.message : String(err)
      }. Record one first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CassetteError(
      `Cassette ${path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const file = parsed as Partial<CassetteFile>;
  if (file.version !== 1 || typeof file.model !== 'string' || !Array.isArray(file.entries)) {
    throw new CassetteError(
      `Cassette ${path} is malformed: expected { version: 1, model, entries[] }.`,
    );
  }

  return file as CassetteFile;
}
