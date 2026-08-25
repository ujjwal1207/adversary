/**
 * The evaluator.
 *
 * Walks the AST over a ledger view and produces a boolean, plus the set of
 * actions responsible when that boolean is unsatisfactory - the *witness set*.
 * Without a witness set, blast radius is a number nobody can check
 * (docs/ARCHITECTURE.md 11.5).
 *
 * Two design commitments run through the whole file:
 *
 *   **Nothing is coerced.** Comparing a number to a string is an error, not
 *   `false`. A missing path is an error, not `undefined`. The failure mode this
 *   guards against is a mistyped invariant that silently passes, and a corpus
 *   full of those would report perfect safety.
 *
 *   **Collections distribute, scalars do not.** `actions[kind=transfer].payeeRef`
 *   is a collection; comparing it to something distributes element-wise and
 *   keeps each element's originating action, which is what lets `all()` blame
 *   exactly the transfers that broke the rule rather than all of them.
 */

import type { MoneyAction } from '../contracts.js';
import type { LedgerView } from '../ledger/view.js';
import type { BinaryNode, CallNode, Node, PathNode, PathStep } from './ast.js';

export class EvalError extends Error {
  override readonly name = 'EvalError';
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

/** What an expression may name. Nothing else is in scope. */
export interface EvalContext {
  readonly view: LedgerView;
  readonly policy: Readonly<Record<string, unknown>>;
  /** Values derived from tainted surfaces - `untrusted.derivedPayees` etc. */
  readonly untrusted: Readonly<Record<string, unknown>>;
}

interface Item {
  readonly value: unknown;
  /** The action this element came from, or null for policy/untrusted data. */
  readonly actionId: string | null;
}

type EvalValue =
  | { readonly type: 'scalar'; readonly value: unknown; readonly witness: readonly string[] }
  | { readonly type: 'collection'; readonly items: readonly Item[]; readonly witness: readonly string[] };

export interface EvalResult {
  readonly value: boolean;
  /**
   * Actions responsible when `value` is false.
   *
   * Empty is meaningful: it says the expression failed but could not attribute
   * the failure to particular actions. The caller widens that to the whole run
   * rather than reporting a blast radius of zero - see `attributeOrWiden`.
   */
  readonly witnessIds: readonly string[];
  /** The left-hand value of a top-level comparison, for the verdict report. */
  readonly observed: unknown;
  /** The right-hand value of a top-level comparison. */
  readonly expected: unknown;
}

const scalar = (value: unknown, witness: readonly string[] = []): EvalValue => ({
  type: 'scalar',
  value,
  witness,
});

const collection = (items: readonly Item[], witness?: readonly string[]): EvalValue => ({
  type: 'collection',
  items,
  witness: witness ?? idsOf(items),
});

function idsOf(items: readonly Item[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.actionId !== null && !out.includes(item.actionId)) out.push(item.actionId);
  }
  return out;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

export function evaluate(node: Node, context: EvalContext): EvalResult {
  const result = evalNode(node, context);
  const value = requireBoolean(result, node.pos, 'An invariant must evaluate to a boolean');

  const { observed, expected } = describeOutcome(node, context);

  return {
    value,
    witnessIds: value ? [] : result.witness,
    observed,
    expected,
  };
}

/**
 * Turns a witness set into the actions a blast radius should be computed over.
 *
 * An expression like `any(actions[gateDecision=escalate])` fails precisely
 * because its collection is empty, so it has nobody to blame. Reporting a blast
 * radius of zero there would say "the invariant was violated and no money was
 * at stake", which is false: the exposure is whatever the run actually moved.
 * So an unattributed failure widens to the whole run, which is the conservative
 * reading rather than the flattering one.
 */
export function attributeOrWiden(
  witnessIds: readonly string[],
  view: LedgerView,
): readonly MoneyAction[] {
  if (witnessIds.length > 0) {
    const wanted = new Set(witnessIds);
    return view.actions().filter((a) => wanted.has(a.id));
  }
  return view.actions();
}

// --- node dispatch ---------------------------------------------------------

function evalNode(node: Node, ctx: EvalContext): EvalValue {
  switch (node.type) {
    case 'literal':
      return scalar(node.value);
    case 'path':
      return evalPath(node, ctx);
    case 'call':
      return evalCall(node, ctx);
    case 'not': {
      const inner = evalNode(node.operand, ctx);
      const value = requireBoolean(inner, node.pos, '`not` needs a boolean');
      // The inner witness carries straight through. `any()` populates its
      // witness when it is *true*, which is exactly what `not any(...)` needs
      // in order to blame the actions that matched.
      return scalar(!value, inner.witness);
    }
    case 'binary':
      return evalBinary(node, ctx);
  }
}

// --- paths -----------------------------------------------------------------

function evalPath(node: PathNode, ctx: EvalContext): EvalValue {
  let current: EvalValue =
    node.root === 'actions'
      ? collection(ctx.view.actions().map((a) => ({ value: a, actionId: a.id })))
      : scalar(node.root === 'policy' ? ctx.policy : ctx.untrusted);

  for (const step of node.steps) {
    current = applyStep(current, step, node.root);
  }

  // A path that lands on an array becomes a collection, so `policy.allowlist`
  // can be the right-hand side of `in` without any special case. Arrays nested
  // inside a collection's elements stay as values; flattening them would make
  // `actions.taint` mean something no scenario author intended.
  if (current.type === 'scalar' && Array.isArray(current.value)) {
    return collection(
      (current.value as unknown[]).map((value) => ({ value, actionId: null })),
      current.witness,
    );
  }

  return current;
}

function applyStep(current: EvalValue, step: PathStep, root: string): EvalValue {
  if (step.kind === 'filter') {
    if (current.type !== 'collection') {
      throw new EvalError(
        `Cannot filter \`${root}\` with [${step.key}=...]: filters narrow a ` +
          'collection, and this is a single value.',
        step.pos,
      );
    }
    return collection(
      current.items.filter((item) => fieldOf(item.value, step.key, step.pos) === step.value),
    );
  }

  if (current.type === 'collection') {
    return collection(
      current.items.map((item) => ({
        value: fieldOf(item.value, step.name, step.pos),
        actionId: item.actionId,
      })),
      current.witness,
    );
  }

  return scalar(fieldOf(current.value, step.name, step.pos), current.witness);
}

/**
 * Reads a field, treating absence as an error.
 *
 * A silent `undefined` from a mistyped path would produce a passing invariant
 * that tests nothing. `null` is different: it is a value a field genuinely
 * holds - `payeeRef` is null on a payment link - and passes through untouched.
 */
function fieldOf(target: unknown, name: string, pos: number): unknown {
  if (target === null || typeof target !== 'object') {
    throw new EvalError(
      `Cannot read \`.${name}\` from ${describeValue(target)}.`,
      pos,
    );
  }

  const record = target as Record<string, unknown>;
  if (!(name in record)) {
    const available = Object.keys(record).sort().slice(0, 12).join(', ');
    throw new EvalError(
      `Unknown field \`${name}\`. Available: ${available}${
        Object.keys(record).length > 12 ? ', ...' : ''
      }.`,
      pos,
    );
  }

  return record[name];
}

// --- functions -------------------------------------------------------------

function evalCall(node: CallNode, ctx: EvalContext): EvalValue {
  const arg = evalNode(node.arg, ctx);

  if (arg.type !== 'collection') {
    throw new EvalError(
      `\`${node.fn}()\` takes a collection, got ${describeValue(arg.value)}. ` +
        'Collections come from `actions`, or from a path that lands on a list.',
      node.pos,
    );
  }

  const items = arg.items;

  switch (node.fn) {
    // Empty-collection semantics are fixed here, once, and tested explicitly.
    // They are conventions, not derivations, and inferring them at each call
    // site is how two invariants come to disagree about the same run.
    case 'count':
      return scalar(items.length, arg.witness);

    case 'sum': {
      let total = 0;
      for (const item of items) {
        if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
          throw new EvalError(
            `\`sum()\` needs numbers, got ${describeValue(item.value)}.`,
            node.pos,
          );
        }
        total += item.value;
      }
      return scalar(total, arg.witness); // sum([]) === 0
    }

    case 'all': {
      const failing = items.filter((item) => !truthy(item, node.pos));
      // all([]) === true - vacuous truth. An agent that did nothing violated
      // no allowlist.
      return scalar(failing.length === 0, idsOf(failing));
    }

    case 'any': {
      const matching = items.filter((item) => truthy(item, node.pos));
      // any([]) === false, the same convention with the opposite polarity.
      // The witness is populated when the result is TRUE, so `not any(...)`
      // can blame the actions that matched.
      return scalar(matching.length > 0, idsOf(matching));
    }

    case 'unique': {
      const seen = new Map<string, Item[]>();
      for (const item of items) {
        const key = uniqueKey(item.value, node.pos);
        const bucket = seen.get(key);
        if (bucket) bucket.push(item);
        else seen.set(key, [item]);
      }
      const duplicated = [...seen.values()].filter((b) => b.length > 1).flat();
      // unique([]) === true - no duplicates exist.
      return scalar(duplicated.length === 0, idsOf(duplicated));
    }
  }
}

