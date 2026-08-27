/**
 * The live-test rail.
 *
 * Three of the four Phase 10 gate conditions are checkable without credentials
 * and are checked here: the production-key refusal, the bounded fallback on
 * every failure mode, and the rejection of tampered webhook signatures.
 *
 * The fourth - "marquee scenarios run on live test mode" - needs a payment
 * provider test key, which this build does not have. It is recorded as
 * unverified in docs/LIMITATIONS.md rather than approximated here. A test that
 * mocked the provider and then claimed the scenarios had run against it would
 * be worse than no test.
 */

import { describe, expect, it, vi } from 'vitest';

import { VirtualClock, paise } from '@adversary/core';

import type { PreparedMoneyAction } from '../../rail.js';
import type { ProviderRequest } from '../provider-client.js';
import { LiveTestRail } from '../live-test-rail.js';
import { McpProviderClient } from '../mcp-client.js';
import type { McpTransport } from '../mcp-client.js';
import type { FetchLike } from '../rest-client.js';
import { RestProviderClient } from '../rest-client.js';
import { ProductionKeyError, assertTestKey, isTestKey, redactKey } from '../test-key.js';
import { WebhookReceiver } from '../webhook.js';

const TEST_KEY = 'rzp_test_A1b2C3d4E5f6G7';
const LIVE_KEY = 'rzp_live_A1b2C3d4E5f6G7';

function action(overrides: Partial<PreparedMoneyAction> = {}): PreparedMoneyAction {
  return {
    runKey: 'key_live_1',
    seq: 0,
    kind: 'transfer',
    params: {},
    amountPaise: paise(120000),
    payeeRef: 'acct_vendor_acme',
    subjectRef: null,
    idempotencyKey: 'inv_00405',
    ts: 1_760_000_000_000,
    ...overrides,
  };
}

/** What a ProviderClient actually receives - the rail adds the run tag. */
function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runKey: 'key_live_1',
    seq: 0,
    kind: 'transfer',
    amountPaise: 120000,
    payeeRef: 'acct_vendor_acme',
    subjectRef: null,
    idempotencyKey: 'inv_00405',
    notes: {
      adversary_run: 'key_live_1',
      adversary_seq: '0',
      adversary_synthetic: 'true',
    },
    ...overrides,
  };
}

function fakeFetch(
  body: unknown,
  status = 200,
): FetchLike & { calls: { url: string; headers: Record<string, string>; body: unknown }[] } {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = (async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }) as FetchLike & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

const restClient = (options: Partial<Parameters<typeof makeRest>[0]> = {}) => makeRest(options);

function makeRest(options: {
  keyId?: string;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  backoffMs?: number;
}) {
  return new RestProviderClient({
    keyId: options.keyId ?? TEST_KEY,
    keySecret: 'secret',
    fetchImpl: options.fetchImpl ?? fakeFetch({ id: 'pout_live_1' }),
    maxRetries: options.maxRetries ?? 2,
    backoffMs: options.backoffMs ?? 1,
  });
}

// ===========================================================================
// The production-key guard
// ===========================================================================

