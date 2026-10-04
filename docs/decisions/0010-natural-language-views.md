# 0010. Store view values as attribute facts and populate them by rule or on the extract tier

Date: 2026-10-04
Status: proposed

## Context

VISION.md promises "views instead of migrations": a field is a sentence ("economic buyer: the person who controls the budget for this deal"), and the host fills it from what it already knows. `ViewDefinition`, `Store.defineView` and `Store.listViews` exist, but nothing populates a view and there is no command to define one (#24).

Three questions need an answer before code: where a view's values live, how they are computed (and at what cost), and what happens when a person disagrees with the computed value. Lightfield, the closest precedent, gives each CRM attribute a natural-language definition describing what it represents and how it is populated, and backfills it with a model. We want the same ergonomics without a second storage model and without weakening the guarantees facts already carry.

## Decision

A view value is an ordinary `attribute` fact with `predicate: "view.<name>"` about the entity, populated either by a rule function or by the `extract` tier, recorded by `@yrm/ext-views`.

**Storage.** Values are facts, not a projection table. They get provenance, confidence, bi-temporality (`yrm facts --as-of` shows what a view said last week), supersession and the human-beats-model rule for free. A changed value supersedes the previous one; an unchanged value is not recorded again. Facts carry `origin.by: "views"`, `version: "1"` and a `view:<name>` tag. Entity-typed values also set `object`, so the value is a graph edge. Rejected and merged entities and the tenant's own people and organization are skipped.

**Rule views** (`populatedBy: "rule"`) are functions `(entity, members, events, store) => { value, provenance, validFrom } | null`. Two ship built in, defined at startup unless the user dropped them: `last_contact` (date of the last event involving the entity or, for an organization, its people) and `open_items` (count of unanswered asks and open commitments on either side). Other extensions add rules by emitting `{ name, rule }` on the `views:rule` topic of the extension event bus. Rules are free and always run.

**Model views** (`populatedBy: "model"`) make one `extract`-tier call per entity per view. The prompt holds the definition, the entity's name and identifiers, the people the answer may name, up to `settings.views.maxFacts` (default 40) current facts about the entity and its people with their ids, and the newest event texts involving them, newest first, until `settings.views.maxEventTokens` (default 3,000) is spent. The model returns `{ value, confidence, evidence, quote }`; `evidence` must cite event ids or fact ids it was shown (fact ids map to their provenance events), or the answer is rejected. Values are validated against `valueType` (enum membership, ISO dates, numbers, booleans; entity names, ids or addresses resolved to an entity, preferring the people shown). Confidence is capped at 0.9. Model views never use the `synthesize` tier, so ADR 0007 holds: the extract tier sees a bounded slice of one entity's events, not a corpus.

**When values are computed.** On demand, with `yrm view backfill <name> [--limit N] [--dry-run]`; the dry run prints the number of calls, estimated tokens and cost from the router's price for the extract route. Incrementally, entities touched during a run (`resolve:after`, `fact:recorded`) are recomputed once each, plus their organization, when the host stops: debounce is "once per entity per run". `settings.views.incremental` is `"all"` (default), `"rules"` or `"off"`. On `NO_ROUTE`, `BUDGET_EXCEEDED`, `ALL_ROUTES_FAILED` and similar router errors the engine logs once and skips model views for the rest of the run; rule views still run. The reason is kept per entity and view in kv so `yrm view show`, `yrm_views` and the web page say why a value is missing.

**Cost.** One call per entity per model view: about 1,500 to 4,500 input and at most 300 output tokens. On a mid-tier hosted model that is roughly $0.005 to $0.02 per value; 200 organizations times 4 model views is about $4 to $16 for a backfill, and incremental runs only pay for organizations whose facts changed. On a local model it is free. The dry run shows the estimate before anything is spent.

**Human values.** `yrm view set <entity> <name> <value>` appends a note event (source `views`) saying who set what, then records a human-origin fact citing it with confidence 1, superseding any model or rule value. The store refuses to let a model or rule fact supersede it and caps any competing model fact below 0.5; the engine also stops recomputing a model view once a human holds it, so a held value costs nothing.

**Definitions.** `yrm view define` validates names (snake_case), kinds, types and enums and refuses duplicates without `--force`. Definitions can also live in `settings.views.definitions` and are applied idempotently at `host:start`. `yrm view drop` removes the definition and keeps every fact; they stay visible in `yrm facts` and `view show` lists them as "(no definition)".

## Consequences

- Views need no new tables and no contract change. Every value can be traced to the events behind it and audited in time.
- Two contract gaps are worked around inside the extension and should get their own contract PRs: `Store` has no `dropView`, so drops are tombstones in kv that every reader honours; and `ViewDefinition.appliesTo` is a single kind, so multi-kind views are written as a comma list (`"person,organization"`), which is still a valid `EntityKind` string. The fix is `appliesTo: EntityKind | EntityKind[]` plus `Store.dropView`.
- View facts sit in the same table as extracted facts. Readers that count "facts recorded by the pipeline" must exclude `view.*` (the Acme import test does). Hosts that render facts show view values in the timeline too; that is deliberate.
- Incremental recomputation at host stop means a long-running host only updates views when it stops or when someone backfills. Nothing runs the pipeline continuously today; when something does, it should call the same `recompute` on a schedule.
- Model views read raw event text on the extract tier. The budget bounds it per entity, but a tenant with 200 organizations and four model views sends up to 2.4M tokens of mail to the extract route on a full backfill. Tenants who want facts only can set `maxEventTokens: 0`.
- Small local models get a short, explicit JSON prompt and a schema. If they cite nothing, the answer is dropped rather than guessed, so views stay empty more often than they are wrong.

## Alternatives considered

- **A `view_values` projection table.** Faster to read, but it would need its own provenance, history and human-override rules, duplicating what facts already do.
- **Compute views on read.** Every agent question would pay for a model call, which is exactly what ADR 0007 rules out.
- **Model views from facts only.** Cheaper and cleaner, but facts today rarely say "X controls the budget" directly; a bounded window of recent text makes the first useful answer possible. The budget setting keeps the facts-only option.
- **Run model views on the `synthesize` tier for quality.** It would feed raw text from many events to the expensive tier; ADR 0007 forbids it.
- **Recompute after every fact.** One extract call per fact recorded during an import is the cost profile we are trying to avoid; once per entity per run gives the same final values.
