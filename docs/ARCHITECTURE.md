# YRM architecture

Status: living document. Decisions behind it are in `decisions/`.

## One paragraph

YRM ingests events from many sources into an append-only log, resolves who was involved, extracts bi-temporal facts with provenance, projects those facts into entities a human can confirm, ranks what deserves attention today, and exposes all of it to agents through MCP. Expensive models see compressed facts, never raw corpora. Everything beyond the log, the store and the extension host is an extension.

## The data model

```
SourceEvent  ──(resolve)──▶  Participant.entityId ──▶ Entity (proposed → confirmed | rejected | merged)
     │
     └──(extract)──▶  Fact { type, subject, predicate, value,
                              validFrom..validTo,        world time
                              knownAt..knownUntil,       belief time (ADR 0008)
                              recordedAt..retractedAt,   when the row was written
                              provenance[eventId, speaker, quote, span],
                              origin{human|model|rule, by, version},
                              supersedes }
                                 │
                                 └──(project)──▶ Entity.summary, Views
                                 └──(rank)─────▶ QueueItem { action, reason, score, evidence }
```

**Events** are immutable and idempotent on `(tenant, source, externalId)`. Ingesters strip quoted text and signatures so `content.text` is only what is new. The stripped text is kept for provenance spans.

**Facts** are edges. `validFrom`/`validTo` say when it was true in the world; `knownAt`/`knownUntil` say when we knew it; `recordedAt`/`retractedAt` say when YRM wrote and closed the row. For live data the last two pairs agree. For imported history `knownAt` comes from the event (when the message was received), so a mailbox imported in October still remembers what was known in June ([ADR 0008](decisions/0008-known-at-for-backfilled-facts.md)). A champion who changed jobs in June that we learned about in August has `validTo: June`, `knownUntil: August` on the old `works_at` fact. Queries take `validAt` and `asOf` (knowledge time) so an agent can ask what was true, and what we knew, at any point.

Facts are never edited. A new fact `supersedes` an old one and the store closes the old one's transaction and knowledge time. **Reconciliation rule:** a `human` origin outranks `model` and `rule` origins on the same subject and predicate, and a human override is never superseded by a model re-deriving the old value. The store enforces this.

**Commitments, asks, decisions and objections are fact types**, not notes. A commitment has parties, a due date, a status and, when resolved, the event that resolved it. This is the "decision trace" idea applied to relationships.

**Entities** are projections. The resolver proposes a person for every address and an organization for every non-freemail domain. Status moves `proposed → confirmed | rejected | merged` only by human action or by a confident rule, and the move is recorded so re-ingestion never undoes it.

**Views** are user-defined fields described in natural language ("the economic buyer for this deal: the person who controls the budget, usually visible from who approves pricing"). The host backfills them from facts. This is how users shape their own schema without migrations. A view value is an `attribute` fact with predicate `view.<name>`, computed by a rule or on the `extract` tier and recorded with provenance like any other fact; `@yrm/ext-views` and ADR 0010 have the details.

## The pipeline

Each stage only sees what the previous stage passed through. Costs are per message, order of magnitude.

| Stage | Who | Cost | What |
|---|---|---|---|
| **Ingest** | source extensions | 0 | Pull from source, normalize to `SourceEvent`, strip quotes, drop bulk mail (`List-Unsubscribe`, `Precedence: bulk`, `noreply@`), emit idempotently. |
| **Resolve** | resolver extensions, priority order | 0 | Headers to entities: address → person, domain → organization, `self` marking. Model-backed resolvers (signature parsing, disambiguation) run last and only on leftovers. |
| **Triage** | `extract` extensions on the `triage` tier | ~$0.001 | Small model: is this relevant, and does it contain a commitment, ask, decision, objection or signal? Output is a few booleans. |
| **Extract** | `extract` extensions on the `extract` tier | ~$0.005–0.02 | Mid or frontier model on flagged events only, with thread context. Emits `NewFact[]` with provenance quotes and spans. |
| **Project** | core | 0 | Rebuild `Entity.summary` and views for touched entities. |
| **Rank** | ranker extensions | 0 then ~$0.05/day | Rule rankers generate candidates from facts (unanswered ask > 2 days, commitment past due, silence > 14 days, meeting tomorrow with open items). A model ranker on the `synthesize` tier re-orders the top N and writes the reasons. One call per tenant per day. |
| **Serve** | MCP, CLI, hooks | 0 | Agents query facts and entities with provenance. The `context:build` hook assembles a token-budgeted bundle for a thread or set of entities. |

