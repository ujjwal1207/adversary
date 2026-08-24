/**
 * The typed view is the only thing the invariant evaluator will ever see, so
 * its semantics are load-bearing for every verdict the system produces. In
 * particular `executedOnly()` is half of the dual evaluation that separates a
 * violation from a containment.
 */

import { describe, expect, it } from 'vitest';

import { createLedgerView } from '../view.js';
import { InMemoryLedger } from '../ledger.js';
import { paise } from '../../money.js';
import { draft } from './fixtures.js';

/** Eleven sub-cap transfers plus one blocked one - the shape of family A1. */
function splitPaymentRun() {
  const ledger = new InMemoryLedger();
  for (let i = 0; i < 11; i += 1) {
    ledger.append(
      draft({
        id: `ma_${i}`,
        amountPaise: paise(499900),
        payeeRef: 'acct_vendor_acme',
        railResult: 'ok',
      }),
    );
  }
  ledger.append(
    draft({
      id: 'ma_blocked',
      amountPaise: paise(499900),
      payeeRef: 'acct_vendor_acme_new',
      gateDecision: 'block',
      railResult: 'not_executed',
      railRef: null,
    }),
  );
  return ledger.view('run_1');
}

describe('ordering', () => {
  it('presents actions in seq order regardless of input order', () => {
    const view = createLedgerView([
      { ...draft(), seq: 2, id: 'c' },
      { ...draft(), seq: 0, id: 'a' },
      { ...draft(), seq: 1, id: 'b' },
    ]);

    expect(view.actions().map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('selection', () => {
  it('selects by kind', () => {
    const ledger = new InMemoryLedger();
    ledger.append(draft({ id: 'a', kind: 'transfer' }));
    ledger.append(draft({ id: 'b', kind: 'refund' }));
    ledger.append(draft({ id: 'c', kind: 'transfer' }));

    expect(ledger.view('run_1').actionsOfKind('transfer').map((a) => a.id)).toEqual([
      'a',
      'c',
    ]);
    expect(ledger.view('run_1').actionsOfKind('payment_link')).toEqual([]);
  });

  it('lists distinct payees in first-seen order, skipping nulls', () => {
    const ledger = new InMemoryLedger();
    ledger.append(draft({ payeeRef: 'acct_vendor_bolt' }));
    ledger.append(draft({ payeeRef: 'acct_vendor_acme' }));
    ledger.append(draft({ payeeRef: 'acct_vendor_bolt' }));
    ledger.append(draft({ payeeRef: null }));

    expect(ledger.view('run_1').payees()).toEqual([
      'acct_vendor_bolt',
      'acct_vendor_acme',
    ]);
  });
});

describe('totals', () => {
  it('sums every action by default', () => {
    expect(splitPaymentRun().totalAmount()).toBe(499900 * 12);
  });

  it('sums a supplied subset', () => {
    const view = splitPaymentRun();
    expect(view.totalAmount(view.executedOnly().actions())).toBe(499900 * 11);
  });

  it('sums an empty run to zero', () => {
    expect(createLedgerView([]).totalAmount()).toBe(0);
  });
});

describe('countBySubject', () => {
  it('counts actions of a kind against each subject', () => {
    // This is what the retry_limit rule reads: how many times did the agent go
    // at the same mandate?
    const ledger = new InMemoryLedger();
    for (let i = 0; i < 4; i += 1) {
      ledger.append(
        draft({
          id: `ma_${i}`,
          kind: 'subscription_charge',
          subjectRef: 'sub_0091',
          payeeRef: null,
        }),
      );
    }
    ledger.append(
      draft({ id: 'other', kind: 'subscription_charge', subjectRef: 'sub_0092' }),
    );
    ledger.append(draft({ id: 'transfer', kind: 'transfer', subjectRef: 'sub_0091' }));

    const counts = ledger.view('run_1').countBySubject('subscription_charge');

    expect(counts.get('sub_0091')).toBe(4);
    expect(counts.get('sub_0092')).toBe(1);
    expect(counts.size).toBe(2);
  });

  it('ignores actions with no subject', () => {
    const ledger = new InMemoryLedger();
    ledger.append(draft({ kind: 'transfer', subjectRef: null }));

    expect(ledger.view('run_1').countBySubject('transfer').size).toBe(0);
  });
});

describe('executedOnly', () => {
  it('keeps only actions the rail actually executed', () => {
    const view = splitPaymentRun();

    expect(view.actions()).toHaveLength(12);
    expect(view.executedOnly().actions()).toHaveLength(11);
    expect(
      view.executedOnly().actions().every((a) => a.railResult === 'ok'),
    ).toBe(true);
  });

  it('filters on rail result, not on gate decision', () => {
    // An action the gate allowed can still fail at the rail. Money that never
    // moved is not blast radius, whatever the reason it did not move.
    const ledger = new InMemoryLedger();
    ledger.append(
      draft({
        id: 'allowed_but_failed',
        gateDecision: 'allow',
        railResult: 'failed',
        railRef: null,
        railError: 'insufficient_funds',
      }),
    );

    expect(ledger.view('run_1').executedOnly().actions()).toEqual([]);
  });

  it('excludes escalated actions, which is why the dual evaluation is asymmetric', () => {
    // An escalation invariant reads `any(actions[gateDecision=escalate])`.
    // Escalated actions are never executed, so the executed-only view strips
    // exactly the evidence that satisfies it. Consulting this view to escalate
    // a pass into a violation would therefore report a perfect run as a
    // failure - which is why it is only ever consulted to downgrade a
    // violation to `blocked` (docs/ARCHITECTURE.md 8.2).
    const ledger = new InMemoryLedger();
    ledger.append(
      draft({
        gateDecision: 'escalate',
        railResult: 'not_executed',
        railRef: null,
      }),
    );

    const view = ledger.view('run_1');
    expect(view.select({ gateDecision: 'escalate' })).toHaveLength(1);
    expect(view.executedOnly().select({ gateDecision: 'escalate' })).toHaveLength(0);
  });

  it('is idempotent', () => {
    const view = splitPaymentRun();
    expect(view.executedOnly().executedOnly().actions()).toHaveLength(11);
  });

  it('renumbers nothing - seq stays as assigned', () => {
    // The evaluator reports witness sets by identity. If the restricted view
    // renumbered, a blast radius would point at the wrong actions.
    const view = splitPaymentRun();
    expect(view.executedOnly().actions().map((a) => a.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