/**
 * Truthiness, defined narrowly on purpose.
 *
 * A boolean is itself. An action is present, so it counts. Everything else is
 * an error, because `any(actions.amountPaise)` quietly meaning "any non-zero
 * amount" is exactly the kind of coercion this project exists to catch.
 */
function truthy(item: Item, pos: number): boolean {
  if (typeof item.value === 'boolean') return item.value;
  if (item.value !== null && typeof item.value === 'object') return true;
  throw new EvalError(
    `\`all()\` and \`any()\` need booleans or actions, got ` +
      `${describeValue(item.value)}. Compare it to something first.`,
    pos,
  );
}

function uniqueKey(value: unknown, pos: number): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  throw new EvalError(
    `\`unique()\` needs scalars, got ${describeValue(value)}. Project a field ` +
      'off the actions first.',
    pos,
  );
}

// --- operators -------------------------------------------------------------

function evalBinary(node: BinaryNode, ctx: EvalContext): EvalValue {
  if (node.op === 'and' || node.op === 'or') {
    // Both sides are evaluated. Short-circuiting would make an error in the
    // right operand appear or vanish depending on the left one, so a broken
    // invariant could pass on some runs and error on others.
    const left = evalNode(node.left, ctx);
    const right = evalNode(node.right, ctx);
    const l = requireBoolean(left, node.pos, `\`${node.op}\` needs booleans`);
    const r = requireBoolean(right, node.pos, `\`${node.op}\` needs booleans`);

    const value = node.op === 'and' ? l && r : l || r;
    if (value) return scalar(true, []);

    // Blame only the operands that actually failed.
    const blame =
      node.op === 'and'
        ? union(l ? [] : left.witness, r ? [] : right.witness)
        : union(left.witness, right.witness);
    return scalar(false, blame);
  }

  const left = evalNode(node.left, ctx);
  const right = evalNode(node.right, ctx);

  if (node.op === 'in') return evalIn(left, right, node);

  if (right.type === 'collection') {
    throw new EvalError(
      `The right side of \`${node.op}\` is a collection. Reduce it with ` +
        'sum() or count() first, or use `in` for membership.',
      node.pos,
    );
  }

  // A collection on the left distributes element-wise, keeping each element's
  // originating action so all()/any() can attribute a failure precisely.
  if (left.type === 'collection') {
    return collection(
      left.items.map((item) => ({
        value: compare(node.op, item.value, right.value, node.pos),
        actionId: item.actionId,
      })),
      left.witness,
    );
  }

  const value = compare(node.op, left.value, right.value, node.pos);
  return scalar(value, value ? [] : union(left.witness, right.witness));
}

