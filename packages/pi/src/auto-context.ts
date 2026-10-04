// Bun only. Inject a small YRM brief into the system prompt when the user's
// prompt names someone YRM knows.
import { estimateTokens, type Entity, type Fact, type Host } from "@yrm/core";

/** Token budget for the injected section. */
export const AUTO_CONTEXT_BUDGET = 1200;
/** Entities one prompt can pull in. */
export const AUTO_CONTEXT_MAX_ENTITIES = 5;
/** System prompt section key; pi wraps it in `<yrm_context>` tags. */
export const AUTO_CONTEXT_SECTION = "yrm_context";
/** Entities scanned for names in the prompt. */
const NAME_SCAN_LIMIT = 5000;
/** Names shorter than this match too much ordinary text. */
const MIN_NAME = 3;
const BUNDLE_HEADROOM = 20;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

/** Settings under `settings.pi` in yrm.config.ts. */
export interface PiSettings {
  /** Inject a YRM brief when a prompt mentions a known person or company. Default true. */
  autoContext?: boolean;
}

export function piSettings(host: Pick<Host, "config">): PiSettings {
  return (host.config.settings?.["pi"] ?? {}) as PiSettings;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(prompt: string, phrase: string, caseSensitive: boolean): boolean {
  // Word boundaries that work for names with accents or punctuation at either end.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}($|[^\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu");
  return re.test(prompt);
}

const live = (e: Entity): boolean => e.status === "confirmed" || e.status === "proposed";

/**
 * Entities the prompt refers to: exact email addresses and domains first,
 * then full names, then a person's first name when exactly one person has it
 * and the prompt capitalizes it ("ask Marcus", not "marcus" in a path).
 */
export async function matchEntities(host: Host, prompt: string, max = AUTO_CONTEXT_MAX_ENTITIES): Promise<Entity[]> {
  const tenantId = host.config.tenant.id;
  const out = new Map<string, Entity>();
  const add = async (e: Entity): Promise<void> => {
    const target = e.status === "merged" ? await host.store.resolveEntity(e.id) : e;
    if (target && live(target) && out.size < max) out.set(target.id, target);
  };

  const emails = new Set((prompt.match(EMAIL) ?? []).map((s) => s.toLowerCase()));
  for (const value of emails) {
    for (const e of await host.store.findEntities({ tenantId, identifier: { type: "email", value } })) await add(e);
  }
  const withoutEmails = prompt.replace(EMAIL, " ");
  for (const value of new Set((withoutEmails.match(DOMAIN) ?? []).map((s) => s.toLowerCase()))) {
    for (const e of await host.store.findEntities({ tenantId, identifier: { type: "domain", value } })) await add(e);
  }
  if (out.size >= max) return [...out.values()];

  const all = await host.store.findEntities({ tenantId, status: ["confirmed", "proposed"], limit: NAME_SCAN_LIMIT });
  // Longer names first, so "Acme Robotics" wins over "Acme" when both exist.
  const byLength = [...all].sort((a, b) => b.name.length - a.name.length);
  for (const e of byLength) {
    if (e.name.length >= MIN_NAME && mentions(prompt, e.name, false)) await add(e);
  }

  const firstNames = new Map<string, Entity[]>();
  for (const e of all) {
    if (e.kind !== "person") continue;
    const first = e.name.split(/\s+/)[0] ?? "";
    if (first.length < MIN_NAME || first === e.name) continue;
    const list = firstNames.get(first) ?? [];
    list.push(e);
    firstNames.set(first, list);
  }
  for (const [first, people] of firstNames) {
    if (people.length === 1 && mentions(prompt, first, true)) await add(people[0]!);
  }
  return [...out.values()];
}

function factLine(f: Fact): string {
  const since = f.validFrom.slice(0, 10);
  const until = f.validTo ? `..${f.validTo.slice(0, 10)}` : "";
  const events = f.provenance.map((p) => p.eventId).join(", ");
  return `- ${f.statement} [${f.type}/${f.predicate}; ${since}${until}; ${f.origin.kind}; event ${events}]`;
}

/**
 * Render a context bundle as fact statements only. Sections are kept for
 * their titles and fact ids; their text is not copied, because a
 * `context:build` hook from any extension can put raw event text there and
 * this goes into every request without the model asking for it.
 */
export async function renderAutoContext(host: Host, entityIds: string[], budget = AUTO_CONTEXT_BUDGET): Promise<string | null> {
  // The bundle's own trimming drops whole sections by their full text, which we
  // do not use; ask for plenty and trim fact by fact below.
  const bundle = await host.buildContext({ entityIds, budget: budget * BUNDLE_HEADROOM });
  const header =
    "YRM context: facts about people and companies the user mentioned, each citing the event it rests on. " +
    "Human-origin facts outrank model facts. For more, call yrm_context or yrm_facts.";
  const lines = [header];
  let used = estimateTokens(header);
  const seen = new Set<string>();
  let dropped = 0;
  let any = false;

  for (const section of bundle.sections) {
    const facts: Fact[] = [];
    for (const id of section.factIds ?? []) {
      if (seen.has(id)) continue;
      const f = await host.store.getFact(id);
      if (f && !f.retractedAt) facts.push(f);
    }
    if (facts.length === 0) continue;
    const title = `## ${section.title}`;
    if (used + estimateTokens(title) + 1 > budget) {
      dropped += facts.length;
      continue;
    }
    const block = [title];
    let blockTokens = estimateTokens(title) + 1;
    for (const f of facts) {
      const line = factLine(f);
      const cost = estimateTokens(line) + 1;
      // Keep room for the "more" line.
      if (used + blockTokens + cost + 16 > budget) {
        dropped++;
        continue;
      }
      block.push(line);
      blockTokens += cost;
      seen.add(f.id);
    }
    if (block.length > 1) {
      lines.push(block.join("\n"));
      used += blockTokens;
      any = true;
    }
  }
  if (!any) return null;
  if (dropped > 0) lines.push(`- ...${dropped} more facts; call yrm_context for the full bundle`);
  return lines.join("\n\n");
}

/** The section text for a prompt, or null when nothing in it resolves in YRM. */
export async function autoContextFor(host: Host, prompt: string, budget = AUTO_CONTEXT_BUDGET): Promise<string | null> {
  const entities = await matchEntities(host, prompt);
  if (entities.length === 0) return null;
  return renderAutoContext(
    host,
    entities.map((e) => e.id),
    budget,
  );
}
