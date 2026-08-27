# Threat model and safety boundary

## What this project is

Adversary is a **defensive** security-testing tool. Every scenario in the corpus
is a test fixture executed against the operator's own agent, inside a sandbox,
against a payment provider's **test mode**. It is the same category of thing as
a fuzzing corpus or a web-application security test suite: a set of inputs whose
purpose is to find out whether a system you own behaves the way you believe it
does.

It exists because AI agents are being given payment authority, every such
deployment carries a policy — a spend cap, an approved-payee list, a retry
limit, a human-approval threshold — and there is no standard way to test whether
the agent honours it.

## What it is not

It is not a tool for attacking anyone else's system. There is no target-host
parameter anywhere in the configuration schema, and adding one would be a change
to the nature of the project rather than a feature.

It is not a better payment agent. The reference agents are test fixtures and are
deliberately unremarkable.

## The five hard constraints

Each of these is enforced by the code rather than by convention, and each names
where.

### 1. Test mode only

The live rail refuses to initialise on anything other than a recognised
test-mode key, and it **throws at construction** — a misconfigured rail cannot
exist as an object, so there is no window in which one sits in a variable
waiting to be called.

The check runs in three places: `RestProviderClient`, `McpProviderClient`, and
`LiveTestRail` itself. The third is redundant with the other two on purpose,
because a caller who supplies their own `ProviderClient` would otherwise skip
the check entirely.

It **fails closed**. A key matching no known test pattern is refused, not
assumed safe: the cost of being wrong in the other direction is moving real
money, and "we did not recognise the format" is not evidence of safety. Adding
a provider's test prefix is a deliberate edit to `TEST_KEY_PATTERNS`.

There is **no bypass** — no flag, no environment variable, no options field.
A test asserts that none of `allowLive`, `force`, `skipKeyCheck`, `unsafe` or
`production` appears in the rail's options.

> `packages/rails/src/live/test-key.ts`

### 2. No third-party targets

Nothing in this repository may point at a system the operator does not own.
There is no target-host parameter in the scenario schema, the config schema, or
the CLI. The system under test is always locally instantiated through the
`PaymentAgent` interface: the operator supplies the agent, in their own process.

> `packages/core/src/contracts.ts` — `PaymentAgent`

### 3. Attack payloads are generic and documented

The corpus encodes publicly-documented failure classes of tool-using agents:
payee substitution, indirect prompt injection, limit evasion, idempotency abuse,
stop-rule violation, confused-deputy scope escalation, data handling. Every
scenario carries a comment explaining the class it belongs to and why it is
plausible.

No payload is tuned to defeat a specific named commercial product. A test also
asserts that the `Ops` reference prompt names no attack technique and no surface
to distrust — a prompt tuned against the corpus would make the corpus measure
the prompt.

> `scenarios/`, `packages/agents/src/__tests__/agents.test.ts`

### 4. Synthetic fixtures only

All vendors, customers, invoices, subscriptions and account identifiers are
obviously fake: `acct_vendor_acme`, `inv_00417`, `cust_0007`. No real-looking
bank identifiers, no plausible business identities, no real personal details.

Asserted rather than trusted. `tests/corpus.test.ts` scans every scenario for
account-number, IFSC, IBAN and card-number shapes and fails if one appears,
because a fixture set that drifted toward realism would be a genuine problem
rather than a stylistic one.

Entities created on a live test rail are tagged with the run that created them
(`adversary_run`, `adversary_synthetic`) so a shared test account can be traced
and cleaned up.

> `fixtures/`, `tests/corpus.test.ts`

### 5. The boundary is documented

This file. Also `docs/LIMITATIONS.md`, which states every known gap, including
the ones that make parts of this document less verified than they sound.

## Synthetic data must be visible in the interface

Any scenario that uses a manufactured webhook — disputes and chargebacks cannot
be created in a provider's test mode — carries `synthetic: true` in the event
payload itself, and the dashboard renders its SYNTHETIC badge from that field.

A reader looking at a dispute trajectory must be able to see that the dispute
was manufactured *without having read this document first*. Putting that
distinction only in prose would mean the interface was quietly lying to anyone
who skipped it.

> `packages/rails/src/mock/mock-rail.ts` (`synthetic: true`),
> `packages/rails/src/live/webhook.ts` (`synthetic: false`)

## If an instruction would cross one of these

Stop and raise it. None of the five is a default to be overridden by a
sufficiently good reason.
