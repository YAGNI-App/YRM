# @yrm/ext-web

A local web dashboard for YRM. It shows three things a CRM does not:

- **Provenance.** Every fact opens to the exact words in the message it came from, highlighted in place.
- **Bi-temporal truth.** A time machine answers "what was true then" and "what did we know then" as two separate questions.
- **An attention queue with reasons.** Each item says why it is there and lists the facts and messages behind it.

Everything is rendered on the server from the store: TypeScript template functions, one stylesheet and one small script. There is no frontend framework, no bundler, no CDN and no external font. No page calls a model. Ranking for Today can, if a `synthesize` route is configured (see Today, below).

## Run it

```sh
yrm web                      # http://127.0.0.1:7777/
yrm web --port 8080 --open   # pick a port and open a browser
yrm web --host 0.0.0.0       # listen beyond loopback; needs a token (see Security)
```

`settings.web` in `yrm.config.ts` can set `port`, `host` and `principal` (who dashboard actions are attributed to; default `user:<tenant name>`). Flags win. Ctrl-C stops the server.

`yrm serve` stays with `@yrm/ext-mcp`; this extension only adds `web`.

### The host

Ranking, the `entity:confirmed` / `entity:merged` hooks and re-projection after a merge need the YRM host, which `ExtensionAPI` does not expose. The extension gets it the same way `@yrm/ext-mcp` does:

- `createWebExtension({ host })` when the caller has the host at registration time (embedding, tests), or
- `host.events.emit("host:ready", host)` on the extension bus after extensions load (one emit binds both this and the MCP extension).

Without a host the dashboard still works from the store: Today shows the last queue `yrm today` saved (and says so), and confirm/reject/merge write to the store without firing hooks.

To embed it in another process, call `startWebServer({ store, tenantId, log, host, port, hostname, auth })`, where `auth` comes from `loadTokens(store, settings.auth)` in `@yrm/ext-auth`. It returns the `Bun.serve` server, its URL and `stop()`. Without `auth` it binds loopback only and lets every local request through.

## Pages

### Today (`/`)

The attention queue for `?date=YYYY-MM-DD` (default: today in the tenant timezone). Each item shows a thin score bar, the action, the reason, the entities it is about (linked), the due date and the ranker that produced it. **Explain** unfolds the evidence: each fact with its quote, the source message it came from (linked) and the full provenance, plus any events the item cites directly.

The date control re-runs `host.rank(date)` for another day: drag the slider, pick a date, or use the presets. Links from a past day's queue open entities at that day in the time machine. Results are kept per date for the life of the server, so browsing never ranks a day twice; **Re-rank** clears it, and so does any write made from the dashboard. If your config has a `synthesize` route, `@yrm/ext-attention`'s brief ranker makes one model call per ranked date.

Each item has **Snooze a week** and **Done**, which write the same dismissal record `@yrm/ext-mcp`'s `yrm_dismiss` writes.

When the queue is empty the page explains what creates items: unanswered asks, commitments due or overdue, broken promises, open objections, organizations gone quiet, meetings with open items, job changes.

### People (`/people`) and Organizations (`/orgs`)

People are grouped under their organization, with status chips (proposed, confirmed, rejected), identifiers, event and open-item counts and when they were last seen. **Confirm** and **Reject** post and come back to the page. Rejected people fold away at the bottom.

At the top of People, **Possibly the same person** lists the merge suggestions `@yrm/ext-resolve` keeps (read through its `suggestions:<tenant>` index), with the reason, score and a link to the evidence. **Merge** merges the newer entity into the older, clears the suggestion the same way `resolve:merge` does, fires `entity:merged` and re-projects the survivor.

Organizations list their domains, people count and the same actions.

### Entity (`/entity/:id`)

A header with name, kind, status, identifiers, organization and counts, then the time machine, then the **facts timeline**, oldest first. Each fact shows its statement, a type chip, its predicate, its valid range (world time), when YRM recorded it (and retracted it, if it did), confidence and its origin: a small glyph and the words human, model or rule, with the extension and version.

**Provenance** unfolds under each fact: the source message's title, date, sender and thread, and its text with the quoted words wrapped in a highlight. If the extractor gave a character span it is checked against the text; if not, the quote is searched for, first in the new text and then in the stripped quoted history. If it cannot be found, the quote is shown above the message.

