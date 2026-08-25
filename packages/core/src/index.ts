/**
 * @adversary/core
 *
 * The domain layer. No filesystem, no network, no clock of its own, no model
 * client - that purity is what makes the invariant evaluator and the metrics
 * engine testable to the standard this product's honesty claim requires
 * (docs/ARCHITECTURE.md 4.2).
 *
 * Built out over phases 2, 3 and 9:
 *   Phase 2 - Paise, MoneyAction, the append-only ledger, the typed view  [done]
 *   Phase 3 - the invariant evaluator (lexer, parser, evaluator)         [done]
 *   Phase 9 - the metrics engine
 */

export type * from './contracts.js';
export * from './enums.js';

export type { Canonical } from './canonical.js';
export {
  CanonicalizationError,
  canonicalJson,
  hashValue,
  normalizeText,
  sha256Hex,
} from './canonical.js';

export {
  MAX_PAISE,
  MoneyError,
  ZERO_PAISE,
  addPaise,
  formatPaise,
  isPaise,
  paise,
  parseRupees,
  rupeesToPaise,
  subPaise,
  sumPaise,
} from './money.js';

export type { GateInput, PolicyGate } from './gate-contract.js';
export { BYPASSED_VERDICT } from './gate-contract.js';

export * from './determinism/index.js';
export * from './ledger/index.js';
export * from './invariants/index.js';
