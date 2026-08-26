# Adversary

An evaluation and red-team harness for AI agents that have payment authority.

Point it at a payment agent. It runs a corpus of adversarial and benign
scenarios against that agent in a sandbox, intercepts and records every money
action the agent attempts, checks the resulting ledger against declaratively
specified invariants, and produces a reproducible scorecard.

Every report shows two numbers side by side, at equal weight:

- **Attack success rate** - how often adversarial scenarios produce a policy violation
- **False-positive cost** - how much legitimate business the defence blocks, in currency

Reporting either alone is misleading. A gate that blocks everything scores a
perfect attack success rate and is useless.

**It is a test harness, not an agent.**

## Status

Under construction, built in twelve phases against a written specification with
an acceptance gate at each one. See `docs/ARCHITECTURE.md` section 19 for the
phase-to-architecture map.

| Phase | | |
|---|---|---|
| 1 | Scaffold | **done** |
| 2 | Ledger and types | **done** |
| 3 | Invariant evaluator | **done** |
| 4 | Mock rail and interceptor | **done** |
| 5 | Reference agents | **done** |
| 6 | Runner and determinism | **done** |
| 7 | Policy gate | not started |
| 8 | Corpus | not started |
| 9 | Metrics and report | not started |
| 10 | Live rail | not started |
| 11 | CLI, demo, dashboard | not started |
| 12 | Documentation and CI | not started |

Nothing here runs a scenario yet. `pnpm demo` arrives in Phase 11.

## Running what exists

Requires Node 20.11+ and pnpm 10. No services, no API keys.

```bash
pnpm install
pnpm verify        # typecheck, lint, build, test
pnpm db:migrate    # creates the five tables in ./adversary.sqlite
```

Postgres instead of SQLite is a two-variable change:

```bash
ADVERSARY_DB_DIALECT=postgres ADVERSARY_PG_URL=postgres://... pnpm db:migrate
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - the design contract this build follows
- `docs/THREAT-MODEL.md` - Phase 12
- `docs/POLICY.md` - Phase 12
- `docs/LIMITATIONS.md` - Phase 12

## Safety boundary

This is a defensive security-testing tool. Every scenario is a test fixture run
against the operator's own agent, in a sandbox, against a payment provider's
test mode. There is no target-host parameter anywhere in the configuration
schema: the system under test is always locally instantiated through the
`PaymentAgent` interface. The live-test rail refuses to construct on anything
other than a test key. All fixtures are obviously synthetic.

## Licence

Apache-2.0.
