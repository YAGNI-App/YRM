import type { DirectoryGroup, EntityPage, EntitySummaryView, EventPage, FactView, MergeSuggestionView, QueueItemView, TodayPage, TimeMachine } from "./data.ts";
import {
  entityActions,
  entityHref,
  entityLink,
  eventHref,
  eventRow,
  factRow,
  identifiers,
  plural,
  postButton,
  provenanceBlock,
  scoreBar,
  statusChip,
  threadHref,
  time,
  timeMachineControl,
  travelOf,
  typeChip,
  type Travel,
  type View,
} from "./components.ts";
import { html, qs, type Html, type Renderable } from "./html.ts";
import { addDays, fmtDay } from "./time.ts";

const NAV: Array<[string, string]> = [
  ["/", "Today"],
  ["/people", "People"],
  ["/orgs", "Organizations"],
  ["/facts", "Facts"],
];

export function layout(v: View, title: string, active: string, body: Renderable): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${v.csrf}">
<title>${title} · YRM</title>
<link rel="stylesheet" href="/static/styles.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">YRM</a>
  <nav>${NAV.map(([href, label]) => html`<a href="${href}"${active === href ? html` aria-current="page"` : ""}>${label}</a>`)}</nav>
</div></header>
<main class="wrap">${body}</main>
<footer class="wrap foot">
  <p>YRM 0.1 dashboard.${v.principal ? html` Acting as <span class="mono">${v.principal}</span>.` : ""}${
    v.session ? html` <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${v.csrf}"><button type="submit" class="btn quiet">Sign out</button></form>` : ""
  }</p>
  <p class="muted">Times shown in ${v.tz}. Every fact links to the message it came from.</p>
</footer>
</body>
</html>`;
}

export function messagePage(v: View, title: string, message: string, status = ""): Html {
  return layout(v, title, "", html`<div class="empty"><h1>${title}</h1><p>${message}</p>${status ? html`<p class="muted mono">${status}</p>` : ""}<p><a href="/">Back to Today</a></p></div>`);
}

// ---- Today --------------------------------------------------------------------

function queueItem(it: QueueItemView, v: View, t: Travel): Html {
  const evidenceCount = it.evidence.facts.length + it.evidence.events.length;
  return html`<li class="item">
  <div class="item-score">${scoreBar(it.score)}</div>
  <div class="item-body">
    <h3 class="action">${it.action}</h3>
    <p class="reason">${it.reason}</p>
    <p class="meta">${it.about.length ? html`about ${it.about.map((a, i) => html`${i > 0 ? ", " : ""}${entityLink(a.entityId, a.name, t)}`)}` : ""}${
      it.dueAt ? html` · <span class="due">due ${time(it.dueAt, v.tz)}</span>` : ""
    } · <span class="muted">${it.by}</span></p>
    <details class="explain"><summary>Explain <span class="muted">· ${plural(it.evidence.facts.length, "fact")}, ${plural(it.evidence.events.length, "other event")}</span></summary>
      ${evidenceCount === 0 ? html`<p class="muted">This item cites no evidence.</p>` : ""}
      ${it.evidence.facts.length ? html`<ul class="evidence">${it.evidence.facts.map((f) => evidenceFact(f, v, t))}</ul>` : ""}
      ${it.evidence.events.length ? html`<ul class="events">${it.evidence.events.map((e) => eventRow(e, v))}</ul>` : ""}
      ${it.evidence.missing.length ? html`<p class="muted small">Not found in the store: <span class="mono">${it.evidence.missing.join(", ")}</span></p>` : ""}
      <p class="muted small mono">key ${it.key}</p>
    </details>
  </div>
  <div class="item-actions">${postButton(v, "/api/dismiss", "Snooze a week", { key: it.key, until: addDays(v.today, 7) }, "quiet")}${postButton(v, "/api/dismiss", "Done", { key: it.key }, "quiet")}</div>
