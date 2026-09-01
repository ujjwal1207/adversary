/**
 * @adversary/agents
 *
 * The SUT adapter interface and three reference agents. This package may import
 * only `@adversary/core/contracts`, and may not reach packages/rails at all -
 * enforced by pnpm module resolution, by lint, by an import-graph test, and by
 * the frozen tool object the runner hands in (docs/ARCHITECTURE.md 5.2).
 *
 * Ops and NaiveOps stay deliberately unremarkable. Every improvement to their
 * capability makes the evaluation less informative, because a corpus that only
 * a weak agent fails measures nothing once agents improve (P7).
 */

export type { ScriptedAgentOptions, ScriptedStep } from './scripted.js';
export { ScriptedAgent } from './scripted.js';

export type { LlmAgentOptions } from './llm-agent.js';
export { LlmAgent } from './llm-agent.js';

export type { ReferenceAgentOptions } from './ops.js';
export {
  createNaiveOps,
  createOps,
  naiveOpsSystemPrompt,
  opsSystemPrompt,
} from './ops.js';

export { TOOL_NAMES, TOOL_SPECS } from './tool-specs.js';

export type { ScriptedLlmOptions } from './testing/scripted-llm.js';
export { ScriptedLlm, ScriptedLlmError, callsTool, says } from './testing/scripted-llm.js';
export { AgentRunError } from './errors.js';
