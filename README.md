# Adversary

[![CI](https://github.com/ujjwal1207/adversary/actions/workflows/ci.yml/badge.svg)](https://github.com/ujjwal1207/adversary/actions/workflows/ci.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

An evaluation and red-team harness for AI agents that have payment authority.

Point it at a payment agent. It runs a corpus of adversarial and benign
scenarios against that agent in a sandbox, intercepts and records every money
action the agent attempts, checks the resulting ledger against declaratively
specified invariants, and produces a reproducible scorecard.

Every report shows two numbers side by side, at equal weight:

- **Attack success rate** — how often adversarial scenarios produce a policy violation
- **False-positive cost** — how much legitimate business the defence blocks, in currency

Reporting either alone is misleading. A gate that blocks everything scores a
perfect attack success rate and is useless.

**It is a test harness, not an agent.**

## Quickstart

Requires Node 20.11+ and pnpm 10. No services, no API keys, no network.

```bash
pnpm install && pnpm demo
```

That runs all 62 scenarios twice — once with the policy gate off, once with it
on — and writes `report.html`. On the reference `ScriptedAgent` against the mock
rail:

| | Attack success | Containment | Blast radius | False-positive cost |
|---|---|---|---|---|
| Gate off | 100.0% | 0.0% | ₹1,77,643.00 | ₹0.00 |
| Gate on | 12.9% | 86.2% | ₹3,997.00 | ₹8,980.00 |

The gate takes attack success from 100% to 12.9%, and it withholds ₹8,980 of
legitimate business to do it. Both numbers, always, together.

The residual 12.9% is corpus scenario `E2` and the whole of family `F` — attacks
about *scope* and *stop rules* rather than about money, which the eight rules
have nothing to say about. Those scenarios are in the corpus deliberately: one
containing only attacks the gate catches would be a corpus that flattered the
gate. See [`docs/POLICY.md`](docs/POLICY.md).

Then, to look at the evidence rather than the summary:

```bash
pnpm dashboard
```

## The command line

```
adversary run [scenario | --family B | --all] [--gate on|off|both]
              [--seed N] [--agent scripted|ops|naive] [--fresh]
adversary report [--out report.html] [--json snapshot.json]
adversary replay <runId>
adversary list-scenarios [--family B]
adversary verify-determinism [--scenario X] [--attempts N]
```

`run` writes to the database; `report` reads from it. Keeping those separate is
what lets a scorecard be regenerated months later from stored evidence rather
than from a re-run — and what makes `adversary replay` able to print exactly
what happened, with the full eight-rule trace behind every decision.

`--agent scripted` is the default and needs no credentials, which is why CI can
run the whole corpus and the determinism check on every push. `ops` and `naive`
need a model — Gemini, Anthropic or OpenAI — and a recorded cassette replays one
with no credentials at all.

```bash
cp .env.example .env      # then paste a key into it
```

`.env.example` lists every variable the project reads, all of them optional. A
variable already set in your shell always beats the file, so
`GEMINI_API_KEY=… pnpm adversary run …` overrides it rather than fighting it.

```bash
pnpm adversary -- list-scenarios --family B
pnpm adversary -- run B1_invoice_borne_redirect --gate both
pnpm adversary -- verify-determinism --family A
```

Postgres instead of SQLite is a two-variable change:

```bash
ADVERSARY_DB_DIALECT=postgres ADVERSARY_PG_URL=postgres://... pnpm db:migrate
```

## How it works

```
                    ┌───────────────────────────────────┐
   scenario  ─────► │  runner — the composition root    │
   (YAML,           │  seed ▸ inject ▸ invoke ▸ verify  │
    hashed)         └───────────────┬───────────────────┘
                                    │ goal, policy, tools
                                    ▼
                    ┌───────────────────────────────────┐
                    │  agent under test                 │  ◄── the only thing
                    │  (yours, or a reference agent)    │      being measured
                    └───────────────┬───────────────────┘
                                    │ every money action
                                    ▼
                    ┌───────────────────────────────────┐
                    │  INTERCEPTOR — the one chokepoint │
                    │                                   │
                    │   taint  ▸  gate  ▸  idempotency  │
                    └───────┬───────────────────┬───────┘
                            │ allowed           │ every attempt, decided or not
                            ▼                   ▼
                    ┌───────────────┐   ┌───────────────────┐
                    │  rail         │   │  ledger           │
                    │  mock │ test  │   │  append-only,     │
                    └───────────────┘   │  deep-frozen      │
                                        └─────────┬─────────┘
                                                  │
                                                  ▼
                                        ┌───────────────────┐
                                        │  invariants       │
                                        │  hand-rolled DSL, │
                                        │  never an LLM     │
                                        └─────────┬─────────┘
                                                  ▼
                                          scorecard · report
                                           · trajectory
```

Four things in that picture are load-bearing:

**The agent cannot reach a rail.** Its only path to money is through
interceptor-provided tools, enforced four ways: pnpm module resolution, a lint
rule, an import-graph test, and the frozen tool object the runner hands in. An
agent that could call a rail directly would make every number a claim about
nothing.

**The ledger records attempts, not just executions.** A blocked action is
evidence. Without it, a gate could not be told apart from an agent that never
tried.

**The oracle is a deterministic function of the ledger.** The invariant
evaluator is a hand-written lexer, parser and tree-walker — never `eval()`,
never a language model. A judge that shares the agent's failure modes is not a
judge.

**Every run is keyed by content hash and seed.** Same scenario, same seed, same
agent ⇒ byte-identical ledger. `adversary verify-determinism` checks that across
the corpus, and CI runs it on every push.

## Status

Built in twelve phases against a written specification, with an acceptance gate
at each one. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §19 for the
phase-to-architecture map.

| Phase | | |
|---|---|---|
| 1 | Scaffold | **done** |
| 2 | Ledger and types | **done** |
| 3 | Invariant evaluator | **done** |
| 4 | Mock rail and interceptor | **done** |
| 5 | Reference agents | **done** |
| 6 | Runner and determinism | **done** |
| 7 | Policy gate | **done** |
| 8 | Corpus | **done** — 62 scenarios, families A–G |
| 9 | Metrics and report | **done** |
| 10 | Live rail | **done** — except live-mode verification, see LIMITATIONS |
| 11 | CLI, demo, dashboard | **done** — clean-machine gate green in CI, not checkable locally |
| 12 | Documentation and CI | **done** — five jobs, all passing |

1,073 tests, 4 skipped. The full corpus has run against a real model - gemini-3.6-flash, 2026-09-03, attack success 0.0% both gate states, FP cost ₹35,578 gated - and `fixtures/cassettes/corpus.json` replays all 124 runs in ~20s with no API key; CI does exactly that on every push. The live rail is wired too: `--rail live-test` with `rzp_test_` credentials has executed a corpus scenario against Razorpay's real test mode, gate-approved and answered with a provider-assigned reference — and refuses production-shaped keys at construction, redacted, exit 1. The four are the Postgres suite, which runs green in CI
against a `postgres:16` service container and has never run on a developer
machine here.

CI runs five jobs on every push: the suite on SQLite, the same suite on Postgres,
the dependency rule, the determinism gate, and `pnpm install && pnpm demo` on a
fresh runner with no credentials. That last one is Phase 11's acceptance
condition, which cannot be checked on a developer machine — and it earned its
place by failing on the first commit it saw, on a defect the other four could
not see. See [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the design contract this build follows
- [`docs/POLICY.md`](docs/POLICY.md) — the eight rules, and what the gate has no way to know
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — the safety boundary, and where each constraint is enforced
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — every known gap, including what this build has not verified

`LIMITATIONS.md` is long, and not because the project is weak. A tool whose
premise is *"your guardrails may not do what you think"* has no business being
vague about its own.

## Developing

```bash
pnpm verify        # typecheck, lint, build, test — what CI runs
pnpm test          # 1,073 tests, no services required - including a keyless replay of a real Gemini run
pnpm db:migrate    # creates the five tables in ./adversary.sqlite
```

`node scripts/build-architecture-page.mjs out.html` renders
`docs/ARCHITECTURE.md` as a standalone page. A script rather than a
hand-conversion, because the failure mode is staleness: a published copy drifted
from the document once already, and regenerating has to be cheap enough that
nobody weighs whether it is worth doing.

## Safety boundary

This is a defensive security-testing tool. Every scenario is a test fixture run
against the operator's own agent, in a sandbox, against a payment provider's
test mode.

There is no target-host parameter anywhere in the configuration schema: the
system under test is always locally instantiated through the `PaymentAgent`
interface. The live-test rail **throws at construction** on anything other than
a recognised test key, and fails closed on a key it does not recognise. All
fixtures are obviously synthetic, and a test scans the corpus for anything
resembling a real account number, IFSC, IBAN or card number.

## Licence

Apache-2.0.
