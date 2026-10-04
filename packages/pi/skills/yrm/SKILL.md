---
name: yrm
description: Answer questions about the user's people, companies, deals, mail threads, commitments and asks from YRM, their relationship record. Use when a prompt names a person, company, email address or thread, asks what is open or overdue, asks what was true or known at a past date, or asks to record something the user learned.
license: Apache-2.0
compatibility: Needs the @yrm/pi extension (in-process tools yrm_*) or YRM's MCP server (tools mcp__yrm__yrm_*).
---

# YRM

YRM keeps an append-only log of the user's mail, meetings and notes, and extracts **facts** from it: who works where, who asked for what, who committed to what and by when, objections, decisions. Every fact cites the event it came from. Answer from facts; do not ask the user to paste mail.

Over MCP the same tools are named `mcp__yrm__yrm_context`, `mcp__yrm__yrm_facts`, and so on.

## Which tool

| Need | Tool |
|---|---|
| A brief on a person, company or thread before replying, meeting or advising | `yrm_context` with `entities` (names, addresses, domains) or `thread` (a subject works) |
| A specific question: a title, an employer, all asks from someone, what changed | `yrm_facts` with `entity`, and `type` or `predicate` to narrow it |
| What needs the user's attention today | `yrm_today` |
| Turning a fragment ("Marc", "northwind") into one entity | `yrm_search_entities` (deferred: find it with tool search) |
| Recording something the user told you | `yrm_record_fact` |

Start with `yrm_context` for open-ended work and `yrm_facts` for exact questions. A `<yrm_context>` section may already be in your system prompt when the user named someone; use it and only call tools for more.

`yrm_facts` is a codemode tool. Call it from a `codemode` script, filter there, and print only the facts that answer the question:

```js
const r = await tools.yrm_facts({ entity: "Marcus Lee", type: "ask" });
return r.facts.filter((f) => !f.validTo).map((f) => `${f.statement} (event ${f.provenance[0]?.eventId})`);
```

## Time: validAt and asOf

Each fact has two time ranges.

- **World time**, `validFrom..validTo`: when it was true. Query it with `validAt`. "Where did Priya work on August 20?" is `validAt: "2026-08-20"`.
- **Belief time**, `recordedAt..retractedAt`: when YRM believed it. Query it with `asOf`. "What did our records say on August 20, before we heard she left?" is `asOf: "2026-08-20"`.

Both default to now. Set both to see exactly what YRM showed at an earlier moment. `includeRetracted: true` returns the full history, including corrected facts.

## Trust and provenance

- Each fact carries `provenance` (event id, speaker, quote, event title and date), `confidence` (0..1, not calibrated) and `origin`.
- Origin ranks **human > model > rule**. A human-origin fact is a correction; prefer it over anything that contradicts it.
- Cite the event when you state a fact the user may want to check: "Marcus asked for Q4 pricing by Friday (event 01J...)."
- When facts conflict or confidence is low, say so instead of picking one silently.

## Recording

Use `yrm_record_fact` only for something the user told you or confirmed. Every fact must rest on an event: pass `eventId` when an existing event says it, otherwise pass `note: { title, text }` with what the user said and YRM records the note first. To correct a fact, pass its id as `supersedes`. The user is asked to approve every write; without an interactive UI, show them the fact and call again with `confirm: true` only after they agree.

Never invent facts, ids or dates. If YRM has nothing, say so.
