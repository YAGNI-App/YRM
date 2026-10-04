# 0008. Record when backfilled facts could first have been known

Date: 2026-10-04
Status: accepted

## Context

ADR 0003 gives every fact a valid time (`validFrom..validTo`, when it was true) and a transaction time (`recordedAt..retractedAt`, when we believed it), and promises that "what did we know on June 3rd" is a query parameter (`asOf`). The store sets `recordedAt` from its clock when it writes the row.

That holds for live sync and fails for the first thing every user does: import their history. A whole mailbox imported in October gets `recordedAt` in October, so `asOf` any earlier date returns nothing. On the Acme corpus, `yrm facts <priya> --as-of 2026-08-20` printed `(no facts)` and `yrm today --as-of 2026-10-03` printed "Nothing needs you today" ([#35](https://github.com/YAGNI-App/YRM/issues/35)). The story's central beat could not be shown: Priya's farewell mail is dated August 14 but was held by Acme's DLP gateway and received on September 3 (`meta.receivedAt`, from the last `Received` header), so her job change was true in August and not known until September.

Graphiti ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)) handles the same problem with a reference time on each episode: edges extracted from an ingested episode are dated from the episode, not from the ingestion run. A person who had the email on September 3 knew it on September 3, regardless of when YRM indexed it.

## Decision

Keep `recordedAt` honest (when this system wrote the row) and add a third time to facts: **`knownAt`**, when the tenant could first have known this, with **`knownUntil`** as its counterpart to `retractedAt`. `asOf` filters on knowledge time.

Specifics:

- `Fact.knownAt` defaults to `recordedAt`. The store clamps it to `recordedAt`: nothing is known before it is written down, so a caller can backdate knowledge but never claim it in the future. Stores always return it; it is optional in the type only so hand-built facts need not repeat it.
- The host sets it. When the pipeline records a fact from an event (extractors, resolvers, `resolve:after` handlers), it defaults `knownAt` to the event's `meta.receivedAt` if that parses as a time, else the event's `occurredAt`, unless the extractor set `knownAt` itself. Extensions do not need to change.
- Live runs know things now. `host.run`, `ingest`, `resolve` and `extract` take `live: true`; `yrm sync` passes it, so facts from sync are known when recorded. `yrm import` does not, and `yrm import --live` forces it for files that really are arriving now.
- Supersedes closures (an ask answered, a commitment kept) are facts from the closing event and get its `knownAt`. The store sets the superseded fact's `knownUntil` to the successor's `knownAt`, and the bridging copy it writes when a successor starts later in world time is known from that same instant. An explicit `retractFact` is a decision made now: `knownUntil = retractedAt`.
- Out of order: imports run in world-time order, but a late-received message can be extracted before messages it was received after. If a successor is known before its predecessor, the predecessor's `knownUntil` is clamped to its own `knownAt` (an empty window, never an inverted one), and the bridging copy uses the same clamped time.
- `FactQuery.asOf` means `knownAt <= asOf AND (knownUntil IS NULL OR knownUntil > asOf)`. `includeRetracted` still ignores it. Migration 2 adds `known_at` (indexed with the tenant) and `known_until`, backfilled from `recorded_at` and `retracted_at`, so existing stores behave exactly as before.

## Consequences

Easier: the time machine works on imported history. On Acme, `facts <priya> --at 2026-08-20 --as-of 2026-08-20` shows her at Acme with no job change and `--as-of 2026-09-05` shows the change dated August 14; `today --as-of` replays a past morning; the web view's "Known by" control means the same thing. `recordedAt` still answers "what did the database contain", for audit and debugging.

Harder: `asOf` now answers "what could the tenant have known", not "what did the database contain". An agent replaying a past decision of YRM's own (what did `today` show on October 5?) gets the knowledge view, which for live data is the same and for imported data includes history imported later. Answering the database question needs a `recordedAt` filter, which no caller needs yet. Any code with the store can backdate `knownAt` (though never later than `recordedAt`); we accept that because store callers are in-process extensions that could equally write the database, and `recordedAt` plus provenance keep it auditable. Knowledge time is only as good as the source's receive time: a mail without `Received` headers falls back to its `Date`, which a sender controls. Facts now carry six timestamps, and the CLI and web view show a `known` time wherever it differs from the recorded day.

Given up: a single belief time. Any code that compared `recordedAt` to mean "when we learned it" (the job-change rule's 30-day window did) must read `knownAt` instead.

## Alternatives considered

- **Overwrite `recordedAt` with the receive time on import (the issue's first candidate).** Fewer fields, but it makes transaction time lie: a row written in October would claim to have existed in September, audits of extractor versions by write time break, and `retractedAt` (set from the clock) could precede `recordedAt`.
- **Do nothing and document that `asOf` only works on live data.** Honest, but the first import is every user's history, and "what did we know then" is the question ADR 0003 exists to answer.
- **A per-event clock injected into the store during import.** The issue's hint; it hides the choice in global state and still rewrites transaction time.
