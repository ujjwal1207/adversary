/**
 * The policy gate: eight deterministic rules, one structured verdict.
 *
 * This is the defence under test, not part of the harness. That distinction
 * matters because everything here has a false-positive cost, and the scorecard
 * exists to publish that cost beside the effectiveness. A defence smuggled into
 * the harness - into the interceptor, or a fixture, or a prompt - would be a
 * defence whose cost never got measured.
 */

import type {
  GateDecision,
  GateInput,
  GateVerdict,
  PolicyGate,
  RuleEvaluation,
} from '@adversary/core';

import type { Rule } from './rules.js';
import { ALL_RULES } from './rules.js';

export interface DeterministicGateOptions {
  /** Defaults to all eight. A subset is how a report isolates one rule's cost. */
  readonly rules?: readonly Rule[];
  readonly name?: string;
}

export class DeterministicGate implements PolicyGate {
  readonly name: string;
  readonly #rules: readonly Rule[];

  constructor(options: DeterministicGateOptions = {}) {
    this.#rules = options.rules ?? ALL_RULES;
    this.name = options.name ?? 'deterministic';
  }

  evaluate(input: GateInput): GateVerdict {
    const ruleTrace: RuleEvaluation[] = [];
    const reasons: string[] = [];
    let decision: GateDecision = 'allow';

    for (const rule of this.#rules) {
      // Every rule runs. Short-circuiting on the first failure would cost
      // nothing to avoid and would make the trace depend on rule order, which
      // would make it useless for comparing gate configurations.
      const evaluation = rule.evaluate(input);
      ruleTrace.push(evaluation);

      if (evaluation.outcome !== 'fail') continue;

      reasons.push(evaluation.message);
      decision = moreRestrictive(decision, rule.onFail);
    }

    // Reasons are ordered most-restrictive first, so the first line of a
    // refusal is the one that actually stopped the action.
    const blocking = new Set(
      this.#rules.filter((r) => r.onFail === 'block').map((r) => r.id),
    );
    reasons.sort((a, b) => rank(b, blocking, ruleTrace) - rank(a, blocking, ruleTrace));

    return { decision, reasons, ruleTrace };
  }
}

/** block beats escalate beats allow. */
function moreRestrictive(current: GateDecision, candidate: GateDecision): GateDecision {
  const order: Record<GateDecision, number> = {
    bypassed: 0,
    allow: 1,
    escalate: 2,
    block: 3,
  };
  return order[candidate] > order[current] ? candidate : current;
}

function rank(
  message: string,
  blocking: ReadonlySet<string>,
  trace: readonly RuleEvaluation[],
): number {
  const source = trace.find((e) => e.message === message);
  return source !== undefined && blocking.has(source.rule) ? 1 : 0;
}

/** The gate with every rule on. What `--gate on` builds. */
export function createGate(options: DeterministicGateOptions = {}): PolicyGate {
  return new DeterministicGate(options);
}
