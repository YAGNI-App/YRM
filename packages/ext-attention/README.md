# @yrm/ext-attention

The attention queue behind `yrm today`. Eight rule rankers turn facts into candidates at zero model cost, a merge ranker dedupes and sorts them, and an optional model ranker on the `synthesize` tier re-orders the top items and rewrites their reasons. Every item carries the fact and event ids it rests on, and `yrm attention:explain <key>` prints them with provenance.

## Rules

| Rule | Fires when | Score |
|---|---|---|
| `unanswered-ask` | an open `ask` of you is at least `askMinDays` old | 0.5 + min(age/14, 0.4) + 0.1 if the asker holds a `role` |
| `overdue-commitment` | an open `commitment` is past `dueAt` | yours: 0.6 + min(late/7, 0.35); theirs: 0.4 + min(late/14, 0.3) |
| `due-soon` | an open commitment is due within `dueSoonDays` | 0.35 + (3 − days until)/10 |
| `broken-commitment` | a commitment became `broken` within `brokenWithinDays` (valid time) | 0.5 |
| `gone-quiet` | an organization with open items has not written or met with you for `quietDays` | 0.3 + min((days − 14)/30, 0.4) |
| `open-objection` | an unresolved objection of high or medium severity (missing counts as medium) | 0.55 / 0.4 |
| `meeting-prep` | a meeting within `meetingWithinDays` has attendees with open items | 0.45 + 0.05 per item, max 0.7 |
| `job-change` | a `job_change` signal was recorded within `jobChangeWithinDays` and a `works_at` to the old org is still valid | 0.5 |

Keys are `<rule>:<factId>`, or `gone-quiet:<orgId>` and `meeting-prep:<eventId>`. Facts are read as of the end of `today` in both valid and transaction time, so superseded facts (an answered ask, a fulfilled commitment) drop out and ranking a past day shows what was known then.

"Gone quiet" counts only contact from them: mail they sent, meetings that happened. Your own unanswered check-ins do not reset the clock. `summary.lastSeen` is used only for people with no events.

## Settings

`settings.attention` in `yrm.config.ts`. `RankContext` does not carry the tenant config, so the host copies the tenant's identity in here.

| Key | Default | Notes |
|---|---|---|
| `selfAddresses` | `[]` | Your addresses. Their person entities are "you". |
| `selfDomains` | `[]` | Used only if no address matches: people at these domains are "you". Organizations at these domains never go quiet. |
| `timezone` | system | Turns instants into calendar days. |
| `askMinDays` | 2 | |
| `dueSoonDays` | 3 | |
| `brokenWithinDays` | 14 | |
| `quietDays` | 14 | |
| `meetingWithinDays` | 2 | |
| `jobChangeWithinDays` | 30 | |
| `brief` | `true` | Set `false` to never call a model. |
| `briefTopN` | 12 | Items the model sees. |
| `briefMaxCostUsd` | | Ceiling for the brief call. |
| `disable` | `[]` | Rule names to skip. |

## The model brief

Runs only when the `synthesize` tier has a route. It sends the top items' action, reason, names and the statements of their evidence facts; never event text or provenance quotes (ADR 0007). It may change scores and reasons for keys it was given and nothing else. The headline is stored at `kv("attention", "brief:<today>")`. Any router error leaves the rule order in place.

## Helpers

```ts
formatBrief(items: QueueItem[], opts: { today: string; tenantName?: string; headline?: string; width?: number; color?: boolean }): string
queueToMarkdown(items: QueueItem[]): string
```
