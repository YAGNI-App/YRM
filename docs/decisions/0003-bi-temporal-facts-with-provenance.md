# 0003. Store facts as bi-temporal edges with provenance

Date: 2026-10-04
Status: accepted

## Context

Given an event log as the truth (0002), we need an intermediate layer between raw events and entities: the things we have concluded. "Dana works at Acme." "Sam promised the security review by Friday." "Legal objected to the indemnity clause."

Two kinds of time matter and CRMs conflate them. Dana left Acme in June. We learned it in August. In July, the CRM said she worked at Acme, and anything that acted on that in July acted correctly on what it knew. A CRM with one `updated_at` cannot answer "what did we believe on July 10th" or "when did she actually leave."

Zep's Graphiti ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956)) models agent memory as a bi-temporal knowledge graph: each edge has valid time (when it held in the world) and transaction time (when the system believed it). Contradictions are resolved by closing the old edge, never deleting it, and every edge points at the episode it came from. As far as we can find, no CRM stores relationship data this way. The "context graph" and decision-trace argument ([Foundation Capital](https://foundationcapital.com/ideas/context-graphs-ais-trillion-dollar-opportunity)) is that this traceability is what makes the layer worth having.

## Decision

A fact is an edge `subject -[predicate]-> object | value` with four timestamps, at least one provenance pointer, an origin and a confidence. Facts are never edited or deleted.

Specifics, as in `packages/core/src/contracts/facts.ts`:

- `validFrom` / `validTo`: world time. `recordedAt` / `retractedAt`: belief time.
- `provenance[]`: at least one `eventId`, optionally speaker, verbatim quote and character span into the event's stripped text.
- `origin`: `human | model | rule`, with `by` and `version` (and `model` for model facts), so re-extraction is auditable.
- To change a fact, record a new one that `supersedes` it; the store sets the old one's `retractedAt`. To say something stopped being true, close `validTo`.
- Reconciliation: a human-origin fact outranks model and rule facts on the same subject and predicate, and the store refuses a model or rule fact that would supersede it.
- Queries take `validAt` and `asOf`. Both default to now.
- Commitments, asks, decisions and objections are fact types with structured values, not notes.

## Consequences

Easier: "what did we know on June 3rd" is a query parameter. Every answer an agent gets carries the quote it rests on. A bad extractor version can be found and its facts retracted in one pass. Corrections stick.

Harder: every query has to filter on two time ranges, and indexes must support it. A naive "current facts" query without the temporal filter returns retracted facts, so the store, not callers, must apply defaults. Extractors must produce quotes and spans, which constrains prompts and adds output tokens. Choosing `validFrom` for a fact extracted from a message is often a guess (the message date is when it was said, not when it became true); we accept that and record it as the message's `occurredAt` unless the text says otherwise.

Given up: compact storage. Superseded facts are kept forever. A busy entity accumulates many versions of the same attribute. We expect this to be fine at the scale of one organization's relationships and will measure it. Model confidence values are not calibrated; we use them for thresholds and do not show them as probabilities.

## Alternatives considered

- **Attribute rows with history tables (Day.ai's `value_history`).** Close to this, but uni-temporal; it records when we learned, not when it was true.
- **Uni-temporal facts with only `recordedAt`.** Simpler, but cannot distinguish "left in June" from "we heard in August."
- **Unstructured memory (embeddings over notes).** Cheap to write, impossible to correct, and gives agents nothing to cite.
- **RDF triple store with named graphs.** Expressive, but heavy tooling for a self-hosted install and no native notion of valid time.
