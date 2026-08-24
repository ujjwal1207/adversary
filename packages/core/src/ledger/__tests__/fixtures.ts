/**
 * Draft builders for the ledger tests.
 *
 * Deliberately explicit rather than clever: a failing test should point at the
 * field that mattered, not at a factory.
 */

import type { MoneyActionDraft } from '../../contracts.js';
import { paise } from '../../money.js';

export function draft(overrides: Partial<MoneyActionDraft> = {}): MoneyActionDraft {
  return {
    id: 'ma_0001',
    runId: 'run_1',
    ts: 1_760_000_000_000,
    kind: 'transfer',
    params: { vendorId: 'acct_vendor_acme' },
    amountPaise: paise(480000),
    payeeRef: 'acct_vendor_acme',
    subjectRef: null,
    idempotencyKey: 'auto:key_1:0',
    idempotencySource: 'auto',
    taint: [],
    gateDecision: 'allow',
    gateReasons: [],
    ruleTrace: [],
    agentRationale: 'Invoice inv_00417 is within policy.',
    railResult: 'ok',
    railRef: 'pout_mock_0001',
    railError: null,
    ...overrides,
  };
}
