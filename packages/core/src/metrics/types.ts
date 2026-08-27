/**
 * The shapes the metrics engine consumes and produces.
 *
 * The one structural commitment here is P4, and it is enforced by the type
 * rather than by reviewer diligence: **there is no type in this system that
 * carries an attack success rate without the false-positive cost measured under
 * the identical configuration.** A renderer cannot show one and omit the other
 * without deleting a field it was handed.
 *
 * The second is P5: `rail` is required on every scorecard, and there is
 * deliberately no type able to express a mixture of mock and live numbers.
 */

import type {
  InvariantStatus,
  MoneyAction,
  Paise,
  RailKind,
  ReproducibilityTier,
  ScenarioFamily,
  ScenarioKind,
} from '../contracts.js';
import type { InvariantResult } from '../invariants/verify.js';

/** One completed run, as the metrics engine needs to see it. */
export interface RunRecord {
  readonly scenarioId: string;
  readonly scenarioKind: ScenarioKind;
  readonly family: ScenarioFamily;
  readonly rail: RailKind;
  readonly gateEnabled: boolean;
  readonly verdict: InvariantStatus;
  readonly turnsUsed: number;
  readonly reproducibility: ReproducibilityTier;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly model: string | null;
  readonly actions: readonly MoneyAction[];
  readonly verdicts: readonly InvariantResult[];
}

export interface Effectiveness {
  /**
   * Violations divided by attack scenarios. `null` when there were none -
   * an unmeasured rate is not a rate of zero.
   */
  readonly attackSuccessRate: number | null;
  /** Violations the gate stopped, over violations attempted. */
  readonly containmentRate: number | null;
  /** Money that actually moved in violation of an invariant. */
  readonly blastRadiusPaise: Paise;
  /** Money actions before the first breaching one, averaged over breaches. */
  readonly meanActionsToViolation: number | null;
  readonly attackScenarios: number;
  readonly violated: number;
  readonly blocked: number;
}

export interface Cost {
  /**
   * Legitimate money the gate withheld: the amount on every action it blocked
   * or escalated in a benign scenario.
   *
   * `null` when the run set contained no benign scenarios. That distinction is
   * the whole point - reporting an unmeasured cost as zero is how a gate that
   * blocks everything comes to look perfect.
   */
  readonly falsePositiveCostPaise: Paise | null;
  /** Benign scenarios in which the gate stopped at least one action. */
  readonly overRefusalRate: number | null;
  readonly benignScenarios: number;
  readonly refused: number;
}

export interface Heuristics {
  /**
   * Scenarios where the agent named a risk and acted anyway, over scenarios
   * where it named one.
   *
   * Keyword detection over the agent's own stated rationale. It is a heuristic
   * about text, not a claim about what a model understood, and it is labelled
   * as one here, in the report and in the docs. This is the only metric that
   * reads `agentRationale`, and the only place in the system permitted to.
   */
  readonly recognitionExecutionGap: number | null;
  readonly statedRisk: number;
  readonly statedRiskAndProceeded: number;
  /** Always true. Present so a renderer cannot forget to say so. */
  readonly heuristic: true;
}

export interface Provenance {
  readonly corpusHash: string;
  readonly seeds: readonly number[];
  readonly agentName: string;
  readonly agentVersion: string;
  readonly model: string | null;
  readonly reproducibility: ReproducibilityTier;
  readonly scenarioCount: number;
  /** Runs whose measurement broke. Reported, never silently dropped. */
  readonly errored: number;
}

export interface FamilyBreakdown {
  readonly family: ScenarioFamily;
  readonly attackScenarios: number;
  readonly violated: number;
  readonly blocked: number;
  readonly attackSuccessRate: number | null;
  readonly blastRadiusPaise: Paise;
  readonly benignScenarios: number;
  readonly falsePositiveCostPaise: Paise | null;
}

/**
 * One configuration, measured.
 *
 * `rail` and `gateEnabled` identify what was measured; everything else is the
 * measurement. Two scorecards may only be compared when those two agree.
 */
export interface Scorecard {
  readonly rail: RailKind;
  readonly gateEnabled: boolean;
  readonly effectiveness: Effectiveness;
  readonly cost: Cost;
  readonly heuristics: Heuristics;
  readonly provenance: Provenance;
  readonly families: readonly FamilyBreakdown[];
}

/** A gate-off / gate-on pair, which is how a defence is actually judged. */
export interface GateComparison {
  readonly rail: RailKind;
  readonly ungated: Scorecard;
  readonly gated: Scorecard;
}

export class MetricsError extends Error {
  override readonly name = 'MetricsError';
}
