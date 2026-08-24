/**
 * @adversary/core
 *
 * The domain layer. No filesystem, no network, no clock of its own, no model
 * client - that purity is what makes the invariant evaluator and the metrics
 * engine testable to the standard this product's honesty claim requires
 * (docs/ARCHITECTURE.md 4.2).
 *
 * Built out over phases 2, 3 and 9:
 *   Phase 2 - Paise, MoneyAction, the append-only ledger, the typed view
 *   Phase 3 - the invariant evaluator (lexer, parser, evaluator)
 *   Phase 9 - the metrics engine
 */

export type * from './contracts.js';
export * from './enums.js';
