# 0007. Never feed raw corpora to the synthesis tier

Date: 2026-10-04
Status: accepted

## Context

The obvious way to build "an AI that knows your relationships" is retrieval over raw mail: when someone asks a question, embed it, pull the top chunks from the inbox, and send them to the best model available. It works in a demo. It is also the most expensive possible design, because cost scales with the number of questions, and in an agent-heavy organization questions are asked by agents, constantly.

Rough numbers for that design, per user: an agent question pulls about 50,000 tokens of mail context into a frontier model at around $3 per million input tokens, so about $0.15 per question. A person asks a handful of questions a day. Agents preparing meetings, drafting replies and checking deal status ask hundreds. At 200 questions a day that is $30 per user per day, about $900 per user per month, and a 100-person company crosses $1M a year.

The alternative is to pay for understanding once, when an event arrives, and answer questions from the compressed result.

## Decision

The `synthesize` tier sees facts, entity summaries and short excerpts, never raw event text from more than one event at a time. Questions are answered from facts. Model spend scales with events ingested, not with questions asked.

The processing tiers and their expected monthly cost for one active user (about 3,000 inbound events a month, about 1,000 surviving the deterministic filter):

| Stage | Volume / month | Unit cost | Monthly |
|---|---|---|---|
| Deterministic filter and resolve | ~3,000 events | $0 | $0 |
| Triage (small model) | ~1,000 events | $0.0004 to $0.001 | $0.40 to $1.00 |
| Extract (frontier or mid, ~30% of triaged) | ~300 events | $0.005 to $0.012 | $1.50 to $3.60 |
| Synthesize (one ranking call per day) | ~30 calls | $0.02 to $0.05 | $0.60 to $1.50 |
| Embed (optional) | facts and summaries | | $0 to $0.40 |
| **Total, hosted models** | | | **~$2.50 to $6.50** |

On self-hosted open-weight models the marginal cost of triage and extract is near zero; the synthesis call is the only hosted spend if the user wants one.

Specifics:

- AGENTS.md rule 5: any code path that sends raw text of more than one event to `synthesize` needs its own ADR.
- `context:build` assembles a token-budgeted bundle from facts with provenance. Quotes are the excerpts already stored on facts.
- If a question cannot be answered from facts, the fix is a new extractor or view, not a corpus lookup.
- The router's `monthlyBudgetUsd` enforces a ceiling, and `yrm doctor` prints the projected cost per tier.

## Consequences

Easier: cost is predictable per user and bounded by budget config. Answers carry provenance because they come from facts. Agents can query as often as they like.

Harder: answer quality depends on extraction coverage. A question about something no extractor captured gets "no facts" instead of a plausible guess from raw text. We treat those gaps as extractor bugs. Backfilling a new view or extractor across history costs extract-tier money once per event, which for a large history can be tens of dollars; batch APIs reduce it.

Given up: open-ended questions over everything ever said ("what was the tone of our early conversations with Acme"). An explicit, user-initiated deep read of one thread is allowed on the `extract` tier; a deep read of the whole corpus is not a feature.

The figures above are estimates from current public prices and an assumed mail volume. The `model_calls` table will give us measured numbers; this ADR should be revised when it does.

## Alternatives considered

- **RAG over raw mail per question.** Best recall on day one, cost grows with agent usage without bound.
- **Frontier model on every event.** No triage stage; roughly triples extraction cost for little gain on bulk and routine mail.