describe('the test-mode guard', () => {
  it.each(['rzp_test_A1b2C3d4E5f6', 'sk_test_abcdefgh12345678', 'test_abcdefgh1234'])(
    'accepts the test key %s',
    (key) => {
      expect(() => assertTestKey(key)).not.toThrow();
      expect(isTestKey(key)).toBe(true);
    },
  );

  it.each([LIVE_KEY, 'sk_live_abcdefgh1234', 'prod_abcdefgh1234'])(
    'refuses the production key %s, and says so',
    (key) => {
      expect(() => assertTestKey(key)).toThrow(ProductionKeyError);
      expect(() => assertTestKey(key)).toThrow(/PRODUCTION/);
      expect(() => assertTestKey(key)).toThrow(/test mode/);
    },
  );

  it('fails closed on an unrecognised format', () => {
    // The cost of being wrong in the other direction is moving real money, and
    // "we did not recognise the format" is not evidence of safety.
    expect(() => assertTestKey('some_other_provider_key_9999')).toThrow(
      /unrecognised/,
    );
    expect(() => assertTestKey('')).toThrow(/none was supplied/);
  });

  it('never prints a key in full', () => {
    const key = 'rzp_live_SUPERSECRETVALUE99';
    let message = '';
    try {
      assertTestKey(key);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toContain('SUPERSECRETVALUE99');
    expect(redactKey(key)).toBe('rzp_live_SUP...99');
  });

  it('throws at CONSTRUCTION of the REST client, not at first use', () => {
    // A misconfigured client must not exist as an object. There is no window in
    // which one sits in a variable waiting to be called.
    expect(() => makeRest({ keyId: LIVE_KEY })).toThrow(ProductionKeyError);
  });

  it('throws at construction of the MCP client', () => {
    const session: McpTransport = { callTool: async () => ({}), close: async () => undefined };
    expect(() => new McpProviderClient({ keyId: LIVE_KEY, session })).toThrow(
      ProductionKeyError,
    );
  });

  it('throws at construction of the rail itself, even with a hand-rolled client', () => {
    // Redundant with the client guards on purpose: a caller who supplies their
    // own ProviderClient would otherwise skip the check entirely.
    expect(
      () =>
        new LiveTestRail({
          keyId: LIVE_KEY,
          client: { transport: 'rest', execute: async () => ({ ok: true, ref: 'x' }), close: async () => undefined },
          clock: new VirtualClock(),
          webhookSecret: 'whsec',
        }),
    ).toThrow(ProductionKeyError);
  });

  it('offers no bypass', () => {
    // Asserted structurally. A flag that disabled this would be the single most
    // dangerous line of code in the project.
    const options = ['keyId', 'client', 'clock', 'webhookSecret', 'webhookToleranceMs'];
    for (const forbidden of ['allowLive', 'force', 'skipKeyCheck', 'unsafe', 'production']) {
      expect(options).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// Webhooks
// ===========================================================================

describe('the webhook receiver', () => {
  const secret = 'whsec_test_1234';
  const receiver = () => new WebhookReceiver({ secret, clock: new VirtualClock() });

  const bodyFor = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: 'evt_live_1',
      kind: 'payout.processed',
      railRef: 'pout_live_1',
      ts: 1_760_000_000_000,
      ...overrides,
    });

  it('accepts a correctly signed delivery', () => {
    const r = receiver();
    const body = bodyFor();
    const outcome = r.accept(body, r.sign(body));

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.event.railRef).toBe('pout_live_1');
  });

  it('rejects a tampered body', () => {
    // The gate condition. The signature was valid for the original body.
    const r = receiver();
    const original = bodyFor();
    const signature = r.sign(original);
    const tampered = original.replace('pout_live_1', 'pout_attacker');

    const outcome = r.accept(tampered, signature);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('bad_signature');
  });

  it('rejects a tampered signature', () => {
    const r = receiver();
    const body = bodyFor();
    const signature = r.sign(body);

    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    expect(flipped).not.toBe(signature);
    expect(r.accept(body, flipped).ok).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(receiver().accept(bodyFor(), undefined).ok).toBe(false);
    expect(receiver().accept(bodyFor(), '   ').ok).toBe(false);
  });

  it('gives the same reason whether the signature is the wrong length or wrong', () => {
    // Distinguishing them tells an attacker which half to work on.
    const r = receiver();
    const body = bodyFor();

    const short = r.accept(body, 'abc');
    const wrong = r.accept(body, r.sign('something else'));

    expect(short.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(!short.ok && short.reason).toBe(!wrong.ok && wrong.reason);
  });

  it('verifies the RAW body, not a re-serialised one', () => {
    // Re-serialising before verifying is the classic way to break a signature
    // check: key order and whitespace are not preserved.
    const r = receiver();
    const raw = '{ "id": "evt_1", "kind": "payout.processed", "ts": 1760000000000 }';
    const signature = r.sign(raw);
    const reserialised = JSON.stringify(JSON.parse(raw));

    expect(r.accept(raw, signature).ok).toBe(true);
    expect(reserialised).not.toBe(raw);
  });

  it('accepts a redelivery and labels it, rather than rejecting it', () => {
    // At-least-once is the normal guarantee. A redelivery is not an attack -
    // and corpus family D1 is about an agent that charges twice on the second.
    const r = receiver();
    const body = bodyFor();
    const signature = r.sign(body);

    const first = r.accept(body, signature);
    const second = r.accept(body, signature);

    expect(first.ok && first.redelivery).toBe(false);
    expect(second.ok && second.redelivery).toBe(true);
    expect(second.ok && second.event.deliveryIndex).toBe(1);
  });

  it('flags an out-of-order delivery rather than dropping it', () => {
    // Providers make no ordering promise. Dropping the older event would be
    // inventing an ordering that was never offered.
    const r = receiver();
    const newer = bodyFor({ id: 'evt_2', ts: 1_760_000_005_000 });
    const older = bodyFor({ id: 'evt_3', ts: 1_760_000_001_000 });

    expect(r.accept(newer, r.sign(newer)).ok).toBe(true);
    const stale = r.accept(older, r.sign(older));

    expect(stale.ok).toBe(true);
    expect(stale.ok && stale.stale).toBe(true);
  });

  it('rejects a correctly signed delivery that is far too old', () => {
    // A replay of a captured request, which is different from a provider's own
    // redelivery.
    const clock = new VirtualClock();
    const r = new WebhookReceiver({ secret, clock, toleranceMs: 1000 });
    const body = bodyFor({ ts: clock.now() });

    clock.advance(60_000);
    const outcome = r.accept(body, r.sign(body));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('stale_timestamp');
  });

  it('rejects a signed body that is not JSON, and says the signature was fine', () => {
    const r = receiver();
    const outcome = r.accept('not json', r.sign('not json'));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('malformed_body');
    expect(!outcome.ok && outcome.detail).toMatch(/Signature verified/);
  });

  it('marks a real provider event synthetic: false', () => {
    // The mock rail marks its own events `synthetic: true`. The dashboard's
    // SYNTHETIC badge reads this field, not the documentation.
    const r = receiver();
    const body = bodyFor();
    const outcome = r.accept(body, r.sign(body));

    expect(outcome.ok && outcome.event.payload['synthetic']).toBe(false);
  });

  it('refuses to exist without a secret', () => {
    expect(() => new WebhookReceiver({ secret: '', clock: new VirtualClock() })).toThrow(
      /signing secret/,
    );
  });
});

// ===========================================================================
// Bounded fallbacks on every failure mode
// ===========================================================================

describe('the REST transport', () => {
  it('maps a 2xx with an id to success', async () => {
    const outcome = await restClient().execute(req());
    expect(outcome).toEqual({ ok: true, ref: 'pout_live_1' });
  });

  it('treats a 2xx with no id as ambiguous, not as failure', async () => {
    // Something exists at the provider and we cannot name it. That is worse
    // than a failure, not better.
    const outcome = await restClient({ fetchImpl: fakeFetch({ status: 'created' }) }).execute(
      req(),
    );

    expect(outcome).toMatchObject({ ok: false, code: 'malformed_response', ambiguous: true });
  });

  it('retries a rate limit a bounded number of times', async () => {
    const fetchImpl = fakeFetch({ error: { code: 'rate_limited' } }, 429);
    const outcome = await restClient({ fetchImpl, maxRetries: 2 }).execute(req());

    expect(outcome).toMatchObject({ ok: false, retryable: true });
    expect(fetchImpl.calls).toHaveLength(3); // one attempt plus exactly two retries
  });

  it('does not retry a 400', async () => {
    // Retrying a malformed request repeats the same mistake.
    const fetchImpl = fakeFetch({ error: { code: 'invalid_request' } }, 400);
    const outcome = await restClient({ fetchImpl }).execute(req());

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_request', retryable: false });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('marks a gateway timeout ambiguous', async () => {
    const outcome = await restClient({
      fetchImpl: fakeFetch({}, 504),
      maxRetries: 0,
    }).execute(req());

    expect(outcome).toMatchObject({ ok: false, ambiguous: true, retryable: true });
  });

  it('marks a transport error ambiguous', async () => {
    // The request may have been received. Saying otherwise would be a claim
    // about something never observed.
    const throwing: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    const outcome = await restClient({ fetchImpl: throwing, maxRetries: 0 }).execute(req());

    expect(outcome).toMatchObject({ ok: false, code: 'timeout', ambiguous: true });
  });

  it('tags every created entity with its runKey', async () => {
    // A shared test account accumulates entities from many runs, and without
    // this there is no way to say which run made which.
    const fetchImpl = fakeFetch({ id: 'pout_live_1' });
    await restClient({ fetchImpl }).execute(
      req({
        runKey: 'key_abc',
        seq: 4,
        notes: { adversary_run: 'key_abc', adversary_seq: '4', adversary_synthetic: 'true' },
      }),
    );

    expect((fetchImpl.calls[0]?.body as { notes: Record<string, string> }).notes).toEqual({
      adversary_run: 'key_abc',
      adversary_seq: '4',
      adversary_synthetic: 'true',
    });
  });

  it('sends the idempotency key the agent supplied', async () => {
    const fetchImpl = fakeFetch({ id: 'pout_live_1' });
    await restClient({ fetchImpl }).execute(req({ idempotencyKey: 'renewal-oct' }));

    expect(fetchImpl.calls[0]?.headers['x-payout-idempotency']).toBe('renewal-oct');
  });

  it('routes each money kind to its own endpoint', async () => {
    for (const [kind, path] of [
      ['transfer', '/v1/payouts'],
      ['payment_link', '/v1/payment_links'],
      ['refund', '/v1/refunds'],
      ['subscription_charge', '/v1/subscriptions/charge'],
    ] as const) {
      const fetchImpl = fakeFetch({ id: 'ref' });
      await restClient({ fetchImpl }).execute(req({ kind }));
      expect(fetchImpl.calls[0]?.url, kind).toContain(path);
    }
  });
});

describe('the MCP transport', () => {
  const client = (session: Partial<McpTransport>) =>
    new McpProviderClient({
      keyId: TEST_KEY,
      session: { callTool: async () => ({}), close: async () => undefined, ...session },
    });

  it('maps a tool result with an id to success', async () => {
    const outcome = await client({ callTool: async () => ({ id: 'pout_mcp_1' }) }).execute(
      req(),
    );
    expect(outcome).toEqual({ ok: true, ref: 'pout_mcp_1' });
  });

  it('maps a tool error', async () => {
    const outcome = await client({
      callTool: async () => ({ error: { code: 'insufficient_funds', message: 'no' } }),
    }).execute(req());

    expect(outcome).toMatchObject({ ok: false, code: 'insufficient_funds', retryable: false });
  });

  it('maps a thrown transport error to the same ambiguity as REST', async () => {
    // "Model-agnostic" and "transport-agnostic" are both claims, and a claim
    // with one implementation behind it is untested.
    const mcp = await client({
      callTool: async () => {
        throw new Error('socket hang up');
      },
    }).execute(req());

    const rest = await restClient({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      maxRetries: 0,
    }).execute(req());

    expect(mcp).toEqual(rest);
  });

  it('passes the idempotency key and the run tag', async () => {
    const callTool = vi.fn(async () => ({ id: 'x' }));
    await client({ callTool }).execute(
      req({
        runKey: 'key_abc',
        idempotencyKey: 'k1',
        notes: { adversary_run: 'key_abc', adversary_seq: '0', adversary_synthetic: 'true' },
      }),
    );

    expect(callTool).toHaveBeenCalledWith(
      'payouts.create',
      expect.objectContaining({
        idempotency_key: 'k1',
        notes: expect.objectContaining({ adversary_run: 'key_abc' }),
      }),
    );
  });

  it('closes its session on close', async () => {
    const close = vi.fn(async () => undefined);
    await client({ close }).close();
    expect(close).toHaveBeenCalled();
  });
});

// ===========================================================================
// The rail
// ===========================================================================

describe('LiveTestRail', () => {
  const build = (execute?: () => Promise<never> | Promise<unknown>) => {
    const close = vi.fn(async () => undefined);
    const rail = new LiveTestRail({
      keyId: TEST_KEY,
      client: {
        transport: 'rest',
        execute: (execute ?? (async () => ({ ok: true, ref: 'pout_live_1' }))) as never,
        close,
      },
      clock: new VirtualClock(),
      webhookSecret: 'whsec_test',
    });
    return { rail, close };
  };

  it('is a live-test rail, and says so', () => {
    // Every number measured on it carries this badge, and it is never
    // aggregated with a mock one.
    expect(build().rail.kind).toBe('live-test');
  });

  it('executes through the injected client', async () => {
    const { rail } = build();
    await rail.provision('key_live_1');

    expect(await rail.execute(action())).toEqual({ result: 'ok', railRef: 'pout_live_1' });
    expect(rail.created).toEqual([{ seq: 0, ref: 'pout_live_1' }]);
  });

  it('surfaces an ambiguous failure as ambiguous', async () => {
    // Corpus family D2 is about what an agent does when it cannot tell whether
    // the money moved. A rail that resolved that for it would delete the
    // scenario.
    const { rail } = build(async () => ({
      ok: false,
      code: 'timeout',
      message: 'gone',
      retryable: true,
      ambiguous: true,
    }));

    expect(await rail.execute(action())).toEqual({
      result: 'failed',
      railError: 'timeout:ambiguous',
      retryable: true,
    });
  });

  it('queues a verified webhook and delivers it on flush', async () => {
    const { rail } = build();
    await rail.provision('key_live_1');

    const body = JSON.stringify({ id: 'evt_1', kind: 'payout.processed', railRef: 'pout_live_1', ts: 1_760_000_000_000 });
    const seen: string[] = [];
    rail.onWebhook((e) => seen.push(e.id));

    expect(rail.receiveWebhook(body, rail.signWebhook(body)).ok).toBe(true);
    expect(rail.flushWebhooks()).toHaveLength(1);
    expect(seen).toEqual(['evt_1']);
  });

  it('queues nothing for a tampered delivery', async () => {
    const { rail } = build();
    await rail.provision('key_live_1');

    const body = JSON.stringify({ id: 'evt_1', ts: 1_760_000_000_000 });
    expect(rail.receiveWebhook(body, 'not-a-signature').ok).toBe(false);
    expect(rail.flushWebhooks()).toEqual([]);
  });

  it('closes the provider client on teardown', async () => {
    const { rail, close } = build();
    await rail.provision('key_live_1');
    await rail.teardown('key_live_1');

    expect(close).toHaveBeenCalled();
    expect(rail.provisionedFor).toBeNull();
  });

  it('reports which transport is in play', () => {
    expect(build().rail.transport).toBe('rest');
  });
});
