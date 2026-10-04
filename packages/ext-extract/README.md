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

- **ask**: ends with `?`, or starts with `can/could/would/will you`, `are you able`, `let me know`, `do you`. It also needs substance: at least four content words, or a `can you <verb> <object>` opening. Pleasantries ("How are you?", "Hope you're well?"), bare check-ins ("Does that work?", "Make sense?") and slot proposals ("Would a call on June 16 work?") are not asks. Asked of the first self `to` recipient, else the first `to`. `value: { what, askedBy, askedOf, answered: false }`.
- **commitment**: `I will`, `I'll`, `we'll`, `I can`, `will send`, `will have`... plus a resolvable due date. `src/dates.ts` resolves weekdays, `tomorrow`, `EOD`, `end of week`, `next week` (its Friday), `June 5`, `5 June`, `06/05`, ISO and `the 17th` against the event date. Not promises: `I'll need/want/wait/watch`, `we'll make a call` / `decide`, and scheduling logistics (`send an invite`, `pencil in`). `value: { what, owedBy, owedTo, dueAt, status: "open" }`. Who owes it:
  - a sentence that starts with another participant's first name ("Dana will send...") is that participant's;
  - one that starts with `she/he/they will` belongs to the participant named most recently in the sentences before it, if that person is on `to`/`cc` (attendees, for notes and meetings): "Rachel Kim in procurement is copied. She'll have the order form back to you by July 17" is Rachel's;
  - a pronoun that cannot be resolved that way stays with the sender at confidence 0.4.
- **decision**: `we've decided`, `we're going with`, `approved`, `signed off`, `green light`, `let's go with`, `on hold`.
- **objection**: `concern`, `blocker`, `can't proceed`, `not comfortable`, `on hold`, `pause`, `risk`. Severity is `high` for blockers, holds and pauses, else `medium`.
- **role**: an introduction or description of someone on `to`/`cc` with a title ("Marcus is our VP of Operations and owns the budget"). `predicate: "holds_role"`, `value: { role, scope }`.

Every rule fact carries `provenance: [{ eventId, speaker, quote, span }]`, `validFrom: event.occurredAt`, `origin: { kind: "rule", by: "extract", version: "1" }` and a `thread:<threadKey>` tag.

**Meetings and notes.** A calendar description is the organizer's agenda, not speech: for `kind: "meeting"` events, commitment, decision and objection patterns count only in sentences with a first-person marker (`I`, `we`, `our`...), and a meeting with `meta.cancelled: true` yields nothing at all ("Cancelled at Marcus's request: the pilot is on hold" is not a new objection). Notes (`kind: "note"`) are the author's own words and are read like mail, with attendees standing in for `to`/`cc` when attributing a promise. The notes source does not yet link its `author` participant to an entity, so on the Acme corpus notes produce no rule facts.

**Closing asks and commitments.** When an event is extracted, open asks and commitments it resolves are closed. In the same thread the thread says what the event is about:

- reply from the asked party → new ask fact, `answered: true, answeredBy: <event id>`
- owing party writes `attached`, `here is`, `sent`, `shared`, `done`, `as promised`, `please find`, `delivered`... → `status: "fulfilled", resolvedBy`
- owing party writes `delayed`, `slipped`, `missed`, `did not get`, `need more time`... after `dueAt` → `status: "broken", resolvedBy` (`dueAt` kept)

Across threads (a proposal sent as a fresh mail, pick data under a new subject) the event must also name the thing. Overlap is token Jaccard on content words, after stopwords and after dropping names, dates and the delivery verbs themselves, taken over the sentence, its clauses, and (for deliveries) the subject line:

- **delivery**: the owing party sends a sentence with delivery language that overlaps the promise's `what` by at least 0.25 (`COMMITMENT_OVERLAP`), to an event the party owed is on → `fulfilled`.
- **receipt**: the party owed writes `thanks for sending`, `got it`, `received`... in a sentence that overlaps the promise by at least 0.25 → `fulfilled`.
- **answer**: the asked party writes, to an event the asker is on, a sentence that overlaps the question by at least 0.35 (`ASK_OVERLAP`) → `answered`.

The closing provenance entry quotes the matching sentence with its span. Each closure is a new fact with `supersedes` set and `validFrom` at the closing event, so the store keeps the open version valid until then. Candidates come from `ExtractContext.knownFacts` plus store queries (the sender's open commitments, commitments owed to the sender and asks put to the sender, valid at the event), because `knownFacts` is capped at 50. Human facts are never superseded.

Known gap: an ask answered in its thread by a promise ("I'll send the report by July 24") is marked answered by that reply rather than by the later delivery (Acme f12).

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

Matching is on type and subject (ground-truth people resolve through their addresses), plus, for commitments and asks, statement similarity (token Jaccard ≥ 0.3 after stopwords) or a shared evidence event, and, for signals, the predicate. Following `fixtures/README.md`, an unmatched fact counts as spurious only for decisions, objections, signals, roles, dated commitments and asks that are questions; anything else is noise. The scorer is exported as `scoreFacts(store, groundTruth)`.

- A ground-truth fact with a `validTo` (Priya's Acme `works_at`) is looked up at the middle of its interval, since a correctly ended edge is not valid now.
- A `possibly_same_person` signal is scored against `people`: correct when both sides are addresses of one person, spurious otherwise.
- The `closure` line counts recalled commitments whose matching facts all carry the ground-truth `status` and `resolvedBy`, and asks whose matching facts all carry `answered` and `answeredBy`. Facts that cite the ground truth's evidence are preferred over ones matched only by wording. Mismatches are listed under "Wrong closures".

`bun test packages/ext-extract` runs the rule extractor over the Acme corpus end to end and prints the scorecard.
