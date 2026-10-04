# @yrm/ext-extract

Turns events into facts: commitments, asks, decisions, objections and roles, each with a verbatim quote, a character span and an origin you can audit. Registers three extractors, an `extract:after` hook and one command. The extension name is `extract`, so every fact it records has `origin.by: "extract"`.

| Extractor | Runs when | Cost per message | Emits |
|---|---|---|---|
| `rule-extractor` v1 | always | $0 | rule facts, confidence 0.5 to 0.7 |
| `model-triage` v1 | a `triage` route is configured | ~$0.0004 to $0.001 (small model, 200 output tokens max) | nothing; stores a verdict in kv |
| `model-extractor` v1 | an `extract` route is configured and the event is flagged | ~$0.005 to $0.02 (mid or frontier model, 2,000 output tokens max) | model facts |

The figures are the ones in ADR 0007. With no API keys only the first row runs and the pipeline still records facts (ARCHITECTURE.md, Degradation). On self-hosted models the last two rows cost close to nothing.

## rule-extractor

Splits `content.text` into sentences (`src/sentences.ts`: list items, paragraphs, abbreviations and quoted text handled) and matches patterns per sentence. The subject is the sender (the `from`, `organizer` or `author` participant). A sender without an `entityId` yields no facts; the skip is logged at debug.

- **ask**: ends with `?`, or starts with `can/could/would/will you`, `are you able`, `let me know`, `do you`. Asked of the first self `to` recipient, else the first `to`. `value: { what, askedBy, askedOf, answered: false }`.
- **commitment**: `I will`, `I'll`, `we'll`, `I can`, `will send`, `will have`... plus a resolvable due date. `src/dates.ts` resolves weekdays, `tomorrow`, `EOD`, `end of week`, `next week` (its Friday), `June 5`, `5 June`, `06/05`, ISO and `the 17th` against the event date. A sentence that starts with another participant's first name ("Dana will send...") is that participant's commitment. `value: { what, owedBy, owedTo, dueAt, status: "open" }`.
- **decision**: `we've decided`, `we're going with`, `approved`, `signed off`, `green light`, `let's go with`, `on hold`.
- **objection**: `concern`, `blocker`, `can't proceed`, `not comfortable`, `on hold`, `pause`, `risk`. Severity is `high` for blockers, holds and pauses, else `medium`.
- **role**: an introduction or description of someone on `to`/`cc` with a title ("Marcus is our VP of Operations and owns the budget"). `predicate: "holds_role"`, `value: { role, scope }`.

Every rule fact carries `provenance: [{ eventId, speaker, quote, span }]`, `validFrom: event.occurredAt`, `origin: { kind: "rule", by: "extract", version: "1" }` and a `thread:<threadKey>` tag.

**Closing asks and commitments.** When an event is extracted, open asks in the same thread whose `askedOf` is this event's sender are answered, and open commitments in the same thread owed by the sender are closed:

- reply from the asked party → new ask fact, `answered: true, answeredBy: <event id>`
- owing party writes `attached`, `here is`, `sent`, `done`, `as promised`... → `status: "fulfilled", resolvedBy`
- owing party writes `delayed`, `slipped`, `missed`, `did not get`, `need more time`... after `dueAt` → `status: "broken", resolvedBy` (`dueAt` kept)

Each closure is a new fact with `supersedes` set and `validFrom` at the closing event, so the store keeps the open version valid until then. Candidates come from `ExtractContext.knownFacts` and a direct store query on the thread tag, because `knownFacts` is capped at 50. Human facts are never superseded.

## model-triage

Sends the subject and text to the `triage` tier with `TRIAGE_SCHEMA_V1` and stores the reply at:

```ts
await store.kvGet("extract", "triage:" + eventId)
// { relevant, has: { commitment, ask, decision, objection, signal }, summary, model, version }
```

An event that already has a verdict is never sent again. `NO_ROUTE`, `NO_ELIGIBLE_ROUTE` and `BUDGET_EXCEEDED` are logged once at info and the extractor returns `[]`. `BLOCKED` and `ALL_ROUTES_FAILED` also return `[]`, logged at warn. Anything else is a bug and is rethrown.

## model-extractor

Runs on events whose triage verdict has any `has.*` flag set. With no triage route it runs on events the rule extractor would find something in. The prompt (`src/prompts.ts`, `EXTRACT_SYSTEM_V1`) explains the fact types in the contract's own words, the meaning of `validFrom`, and the verbatim-quote rule. The user message lists participants with entity ids and `self` flags, up to ~3k tokens of thread context (oldest first), known facts with ids, and the message.

The reply is validated before anything is recorded:

- `subjectEntityId` must be a participant's entity id, or the fact is dropped. An unknown `objectEntityId` is dropped from the fact.
- `quote` is located with `indexOf`, then with whitespace and quote style normalized. If it cannot be found the fact is kept without a span at 0.7× confidence.
- `supersedes` is kept only if it names a known fact that is not human-origin.
- `origin: { kind: "model", by: "extract", model: <the model that answered>, version: "1" }`.

The `extract:after` hook drops a rule fact when a model fact of the same type and subject quotes an overlapping span, and keeps only one fact per `supersedes` target (human, then model, then rule).

## For rankers: reading the fact shapes

- **Unanswered ask**: `type: "ask"`, `value.answered === false`. `subject` is who asked, `object` / `value.askedOf` who should answer. Age is `validFrom`. Asks of the tenant are those whose `askedOf` entity is self.
- **Overdue commitment**: `type: "commitment"`, `value.status === "open"` and `value.dueAt < today` (`dueAt` is an ISO date). `subject` / `value.owedBy` owes it.
- **Broken commitment**: `value.status === "broken"`, with `value.resolvedBy` the event that reported the miss.

Query with the default `validAt`/`asOf` (now) and superseded versions drop out on their own.

## Evaluating

`extract:eval` scores the facts in the store against a corpus's `ground-truth.json` and prints precision, recall and F1 per type, then the misses and spurious facts with their quotes:

```
yrm extract:eval --corpus fixtures/acme
yrm extract:eval --corpus fixtures/acme --json
```

Matching is on type and subject (ground-truth people resolve through their addresses), plus, for commitments and asks, statement similarity (token Jaccard ≥ 0.3 after stopwords) or a shared evidence event. Following `fixtures/README.md`, an unmatched fact counts as spurious only for decisions, objections, signals, roles, dated commitments and asks that are questions; anything else is noise. The scorer is exported as `scoreFacts(store, groundTruth)`.

`bun test packages/ext-extract` runs the rule extractor over the Acme corpus end to end and prints the scorecard.