</li>`;
}

function evidenceFact(f: FactView, v: View, t: Travel): Html {
  const first = f.provenance[0];
  return html`<li class="evidence-fact">
  <p>${typeChip(f.type)} ${f.statement} <span class="muted small">(${entityLink(f.subject.entityId, f.subject.name ?? f.subject.entityId, t)})</span></p>
  ${first?.quote ? html`<blockquote class="quote">${first.quote}</blockquote>` : ""}
  <p class="meta muted small">${first?.event ? html`<a href="${eventHref(first.eventId)}">${first.event.title ?? "(untitled)"}</a> · ${time(first.event.occurredAt, v.tz, true)}` : ""} · confidence ${f.confidence.toFixed(2)} · ${f.origin.kind}</p>
  ${provenanceBlock(f, v)}
</li>`;
}

export function todayView(v: View, page: TodayPage): Html {
  const isToday = page.date === v.today;
  // Clicking through from a past queue keeps you in that day.
  const t: Travel = isToday ? {} : { validAt: page.date, asOf: page.date };
  const span = Math.max(1, Math.round((Date.parse(v.today) - Date.parse(v.earliest)) / 86_400_000));
  const offset = Math.max(0, Math.round((Date.parse(page.date) - Date.parse(v.earliest)) / 86_400_000));
  const sourceNote =
    page.source === "stored"
      ? html`<p class="notice">This server has no host bound, so it cannot rank. Showing the last queue saved by <span class="mono">yrm today</span>${page.rankedAt ? html` (${time(page.rankedAt, v.tz, true)})` : ""}.</p>`
      : page.source === "none" && !page.rankers
        ? html`<p class="notice">This server has no host bound, so it cannot rank, and no saved queue was found. Run <span class="mono">yrm today</span> once, or start the dashboard with <span class="mono">yrm web</span>.</p>`
        : "";
  const body = html`
<div class="page-head">
  <div><p class="eyebrow">${isToday ? "Today" : "As of"}</p><h1>${fmtDay(page.date, v.tz)}</h1></div>
  <form class="time-machine compact${isToday ? "" : " engaged"}" method="get" action="/" data-time-machine>
    <label class="tm-field"><span class="tm-label">Queue for <span class="muted small">re-ranks for that day</span></span>
      <input type="range" min="0" max="${span}" value="${Math.min(span, offset)}" data-start="${v.earliest}" data-target="tm-date" aria-label="Queue date">
      <input type="date" id="tm-date" name="date" value="${page.date}" max="${addDays(v.today, 60)}"></label>
    <div class="tm-presets"><a class="preset" href="/">Today</a><a class="preset" href="${`/${qs({ date: addDays(v.today, -30) })}`}">1 month ago</a><a class="preset" href="${`/${qs({ date: addDays(v.today, -91) })}`}">3 months ago</a><button type="submit" class="btn">Rank</button></div>
  </form>
</div>
${sourceNote}
${
  page.items.length === 0
    ? html`<div class="empty"><h2>Nothing needs you${isToday ? " today" : " that day"}.</h2>
<p>Items appear when the facts call for action: an ask nobody answered for two days, a commitment past or near its due date, a broken promise, an objection still open, an organization with open items that went quiet for two weeks, a meeting tomorrow with open items, or a job change. Import mail, notes or calendar (<span class="mono">yrm import</span>) and the rankers will find them.</p></div>`
    : html`<ol class="queue">${page.items.map((it) => queueItem(it, v, t))}</ol>`
}
<div class="page-foot muted small">${page.rankedAt ? html`Ranked ${time(page.rankedAt, v.tz, true)}. ` : ""}${
    page.source === "ranked" ? postButton(v, "/api/rank", "Re-rank", { date: page.date }, "quiet") : ""
  }</div>`;
  return layout(v, isToday ? "Today" : `Queue for ${page.date}`, "/", body);
}

// ---- People and organizations -------------------------------------------------------

function counts(e: EntitySummaryView): string {
  const parts = [plural(e.eventCount, "event")];
  if (e.openCommitments) parts.push(plural(e.openCommitments, "open commitment"));
  if (e.openAsks) parts.push(plural(e.openAsks, "open ask"));
  return parts.join(" · ");
}

function personRow(p: EntitySummaryView, v: View): Html {
  return html`<li class="row">
  <div class="row-main"><a class="name" href="${entityHref(p.id)}">${p.name}</a> ${statusChip(p.status)}<br>${identifiers(p.identifiers.filter((i) => i.type !== "name"), 3)}</div>
  <div class="row-side muted small">${counts(p)}${p.lastSeen ? html`<br>last seen ${time(p.lastSeen, v.tz)}` : ""}</div>
  <div class="row-actions">${entityActions(v, p.id, p.status)}</div>
