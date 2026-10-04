import type { FactOrigin } from "@yrm/core";
import type { EventRef, FactView, ProvenanceView, TimeMachine } from "./data.ts";
import { html, qs, type Html, type Renderable } from "./html.ts";
import { CSRF_FIELD } from "./security.ts";
import { addDays, daysBetween, fmtDay, fmtInstant } from "./time.ts";

/** Rendering context every page shares. */
export interface View {
  tz: string;
  csrf: string;
  /** Today in the tenant timezone, YYYY-MM-DD. */
  today: string;
  /** Oldest day worth sliding back to. */
  earliest: string;
  /** The path being rendered, for GET forms. */
  path: string;
  /** Path and query, for redirects back after a POST. */
  here: string;
  /** Who this request runs as; shown in the footer. */
  principal?: string;
  /** True when the caller holds a session cookie, so the footer offers "Sign out". */
  session?: boolean;
}

// ---- links -------------------------------------------------------------------

/** Time-machine params carried from page to page so a click keeps you in the past. */
export interface Travel {
  validAt?: string | null;
  asOf?: string | null;
}

export function travelOf(tm: TimeMachine): Travel {
  return tm.engaged ? { validAt: tm.validDate, asOf: tm.asOfDate } : {};
}

export function entityHref(id: string, t: Travel = {}): string {
  return `/entity/${encodeURIComponent(id)}${qs({ validAt: t.validAt ?? null, asOf: t.asOf ?? null })}`;
}

export function eventHref(id: string): string {
  return `/event/${encodeURIComponent(id)}`;
}

export function threadHref(key: string): string {
  return `/thread/${encodeURIComponent(key)}`;
}

export function entityLink(id: string, name: string, t: Travel = {}): Html {
  return html`<a href="${entityHref(id, t)}">${name}</a>`;
}

// ---- chips and glyphs --------------------------------------------------------

const KNOWN_TYPES = new Set(["commitment", "ask", "decision", "objection", "signal", "role", "relationship", "attribute"]);

/** Fact types keep one color everywhere; extension-defined types share a neutral one. */
export function typeChip(type: string): Html {
  const cls = KNOWN_TYPES.has(type) ? type : "other";
  return html`<span class="chip t-${cls}">${type}</span>`;
}

export function statusChip(status: string): Html {
  return html`<span class="chip s-${status}">${status}</span>`;
}

export function originBadge(o: FactOrigin): Html {
  const detail = [o.by, o.model, o.version ? `v${o.version}` : undefined].filter(Boolean).join(" · ");
  return html`<span class="origin o-${o.kind}" title="${`${o.kind} origin: ${detail}`}"><span class="glyph" aria-hidden="true"></span>${o.kind}<span class="muted"> ${detail}</span></span>`;
}

/** A thin bar; SVG so the width needs no inline style (the CSP forbids those). */
export function scoreBar(score: number): Html {
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  return html`<span class="score" title="${`score ${score.toFixed(2)}`}"><svg class="bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-bg" width="100" height="4" rx="2"></rect><rect class="bar-fg" width="${pct}" height="4" rx="2"></rect></svg><span class="num">${score.toFixed(2)}</span></span>`;
}

export function csrfField(v: View): Html {
  return html`<input type="hidden" name="${CSRF_FIELD}" value="${v.csrf}">`;
}