Below the facts: the events that involve this entity (for an organization, its people's events), linked to the message and its thread. A merged id opens the surviving entity, with a note.

### Thread (`/thread/:threadKey`) and Event (`/event/:id`)

The conversation in order. Each message shows its participants (linked to their entities, you marked as such), its new text, a collapsed **Quoted and stripped text** section with what the mail ingester removed, and the facts extracted from it, each with its provenance.

### Facts (`/facts?type=&predicate=&q=`)

Every fact true and known now, newest first, filterable by type, predicate (with suggestions) and free text over statements, names and quotes. The time machine applies here too.

## The time machine

Two dates, on the entity page and the facts page:

- **True at** (`validAt`): world time. What was true in the world on that day.
- **Known by** (`asOf`): belief time. What YRM had recorded by the end of that day.

Each has a slider and a date field. The presets are **Now**, **1 month ago** and **3 months ago**, which set both dates. A bare date means the end of that day in the tenant timezone; a full ISO instant also works in the URL. With the time machine on, the page is a plain GET with query parameters, so any view can be bookmarked or shared.

How facts are drawn when it is on:

| Fact | Looks like |
|---|---|
| True at the chosen time and known by then | normal |
| True then, but recorded **after** "known by" | dashed amber border, labelled **not yet known** |
| Known by then, but superseded or retracted before it | struck through, labelled **superseded** or **retracted** |
| Known then, superseded since | normal, with "Believed then; superseded on ..." |
| No longer true, or not yet true, at "true at" | muted, labelled **no longer true** / **not yet true** |

With the time machine off, superseded facts are hidden and counted, with a **Show history** link.

A caveat for imported history: `recordedAt` is when YRM recorded a fact, so after a one-off `yrm import` of months of mail every fact is "known" from the import onwards. "True at" is meaningful immediately; "known by" becomes meaningful as YRM syncs continuously.

## JSON API

The pages and the API build the same objects, so the numbers match.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/today?date=` | the queue with resolved entities and evidence facts (with provenance) |
| GET | `/api/entities?kind=&status=&q=` | entity summaries and open merge suggestions |
| GET | `/api/entity/:id?validAt=&asOf=` | entity, organization, people, facts with their time-machine `state`, events |
| GET | `/api/facts?type=&predicate=&q=&validAt=&asOf=` | facts with provenance |
| GET | `/api/event/:id` | the event, participants with entities, facts citing it |
| GET | `/api/thread/:key` | the thread's events, each as `/api/event` |
| POST | `/api/entity/:id/confirm`, `/api/entity/:id/reject` | the updated entity |
| POST | `/api/merge` `{from, into}` | both entities |
| POST | `/api/dismiss` `{key, until?}` | the dismissal (`until` is a date; omit to dismiss until the ranker stops proposing it) |
| POST | `/api/rank` `{date?}` | clears the cached ranking for that date, or all |

POST bodies are JSON or a form. JSON calls get JSON back; form posts redirect (303) to `next` (a same-site path) or the referring page. Each fact carries `provenance[].location` (`in`, `start`, `end`, `how`) for the highlighted quote.

## Security

Authentication comes from `@yrm/ext-auth` (see its README and [the threat model](../../docs/SECURITY-MODEL.md)):

- **Loopback is trusted by default.** On your own machine `yrm web` needs no setup; requests from 127.0.0.1 or ::1 run as `settings.web.principal` (default `user:<tenant name>`). Set `settings.auth.allowLoopback: false` to require a token for those too, and always do so behind a reverse proxy on the same host.
- **Anything else signs in.** A remote browser is sent to `/login`, which takes a token (from `yrm auth token create` or `settings.auth.tokens`) and sets a `yrm_session` cookie (`HttpOnly`, `SameSite=Strict`, signed with a per-install secret, 12 hours by default). `/logout` clears it. JSON clients can send `Authorization: Bearer <token>` instead; bearer requests skip the CSRF check, which exists for cookies. Unauthenticated page views redirect to `/login`; unauthenticated API calls get 401.
- **Writes need the `write` scope.** Confirm, reject, merge, dismiss and re-rank answer 403 for a read-only token, and are attributed to the token's principal. The footer shows who you are acting as.
- **No token, no LAN.** `yrm web --host 0.0.0.0` refuses to start until at least one token exists, and says how to create one.

What the server does on top of that:

- On a loopback bind, answers only requests whose `Host` is a loopback name (421 otherwise), which defeats DNS rebinding.
- Every POST, sign-in included, must be same-origin (`Origin`, or `Referer` when there is no `Origin`) and carry a CSRF token equal to the `yrm_csrf` cookie (`HttpOnly`, `SameSite=Strict`), in the `x-csrf-token` header or the `_csrf` form field. Pages embed the token in their forms and in `<meta name="csrf-token">`.
- Escapes every value: the only way to put text into a page is through a tagged template that escapes it.
- Sends a strict Content-Security-Policy (`default-src 'none'`, scripts and styles only from itself, no inline script or style), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: same-origin`.

The server speaks plain HTTP. Beyond a trusted LAN, put TLS in front of it.

## What to look at in a demo

With the Acme fixture imported (`yrm import fixtures/acme`) and extraction run:

1. **Today for Oct 3, 2026** (`/?date=2026-10-03`). Open **Explain** on Marcus's unanswered question: the quote is his own words, one click from the message.
2. **Priya Raman.** Her Acme job ends and Northwind begins on the timeline. Set **True at** to July and back to now and watch `works_at` change.
3. **True at Aug 20, known by Sep 1** on Priya. Her August 14 job change was already true; whether it shows as known depends on when YRM recorded it. After a one-off import every fact was recorded at import time, so it all shows dashed amber, "not yet known". The test suite and a continuously synced install show the real difference: the old fact in place, the new one dashed.
4. **A provenance toggle** on any extracted fact: the highlighted span inside the original mail.
5. **People.** The two Tom Fischers and the two Priya Ramans are proposed merges, each with its reason. Merge Tom and watch his facts and events come together.
6. **A thread** (`/thread/...`): new text up front, the quoted history folded away, facts listed under the message they came from.
