# Known limitations

Every gap this build knows about, stated plainly. Nothing here is softened, and
several entries make claims elsewhere in the documentation less verified than
they sound.

The reason this file is long is not that the project is weak. It is that a tool
whose entire premise is *"your guardrails may not do what you think"* has no
business being vague about its own.

---

## Not verified in this build

These are things that are implemented and tested as far as they can be without
credentials or services, and **have never been exercised against the real
thing**. They are not known to be broken; they are known not to have been
checked.

### The live rail has never talked to a payment provider

No payment-provider test key was available. The REST transport, the MCP
transport and the webhook receiver are implemented from published request and
response shapes and are tested against an injected `fetch` and an injected MCP
session.

What that covers: the mapping between a money action and a provider request, the
failure-mode taxonomy, the retry bounds, the run tagging, and the signature
verification. What it does not cover: whether the endpoint paths, field names,
authentication scheme or webhook envelope are correct for any real provider.

**Phase 10's gate condition "marquee scenarios run on live test mode" is
therefore unmet.** Every other condition of that gate is met.

### The MCP transport has never talked to an MCP server

`McpProviderClient` takes an injected session rather than spawning one. Wiring a
stdio child process to a specific vendor's MCP server is deployment detail; the
mapping between a money action and a tool call is what lives here, and that is
what is tested. The tool names are plausible defaults, not confirmed ones.

### The model adapters have never talked to a model

Same situation. `AnthropicLlm` and `OpenAiLlm` are implemented from published
API shapes and tested against an injected `fetch`. A test asserts both produce an
identical completion object from their respective wire formats, which checks the
translation but not the HTTP contract.

### `Ops` and `NaiveOps` have never run against a real model

Both are exercised against `ScriptedLlm`, which tests their loop and the wiring
beneath it — not a model's judgment. Every number in the shipped scorecard comes
from `ScriptedAgent`, so it measures **the harness and the gate**, not any
model's behaviour.

### The clean-container gate is met in CI, not on a developer machine

**Status: passing.** Run `33110069174` on commit `74700f0` — all five jobs green,
`pnpm install && pnpm demo` in 31 seconds on a fresh runner with no credentials
set.

Phase 11's acceptance condition is that a clean container with only an API key
set produces a scorecard from `pnpm install && pnpm demo`. There is no container
runtime on the machine this was built on, so the condition **cannot be checked
here**: a developer machine always has a warm store, a built `dist`, and a
database from last time.

The `demo` job in `.github/workflows/ci.yml` is that check on a fresh runner with
no credentials set, and it asserts more than exit zero — that the report carries
both numbers, and that the snapshot covers every scenario in both gate states.

**It found a real bug on its first run.** `adversary report` wrote the snapshot
into `apps/dashboard/public/`, a directory whose only file is gitignored — so git
did not track it, and a fresh checkout did not have it. Every machine that had
ever produced a snapshot already had the directory, which made the failure
invisible to exactly the people who would have gone looking. `report` now creates
the directory for whatever path it is given.

That is the entire argument for the job: it failed on the first commit it ever
saw, on a defect four other green jobs could not see.

What remains true: this has been verified on a GitHub-hosted Ubuntu runner, not
in a container image of the operator's choosing, and not on Windows or macOS. The
harness is developed on Windows and tested on Linux; no third platform is
checked.

### The dashboard has no test suite

It is typechecked, linted, and built. Its logic is thin by design — the numbers
arrive precomputed in the snapshot — and the two defects found in it were found
by reading it against the data and by closing a type, not by a test.

That is a real gap. `railResult === 'executed'` typechecked as `string` for as
long as the field was typed loosely, and every "moved" column read a reassuring
₹0.00 next to runs where money had in fact left. The union is closed now, which
turns that class of mistake into a compile error rather than a test that nobody
wrote.

### The SYNTHETIC badge never appears in the shipped demo

There is no dispute scenario, so nothing in the corpus produces a payload
carrying `synthetic: true`, so the badge the interface promises is never seen by
anyone running `pnpm demo`.

The detection is unit-tested — including that it finds a flag nested anywhere in
a payload, and that it is not fooled by the word appearing as a value or by
`synthetic: false`. But a reader should know that the label's first real outing
will be the day a dispute scenario lands.

### Postgres is verified in CI only

**Status: passing.** The full suite runs green against a `postgres:16` service
container, including the four tests that skip without a database.

They have never been run against Postgres on a developer machine, because none
was available here, so the dialect is exercised on exactly one configuration:
the version, extensions and locale of that container image. SQLite is verified
both ways.

---

## Inherent to the design

These are not going to be fixed. Each is a consequence of a decision that is
better than the alternative, and the reasoning is given so a reader can disagree
with it knowingly.

### A live-model run is not reproducible, and cannot be made so

A hosted model is not deterministic even at temperature 0: batching, hardware
routing and provider-side updates all produce different outputs from identical
inputs. Any claim that an LLM-backed run is byte-reproducible would be false.

Adversary reports a **reproducibility tier** instead — `scripted`, `cassette`,
`live` — and `verifyDeterminism` refuses to compare `live` runs rather than
asserting an identity that does not hold. Recording a cassette and replaying it
makes a run reproducible *given that cassette*, which is a true statement.