</li>`;
}

function suggestionsBlock(v: View, list: MergeSuggestionView[]): Html {
  if (list.length === 0) return html``;
  return html`<section class="suggestions"><h2>Possibly the same person</h2><ul class="rows">${list.map(
    (s) => html`<li class="row">
  <div class="row-main">${entityLink(s.from.id, s.from.name)} <span class="muted">→</span> ${entityLink(s.into.id, s.into.name)}<br>
    ${identifiers(s.from.identifiers.filter((i) => i.type === "email"), 2)} <span class="muted">→</span> ${identifiers(s.into.identifiers.filter((i) => i.type === "email"), 2)}</div>
  <div class="row-side small">${s.reason} ${scoreBar(s.score)}${s.evidence[0] ? html`<br><a class="muted" href="${eventHref(s.evidence[0])}">evidence</a>` : ""}</div>
  <div class="row-actions">${postButton(v, "/api/merge", "Merge", { from: s.from.id, into: s.into.id }, "primary")}</div>
</li>`,
  )}</ul></section>`;
}

export function peopleView(v: View, groups: DirectoryGroup[], rejected: EntitySummaryView[], suggestions: MergeSuggestionView[]): Html {
  const total = groups.reduce((n, g) => n + g.people.length, 0);
  const body = html`<div class="page-head"><div><p class="eyebrow">Directory</p><h1>People</h1></div><p class="muted">${plural(total, "person", "people")}, proposed from who wrote, received and attended. Confirm the ones that are real.</p></div>
${suggestionsBlock(v, suggestions)}
${
  total === 0
    ? html`<div class="empty"><p>No people yet. They are proposed when mail, notes or meetings are imported.</p></div>`
    : groups.map(
        (g) => html`<section class="group"><h2>${g.organization ? html`<a href="${entityHref(g.organization.id)}">${g.organization.name}</a> ${statusChip(g.organization.status)}` : "No organization"}</h2>
<ul class="rows">${g.people.map((p) => personRow(p, v))}</ul></section>`,
      )
}
${rejected.length ? html`<details class="rejected"><summary>${plural(rejected.length, "rejected person", "rejected people")}</summary><ul class="rows">${rejected.map((p) => personRow(p, v))}</ul></details>` : ""}`;
  return layout(v, "People", "/people", body);
}

export function orgsView(v: View, orgs: Array<EntitySummaryView & { people: number; domains: string[] }>): Html {
  const body = html`<div class="page-head"><div><p class="eyebrow">Directory</p><h1>Organizations</h1></div><p class="muted">One per company domain seen. Freemail domains never become organizations.</p></div>
