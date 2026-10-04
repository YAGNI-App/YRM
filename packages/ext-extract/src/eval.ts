import type { Command, Fact, Store } from "@yrm/core";

/**
 * Score the facts in a store against a corpus's `ground-truth.json`.
 *
 * A recorded fact matches a ground-truth fact when the type agrees, the
 * subject is one of the entities the ground-truth key resolves to, and, for
 * commitments and asks, either the statement is close enough (token Jaccard
 * after stopword removal) or the fact cites one of the ground-truth evidence
 * events. Per fixtures/README.md, unlisted low-stakes extractions are noise:
 * only decisions, objections, signals, roles, dated commitments and question
 * asks count as spurious.
 */

export interface GroundTruthFact {
  id: string;
  type: string;
  subject: string;
  object?: string;
  statement: string;
  evidence?: string[];
  predicate?: string;
}

export interface GroundTruth {
  people?: Array<{ key: string; addresses: string[] }>;
  organizations?: Array<{ domain: string }>;
  facts: GroundTruthFact[];
}

export interface TypeScore {
  expected: number;
  /** Ground-truth facts matched by at least one recorded fact. */
  recalled: number;
  /** Recorded facts that matched some ground-truth fact. */
  matched: number;
  /** Recorded facts that matched nothing and are of a kind that counts. */
  spurious: number;
  /** Recorded facts that matched nothing but are treated as noise. */
  noise: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface Scorecard {
  overall: TypeScore;
  byType: Record<string, TypeScore>;
  misses: Array<{ id: string; type: string; subject: string; statement: string }>;
  spurious: Array<{ factId: string; type: string; subject: string; quote: string; event?: string }>;
}

export const JACCARD_THRESHOLD = 0.3;

const STOPWORDS = new Set(
  (
    "a an the and or but if of to in on at by for from with about as into than then so that this these those it its " +
    "is are was were be been being am do does did have has had will would can could should shall may might must " +
    "i you he she we they me him her us them my your his our their what which who whom whether not no yes " +
    "all any some just also there here up out over after before until again very s t ll ve re d"
  ).split(" "),
);

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[’']/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

function normId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

function what(f: Fact): string | undefined {
  const v = f.value as { what?: unknown } | null;
  return typeof v?.what === "string" ? v.what : undefined;
}

function quoteOf(f: Fact): string {
  return f.provenance.find((p) => p.quote)?.quote ?? what(f) ?? f.statement;
}

/** Counts as spurious when unmatched (README: unlisted small commitments are noise). */
function countsWhenUnmatched(f: Fact): boolean {
  if (["decision", "objection", "signal", "role"].includes(f.type)) return true;
  if (f.type === "commitment") return Boolean((f.value as { dueAt?: unknown } | null)?.dueAt);
  if (f.type === "ask") return /\?/.test(what(f) ?? quoteOf(f));
  return false;
}

function emptyScore(): TypeScore {
  return { expected: 0, recalled: 0, matched: 0, spurious: 0, noise: 0, precision: 0, recall: 0, f1: 0 };
}

function finish(s: TypeScore): TypeScore {
  s.precision = s.matched + s.spurious === 0 ? 0 : s.matched / (s.matched + s.spurious);
  s.recall = s.expected === 0 ? 0 : s.recalled / s.expected;
  s.f1 = s.precision + s.recall === 0 ? 0 : (2 * s.precision * s.recall) / (s.precision + s.recall);
  return s;
}

export interface ScoreOptions {
  tenantId?: string;
  /** World time to read facts at. Defaults to now. */
  validAt?: string;
}

export async function scoreFacts(store: Store, groundTruth: GroundTruth, opts: ScoreOptions = {}): Promise<Scorecard> {
  const tenant = opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {};

  // Ground-truth keys (person keys, org domains) to the entity ids they resolve to.
  const entitiesFor = new Map<string, Set<string>>();
  const nameOf = new Map<string, string>();
  const addIds = async (key: string, values: string[]) => {
    const ids = new Set<string>();
    for (const value of values) {
      for (const e of await store.findEntities({ ...tenant, identifier: { value: value.toLowerCase() } })) {
        ids.add(e.id);
        nameOf.set(e.id, e.name);
        const live = await store.resolveEntity(e.id);
        if (live) ids.add(live.id);
      }
    }
    entitiesFor.set(key, ids);
  };
  for (const p of groundTruth.people ?? []) await addIds(p.key, p.addresses);
  for (const o of groundTruth.organizations ?? []) await addIds(o.domain, [o.domain]);

  const events = await store.listEvents({ ...tenant });
  const eventByExternal = new Map(events.map((e) => [normId(e.externalId), e.id]));
  const externalByEvent = new Map(events.map((e) => [e.id, e.externalId]));

  const facts = await store.queryFacts({ ...tenant, ...(opts.validAt ? { validAt: opts.validAt } : {}) });

  const matches = (f: Fact, g: GroundTruthFact): boolean => {
    if (f.type !== g.type) return false;
    if (!entitiesFor.get(g.subject)?.has(f.subject.entityId)) return false;
    if (g.type !== "commitment" && g.type !== "ask") return true;
    const texts = [what(f), f.statement].filter((t): t is string => t !== undefined);
    if (texts.some((t) => jaccard(t, g.statement) >= JACCARD_THRESHOLD)) return true;
    const evidence = new Set((g.evidence ?? []).map((e) => eventByExternal.get(normId(e))).filter(Boolean));
    return f.provenance.some((p) => evidence.has(p.eventId));
  };

  const byType: Record<string, TypeScore> = {};
  const score = (type: string) => (byType[type] ??= emptyScore());
  const overall = emptyScore();
  const card: Scorecard = { overall, byType, misses: [], spurious: [] };
  const gtTypes = new Set(groundTruth.facts.map((g) => g.type));

  for (const g of groundTruth.facts) {
    const s = score(g.type);
    s.expected++;
    overall.expected++;
    if (facts.some((f) => matches(f, g))) {
      s.recalled++;
      overall.recalled++;
    } else {
      card.misses.push({ id: g.id, type: g.type, subject: g.subject, statement: g.statement });
    }
  }

  for (const f of facts) {
    if (!gtTypes.has(f.type) && !countsWhenUnmatched(f)) continue;
    const s = score(f.type);
    if (groundTruth.facts.some((g) => matches(f, g))) {
      s.matched++;
      overall.matched++;
    } else if (countsWhenUnmatched(f)) {
      s.spurious++;
      overall.spurious++;
      const ev = f.provenance[0]?.eventId;
      const external = ev ? externalByEvent.get(ev) : undefined;
      card.spurious.push({
        factId: f.id,
        type: f.type,
        subject: f.subject.name ?? nameOf.get(f.subject.entityId) ?? f.subject.entityId,
        quote: quoteOf(f),
        ...(external ? { event: external } : {}),
      });
    } else {
      s.noise++;
      overall.noise++;
    }
  }

  for (const s of Object.values(byType)) finish(s);
  finish(overall);
  return card;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(5);

export function formatScorecard(card: Scorecard): string[] {
  const row = (label: string, s: TypeScore) =>
    `${label.padEnd(13)} ${String(s.recalled).padStart(3)}/${String(s.expected).padEnd(3)} recall ${pct(s.recall)}  precision ${pct(s.precision)}  F1 ${pct(s.f1)}  (matched ${s.matched}, spurious ${s.spurious}, noise ${s.noise})`;
  const lines = ["Fact extraction scorecard", ""];
  for (const [type, s] of Object.entries(card.byType).sort(([a], [b]) => a.localeCompare(b))) lines.push(row(type, s));
  lines.push(row("overall", card.overall));
  if (card.misses.length > 0) {
    lines.push("", `Misses (${card.misses.length}):`);
    for (const m of card.misses) lines.push(`  ${m.id} ${m.type} [${m.subject}] ${m.statement}`);
  }
  if (card.spurious.length > 0) {
    lines.push("", `Spurious (${card.spurious.length}):`);
    for (const s of card.spurious) lines.push(`  ${s.type} [${s.subject}] "${s.quote.replace(/\s+/g, " ")}"${s.event ? ` ${s.event}` : ""}`);
  }
  return lines;
}

export function evalCommand(): Command {
  return {
    name: "extract:eval",
    description: "Score extracted facts against a corpus's ground truth (precision, recall, F1 per type).",
    usage: "extract:eval [--corpus fixtures/acme] [--json]",
    async run(ctx) {
      const corpusFlag = ctx.flags["corpus"];
      const corpus = (typeof corpusFlag === "string" ? corpusFlag : ctx.args[0]) ?? "fixtures/acme";
      const file = Bun.file(`${corpus.replace(/\/$/, "")}/ground-truth.json`);
      if (!(await file.exists())) {
        ctx.stderr(`no ground-truth.json in ${corpus}`);
        return 1;
      }
      const card = await scoreFacts(ctx.store, (await file.json()) as GroundTruth, { tenantId: ctx.tenantId });
      if (ctx.flags["json"]) ctx.stdout(JSON.stringify(card, null, 2));
      else for (const line of formatScorecard(card)) ctx.stdout(line);
      return 0;
    },
  };
}
