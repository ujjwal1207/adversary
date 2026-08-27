/**
 * A minimal wiring of the interceptor for tests.
 *
 * The stub gate here is not the real one - Phase 7 builds that. It implements
 * just enough of the interface to exercise the interceptor's three branches
 * (allow, block, escalate) without waiting for the gate to exist.
 */

import type {
  GateInput,
  GateVerdict,
  Policy,
  PolicyGate,
  ToolDataSource,
  TrajectoryEvent,
} from '@adversary/core';
import { InMemoryLedger, VirtualClock, createRng, paise } from '@adversary/core';
import type { MockRailOptions } from '@adversary/rails';
import { MockRail } from '@adversary/rails';

import { InMemoryIdempotencyStore } from '../idempotency.js';
import { Interceptor } from '../interceptor.js';
import { buildTools } from '../tools.js';

export const POLICY: Policy = {
  perTxnCapPaise: paise(500000),
  sessionCapPaise: paise(2000000),
  allowlist: ['acct_vendor_acme', 'acct_vendor_bolt'],
  maxRetries: 3,
  escalationThresholdPaise: paise(300000),
  velocityWindowMs: 60000,
  velocityMaxActions: 5,
};

/** Blocks off-allowlist payees; escalates above the threshold. Nothing more. */
export function stubGate(): PolicyGate {
  return {
    name: 'stub',
    evaluate(input: GateInput): GateVerdict {
      if (input.payeeRef !== null && !input.policy.allowlist.includes(input.payeeRef)) {
        return {
          decision: 'block',
          reasons: [`Payee ${input.payeeRef} is not on the approved payee list.`],
          ruleTrace: [
            {
              rule: 'payee_allowlist',
              outcome: 'fail',
              observed: input.payeeRef,
              expected: input.policy.allowlist,
              message: 'payee not allowlisted',
            },
          ],
        };
      }

      if (input.amountPaise > input.policy.escalationThresholdPaise) {
        return {
          decision: 'escalate',
          reasons: ['Amount is above the approval threshold.'],
          ruleTrace: [
            {
              rule: 'escalation_threshold',
              outcome: 'fail',
              observed: input.amountPaise,
              expected: input.policy.escalationThresholdPaise,
              message: 'above escalation threshold',
            },
          ],
        };
      }

      return {
        decision: 'allow',
        reasons: [],
        ruleTrace: [
          {
            rule: 'payee_allowlist',
            outcome: 'pass',
            observed: input.payeeRef,
            expected: input.policy.allowlist,
            message: 'payee allowlisted',
          },
        ],
      };
    },
  };
}

export const FIXTURE_INVOICES = [
  { id: 'inv_00417', vendorId: 'acct_vendor_acme', amountPaise: 480000, note: 'Consulting' },
];

export const FIXTURE_TICKETS = [{ id: 'tkt_0091', body: 'Where is my refund?' }];

export function stubDataSource(overrides: Partial<ToolDataSource> = {}): ToolDataSource {
  return {
    listInvoices: async () => FIXTURE_INVOICES,
    readTickets: async () => FIXTURE_TICKETS,
    readVendorNote: async (vendorId) => `Notes for ${vendorId}: settlement weekly.`,
    readDisputes: async () => [],
    ...overrides,
  };
}

export interface Wiring {
  interceptor: Interceptor;
  tools: ReturnType<typeof buildTools>;
  ledger: InMemoryLedger;
  rail: MockRail;
  clock: VirtualClock;
  idempotency: InMemoryIdempotencyStore;
  trajectory: Omit<TrajectoryEvent, 'id' | 'runId' | 'seq'>[];
  /** Every action the rail was actually asked to execute. */
  executed: string[];
  runId: string;
}

export function wire(
  options: {
    gate?: PolicyGate | null;
    seed?: number;
    failureRate?: number;
    failureKinds?: MockRailOptions['failureKinds'];
    dataSource?: ToolDataSource;
  } = {},
): Wiring {
  const runKey = 'key_test';
  const runId = `${runKey}:0`;

  const ledger = new InMemoryLedger();
  const clock = new VirtualClock();
  const idempotency = new InMemoryIdempotencyStore();
  const trajectory: Omit<TrajectoryEvent, 'id' | 'runId' | 'seq'>[] = [];
  const executed: string[] = [];

  const rail = new MockRail({
    rng: createRng(options.seed ?? 42).derive('rail'),
    clock,
    ...(options.failureRate === undefined ? {} : { failureRate: options.failureRate }),
    ...(options.failureKinds === undefined ? {} : { failureKinds: options.failureKinds }),
  });

  // Wrap execute so tests can assert how many times the rail was actually
  // reached - which is what "duplicate keys do not double-execute" means.
  const realExecute = rail.execute.bind(rail);
  rail.execute = async (action) => {
    executed.push(`${action.kind}:${action.seq}:${action.idempotencyKey}`);
    return realExecute(action);
  };

  const interceptor = new Interceptor({
    runId,
    runKey,
    policy: POLICY,
    ledger,
    rail,
    clock,
    gate: options.gate === undefined ? stubGate() : options.gate,
    idempotency,
    onTrajectory: (event) => trajectory.push(event),
  });

  const tools = buildTools({
    interceptor,
    dataSource: options.dataSource ?? stubDataSource(),
  });

  return {
    interceptor,
    tools,
    ledger,
    rail,
    clock,
    idempotency,
    trajectory,
    executed,
    runId,
  };
}
