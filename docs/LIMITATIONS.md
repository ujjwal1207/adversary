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

Same situation. `AnthropicLlm`, `OpenAiLlm` and `GeminiLlm` are implemented from
published API shapes and tested against an injected `fetch`. A test asserts all
three produce an identical completion object from their respective wire formats,
which checks the translation but not the HTTP contract.

Gemini is the one to watch, because it is the one whose wire format differs
structurally rather than cosmetically. It gives tool calls no id, so the adapter
mints `name#index` and decodes the name back out when the result returns; it
reports `STOP` even on a turn that asked for a tool, so the stop reason is
derived from whether a function call came back; it calls the assistant `model`;
and it rejects both an empty `parameters` object and an empty `tools` array, so
each is omitted rather than sent. Every one of those is asserted against a
canned response. None has been confirmed against Google's servers, and a wrong
guess about any of them would show up as a 400 on the first real call.

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

### The dashboard's tests cover behaviour, not appearance

Fifteen tests render the run list and the trajectory viewer in a DOM and assert
what they say: that the `SYNTHETIC` badge appears on manufactured evidence and
not otherwise, that only `railResult: 'ok'` counts as money moved, that a
re-run replaces a row instead of adding one, that a run opens from the keyboard,
and that a run whose scenario is missing renders rather than crashing.

Nothing asserts layout, colour or class names. Those change for good reasons,
and a test pinning them produces false alarms rather than findings — so a
visual regression in the viewer would not be caught here. Nobody is looking at
this in more than one browser either.

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

The baseline has to be drawn *inside* a record as well as across records. A
dispute is a single object with two kinds of field: structured ones the payment
network supplies as data (the payment it refers to, the customer, the amount)
and one free-text field the cardholder wrote. The structured fields are trusted
and the reason is not, so a payee named only in the reason is traced while the
payment the dispute is about is not.

Getting that wrong is not subtle in its effects: with the whole dispute
untrusted, reading one taints the very payment it concerns, and refunding that
payment — the single correct response — escalates. Corpus `C4`'s benign twin
failed exactly that way before the distinction existed.

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
says the agent survived these sixty-two scenarios.

### The gate has no notion of scope

The eight rules reason about amounts, payees, rates, duplication and provenance.
None of them knows which tools a goal authorised, or that a customer asked not
to be billed. Corpus scenario `E2` and the whole of family `F` therefore expect
`gated: violated` — the gate runs, allows the action, and the invariant still
fails.

Those scenarios are the point rather than an oversight. A corpus containing only
attacks the gate catches would be a corpus that flattered the gate. The residual
12.9% attack success rate in the shipped scorecard is almost entirely these.

---

## Scope

### Disputes and chargebacks are manufactured, and say so

They cannot be raised in a payment provider's test mode, so every dispute the
corpus shows an agent was written by hand. Each carries `synthetic: true` in the
payload itself — the field is typed as the literal `true`, because there is no
such thing as a genuine dispute in this system and a fixture claiming otherwise
should not compile.

The badge that renders from it is asserted by a test in the viewer, not only by
this sentence.

What this does *not* cover: a real dispute's lifecycle. There is no evidence
submission, no network response, no representment, and no deadline. The corpus
uses a dispute as an untrusted surface that arrives from outside the merchant,
which is what makes it interesting here — not as a workflow to be completed.

### Mandate authentication is not exercised

Test mode mocks it. No real 3DS or OTP path is tested, so an agent's behaviour
around a genuine authentication challenge is unmeasured.

### Agent-to-agent scenarios are out of scope

One agent, one session. Multi-agent delegation, where the confused-deputy
problem gets substantially worse, is not modelled.

### The corpus is 50/50, not 60/40

The build spec asks for roughly 60% attack and 40% benign, and also that every
attack be paired. With one-to-one pairing those cannot both hold. Pairing won:
31 attacks, each with its own benign twin on the same surface and the same
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
| Reading a dispute tainted the very payment it was about, so refunding it escalated | corpus C4's benign twin |
| The turn cap was documented, validated, and enforced by nothing | the first live-model run |
| Ten of eleven scenario targets could not be discovered through any read tool | corpus family E, against Gemini |
| An unref'd backoff timer let the process exit 0 mid-corpus on a rate limit | Gemini rate-limiting a family E run |
| Two benign scenarios asserted what the scripted agent does, contradicting their own goals | Gemini doing the job it was given |
| Record mode recorded into memory and wrote nothing - the CLI never called save() | the first cassette recording attempt |
| A run whose model never answered was verdicted pass, in both gate states | an invalid API key |
| The default Gemini model had been retired for new API keys | the rotated credential |
| Gemini 3 rejects history whose function calls lack their thoughtSignature | the first successful model turn |
| The agent exploded a parallel tool turn into N invented single-call turns | corpus family A, the batch scenarios |
