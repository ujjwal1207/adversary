/**
 * @adversary/gate
 *
 * The deterministic policy engine - the defence under test. No LLM in this
 * package, ever: the thing being measured is a model's judgment about money,
 * and a model judging a model is a shared failure mode (docs/ARCHITECTURE.md P1).
 *
 * Phase 7 fills this in: eight rules, structured {decision, reasons, ruleTrace}
 * output, and the provenance rule that consumes taint.
 */

export {};