function evalIn(left: EvalValue, right: EvalValue, node: BinaryNode): EvalValue {
  if (right.type !== 'collection') {
    throw new EvalError(
      `The right side of \`in\` must be a list, got ${describeValue(right.value)}.`,
      node.pos,
    );
  }

  const haystack = right.items.map((item) => item.value);
  const member = (value: unknown): boolean => haystack.some((h) => strictEquals(h, value));

  if (left.type === 'collection') {
    return collection(
      left.items.map((item) => ({ value: member(item.value), actionId: item.actionId })),
      left.witness,
    );
  }

  const value = member(left.value);
  return scalar(value, value ? [] : left.witness);
}

function compare(op: string, left: unknown, right: unknown, pos: number): boolean {
  if (op === '==' || op === '!=') {
    if (!comparableTypes(left, right)) {
      throw new EvalError(
        `Cannot compare ${describeValue(left)} with ${describeValue(right)}. ` +
          'Values are never coerced here.',
        pos,
      );
    }
    const equal = strictEquals(left, right);
    return op === '==' ? equal : !equal;
  }

  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new EvalError(
      `\`${op}\` needs numbers, got ${describeValue(left)} and ` +
        `${describeValue(right)}.`,
      pos,
    );
  }

  switch (op) {
    case '<=':
      return left <= right;
    case '<':
      return left < right;
    case '>=':
      return left >= right;
    case '>':
      return left > right;
    default:
      throw new EvalError(`Unknown operator \`${op}\`.`, pos);
  }
}

/** `null` compares with anything; otherwise the primitive types must match. */
function comparableTypes(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return true;
  return typeof left === typeof right && typeof left !== 'object';
}

function strictEquals(a: unknown, b: unknown): boolean {
  return a === b;
}

// --- helpers ---------------------------------------------------------------

function requireBoolean(value: EvalValue, pos: number, context: string): boolean {
  if (value.type !== 'scalar' || typeof value.value !== 'boolean') {
    const got =
      value.type === 'collection'
        ? `a collection of ${value.items.length}`
        : describeValue(value.value);
    throw new EvalError(
      `${context}, got ${got}. Wrap it in all(), any(), or compare it.`,
      pos,
    );
  }
  return value.value;
}

/**
 * Best-effort reporting values for the verdict.
 *
 * When the invariant is a top-level comparison - which most are - `observed`
 * and `expected` are its two sides, so a report can say "sum was 5,499,000,
 * cap was 2,000,000" instead of just "false". Anything more complex reports the
 * boolean against `true`, which is honest rather than invented.
 */
function describeOutcome(
  node: Node,
  ctx: EvalContext,
): { observed: unknown; expected: unknown } {
  if (node.type === 'binary' && node.op !== 'and' && node.op !== 'or') {
    try {
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      return { observed: summarise(left), expected: summarise(right) };
    } catch {
      // describeOutcome is reporting, not verification. If it cannot produce a
      // nicer summary the verdict is still correct.
    }
  }
  return { observed: undefined, expected: true };
}

function summarise(value: EvalValue): unknown {
  return value.type === 'scalar' ? value.value : value.items.map((i) => i.value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string "${value}"`;
  return `${typeof value} ${String(value)}`;
}
