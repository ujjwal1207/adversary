/**
 * The digest is the mechanism behind the project's central claim. These tests
 * pin down exactly which differences between two runs count as behaviour and
 * which count as bookkeeping - because a determinism check that is too strict
 * fails on noise, and one that is too loose passes on real divergence.
 */

import { describe, expect, it } from 'vitest';

import { firstDifference, ledgerDigest, projectAction } from '../digest.js';
import { InMemoryLedger } from '../ledger.js';
import { paise } from '../../money.js';
import { draft } from './fixtures.js';

function run(overrides: Parameters<typeof draft>[0][] = [{}]) {
  const ledger = new InMemoryLedger();
  for (const o of overrides) ledger.append(draft(o));
  return ledger.getRun('run_1');
}

describe('what the digest ignores', () => {
  it('ignores the per-row id', () => {
    expect(ledgerDigest(run([{ id: 'ma_0001' }]))).toBe(
      ledgerDigest(run([{ id: 'ma_9999' }])),
    );
  });

  it('ignores runId, which carries an attempt counter', () => {
    // runId is `runKey:attempt`. Two attempts of the same experiment must
    // digest identically, or the determinism gate would fail for a reason that
    // says nothing about the system's behaviour.
    const a = new InMemoryLedger();
    const b = new InMemoryLedger();
    a.append(draft({ runId: 'key_abc:0' }));
    b.append(draft({ runId: 'key_abc:1' }));

    expect(ledgerDigest(a.getRun('key_abc:0'))).toBe(ledgerDigest(b.getRun('key_abc:1')));
  });

  it('does not include id or runId in the projection at all', () => {
    const projected = projectAction(run()[0]!);
    expect(projected).not.toHaveProperty('id');
    expect(projected).not.toHaveProperty('runId');
  });
});

describe('what the digest catches', () => {
  it.each([
    ['amount', { amountPaise: paise(480001) }],
    ['payee', { payeeRef: 'acct_vendor_acme_new' }],
    ['kind', { kind: 'refund' as const }],
    ['gate decision', { gateDecision: 'escalate' as const, railResult: 'not_executed' as const, railRef: null }],
    ['rail result', { railResult: 'failed' as const, railRef: null, railError: 'timeout' }],
    ['idempotency source', { idempotencySource: 'agent' as const }],
    ['params', { params: { vendorId: 'acct_attacker' } }],
    ['timestamp', { ts: 1_760_000_000_001 }],
    ['rationale', { agentRationale: 'Something else entirely.' }],
  ])('catches a changed %s', (_label, override) => {
    expect(ledgerDigest(run())).not.toBe(ledgerDigest(run([override])));
  });

  it('catches an extra action', () => {
    expect(ledgerDigest(run([{}]))).not.toBe(ledgerDigest(run([{}, {}])));
  });

  it('catches a reordering', () => {
    const forward = run([{ amountPaise: paise(100) }, { amountPaise: paise(200) }]);
    const backward = run([{ amountPaise: paise(200) }, { amountPaise: paise(100) }]);

    expect(ledgerDigest(forward)).not.toBe(ledgerDigest(backward));
  });

  it('catches taint appearing on an action', () => {
    // Provenance is part of what happened, not commentary on it.
    expect(ledgerDigest(run())).not.toBe(
      ledgerDigest(
        run([
          {
            taint: [
              {
                sourceKind: 'invoice_line_item',
                sourceId: 'inv_00417',
                extractedValues: ['acct_vendor_acme_new'],
                matchedVia: 'normalized',
              },
            ],
          },
        ]),
      ),
    );
  });
});

describe('relaxations are opt-in and named', () => {
  it('can exclude rail refs, for the live rail where they are provider-assigned', () => {
    const a = run([{ railRef: 'pout_live_A' }]);
    const b = run([{ railRef: 'pout_live_B' }]);

    expect(ledgerDigest(a)).not.toBe(ledgerDigest(b));
    expect(ledgerDigest(a, { includeRailRefs: false })).toBe(
      ledgerDigest(b, { includeRailRefs: false }),
    );
  });

  it('can exclude timestamps, for the live rail where they are wall-clock', () => {
    const a = run([{ ts: 1 }]);
    const b = run([{ ts: 2 }]);

    expect(ledgerDigest(a, { includeTimestamps: false })).toBe(
      ledgerDigest(b, { includeTimestamps: false }),
    );
  });

  it('can exclude the rationale, for live model runs where prose varies', () => {
    const a = run([{ agentRationale: 'Paying inv_00417, within policy.' }]);
    const b = run([{ agentRationale: 'This invoice is within the cap, paying it.' }]);

    expect(ledgerDigest(a, { includeRationale: false })).toBe(
      ledgerDigest(b, { includeRationale: false }),
    );
  });

  it('relaxing the rationale still catches a substantive difference', () => {
    // The point of the relaxation is to let prose vary, never to let the
    // ledger's substance vary.
    const a = run([{ agentRationale: 'A', amountPaise: paise(100) }]);
    const b = run([{ agentRationale: 'B', amountPaise: paise(200) }]);

    expect(ledgerDigest(a, { includeRationale: false })).not.toBe(
      ledgerDigest(b, { includeRationale: false }),
    );
  });

  it('is strict by default', () => {
    expect(ledgerDigest(run([{ ts: 1 }]))).not.toBe(ledgerDigest(run([{ ts: 2 }])));
  });
});

describe('firstDifference', () => {
  it('returns null for identical ledgers', () => {
    expect(firstDifference(run(), run())).toBeNull();
  });

  it('reports differing action counts', () => {
    expect(firstDifference(run([{}]), run([{}, {}]))).toBe('action count: 1 vs 2');
  });

  it('names the action index and the field', () => {
    // "Digests differ" is not a debuggable error message, and the determinism
    // gate is the check most likely to fail on a change nobody expected to
    // matter.
    const diff = firstDifference(run([{}, {}]), run([{}, { amountPaise: paise(1) }]));

    expect(diff).toContain('action[1].amountPaise');
    expect(diff).toContain('480000');
    expect(diff).toContain('1');
  });

  it('honours the same relaxations as the digest', () => {
    const a = run([{ railRef: 'A' }]);
    const b = run([{ railRef: 'B' }]);

    expect(firstDifference(a, b)).toContain('railRef');
    expect(firstDifference(a, b, { includeRailRefs: false })).toBeNull();
  });
});
