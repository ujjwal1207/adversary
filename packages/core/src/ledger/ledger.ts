/**
 * The append-only ledger.
 *
 * Append and read. No update method, no delete method - not "we agree not to
 * call them", they do not exist. This record is what every reported number is
 * computed from, so if it could be edited after the fact the scorecard would be
 * describing something other than what happened (docs/ARCHITECTURE.md P3).
 *
 * Two guarantees the tests hold this to:
 *
 *   `seq` is monotonic and gapless within a run. `append` is synchronous and
 *   never yields between reading the counter and writing it back, so no
 *   interleaving of callers can produce a duplicate or a hole. That is why it
 *   returns a value rather than a promise, despite everything around it being
 *   async: an awaitable append would be an invitation to a race.
 *
 *   Returned records are deep-frozen, and the store holds its own copy of the
 *   draft. A caller cannot corrupt the ledger by mutating what it passed in or
 *   what it got back.
 */

import type {
  LedgerFilter,
  MoneyAction,
  MoneyActionDraft,
} from '../contracts.js';
import { isPaise } from '../money.js';
import type { DigestOptions } from './digest.js';
import { ledgerDigest } from './digest.js';
import type { LedgerView } from './view.js';
import { createLedgerView } from './view.js';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
}

export interface Ledger {
  /** Assigns `seq`, stores a frozen copy, returns it. Synchronous by design. */
  append(draft: MoneyActionDraft): MoneyAction;
  getRun(runId: string): readonly MoneyAction[];
  query(runId: string, filter: LedgerFilter): readonly MoneyAction[];
  view(runId: string): LedgerView;
  digest(runId: string, options?: DigestOptions): string;
  size(runId: string): number;
  runIds(): readonly string[];
}

export class InMemoryLedger implements Ledger {
  readonly #actions = new Map<string, MoneyAction[]>();
  readonly #nextSeq = new Map<string, number>();

  append(draft: MoneyActionDraft): MoneyAction {
    validate(draft);

    // --- critical section ---------------------------------------------------
    // Everything from here to the push is synchronous. Introducing an `await`
    // inside it would let a second caller read the same seq before the first
    // wrote it back, and monotonicity would become a probabilistic property.
    const seq = this.#nextSeq.get(draft.runId) ?? 0;
    this.#nextSeq.set(draft.runId, seq + 1);

    const stored = deepFreeze({ ...structuredClone(toPlain(draft)), seq }) as MoneyAction;

    let run = this.#actions.get(draft.runId);
    if (run === undefined) {
      run = [];
      this.#actions.set(draft.runId, run);
    }
    run.push(stored);
    // --- end critical section -----------------------------------------------

    return stored;
  }

  /**
   * A frozen snapshot, not the internal array.
   *
   * Handing back the live array would leave the store one `push` away from a
   * caller, which would defeat the point of freezing the records inside it.
   * The copy is cheap - a run holds tens of actions, not millions.
   */
  getRun(runId: string): readonly MoneyAction[] {
    return Object.freeze([...(this.#actions.get(runId) ?? [])]);
  }

  query(runId: string, filter: LedgerFilter): readonly MoneyAction[] {
    return createLedgerView(this.getRun(runId)).select(filter);
  }

  view(runId: string): LedgerView {
    return createLedgerView(this.getRun(runId));
  }

  digest(runId: string, options: DigestOptions = {}): string {
    return ledgerDigest(this.getRun(runId), options);
  }

  size(runId: string): number {
    return this.getRun(runId).length;
  }

  runIds(): readonly string[] {
    return [...this.#actions.keys()].sort();
  }
}

/**
 * Runtime validation, duplicating what the type system already says.
 *
 * Not redundant: drafts are assembled from tool arguments and provider
 * responses, which were never type-checked. The brand stops a mistake in our
 * code; this stops one in theirs.
 */
function validate(draft: MoneyActionDraft): void {
  if (!draft.runId) {
    throw new LedgerError('MoneyAction.runId is required.');
  }
  if (!isPaise(draft.amountPaise)) {
    throw new LedgerError(
      `MoneyAction.amountPaise must be a non-negative safe integer number of ` +
        `paise, got ${String(draft.amountPaise)}. Amounts never reach the ` +
        'ledger as rupees or as floats.',
    );
  }
  if ('seq' in draft) {
    throw new LedgerError(
      'MoneyAction.seq is assigned by the ledger and must not be supplied. ' +
        'A caller-supplied seq would make monotonicity a convention.',
    );
  }
  if (draft.gateDecision === 'block' && draft.railResult === 'ok') {
    throw new LedgerError(
      'A blocked action cannot have executed. Recording one would corrupt the ' +
        'containment-rate metric, which is exactly the difference between an ' +
        'attempt that was stopped and one that succeeded.',
    );
  }
}

/** Strips any prototype, so a draft built from JSON cannot smuggle one in. */
function toPlain(draft: MoneyActionDraft): Record<string, unknown> {
  return { ...draft };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<string | symbol, unknown>)[key]);
  }
  return Object.freeze(value);
}
