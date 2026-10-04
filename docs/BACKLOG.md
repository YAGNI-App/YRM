# Backlog

The issues the Teams work from, grouped by the [first week plan](TEAMS.md#first-week-plan) and everything after it. GitHub is the source of truth for status; this list is the map. Labels and sizes are as filed.

## First week

| # | Issue | Labels | Size |
|---|---|---|---|
| [#18](https://github.com/YAGNI-App/YRM/issues/18) | End the old `works_at` edge when a job change is recorded | area:resolve, ready, demo | S |
| [#28](https://github.com/YAGNI-App/YRM/issues/28) | Add `resolve:eval` and a CI test against ground-truth people | area:resolve, ready | S |
| [#35](https://github.com/YAGNI-App/YRM/issues/35) | Record backfilled facts at the time we received the event | area:core, adr, demo, ready | M |
| [#16](https://github.com/YAGNI-App/YRM/issues/16) | Close fulfilled commitments that are delivered in a new thread | area:extract, ready, demo | M |
| [#25](https://github.com/YAGNI-App/YRM/issues/25) | Show who confirmed, rejected or merged an entity, and when | area:cli, ready | S |
| [#26](https://github.com/YAGNI-App/YRM/issues/26) | Add `attention:dismiss` with snooze, and explain in the web UI | area:rank, demo, ready | S |
| [#31](https://github.com/YAGNI-App/YRM/issues/31) | Add `doctor --spend`: model calls and cost by tier and day | area:providers, ready | S |
| [#32](https://github.com/YAGNI-App/YRM/issues/32) | Measure `yrm_context` bundle quality and add a `context:build` test harness | area:mcp, ready | S |

## Later: ready

| # | Issue | Labels | Size |
|---|---|---|---|
| [#17](https://github.com/YAGNI-App/YRM/issues/17) | Record model extractor scorecards against real routes | area:extract, ready | M |
| [#19](https://github.com/YAGNI-App/YRM/issues/19) | Parse signature blocks into titles and phone identifiers | area:resolve, extension, ready | M |
| [#22](https://github.com/YAGNI-App/YRM/issues/22) | Sync Google Calendar events as meeting events | area:ingest, extension, ready | M |
| [#23](https://github.com/YAGNI-App/YRM/issues/23) | Add a Slack source for channels and DMs | area:ingest, extension, ready | M |
| [#27](https://github.com/YAGNI-App/YRM/issues/27) | Evaluate the model brief against rule-only ranking over 30 days | area:rank, ready | M |
| [#29](https://github.com/YAGNI-App/YRM/issues/29) | Add a second fixture corpus in another industry | area:extract, demo, ready | M |
| [#33](https://github.com/YAGNI-App/YRM/issues/33) | Add authentication for `yrm web` and `serve --http`, with a threat model | area:mcp, adr, ready | M |

## Later: proposals (a person adds `ready` before work starts)

| # | Issue | Labels | Size |
|---|---|---|---|
| [#20](https://github.com/YAGNI-App/YRM/issues/20) | Add a Postgres `Store` behind the shared store test suite | area:core, adr, proposal | L |
| [#21](https://github.com/YAGNI-App/YRM/issues/21) | Push Gmail changes through Pub/Sub instead of polling | area:ingest, extension, proposal | L |
| [#24](https://github.com/YAGNI-App/YRM/issues/24) | Populate natural-language views and add `yrm view define/list` | area:core, adr, proposal | L |
| [#30](https://github.com/YAGNI-App/YRM/issues/30) | Backfill the extract tier through provider batch endpoints | area:providers, proposal | M |
| [#34](https://github.com/YAGNI-App/YRM/issues/34) | Export and import the event log for portability | area:core, proposal | M |
