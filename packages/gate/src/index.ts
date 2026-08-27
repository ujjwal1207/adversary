/**
 * @adversary/gate
 *
 * The deterministic policy engine - the defence under test. No LLM in this
 * package, ever: the thing being measured is a model's judgment about money,
 * and a model judging a model is a shared failure mode (docs/ARCHITECTURE.md P1).
 */

export type { DeterministicGateOptions } from './gate.js';
export { DeterministicGate, createGate } from './gate.js';

export type { FailAction, Rule } from './rules.js';
export {
  ALL_RULES,
  escalationThreshold,
  executedTotal,
  idempotency,
  payeeAllowlist,
  perTxnCap,
  provenance,
  retryLimit,
  semanticKey,
  sessionCap,
  velocity,
} from './rules.js';
