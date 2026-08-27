# apps/dashboard

A viewer over an evidence snapshot. React, Vite, Tailwind, no component library.

## Running it

```
pnpm demo        # runs the corpus and writes public/snapshot.json
pnpm dashboard   # serves this app at http://localhost:5173
```

## Why it has no backend

The viewer reads `public/snapshot.json`, which `adversary report` writes from the
database. It never queries anything.

That is a safety decision as much as a convenience one. A dashboard that talked
to a live database would need a process listening on a port, and nothing in this
repository opens one. A snapshot can also be attached to a pull request, archived
next to the scorecard it describes, or opened on a machine that has never run the
harness.

The report HTML and the snapshot come out of the same read, so the two can never
be looking at different evidence.

## Three screens

**Scorecard.** Both cards are rendered by one function called twice, which is why
no code path exists that can show effectiveness without cost.

**Runs.** Filterable by family, kind, gate state and verdict. Shows the newest
attempt of each experiment; older attempts stay in the snapshot.

**Trajectory.** Messages and tool calls in order, each money action expanded
where it occurred with the gate decision, the reasons, the rule trace, the taint
records and the rail result. Raw JSON is shown as raw JSON.

## The badges

`SYNTHETIC` is rendered from the snapshot's `synthetic` field, which is computed
by walking the event payloads for `synthetic: true` — never from a hand-written
list of scenarios. A reader looking at a manufactured dispute must be able to see
that it was manufactured without having read `docs/THREAT-MODEL.md` first.

`mock rail · simulated` says plainly that a number came out of a deterministic
simulator rather than a payment provider. Mock and live figures are never
aggregated.