/** A one-button POST form that comes back to this page. */
export function postButton(v: View, action: string, label: string, fields: Record<string, string> = {}, cls = ""): Html {
  return html`<form method="post" action="${action}" class="inline">${csrfField(v)}<input type="hidden" name="next" value="${v.here}">${Object.entries(
    fields,
  ).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`)}<button type="submit" class="${`btn ${cls}`}">${label}</button></form>`;
}

export function entityActions(v: View, id: string, status: string): Html {
  return html`<span class="actions">${status !== "confirmed" ? postButton(v, `/api/entity/${encodeURIComponent(id)}/confirm`, "Confirm", {}, "primary") : ""}${
    status !== "rejected" ? postButton(v, `/api/entity/${encodeURIComponent(id)}/reject`, "Reject", {}, "quiet") : ""
  }</span>`;
}

// ---- dates -------------------------------------------------------------------

export function validRange(f: Pick<FactView, "validFrom" | "validTo">, tz: string): string {
  return `${fmtDay(f.validFrom, tz)} → ${f.validTo ? fmtDay(f.validTo, tz) : "now"}`;
}

export function time(iso: string, tz: string, withTime = false): Html {
  return html`<time datetime="${iso}">${withTime ? fmtInstant(iso, tz) : fmtDay(iso, tz)}</time>`;
}

// ---- provenance --------------------------------------------------------------

/** The source text with the quote wrapped in <mark>; the quote above the text when it cannot be found. */
export function sourceExcerpt(p: ProvenanceView): Html {
  const e = p.event;
  if (!e) return html`<p class="muted">Source event ${p.eventId} is not in the log.</p>${p.quote ? html`<blockquote class="quote">${p.quote}</blockquote>` : ""}`;
  const loc = p.location;
  if (loc) {
    const body = loc.in === "text" ? e.text : (e.stripped ?? "");
    const marked = html`${body.slice(0, loc.start)}<mark>${body.slice(loc.start, loc.end)}</mark>${body.slice(loc.end)}`;
    const note = loc.in === "stripped" ? html`<p class="muted small">Found in the quoted history of this message, not its new text.</p>` : "";
    return html`${note}<pre class="source">${marked}</pre>`;
  }
  return html`${p.quote ? html`<blockquote class="quote">${p.quote}</blockquote><p class="muted small">Quote not located in the message text; showing it above the message.</p>` : ""}<pre class="source">${e.text}</pre>`;
}

export function provenanceBlock(f: FactView, v: View): Html {
  if (f.provenance.length === 0) return html``;
  const first = f.provenance[0]!;
  const label = first.quote ? `“${truncate(first.quote, 80)}”` : (first.event?.title ?? "source");
  return html`<details class="prov" data-fact="${f.id}"><summary><span class="prov-label">Provenance</span> <span class="quote-inline">${label}</span>${
    f.provenance.length > 1 ? html` <span class="muted">+${f.provenance.length - 1} more</span>` : ""
  }</summary>${f.provenance.map(
    (p) => html`<div class="prov-item"><div class="prov-head">${
      p.event
        ? html`<a href="${eventHref(p.eventId)}">${p.event.title ?? "(untitled)"}</a> <span class="muted">${p.event.source}/${p.event.kind} · ${time(p.event.occurredAt, v.tz, true)}${p.event.from ? ` · ${p.event.from}` : ""}</span>${
            p.event.threadKey ? html` · <a class="muted" href="${threadHref(p.event.threadKey)}">thread</a>` : ""
          }`
        : html`<span class="mono">${p.eventId}</span>`
    }${p.speaker ? html`<span class="muted"> · said by ${p.speaker.name ?? p.speaker.entityId}</span>` : ""}</div>${sourceExcerpt(p)}</div>`,
  )}</details>`;
}

// ---- facts -------------------------------------------------------------------

const STATE_LABEL: Record<FactView["state"], string> = {
  current: "",
  ended: "no longer true",
  future: "not yet true",
  "not-yet-known": "not yet known",
  retracted: "superseded",
};

export function factRow(f: FactView, v: View, opts: { showSubject?: boolean; travel?: Travel } = {}): Html {
  const t = opts.travel ?? {};
  const stateLabel = f.state === "retracted" && !f.supersededBy ? "retracted" : STATE_LABEL[f.state];
  return html`<li class="${`fact state-${f.state}`}" id="${`fact-${f.id}`}">
  <div class="fact-when">${time(f.validFrom, v.tz)}</div>
  <div class="fact-body">
    <p class="statement">${stateLabel ? html`<span class="state-label">${stateLabel}</span> ` : ""}<span class="text">${f.statement}</span></p>
    <p class="meta">${typeChip(f.type)} <span class="mono predicate">${f.predicate}</span>${
      opts.showSubject ? html` · ${entityLink(f.subject.entityId, f.subject.name ?? f.subject.entityId, t)}${f.object ? html` → ${entityLink(f.object.entityId, f.object.name ?? f.object.entityId, t)}` : ""}` : ""
    }</p>
    <p class="meta muted"><span title="valid time: when it was true in the world">valid ${validRange(f, v.tz)}</span> · ${
      f.knownAt.slice(0, 10) !== f.recordedAt.slice(0, 10)
        ? html`<span title="knowledge time: when we could first have known it (for imported mail, when it was received)">known ${time(f.knownAt, v.tz, true)}</span> · `
        : ""
    }<span title="transaction time: when YRM recorded it">recorded ${time(f.recordedAt, v.tz, true)}</span>${
      f.retractedAt ? html` · <span title="when YRM stopped believing it">retracted ${time(f.retractedAt, v.tz, true)}</span>` : ""
    } · confidence ${f.confidence.toFixed(2)} · ${originBadge(f.origin)}</p>
    ${f.laterRetractedAt ? html`<p class="meta later">Believed then; superseded on ${fmtDay(f.laterRetractedAt, v.tz)}.</p>` : ""}
    ${provenanceBlock(f, v)}
  </div>
