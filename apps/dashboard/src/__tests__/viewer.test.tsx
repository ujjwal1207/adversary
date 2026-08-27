/**
 * @vitest-environment jsdom
 *
 * The viewer's tests.
 *
 * Two things are worth testing here and the rest is not. The first is the
 * `SYNTHETIC` badge, because docs/THREAT-MODEL.md makes a promise about the
 * interface — that a reader looking at a manufactured dispute can see it was
 * manufactured without having read the documentation first — and a promise
 * about rendered output can only be checked by rendering it.
 *
 * The second is the arithmetic in the run list. That is where the viewer's one
 * real defect lived: it summed `railResult === 'executed'`, a value that does
 * not exist, so every "moved" column read a reassuring ₹0.00 next to runs where
 * money had in fact left. The union is closed now, which turns that exact
 * mistake into a compile error — but the *shape* of it, a filter that silently
 * matches nothing, is worth a test that would notice.
 *
 * What is deliberately not tested: layout, colours, and which Tailwind classes
 * an element carries. Those change for good reasons and a test asserting them
 * only ever produces false alarms.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RunList } from '../RunList';
import { TrajectoryView } from '../TrajectoryView';
import type { Paise, Snapshot, SnapshotAction, SnapshotRun } from '../types';

afterEach(cleanup);

const paise = (n: number): Paise => n as unknown as Paise;

function action(over: Partial<SnapshotAction> = {}): SnapshotAction {
  return {
    id: 'ma_1',
    seq: 0,
    ts: 0,
    kind: 'transfer',
    params: {},
    amountPaise: paise(99900),
    payeeRef: 'acct_vendor_acme',
    subjectRef: null,
    idempotencyKey: 'auto:k:0',
    idempotencySource: 'auto',
    taint: [],
    gateDecision: 'allow',
    gateReasons: [],
    ruleTrace: [],
    agentRationale: 'Paying the invoice.',
    railResult: 'ok',
    railRef: 'pay_1',
    railError: null,
    ...over,
  };
}

function run(over: Partial<SnapshotRun> = {}): SnapshotRun {
  return {
    runId: 'key_a:0',
    runKey: 'key_a',
    attempt: 0,
    scenarioId: 'B1_invoice_borne_redirect',
    scenarioContentHash: 'hash_b1',
    seed: 42,
    rail: 'mock',
    gateEnabled: true,
    agentName: 'scripted',
    agentVersion: '1.0.0',
    model: null,
    reproducibility: 'scripted',
    startedAt: 0,
    finishedAt: 1,
    verdict: 'violated',
    error: null,
    turnsUsed: 2,
    synthetic: false,
    actions: [action()],
    trajectory: [],
    verdicts: [],
    ...over,
  };
}

function snapshot(runs: readonly SnapshotRun[]): Snapshot {
  return {
    version: 1,
    // The comparison is not what these tests exercise; RunList never reads it.
    comparison: {} as Snapshot['comparison'],
    scenarios: [
      {
        id: 'B1_invoice_borne_redirect',
        contentHash: 'hash_b1',
        title: 'Vendor bank details altered inside an invoice line item',
        family: 'B',
        kind: 'attack',
      },
      {
        id: 'C4_webhook_field_instruction',
        contentHash: 'hash_c4',
        title: 'Instruction embedded in the reason field of a dispute',
        family: 'C',
        kind: 'attack',
      },
      {
        id: 'C4_benign_dispute_response',
        contentHash: 'hash_c4b',
        title: 'Ordinary duplicate-charge dispute settled by refunding the card',
        family: 'C',
        kind: 'benign',
      },
    ],
    runs,
  };
}

// --- the badge --------------------------------------------------------------

describe('the SYNTHETIC badge', () => {
  const manufactured = run({
    runId: 'key_c4:0',
    runKey: 'key_c4',
    scenarioId: 'C4_webhook_field_instruction',
    scenarioContentHash: 'hash_c4',
    synthetic: true,
  });

  it('appears in the run list on a run built from manufactured evidence', () => {
    render(<RunList snapshot={snapshot([manufactured])} onOpen={() => {}} />);
    expect(screen.getByText(/^synthetic$/i)).toBeDefined();
  });

  it('does not appear on an ordinary run', () => {
    render(<RunList snapshot={snapshot([run()])} onOpen={() => {}} />);
    expect(screen.queryByText(/^synthetic$/i)).toBeNull();
  });

  it('appears on the trajectory screen too', () => {
    // The run list is not enough. A reader who opens a dispute trajectory
    // directly must see the label there, on the screen showing the evidence.
    render(
      <TrajectoryView
        run={manufactured}
        scenario={snapshot([]).scenarios[1]}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText(/^synthetic$/i)).toBeDefined();
  });

  it('explains itself without the reader leaving the page', () => {
    // The promise is that the documentation is not required reading. A bare
    // word nobody can interpret would satisfy the letter of that and none of
    // its point.
    render(<RunList snapshot={snapshot([manufactured])} onOpen={() => {}} />);
    const badge = screen.getByText(/^synthetic$/i);

    expect(badge.getAttribute('title')).toMatch(/manufactured/i);
    expect(badge.getAttribute('title')).toMatch(/test mode/i);
  });
});

// --- what the run list says happened ----------------------------------------

describe('the run list', () => {
  it('counts and sums only actions the rail carried out', () => {
    // `ok` is the only rail result that means money moved. This is the test
    // that would have caught the `=== "executed"` bug: a filter matching
    // nothing reports zero, and zero reads as safety.
    const mixed = run({
      actions: [
        action({ id: 'a', seq: 0, railResult: 'ok', amountPaise: paise(120000) }),
        action({ id: 'b', seq: 1, railResult: 'not_executed', amountPaise: paise(500000) }),
        action({ id: 'c', seq: 2, railResult: 'failed', amountPaise: paise(700000) }),
        action({ id: 'd', seq: 3, railResult: 'ok', amountPaise: paise(80000) }),
      ],
    });

    render(<RunList snapshot={snapshot([mixed])} onOpen={() => {}} />);
    const cells = screen.getAllByRole('cell').map((c) => c.textContent);

    expect(cells).toContain('4'); // attempted
    expect(cells).toContain('2'); // executed
    expect(cells.some((c) => c?.includes('2,000.00'))).toBe(true); // 120000 + 80000
    expect(cells.some((c) => c?.includes('13,000.00'))).toBe(false); // not the total
  });

  it('shows the newest attempt of an experiment, not both', () => {
    const first = run({ runId: 'key_a:0', attempt: 0, verdict: 'violated' });
    const second = run({ runId: 'key_a:1', attempt: 1, verdict: 'blocked' });

    render(<RunList snapshot={snapshot([first, second])} onOpen={() => {}} />);

    // One row. Re-running a scenario replaces its line rather than adding one,
    // or a list of sixty-two would show a hundred and twenty-four the second
    // time anyone pressed the button.
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2); // header + one

    // Scoped to the row, not the page: the verdict filter's options carry these
    // same words, and a page-wide query matches those too.
    const row = within(rows[1] as HTMLElement);
    expect(row.getByText('blocked')).toBeDefined();
    expect(row.queryByText('violated')).toBeNull();
  });

  it('filters by kind, and says how much it is hiding', () => {
    const attack = run({ runKey: 'k1', runId: 'k1:0' });
    const benign = run({
      runKey: 'k2',
      runId: 'k2:0',
      scenarioId: 'C4_benign_dispute_response',
      scenarioContentHash: 'hash_c4b',
      verdict: 'pass',
    });

    render(<RunList snapshot={snapshot([attack, benign])} onOpen={() => {}} />);
    expect(screen.getByText('2 of 2 runs')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'benign' } });

    expect(screen.getByText('1 of 2 runs')).toBeDefined();
    expect(screen.getByText('C4_benign_dispute_response')).toBeDefined();
    expect(screen.queryByText('B1_invoice_borne_redirect')).toBeNull();
  });

  it('opens a run from the keyboard', () => {
    // The scenario cell is a real button rather than a click handler on the
    // row. A <tr> carries no role, so a keyboard user could not open a run and
    // nothing reading the page structurally could find one.
    let opened: string | null = null;
    render(<RunList snapshot={snapshot([run()])} onOpen={(id) => (opened = id)} />);

    const button = screen.getByRole('button', { name: 'B1_invoice_borne_redirect' });
    fireEvent.click(button);

    expect(opened).toBe('key_a:0');
  });

  it('renders a run whose scenario is missing rather than crashing', () => {
    // A snapshot can outlive the corpus it was measured against. Showing a row
    // with dashes is honest; a blank screen is not.
    const orphan = run({ scenarioContentHash: 'hash_that_is_gone' });
    render(<RunList snapshot={snapshot([orphan])} onOpen={() => {}} />);

    expect(screen.getByText('B1_invoice_borne_redirect')).toBeDefined();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

// --- the trajectory ---------------------------------------------------------

describe('the trajectory viewer', () => {
  it('marks money that moved despite the gate refusing it', () => {
    const escaped = run({
      actions: [action({ gateDecision: 'block', railResult: 'ok' })],
    });
    const { container } = render(
      <TrajectoryView run={escaped} scenario={undefined} onBack={() => {}} />,
    );

    // Blocked by the gate and executed by the rail is the single worst thing
    // this system can observe, so it is the one state the viewer highlights.
    expect(container.querySelectorAll('.bg-red-50')).toHaveLength(1);
  });

  it('leaves an ordinary allowed payment unmarked', () => {
    const { container } = render(
      <TrajectoryView run={run()} scenario={undefined} onBack={() => {}} />,
    );
    expect(container.querySelectorAll('.bg-red-50')).toHaveLength(0);
  });

  it('expands a money action beside the event that produced it', () => {
    const withEvents = run({
      trajectory: [
        { seq: 0, role: 'harness', kind: 'tool_call', content: { tool: 'pay_vendor' } },
        {
          seq: 1,
          role: 'tool',
          kind: 'tool_result',
          content: { actionId: 'ma_1', gateDecision: 'allow' },
        },
      ],
    });

    render(<TrajectoryView run={withEvents} scenario={undefined} onBack={() => {}} />);

    expect(screen.getByText(/money action/i)).toBeDefined();
    expect(screen.getByText('acct_vendor_acme')).toBeDefined();
    // Linked, so it must not also appear under the unlinked heading.
    expect(screen.queryByText(/not linked to a trajectory event/i)).toBeNull();
  });

  it('surfaces a money action no event accounts for', () => {
    // An action with no event beside it would otherwise be invisible here while
    // still counting toward every number on the scorecard.
    render(<TrajectoryView run={run()} scenario={undefined} onBack={() => {}} />);
    expect(screen.getByText(/not linked to a trajectory event/i)).toBeDefined();
  });

  it('shows the gate reasons behind a refusal', () => {
    const refused = run({
      actions: [
        action({
          gateDecision: 'block',
          railResult: 'not_executed',
          gateReasons: ['Payee acct_x is not on the approved payee list.'],
        }),
      ],
    });

    render(<TrajectoryView run={refused} scenario={undefined} onBack={() => {}} />);
    expect(screen.getByText(/not on the approved payee list/)).toBeDefined();
  });

  it("labels the agent's rationale as evidence about the agent", () => {
    // The stated reason is the one field on the screen that is not evidence
    // about what happened, and the viewer has to say so where it is shown.
    render(<TrajectoryView run={run()} scenario={undefined} onBack={() => {}} />);

    const rationale = screen.getByText('Paying the invoice.');
    expect(rationale).toBeDefined();
    expect(
      within(rationale.parentElement as HTMLElement).getByText(
        /evidence about the agent, never evidence about what happened/i,
      ),
    ).toBeDefined();
  });
});
