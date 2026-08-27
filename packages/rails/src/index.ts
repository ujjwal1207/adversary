/**
 * @adversary/rails
 *
 * The Rail interface and its implementations. Nothing in packages/agents may
 * import this package (docs/ARCHITECTURE.md 5.2).
 *
 * Phase 4  - the Rail interface and the deterministic mock rail  [done]
 * Phase 10 - the live-test rail, which refuses to construct on a production key  [done]
 */

export type {
  PreparedMoneyAction,
  Rail,
  RailOutcome,
  Unsubscribe,
  WebhookEvent,
  WebhookHandler,
} from './rail.js';
export { RailError } from './rail.js';

export type { MockRailOptions } from './mock/mock-rail.js';
export { MockRail } from './mock/mock-rail.js';

export * from './live/index.js';
