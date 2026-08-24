/**
 * @adversary/runner
 *
 * The composition root: the only package allowed to know about core, gate,
 * rails and agents at once. It owns the nine-step run flow, seeding, the
 * interceptor, trajectory capture and persistence.
 *
 * Phase 4 - the interceptor and idempotency store
 * Phase 6 - the nine-step flow, the seed tree, replay, verify-determinism
 */

export * from './db/index.js';
