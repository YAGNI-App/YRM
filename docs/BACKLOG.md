# Backlog

The open issues the Teams work from, grouped by the [first week plan](TEAMS.md#first-week-plan) and everything after it. GitHub is the source of truth for status; this list is the map. Labels and sizes are as filed. Closed issues are not listed; the pull request history says what landed.

## First week

| # | Issue | Labels | Size |
|---|---|---|---|
| [#52](https://github.com/YAGNI-App/YRM/issues/52) | Dry-run the release workflow and make the image start on a fresh volume | area:core, demo, proposal | M |
| [#51](https://github.com/YAGNI-App/YRM/issues/51) | Show facts as they stood under `--as-of`, and full history with `--all` | area:cli, demo, proposal | S |
| [#48](https://github.com/YAGNI-App/YRM/issues/48) | Read bare `--at` and `--as-of` dates as end of day in the tenant timezone | area:cli, demo, proposal | S |
| [#53](https://github.com/YAGNI-App/YRM/issues/53) | Let a bearer token override the loopback bypass | area:mcp, adr, proposal | S |
| [#28](https://github.com/YAGNI-App/YRM/issues/28) | Add `resolve:eval` and a CI test against ground-truth people | area:resolve, ready | S |
| [#50](https://github.com/YAGNI-App/YRM/issues/50) | Link the author of a note to the tenant so notes yield facts | area:ingest, demo, proposal | S |
| [#31](https://github.com/YAGNI-App/YRM/issues/31) | Add `doctor --spend`: model calls and cost by tier and day | area:providers, ready | S |
| [#17](https://github.com/YAGNI-App/YRM/issues/17) | Record model extractor scorecards against real routes | area:extract, ready | M |

## Next: ready

| # | Issue | Labels | Size |
|---|---|---|---|
| [#26](https://github.com/YAGNI-App/YRM/issues/26) | Add `attention:dismiss` with snooze, and explain in the web UI | area:rank, demo, ready | S |
| [#25](https://github.com/YAGNI-App/YRM/issues/25) | Show who confirmed, rejected or merged an entity, and when | area:cli, ready | S |
| [#32](https://github.com/YAGNI-App/YRM/issues/32) | Measure `yrm_context` bundle quality and add a `context:build` test harness | area:mcp, ready | S |
| [#27](https://github.com/YAGNI-App/YRM/issues/27) | Evaluate the model brief against rule-only ranking over 30 days | area:rank, ready | M |
| [#29](https://github.com/YAGNI-App/YRM/issues/29) | Add a second fixture corpus in another industry | area:extract, demo, ready | M |
| [#19](https://github.com/YAGNI-App/YRM/issues/19) | Parse signature blocks into titles and phone identifiers | area:resolve, extension, ready | M |
| [#22](https://github.com/YAGNI-App/YRM/issues/22) | Sync Google Calendar events as meeting events | area:ingest, extension, ready | M |

## Later: proposals (a person adds `ready` before work starts)

| # | Issue | Labels | Size |
|---|---|---|---|
| [#49](https://github.com/YAGNI-App/YRM/issues/49) | Add `Store.dropView` and multi-kind `ViewDefinition.appliesTo` | area:core, adr, proposal | S + S |
| [#21](https://github.com/YAGNI-App/YRM/issues/21) | Push Gmail changes through Pub/Sub instead of polling | area:ingest, extension, proposal | L |
| [#30](https://github.com/YAGNI-App/YRM/issues/30) | Backfill the extract tier through provider batch endpoints | area:providers, proposal | M |
| [#34](https://github.com/YAGNI-App/YRM/issues/34) | Export and import the event log for portability | area:core, proposal | M |

The first-week issues still labelled `proposal` need a person to add `ready` before Wright starts them. Issues labelled `adr` (#53, #49) also need a person's answer before code merges (see [Escalation](TEAMS.md#escalation)).