</li>`;
}

// ---- time machine ------------------------------------------------------------

/**
 * Two dates: "true at" (validAt, world time) and "known by" (asOf, belief
 * time). Plain GET form so it works without JS; app.js adds the sliders'
 * live labels and submits on change.
 */
export function timeMachineControl(v: View, tm: TimeMachine, extra: Record<string, string | undefined> = {}): Html {
  const span = Math.max(1, daysBetween(v.earliest, v.today));
  const hidden = Object.entries(extra)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`);
  const preset = (label: string, date: string | null): Html =>
    html`<a class="preset" href="${`${v.path}${qs({ ...extra, validAt: date, asOf: date })}`}">${label}</a>`;
  const slider = (name: string, label: string, hint: string, value: string | null): Html => {
    const offset = value ? Math.min(span, Math.max(0, daysBetween(v.earliest, value))) : span;
    return html`<label class="tm-field"><span class="tm-label">${label} <span class="muted small">${hint}</span></span>
      <input type="range" min="0" max="${span}" value="${offset}" data-start="${v.earliest}" data-target="${`tm-${name}`}" aria-label="${label}">
      <input type="date" id="${`tm-${name}`}" name="${name}" value="${value ?? ""}" min="${v.earliest}" max="${v.today}"></label>`;
  };
  return html`<form class="${`time-machine${tm.engaged ? " engaged" : ""}`}" method="get" action="${v.path}" data-time-machine>
  <div class="tm-head"><span class="tm-title">Time machine</span>${
    tm.engaged
      ? html`<span class="tm-status">true at <strong>${tm.validDate ? fmtDay(tm.validDate, v.tz) : "now"}</strong>, known by <strong>${tm.asOfDate ? fmtDay(tm.asOfDate, v.tz) : "now"}</strong></span>`
      : html`<span class="tm-status muted">showing what is true and known now</span>`
  }</div>
  ${hidden}
  <div class="tm-fields">${slider("validAt", "True at", "world time", tm.validDate)}${slider("asOf", "Known by", "what we knew then", tm.asOfDate)}</div>
  <div class="tm-presets">${preset("Now", null)}${preset("1 month ago", addDays(v.today, -30))}${preset("3 months ago", addDays(v.today, -91))}<button type="submit" class="btn">Travel</button></div>
</form>`;
}

// ---- events ------------------------------------------------------------------

export function eventRow(e: EventRef, v: View): Html {
  return html`<li class="event-row"><span class="when">${time(e.occurredAt, v.tz)}</span> <a href="${eventHref(e.id)}">${e.title ?? "(untitled)"}</a> <span class="muted small">${e.source}/${e.kind}${e.from ? ` · ${e.from}` : ""}</span>${
    e.threadKey ? html` <a class="muted small" href="${threadHref(e.threadKey)}">thread</a>` : ""
  }</li>`;
}

export function identifiers(ids: Array<{ type: string; value: string }>, max = 99): Html {
  const shown = ids.slice(0, max);
  return html`<span class="ids">${shown.map((i) => html`<span class="mono id" title="${i.type}">${i.value}</span>`)}${
    ids.length > max ? html`<span class="muted small"> +${ids.length - max}</span>` : ""
  }</span>`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function section(title: string, body: Renderable, cls = ""): Html {
  return html`<section class="${cls}"><h2>${title}</h2>${body}</section>`;
}
