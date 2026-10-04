# 0002. Treat the event log as the source of truth and entities as projections

Date: 2026-10-04
Status: accepted

## Context

A conventional CRM makes the record the truth. Someone creates a contact, types a title, picks a deal stage, and the database row is what the system knows. The rows drift from reality as soon as people stop typing, and nobody can tell which field came from where.

In YRM almost nothing is typed by hand. People, companies and deals are inferred from mail, calendars and notes. If the inferred rows are the truth, every improvement to the resolver or extractor leaves the old wrong rows behind, and a re-run either duplicates them or overwrites a correction a person made. We need to be able to throw away every derived record and rebuild it from what actually happened.

The closest shipping systems point the same way. Day.ai keeps an entity-attribute-value write log and builds its CRM objects as incrementally maintained projections in Materialize, with a `value_history` that carries confidence and a rule that human overrides outrank model output and never flip back ([Materialize customer story](https://materialize.com/customer-stories/day-ai/)). Lightfield keeps a schema-less core and lets users define fields in natural language, which are then backfilled ([docs](https://docs.lightfield.app/)). "The Log is the Agent" ([arXiv 2605.21997](https://arxiv.org/abs/2605.21997)) argues for the event log as truth with the graph as a projection. Neither Day.ai nor Lightfield is open source.

## Decision

The append-only log of `SourceEvent`s is the only source of truth. Facts (0003), entities, views and the attention queue are all derived from it and can be rebuilt from it.

Specifics:

- Events are immutable and idempotent on `(tenantId, source, externalId)`. Re-delivery returns the existing event.
- The only mutable field on an event is the resolver-owned `participants[].entityId`.
- Entities are proposals. Status moves `proposed → confirmed | rejected | merged` only by human action or a confident rule. That move is itself recorded, so re-ingestion and re-resolution never undo it.
- Human input is an event too. A note, a confirmation or a correction enters the log and produces facts with `origin.kind: "human"`.
- There is no fixed CRM schema. Entities carry identifiers, a name, a status and a summary. Everything else is a fact or a user-defined view.

## Consequences

Easier: replacing an extractor or resolver is safe; we re-derive and compare. Every derived value can point at the events behind it, which is what an agent needs to judge trust. Adding a source never requires a schema change.

Harder: reads need projections. A "list my deals" query cannot be a single table scan unless we maintain a projection for it, and keeping projections fresh is real work that a CRUD app does not have. Rebuilds cost model money if they re-run the extract tier, so extractor version bumps need to be deliberate.

Given up: the simplicity of editing a row. A user who wants to change a company's name does not edit a field; they record a human fact that outranks the derived one. The UI and CLI have to make that feel like editing, or people will not use it.

Storage grows without bound. The log is kept forever by default; retention and deletion for privacy (a person asking to be forgotten) need their own ADR before 0.3, and will mean tombstoning events and rebuilding, not editing them.

## Alternatives considered

- **Records as truth with an activity timeline (the original plan).** Simple, familiar, and the reason CRMs go stale; it cannot absorb better extraction without losing corrections.
- **A graph database as truth.** Natural for relationships, but makes the graph the thing that gets corrupted; we want the graph as a projection.
- **Event sourcing with a stream processor (Materialize, Kafka).** The Day.ai approach; correct, but too much infrastructure for a self-hosted single-user install.
