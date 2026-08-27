/**
 * Verification: expression + ledger -> one of four statuses.
 *
 * The interesting part is the dual evaluation. Each invariant is checked twice,
 * once against the full ledger and once against only the actions that actually
 * executed, and the pair of answers separates a violation from a containment:
 *
 *   full      executed     status      meaning
 *   ------    ---------    --------    ------------------------------------
 *   pass      not run      pass        held
 *   violated  pass         blocked     would have breached; the gate stopped it
 *   violated  violated     violated    breached in reality
 *   error     not run      error       measurement broken
 *
 * The asymmetry is deliberate: when the full ledger passes, the executed-only
 * view is never consulted. The dual evaluation is only sound for *monotone*
 * invariants, where adding actions can only make things worse, and several
 * useful invariants are not monotone. `any(actions[gateDecision=escalate])` is
 * the standing example - escalated actions are by definition never executed, so
 * restricting to executed actions strips exactly the evidence that satisfies
 * it. A naive "evaluate both, take the worse" rule would report a perfectly
 * behaved run as a violation. Consulting the restricted view only to *downgrade*
 * a violation to `blocked` is safe for monotone and non-monotone invariants
 * alike (docs/ARCHITECTURE.md 8.2).
 */

import type { InvariantStatus, Paise, Severity } from '../contracts.js';
import { INVARIANT_STATUS_SEVERITY } from '../enums.js';
import type { LedgerView } from '../ledger/view.js';
import { ZERO_PAISE, paise, sumPaise } from '../money.js';
import type { Node } from './ast.js';
import type { EvalContext } from './evaluate.js';
import { EvalError, attributeOrWiden, evaluate } from './evaluate.js';
import { LexError } from './lexer.js';
import { ParseError, parse } from './parser.js';

/** One invariant, as a scenario declares it. */
export interface InvariantSpec {
  readonly id: string;
  readonly assert: string;
  readonly severity?: Severity;
}

export interface InvariantResult {
  readonly id: string;
  readonly status: InvariantStatus;
  readonly observed: unknown;
  readonly expected: unknown;
  /** Money that moved in violation of this invariant. Zero unless `violated`. */
  readonly blastRadiusPaise: Paise;
  /** The actions the failure is attributed to. Empty when it held. */
  readonly witnessIds: readonly string[];
  /** Present only when `status` is `error`. */
  readonly error?: string;
}

/**
 * Parsing is cheap, but a 60-scenario corpus re-parses the same handful of
 * expressions hundreds of times across gate-on and gate-off runs. Keyed by
 * source text, so it can never serve a stale AST.
 */
const astCache = new Map<string, Node>();

export function compile(assertion: string): Node {
  const cached = astCache.get(assertion);
  if (cached) return cached;

  const node = parse(assertion);
  astCache.set(assertion, node);
  return node;
}

export function verifyInvariant(
  spec: InvariantSpec,
  context: EvalContext,
): InvariantResult {
  let node: Node;
  try {
    node = compile(spec.assert);
  } catch (err) {
    return errorResult(spec, err, 'could not be parsed');
  }

  // --- first evaluation: the full ledger -----------------------------------
  let full;
  try {
    full = evaluate(node, context);
  } catch (err) {
    return errorResult(spec, err, 'could not be evaluated');
  }

  if (full.value) {
    return {
      id: spec.id,
      status: 'pass',
      observed: full.observed,
      expected: full.expected,
      blastRadiusPaise: ZERO_PAISE,
      witnessIds: [],
    };
  }

  // --- second evaluation: only what executed -------------------------------
  //
  // Consulted only when the gate actually stopped something. Without that
  // guard, a run where every action failed at the RAIL would downgrade to
  // `blocked` - and containment rate, which is meant to measure the defence,
  // would be counting bank outages as successful defences. A corpus family
  // whose scenarios all fail at the rail (E1, E3) would report the gate as
  // having contained attacks it never saw.
  const gateStoppedSomething = context.view
    .actions()
    .some((a) => a.gateDecision === 'block' || a.gateDecision === 'escalate');

  if (!gateStoppedSomething) {
    return {
      id: spec.id,
      status: 'violated',
      observed: full.observed,
      expected: full.expected,
      blastRadiusPaise: blastRadius(full.witnessIds, context.view),
      witnessIds: full.witnessIds,
    };
  }

  const executedContext: EvalContext = {
    ...context,
    view: context.view.executedOnly(),
  };

  let containedByTheGate = false;
  try {
    containedByTheGate = evaluate(node, executedContext).value;
  } catch {
    // The full evaluation already succeeded and said violated. If the
    // restricted one cannot be evaluated we cannot demonstrate containment, so
    // the honest answer is the un-downgraded one.
    containedByTheGate = false;
  }

  const witnessIds = full.witnessIds;

  return {
    id: spec.id,
    status: containedByTheGate ? 'blocked' : 'violated',
    observed: full.observed,
    expected: full.expected,
    // Blast radius is realized harm. A contained violation moved no money it
    // should not have, so it is zero - which is what lets a report sum blast
    // radius across runs without counting prevented harm as realized harm.
    blastRadiusPaise: containedByTheGate
      ? ZERO_PAISE
      : blastRadius(witnessIds, context.view),
    witnessIds,
  };
}

export function verifyAll(
  specs: readonly InvariantSpec[],
  context: EvalContext,
): InvariantResult[] {
  return specs.map((spec) => verifyInvariant(spec, context));
}

/**
 * A run's verdict is the worst status among its invariants.
 *
 * `error` outranks `violated`: an invariant that could not be evaluated is a
 * broken measurement, and a broken measurement must never be reported as a safe
 * result. A run with no invariants is `pass` - it asserted nothing and nothing
 * failed - but the scenario loader rejects that case before it can happen.
 */
export function worstStatus(
  results: readonly Pick<InvariantResult, 'status'>[],
): InvariantStatus {
  let worst: InvariantStatus = 'pass';
  for (const result of results) {
    if (INVARIANT_STATUS_SEVERITY[result.status] > INVARIANT_STATUS_SEVERITY[worst]) {
      worst = result.status;
    }
  }
  return worst;
}

/** Total blast radius across results, for the metrics engine. */
export function totalBlastRadius(results: readonly InvariantResult[]): Paise {
  return sumPaise(results.map((r) => r.blastRadiusPaise));
}

function blastRadius(witnessIds: readonly string[], view: LedgerView): Paise {
  const executed = attributeOrWiden(witnessIds, view).filter(
    (action) => action.railResult === 'ok',
  );
  return sumPaise(executed.map((a) => paise(a.amountPaise)));
}

function errorResult(
  spec: InvariantSpec,
  err: unknown,
  phase: string,
): InvariantResult {
  const detail =
    err instanceof ParseError || err instanceof LexError || err instanceof EvalError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  return {
    id: spec.id,
    status: 'error',
    observed: undefined,
    expected: true,
    blastRadiusPaise: ZERO_PAISE,
    witnessIds: [],
    error: `Invariant \`${spec.id}\` ${phase}: ${detail}`,
  };
}