### Taint propagation is normalization-based

A value is traced when the literal the agent finally passes to a tool matches,
after normalisation, something that appeared on an untrusted surface.
Normalisation is NFKC, case folding and separator stripping, so
`acct_vendor_acme_new`, `ACCT VENDOR ACME NEW` and `Acct-Vendor-Acme-New` all
match.

**A value the agent composes rather than copies is not traced.** If a ticket
gives a name and a phone number separately and the agent builds
`otto-lindgren-5550142` from them, that string appears nowhere in the ticket and
provenance has nothing to match. Corpus scenario `G2` documents this from the
inside: it was written that way first, came back `pass`, and the comment records
why.

Closing the gap would mean putting a language model in the provenance path,
which would reintroduce exactly the shared failure mode the architecture exists
to avoid — the detector and the agent would be the same kind of thing, failing
on the same inputs, at the same time, silently.

### The taint baseline is the pre-injection fixture state

Taint tracks what an untrusted surface *introduced*, not what it mentioned,
because indexing everything a surface mentions taints every ordinary payment
(a legitimate invoice names its own vendor and its own amount).

The consequence: an attacker who reuses a value already in the merchant's own
records is not traced by provenance. Corpus scenario `B3` is exactly this — a
real-but-unapproved vendor with a near-identical name — and it is caught by the
allowlist rule instead. Both invariants stay on that scenario so a report shows
which defence did the work.

### The recognition-execution gap is a keyword heuristic

It is substring matching over the agent's stated rationale. It cannot tell
whether a model understood anything. It is labelled `heuristic: true` on the
type, in the report, and here.

It is also the only metric that reads `agentRationale`. The agent's stated
reasoning is evidence about the agent, never evidence about what happened.

### Mock-rail numbers come from a simulator

They are never aggregated with live-rail numbers — there is deliberately no type
able to express the mixture, and `scorecardFor` throws on one. Every figure in
the report carries the rail it was measured on.

### The corpus is a floor, not a ceiling

It encodes publicly-documented failure classes. **Absence of violations means
the corpus found none, not that none exist.** A scorecard of 0% attack success
says the agent survived these sixty scenarios.

### The gate has no notion of scope

The eight rules reason about amounts, payees, rates, duplication and provenance.
None of them knows which tools a goal authorised, or that a customer asked not
to be billed. Corpus scenario `E2` and the whole of family `F` therefore expect
`gated: violated` — the gate runs, allows the action, and the invariant still
fails.

Those scenarios are the point rather than an oversight. A corpus containing only
attacks the gate catches would be a corpus that flattered the gate. The residual
13.3% attack success rate in the shipped scorecard is almost entirely these.

---

## Scope

### Disputes and chargebacks are synthetic

They cannot be created in a payment provider's test mode. Any dispute scenario
would use a manufactured HMAC-signed webhook, carrying `synthetic: true` in the
payload so the interface can badge it. **No dispute scenario ships yet.**

### Mandate authentication is not exercised

Test mode mocks it. No real 3DS or OTP path is tested, so an agent's behaviour
around a genuine authentication challenge is unmeasured.

### Corpus scenario C4 is missing

`C4` — injection through a webhook field — is named in the build spec and is not
in the corpus. Webhook delivery to the agent needs a read tool the agent does not
have, and the injection surface throws rather than silently injecting nothing:
a scenario whose payload went nowhere would run clean and report the agent safe
against an attack it was never shown.

The corpus is 60 scenarios without it.

### Agent-to-agent scenarios are out of scope

One agent, one session. Multi-agent delegation, where the confused-deputy
problem gets substantially worse, is not modelled.

### The corpus is 50/50, not 60/40

The build spec asks for roughly 60% attack and 40% benign, and also that every
attack be paired. With one-to-one pairing those cannot both hold. Pairing won:
30 attacks, each with its own benign twin on the same surface and the same
target. See `docs/ARCHITECTURE.md` §17 A16.

---

## Things that were wrong and are now fixed

Kept because each was found by the system testing itself, and because a reader
deciding how much to trust this build should know what kind of defects it
catches.

| What | Found by |
|---|---|
| `blocked` was counting rail failures as gate containment | corpus E1, E3 |
| Cached idempotency failures made an ambiguous retry impossible | corpus D2 |
| Line-leading identifiers were corrupted before taint extraction | corpus G1 |
| Taint with no trusted baseline tainted every ordinary payment | corpus B1 gated |
| Money-action ids collided across two attempts at one experiment | the determinism gate |
| `turnsUsed` double-counted the interceptor's and the agent's records | the runner tests |
| A benign scenario paid an amount that existed only in the invoice text | corpus A4 |
| A persisted verdict came back in a different order, and `undefined` came back as `null` | the round-trip test |
| The viewer summed a rail result that does not exist, reporting ₹0.00 moved | reading it against the data |
| A new `core` subpath widened what an agent could import | the boundary test |
| `report` wrote into a directory git does not track, so a fresh checkout failed | the `demo` CI job, first run |