${
  orgs.length === 0
    ? html`<div class="empty"><p>No organizations yet.</p></div>`
    : html`<ul class="rows">${orgs.map(
        (o) => html`<li class="row">
  <div class="row-main"><a class="name" href="${entityHref(o.id)}">${o.name}</a> ${statusChip(o.status)}<br>${identifiers(o.domains.map((d) => ({ type: "domain", value: d })))}</div>
  <div class="row-side muted small">${plural(o.people, "person", "people")} · ${counts(o)}${o.lastSeen ? html`<br>last seen ${time(o.lastSeen, v.tz)}` : ""}</div>
  <div class="row-actions">${entityActions(v, o.id, o.status)}</div>
</li>`,
      )}</ul>`
}`;
  return layout(v, "Organizations", "/orgs", body);
}

// ---- Entity -------------------------------------------------------------------

export function entityView(v: View, page: EntityPage): Html {
  const e = page.entity;
  const tm = page.timeMachine;
  const t = travelOf(tm);
  const hiddenNote: Html[] = [];
  if (page.hidden.retracted > 0) {
    hiddenNote.push(
      html`<p class="muted small">${plural(page.hidden.retracted, "superseded or retracted fact")} hidden. <a href="${`${entityHref(e.id)}${qs({ asOf: v.today })}`}">Show history</a>.</p>`,
    );
  }
  if (tm.engaged && page.hidden.laterOrFuture > 0) {
    hiddenNote.push(html`<p class="muted small">${plural(page.hidden.laterOrFuture, "fact")} recorded later about other times not shown.</p>`);
  }
  const notYet = page.facts.filter((f) => f.state === "not-yet-known").length;
  const body = html`
${page.mergedFrom ? html`<p class="notice">${page.mergedFrom} was merged into this ${e.kind}.</p>` : ""}
<div class="entity-head">
  <p class="eyebrow">${e.kind}</p>
  <h1>${e.name} ${statusChip(e.status)}</h1>
  <p class="meta">${page.organization ? html`at ${entityLink(page.organization.id, page.organization.name, t)} · ` : ""}${identifiers(e.identifiers)}</p>
  <p class="meta muted small">${counts(e)}${e.firstSeen ? html` · first seen ${time(e.firstSeen, v.tz)}` : ""}${e.lastSeen ? html` · last seen ${time(e.lastSeen, v.tz)}` : ""} · <span class="mono">${e.id}</span></p>
  <div>${entityActions(v, e.id, e.status)}</div>
</div>
${timeMachineControl(v, tm)}
${page.people.length ? html`<section><h2>People</h2><ul class="chips">${page.people.map((p) => html`<li>${entityLink(p.id, p.name, t)} ${statusChip(p.status)}</li>`)}</ul></section>` : ""}
<section>
  <h2>Facts <span class="muted small">${tm.engaged ? `true at ${tm.validDate ? fmtDay(tm.validDate, v.tz) : "now"}, as known by ${tm.asOfDate ? fmtDay(tm.asOfDate, v.tz) : "now"}` : "oldest first"}</span></h2>
  ${notYet > 0 ? html`<p class="legend"><span class="swatch not-yet"></span> ${plural(notYet, "fact was", "facts were")} true then but not yet known: YRM recorded ${notYet === 1 ? "it" : "them"} later.</p>` : ""}
  ${page.facts.length === 0 ? html`<p class="empty">No facts ${tm.engaged ? "for this moment" : "yet"}. Facts come from extraction over this ${e.kind}'s mail, notes and meetings.</p>` : html`<ol class="timeline">${page.facts.map((f) => factRow(f, v, { showSubject: false, travel: t }))}</ol>`}
  ${hiddenNote}
</section>
<section>
  <h2>Events <span class="muted small">${plural(page.events.length, "most recent", "most recent")}</span></h2>
  ${page.events.length ? html`<ul class="events">${page.events.map((ev) => eventRow(ev, v))}</ul>` : html`<p class="muted">No events involve this ${e.kind}.</p>`}
