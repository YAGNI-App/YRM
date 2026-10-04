/** Sent in the MCP initialize response; clients may show it to the model up front. */
export const SERVER_INSTRUCTIONS =
  "YRM is a relationship context layer: an append-only log of events (mail, meetings, notes) and bi-temporal facts extracted from them, " +
  "each with provenance. Prefer facts over raw events. Every fact has validFrom/validTo (when it was true) and recordedAt/retractedAt " +
  "(when YRM believed it); use validAt and asOf on yrm_facts to ask about the past. Check provenance (event, speaker, quote) and origin " +
  "(human > model > rule) before relying on a fact. Write tools need confirm: true after the user approves. Read yrm://story for details.";

/** The yrm://story resource: enough for an agent connecting cold to use the tools well. */
export const STORY_MARKDOWN = `# How to read YRM

YRM is a shared record of relationships that many agents read and write. It is built so you can **judge how much to trust each answer**.

## The data model

- **Events** are the source of truth: messages, meetings, notes. Append-only, never edited. \`content.text\` is only what was new in the event.
- **Facts** are what YRM has concluded from events: \`subject -[predicate]-> object | value\`, plus a one-sentence \`statement\`.
  Types: \`commitment\` (who owes what to whom, by when, status), \`ask\` (answered or not), \`decision\`, \`objection\` (resolved or not),
  \`signal\`, \`role\`, \`relationship\` (works_at, reports_to), \`attribute\` (title, deal stage).
- **Entities** (people, organizations, deals) are projections the system proposes and a person confirms, rejects or merges.
  A person's organization is \`summary.parentId\`.
- **The attention queue** (\`yrm_today\`) ranks what deserves action today, each item with its reason and evidence.

## Two kinds of time

Every fact has four timestamps:

| Field | Meaning |
|---|---|
| \`validFrom\` .. \`validTo\` | **World time**: when it was true. |
| \`recordedAt\` .. \`retractedAt\` | **Belief time**: when YRM believed it. |

Example: a champion left Acme on Aug 14, but the email saying so arrived Sep 3. The old \`works_at Acme\` fact has \`validTo: Aug 14\`
and was retracted on Sep 3.

- \`yrm_facts { validAt: "2026-08-20" }\` answers **"what was true on Aug 20?"** (she had already left).
- \`yrm_facts { asOf: "2026-08-20" }\` answers **"what did we know on Aug 20?"** (our records still said Acme).
- Both default to now. Set both to replay exactly what an agent saw at an earlier moment. \`includeRetracted\` shows every version.

## Provenance and trust

Every fact carries:

- \`provenance[]\`: the \`eventId\` it rests on, the \`speaker\`, a verbatim \`quote\`, and the event's \`title\` and \`date\`.
- \`origin\`: \`human\` (a person confirmed or corrected it), \`model\` (an extractor), or \`rule\` (a heuristic). **Human outranks model and rule**
  and is never overturned by re-extraction.
- \`confidence\`: 0..1. Human facts are 1. Model confidences are not calibrated probabilities; use them to compare, not to quote.

If an answer matters, cite the quote and event date. If a fact looks wrong, read its event (\`yrm_events\`, \`yrm_thread\`) before acting.

## Which tool for which question

| Question | Tool |
|---|---|
| Who is "Marcus"? Which entity is acme-robotics.example? | \`yrm_search_entities\` |
| Everything about this person or company | \`yrm_get_entity\` (or resource \`yrm://entity/{id}\`) |
| Where does Priya work? What did we believe on July 10? | \`yrm_facts\` with \`entityId\`, \`predicate\`, \`validAt\`, \`asOf\` |
| What do we owe Acme? What is overdue? Any unresolved objections? | \`yrm_open_items\` |
| What should I do today? | \`yrm_today\` (or resource \`yrm://today\`) |
| Brief me before I reply to this thread or meet these people | \`yrm_context\` |
| What exactly did they write? | \`yrm_events\`, \`yrm_thread\` (truncated raw text; prefer facts) |

## Writing

Writes are shared with every other agent, so they need the user's approval: call the write tool with \`confirm: true\` only after the user agrees.

- \`yrm_record_note\` appends a note event and returns its \`eventId\`.
- \`yrm_record_fact\` records a human-origin fact. It must cite an \`eventId\`; to record something no event says yet, write a note first and cite it.
  To correct a fact, pass its id as \`supersedes\`; the old version stays in history.
- \`yrm_confirm_entity\`, \`yrm_reject_entity\`, \`yrm_merge_entities\` curate entities.
- \`yrm_dismiss\` hides an item from \`yrm_today\`, optionally until a date.
`;
