import { todayIn } from "@yrm/core";
import type {
  AskValue,
  CommitmentValue,
  Entity,
  EntityRef,
  Fact,
  FactType,
  ObjectionValue,
  RankContext,
  SourceEvent,
} from "@yrm/core";
import type { AttentionSettings } from "./settings.ts";

// ---- dates -------------------------------------------------------------------

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/** Whole calendar days from `from` to `to` (both ISO dates). Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day an ISO instant falls on in `tz`. A bare date is already a day. */
export function localDate(iso: string, tz: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  // A bare date stored through the store comes back as UTC midnight. Read it
  // as the date it was, or every tenant west of UTC sees it a day early.
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10);
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : todayIn(tz, new Date(t));
}

/** The last instant of `date` in `tz`, so "valid today" includes everything that happened today. */
export function endOfDay(date: string, tz: string): string {
  const guess = Date.parse(`${date}T23:59:59.000Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return new Date(guess - (wall - guess) + 999).toISOString();
}

// ---- values ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isRef(v: unknown): v is EntityRef {
  return isRecord(v) && typeof v.entityId === "string" && v.entityId.length > 0;
}

function ref(v: unknown, fallback: EntityRef | undefined): EntityRef | undefined {
  return isRef(v) ? v : fallback;
}

export interface Ask {
  fact: Fact;
  value: AskValue;
  askedBy: EntityRef | undefined;
  askedOf: EntityRef | undefined;
}

export interface Commitment {
  fact: Fact;
  value: CommitmentValue;
  owedBy: EntityRef | undefined;
  owedTo: EntityRef | undefined;
}

export interface Objection {
  fact: Fact;
  value: ObjectionValue;
  raisedBy: EntityRef | undefined;
}

export function asAsk(f: Fact): Ask | undefined {
  const v = f.value;
  if (f.type !== "ask" || !isRecord(v) || typeof v.what !== "string" || typeof v.answered !== "boolean") return undefined;
  const value = v as unknown as AskValue;
  return { fact: f, value, askedBy: ref(v.askedBy, f.subject), askedOf: ref(v.askedOf, f.object) };
}

export function asCommitment(f: Fact): Commitment | undefined {
  const v = f.value;
  if (f.type !== "commitment" || !isRecord(v) || typeof v.what !== "string" || typeof v.status !== "string") return undefined;
  const value = v as unknown as CommitmentValue;
  return { fact: f, value, owedBy: ref(v.owedBy, f.subject), owedTo: ref(v.owedTo, f.object) };
}

export function asObjection(f: Fact): Objection | undefined {
  const v = f.value;
  if (f.type !== "objection" || !isRecord(v) || typeof v.what !== "string" || typeof v.resolved !== "boolean") return undefined;
  const value = v as unknown as ObjectionValue;
  return { fact: f, value, raisedBy: ref(v.raisedBy, f.subject) };
}

/** Pull an entity ref out of a loose signal value: an EntityRef or a bare id string. */
export function refFrom(v: unknown): EntityRef | undefined {
  if (isRef(v)) return v;
  if (typeof v === "string" && v.length > 0) return { entityId: v };
  return undefined;
}

/** Every entity a fact touches: subject, object and the parties named in its value. */
export function partiesOf(f: Fact): Set<string> {
  const ids = new Set<string>([f.subject.entityId]);
  if (f.object) ids.add(f.object.entityId);
  if (isRecord(f.value)) {
    for (const k of ["askedBy", "askedOf", "owedBy", "owedTo", "raisedBy"]) {
      const r = f.value[k];
      if (isRef(r)) ids.add(r.entityId);
    }
  }
  return ids;
}

export function eventIdsOf(facts: Fact[]): string[] {
  return [...new Set(facts.flatMap((f) => f.provenance.map((p) => p.eventId)))];
}

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function clamp01(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
}

// ---- snapshot ------------------------------------------------------------------

/** Roles that count as "heard from them": they wrote, organised or authored it. */
const INBOUND_ROLES = new Set(["from", "author", "organizer", "sender"]);

/**
 * Read-through cache over the store for one ranker invocation. Everything is
 * read "as of the end of today" in both valid and transaction time, so ranking
 * a past day shows what we knew then, and superseded facts (an answered ask, a
 * fulfilled commitment) drop out.
 */
export class Snapshot {
  readonly today: string;
  readonly at: string;
  readonly tz: string;
  private readonly factCache = new Map<string, Promise<Fact[]>>();
  private readonly entityCache = new Map<string, Promise<Entity | null>>();
  private readonly eventCache = new Map<string, Promise<SourceEvent | null>>();
  private selfCache: Promise<Set<string>> | undefined;

  constructor(
    readonly ctx: RankContext,
    readonly settings: AttentionSettings,
  ) {
    this.today = ctx.today;
    this.tz = settings.timezone;
    this.at = endOfDay(ctx.today, settings.timezone);
  }

  facts(type: FactType, predicate?: string): Promise<Fact[]> {
    const key = `${type}\u0000${predicate ?? ""}`;
    let hit = this.factCache.get(key);
    if (!hit) {
      hit = this.ctx.store.queryFacts({
        tenantId: this.ctx.tenantId,
        type,
        ...(predicate !== undefined ? { predicate } : {}),
        validAt: this.at,
        asOf: this.at,
      });
      this.factCache.set(key, hit);
    }
    return hit;
  }

  async openAsks(): Promise<Ask[]> {
    return (await this.facts("ask")).flatMap((f) => {
      const a = asAsk(f);
      return a && !a.value.answered ? [a] : [];
    });
  }

  async openCommitments(): Promise<Commitment[]> {
    return (await this.facts("commitment")).flatMap((f) => {
      const c = asCommitment(f);
      return c && c.value.status === "open" ? [c] : [];
    });
  }

  async openObjections(): Promise<Objection[]> {
    return (await this.facts("objection")).flatMap((f) => {
      const o = asObjection(f);
      return o && !o.value.resolved ? [o] : [];
    });
  }

  /** Open asks, open commitments and unresolved objections, in that order. */
  async openItems(): Promise<Fact[]> {
    const [a, c, o] = await Promise.all([this.openAsks(), this.openCommitments(), this.openObjections()]);
    return [...a.map((x) => x.fact), ...c.map((x) => x.fact), ...o.map((x) => x.fact)];
  }

  entity(id: string): Promise<Entity | null> {
    let hit = this.entityCache.get(id);
    if (!hit) {
      hit = this.ctx.store.resolveEntity(id).then((e) => e ?? this.ctx.store.getEntity(id));
      this.entityCache.set(id, hit);
    }
    return hit;
  }

  event(id: string): Promise<SourceEvent | null> {
    let hit = this.eventCache.get(id);
    if (!hit) {
      hit = this.ctx.store.getEvent(id);
      this.eventCache.set(id, hit);
    }
    return hit;
  }

  /** Display name: the entity's current name, else the snapshot on the ref, else the id. */
  async name(r: EntityRef | undefined): Promise<string> {
    if (!r) return "someone";
    const e = await this.entity(r.entityId);
    return e?.name ?? r.name ?? r.entityId;
  }

  /** Named `about` entries, deduped. The tenant's own people are left out: "you" is implied. */
  async about(...refs: Array<EntityRef | undefined>): Promise<QueueAbout[]> {
    const out: QueueAbout[] = [];
    const seen = new Set<string>(await this.selfIds());
    for (const r of refs) {
      if (!r || seen.has(r.entityId)) continue;
      seen.add(r.entityId);
      out.push({ entityId: r.entityId, name: await this.name(r) });
    }
    return out;
  }

  /** Title of the first provenance event that has one. */
  async titleOf(f: Fact): Promise<string | undefined> {
    for (const p of f.provenance) {
      const title = (await this.event(p.eventId))?.content.title;
      if (title) return title;
    }
    return undefined;
  }

  /**
   * The tenant's own people. Addresses first; only when none match, every
   * person at a self domain (by org parent or by email domain).
   */
  selfIds(): Promise<Set<string>> {
    this.selfCache ??= this.loadSelf();
    return this.selfCache;
  }

  private async loadSelf(): Promise<Set<string>> {
    const { store, tenantId } = this.ctx;
    const ids = new Set<string>();
    const add = (e: Entity): void => {
      ids.add(e.status === "merged" && e.mergedInto ? e.mergedInto : e.id);
    };
    for (const value of this.settings.selfAddresses) {
      for (const e of await store.findEntities({ tenantId, identifier: { type: "email", value } })) add(e);
    }
    if (ids.size > 0 || this.settings.selfDomains.length === 0) {
      if (ids.size === 0) this.ctx.log.debug("no self entities: set settings.attention.selfAddresses");
      return ids;
    }
    const domains = new Set(this.settings.selfDomains);
    for (const d of domains) {
      for (const org of await store.findEntities({ tenantId, kind: "organization", identifier: { type: "domain", value: d } })) {
        for (const p of await store.findEntities({ tenantId, kind: "person", parentId: org.id })) add(p);
      }
    }
    for (const p of await store.findEntities({ tenantId, kind: "person" })) {
      if (p.identifiers.some((i) => i.type === "email" && domains.has(i.value.slice(i.value.lastIndexOf("@") + 1)))) add(p);
    }
    return ids;
  }

  /**
   * The last day we heard from a person: an event they sent, authored or
   * organised, or a meeting that took place with them in it. Our own outbound
   * check-ins do not count, which is the point of measuring silence. Falls back
   * to `summary.lastSeen` only when the person has no events at all.
   */
  async lastHeardFrom(personId: string): Promise<{ date: string; eventId?: string } | undefined> {
    const events = await this.ctx.store.listEvents({ tenantId: this.ctx.tenantId, entityId: personId, occurredBefore: this.at });
    let best: SourceEvent | undefined;
    for (const e of events) {
      const inbound = e.participants.some(
        (p) =>
          p.entityId === personId &&
          !p.self &&
          (INBOUND_ROLES.has(p.role) || (e.kind === "meeting" && e.meta.cancelled !== true)),
      );
      if (inbound && (!best || e.occurredAt > best.occurredAt)) best = e;
    }
    if (best) return { date: localDate(best.occurredAt, this.tz), eventId: best.id };
    if (events.length > 0) return undefined;
    const lastSeen = (await this.entity(personId))?.summary?.lastSeen;
    return lastSeen ? { date: localDate(lastSeen, this.tz) } : undefined;
  }
}

export type QueueAbout = { entityId: string; name?: string };