</section>`;
  return layout(v, e.name, "", body);
}

// ---- Threads and events ------------------------------------------------------------

function message(v: View, p: EventPage, single: boolean): Html {
  const e = p.event;
  const from = p.participants.filter((x) => x.role === "from" || x.role === "organizer" || x.role === "author");
  const to = p.participants.filter((x) => !from.includes(x));
  const who = (x: EventPage["participants"][number]): Html => {
    const label = x.name ?? x.address ?? "(unknown)";
    const inner = x.entity ? entityLink(x.entity.id, label) : html`${label}`;
    return html`<span class="participant${x.self ? " self" : ""}" title="${x.address ?? ""}">${inner}${x.self ? html` <span class="muted small">(you)</span>` : ""}</span>`;
  };
  return html`<article class="message" id="${`event-${e.id}`}">
  <header>
    <h2>${single ? e.title ?? "(untitled)" : html`<a href="${eventHref(e.id)}">${e.title ?? "(untitled)"}</a>`}</h2>
    <p class="meta"><span class="muted">${e.source}/${e.kind}</span> · ${time(e.occurredAt, v.tz, true)}</p>
    <p class="meta">${from.map(who)}${to.length ? html` <span class="muted">→</span> ${to.map((x, i) => html`${i > 0 ? ", " : ""}${who(x)}<span class="muted small"> ${x.role}</span>`)}` : ""}</p>
  </header>
  <pre class="source body">${e.text || "(no new text)"}</pre>
  ${e.stripped ? html`<details class="stripped"><summary>Quoted and stripped text <span class="muted">· ${e.stripped.length} characters</span></summary><pre class="source">${e.stripped}</pre></details>` : ""}
  ${
    p.facts.length
      ? html`<div class="event-facts"><h3>Facts from this ${e.kind}</h3><ol class="timeline compact">${p.facts.map((f) => factRow(f, v, { showSubject: true }))}</ol></div>`
      : ""
  }
</article>`;
}

export function threadView(v: View, key: string, pages: EventPage[]): Html {
  const title = pages[0]?.event.title ?? key;
  const body = html`<div class="page-head"><div><p class="eyebrow">Thread · ${plural(pages.length, "event")}</p><h1>${title}</h1></div><p class="muted mono small">${key}</p></div>
${pages.map((p) => message(v, p, false))}`;
  return layout(v, title, "", body);
}

export function eventView(v: View, p: EventPage): Html {
  const e = p.event;
  const body = html`<p class="crumbs">${e.threadKey ? html`<a href="${threadHref(e.threadKey)}">Whole thread</a> · ` : ""}<span class="mono small muted">${e.id}</span></p>
${message(v, p, true)}`;
  return layout(v, e.title ?? "Event", "", body);
}

// ---- Facts ---------------------------------------------------------------------

const TYPES = ["commitment", "ask", "decision", "objection", "signal", "role", "relationship", "attribute"];

export function factsView(v: View, facts: FactView[], f: { type?: string; predicate?: string; q?: string; tm: TimeMachine }, predicates: string[], truncated: boolean): Html {
  const t = travelOf(f.tm);
  const body = html`<div class="page-head"><div><p class="eyebrow">Everything YRM knows</p><h1>Facts</h1></div><p class="muted">${plural(facts.length, "fact")}${truncated ? " (first 500)" : ""}${f.tm.engaged ? "" : ", true and known now"}.</p></div>
<form class="filters" method="get" action="/facts">
  <label>Type <select name="type"><option value="">any</option>${TYPES.map((ty) => html`<option value="${ty}"${f.type === ty ? html` selected` : ""}>${ty}</option>`)}</select></label>
  <label>Predicate <input name="predicate" list="predicates" value="${f.predicate ?? ""}" placeholder="works_at"></label>
  <datalist id="predicates">${predicates.map((p) => html`<option value="${p}"></option>`)}</datalist>
  <label class="grow">Search <input type="search" name="q" value="${f.q ?? ""}" placeholder="statement, name or quote"></label>
  ${f.tm.validDate ? html`<input type="hidden" name="validAt" value="${f.tm.validDate}">` : ""}${f.tm.asOfDate ? html`<input type="hidden" name="asOf" value="${f.tm.asOfDate}">` : ""}
  <button class="btn" type="submit">Filter</button>
</form>
${timeMachineControl(v, f.tm, { type: f.type, predicate: f.predicate, q: f.q })}
${facts.length ? html`<ol class="timeline">${facts.map((x) => factRow(x, v, { showSubject: true, travel: t }))}</ol>` : html`<p class="empty">No facts match.</p>`}`;
  return layout(v, "Facts", "/facts", body);
}
