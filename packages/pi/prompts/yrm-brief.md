---
description: Morning brief from YRM's attention queue, with reasons and evidence
argument-hint: "[YYYY-MM-DD]"
---
Write my morning brief from YRM.

1. Call `yrm_today` (over MCP: `mcp__yrm__yrm_today`) with `date` set to ${1:-today's date; omit it to use my timezone}.
2. Start with the queue's headline if it has one, then one line saying how many items need me.
3. List the top items, highest score first, at most eight. For each give:
   - the action I should take, in imperative form;
   - the reason, in one sentence I can check;
   - the evidence: the fact statements it rests on, each with its event id, and who it is about.
4. Group items about the same person or company. Mark anything overdue.
5. If an item needs more background, call `yrm_context` for that person or company and add at most two lines.
6. End with anything that looks wrong or stale in the evidence (low confidence, conflicting facts), or say there is none.

Use only what YRM returns. Do not invent items, dates or ids; if the queue is empty, say so.