Backfill of history runs the same stages through batch endpoints where the provider offers them.

### Degradation

With no API keys configured, ingest, resolve, project and rule-based rank all work. Extract falls back to a rule extractor (regex and heuristics for dates, questions, "I will", "can you") that records facts with `origin.kind: "rule"` and low confidence. The product is useful on day one with zero model spend; models make it good.

## Extensions

Modeled on pi's harness: a minimal core and a typed `ExtensionAPI` that lets a TypeScript module register sources, extractors, resolvers, rankers, providers, commands and tools, and subscribe to hooks at every seam. See `packages/core/src/contracts/extensions.ts` for the full surface.

Loading order: built-ins from `packages/ext-*` and `packages/provider-*`, then packages named in `yrm.config.ts`, then `.yrm/extensions/*.ts` in the project, then `~/.yrm/extensions/*.ts`. Later registrations see earlier ones. Hooks run in load order; a hook that returns a value replaces the subject for the next hook.

Extensions must work in every host mode: CLI, MCP server, embedded in another process. They receive a `Logger` and must not write to stdout.

## Model routing

No code names a model. Extensions ask for a tier. Config maps tiers to ordered fallback chains of `{provider, model}`. Core ships two providers:

- `anthropic`: the Anthropic SDK.
- `openai-compatible`: any `/v1/chat/completions` endpoint. This one covers vLLM, Ollama, llama.cpp, Together, Fireworks, Groq, DeepSeek and OpenRouter. OpenRouter is a `baseUrl`, not a dependency.

The router records usage and cost per call, enforces `maxCostUsd` per request and `monthlyBudgetUsd` per tenant, honors `localOnly`, and fires `model:before` / `model:after` hooks so extensions can log, cache or block.

Default routes for a solo install: `triage` and `extract` on a local open-weight model if one is reachable, else the cheapest configured hosted model; `synthesize` on the best configured model. The CLI's `yrm doctor` prints what each tier resolves to and what a day of typical use would cost.

## Storage

`Store` is the only persistence interface. The SQLite implementation (`bun:sqlite`) is the default and is enough for a person or a small team. Postgres implements the same interface for multi-tenant deployments. Extensions never see SQL and never get a connection.

Tables (SQLite): `events`, `event_participants`, `facts`, `fact_provenance`, `entities`, `entity_identifiers`, `views`, `cursors`, `kv`, `model_calls`. Facts and events have no `UPDATE` path except the resolver-owned `participants[].entityId` and the store-owned `retractedAt`/`validTo` columns.

## Hosts

- **CLI** (`yrm`): `init`, `sync`, `import <path>`, `today`, `who <query>`, `facts <entity>`, `view`, `confirm`, `merge`, `doctor`, `serve`. Commands are extensions; built-ins live in `@yrm/cli`.
- **MCP server** (`yrm serve --mcp`): exposes registered `Tool`s. Reads are auto-approved; writes require confirmation from the host. Every fact returned carries provenance so the calling agent can judge trust.
- **Embedded**: `createHost(config)` returns a host with `store`, `models`, `run(stage)` and `context(request)`. Other agent runtimes (pi, YAGNI, Claude Code) use this or MCP.

## Multi-tenancy

`tenantId` is on every row from day one. A solo install has one tenant, `local`. Nothing in core assumes a single tenant; nothing in 0.1 implements auth. That is an ADR for 0.3.

## What is deliberately not here

- No fixed CRM schema. Entities have identifiers, a name, a status and a summary. Everything else is a fact or a view.
- No free-text notes field. A note is an event; what it says becomes facts.
- No "AI assistant" persona. The system proposes; a person confirms; agents read.
- No per-question retrieval over raw mail. If a question cannot be answered from facts, that is a missing extractor, not a reason to read the corpus.
