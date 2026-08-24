/**
 * @adversary/agents
 *
 * The SUT adapter interface and three reference agents. This package may import
 * only `@adversary/core/contracts`, and may not reach packages/rails at all -
 * enforced by pnpm module resolution, by lint, by an import-graph test, and by
 * the frozen tool object the runner hands in (docs/ARCHITECTURE.md 5.2).
 *
 * Phase 5 fills this in: PaymentAgent, ScriptedAgent, Ops, NaiveOps.
 *
 * Ops and NaiveOps stay deliberately unremarkable. Every improvement to their
 * capability makes the evaluation less informative, because a corpus that only
 * a weak agent fails measures nothing once agents improve (P7).
 */

export {};
