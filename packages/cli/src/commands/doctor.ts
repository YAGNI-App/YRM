import { existsSync, statSync } from "node:fs";
import { estimateCost, lookupPricing, type ModelPricing, type Route } from "@yrm/core";
import { PROVIDER_NAME as ANTHROPIC } from "@yrm/provider-anthropic";
import { OpenAICompatibleProvider } from "@yrm/provider-openai";
import type { Booted } from "../bootstrap.ts";
import { PROVIDER_EXTENSIONS } from "../bootstrap.ts";
import { booted, type BuiltinCommand, type CliEnv, type FetchLike } from "../env.ts";
import { bytes, table, usd } from "../format.ts";

export const PROBE_TIMEOUT_MS = 2000;

/**
 * The workload behind "what would this cost a month": 40 messages a day,
 * each triaged and extracted, plus one synthesized brief a day. Token counts
 * are rough per-call sizes, not measurements.
 */
export const WORKLOAD = {
  messagesPerDay: 40,
  days: 30,
  perMessage: {
    triage: { inputTokens: 1500, outputTokens: 150 },
    extract: { inputTokens: 3000, outputTokens: 600 },
  },
  perDay: {
    synthesize: { inputTokens: 8000, outputTokens: 1500 },
  },
} as const;

export interface TierEstimate {
  tier: string;
  route?: Route;
  /** USD per month, or null when the price is unknown. */
  usd: number | null;
  note: string;
}

/** Estimate monthly cost per tier from the first hop of each chain. Local, unpriced hops cost zero. */
export function estimateMonthly(routes: Record<string, Route[]>, isLocal: (provider: string) => boolean): TierEstimate[] {
  const calls: Array<[string, { inputTokens: number; outputTokens: number }, number]> = [
    ["triage", WORKLOAD.perMessage.triage, WORKLOAD.messagesPerDay * WORKLOAD.days],
    ["extract", WORKLOAD.perMessage.extract, WORKLOAD.messagesPerDay * WORKLOAD.days],
    ["synthesize", WORKLOAD.perDay.synthesize, WORKLOAD.days],
  ];
  return calls.map(([tier, usage, n]) => {
    const route = routes[tier]?.[0];
    if (!route) return { tier, usd: 0, note: "no route" };
    const pricing: ModelPricing | undefined = route.pricing ?? lookupPricing(route.model);
    if (pricing) return { tier, route, usd: estimateCost(usage, pricing) * n, note: `${n} calls` };
    if (isLocal(route.provider)) return { tier, route, usd: 0, note: "local" };
    return { tier, route, usd: null, note: "unknown pricing" };
  });
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** GET `${baseUrl}/models` with a hard timeout. Never throws and never outlives the timeout. */
export async function probeEndpoint(baseUrl: string, fetchImpl: FetchLike, timeoutMs = PROBE_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: `unreachable (no answer in ${timeoutMs / 1000}s)` });
    }, timeoutMs);
  });
  const attempt = (async (): Promise<ProbeResult> => {
    try {
      const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true, detail: `reachable (${res.status})` };
      return { ok: res.status === 401 || res.status === 403 ? false : true, detail: `answered ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
      const refused = code === "ConnectionRefused" || code === "ECONNREFUSED" || /Unable to connect|ECONNREFUSED/.test(msg);
      return { ok: false, detail: `unreachable (${refused ? "connection refused" : msg.slice(0, 80)})` };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function storageLine(boot: Booted): string {
  const { storage } = boot.config;
  if (storage.driver !== "sqlite") return `${storage.driver} ${storage.url ?? storage.path ?? ""}`;
  const path = storage.path ?? "";
  if (path === ":memory:") return "sqlite (in memory)";
  let size = 0;
  for (const p of [path, `${path}-wal`]) if (existsSync(p)) size += statSync(p).size;
  return `sqlite ${path} (${bytes(size)})`;
}

async function providerStatus(boot: Booted, name: string, env: CliEnv): Promise<string> {
  const provider = boot.host.registry.providers.get(name);
  if (!provider) return "not registered";
  const settings = boot.config.settings?.[PROVIDER_EXTENSIONS[name] ?? `provider-${name}`] ?? {};
  const keyEnv = typeof settings["apiKeyEnv"] === "string" ? settings["apiKeyEnv"] : undefined;
  const hasLiteralKey = typeof settings["apiKey"] === "string";
  if (name === ANTHROPIC) {
    const envName = keyEnv ?? "ANTHROPIC_API_KEY";
    return hasLiteralKey || env.env[envName] ? `key present (${hasLiteralKey ? "apiKey" : envName})` : `no key (${envName} not set)`;
  }
  if (provider instanceof OpenAICompatibleProvider) {
    const key = hasLiteralKey ? (settings["apiKey"] as string) : keyEnv ? env.env[keyEnv] : undefined;
    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    const probe = await probeEndpoint(provider.baseUrl, env.fetch, PROBE_TIMEOUT_MS, headers);
    const keyNote = keyEnv ? (key ? `, ${keyEnv} set` : `, ${keyEnv} not set`) : "";
    return `${provider.baseUrl} ${probe.detail}${provider.local ? ", local" : ""}${keyNote}`;
  }
  return "registered";
}

export function doctorCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "doctor",
    description: "Check the installation: config, storage, extensions, models and spend",
    usage: "yrm doctor",
    needsHost: true,
    async run(ctx) {
      const boot = booted(env);
      const { host, config } = boot;
      const s = env.style;
      const out = ctx.stdout;
      const reg = host.registry;

      out(s.bold("yrm doctor"));
      const tenant = `${config.tenant.id}${config.tenant.name ? ` (${config.tenant.name})` : ""}, tz ${config.tenant.timezone ?? "system"}`;
      for (const l of table(
        [
          ["bun", Bun.version],
          ["config", boot.configFile ?? "(none)"],
          ["storage", storageLine(boot)],
          ["tenant", tenant],
          ["self", [...config.tenant.selfAddresses, ...(config.tenant.selfDomains ?? []).map((d) => `*@${d}`)].join(", ") || "(none: set tenant.selfAddresses)"],
        ],
        { indent: "  " },
      ))
        out(l);

      out("");
      out(s.bold("extensions"));
      const extRows = host.extensions.map((e) => [e.manifest.name, e.path === "(in-process)" ? "built-in" : e.origin, e.path === "(in-process)" ? "" : e.path]);
      for (const b of boot.builtins) {
        if (b.status !== "loaded") extRows.push([b.specifier, b.status, b.status === "missing" ? "not installed" : "listed in disable"]);
      }
      for (const l of table(extRows, { indent: "  " })) out(l);

      out("");
      out(s.bold("registered"));
      const names = (xs: Array<{ name: string }>) => (xs.length ? ` (${xs.map((x) => x.name).join(", ")})` : "");
      for (const l of table(
        [
          ["sources", `${reg.sources.size}${names(reg.sources.list())}`],
          ["extractors", `${reg.extractors.size}${names(reg.extractors.list())}`],
          ["resolvers", `${reg.resolvers.size}${names(reg.resolvers.list())}`],
          ["rankers", `${reg.rankers.size}${names(reg.rankers.list())}`],
          ["providers", `${reg.providers.size}${names(reg.providers.list())}`],
          ["commands", `${reg.commands.size}`],
          ["tools", `${reg.tools.size}`],
        ],
        { indent: "  ", align: ["left", "left"] },
      ))
        out(l);

      out("");
      out(s.bold("models"));
      const tiers = [...new Set(["triage", "extract", "synthesize", ...Object.keys(config.models.routes)])];
      const tierRows = tiers.map((t) => {
        const chain = host.models.describe(t);
        return [t, chain.length ? chain.map((r) => `${r.provider}/${r.model}`).join(" -> ") : s.dim("(no route)")];
      });
      for (const l of table(tierRows, { indent: "  " })) out(l);
      if (config.models.localOnly) out("  localOnly: hosted models are skipped");

      out("");
      out(s.bold("providers"));
      const used = new Set<string>(Object.values(config.models.routes).flatMap((chain) => chain.map((r) => r.provider)));
      for (const p of reg.providers.list()) used.add(p.name);
      const providerRows: string[][] = [];
      for (const name of used) providerRows.push([name, await providerStatus(boot, name, env)]);
      for (const l of table(providerRows, { indent: "  " })) out(l);

      out("");
      out(s.bold("spend"));
      const spend = await host.models.spend();
      const budget = config.models.monthlyBudgetUsd;
      out(`  month to date  ${usd(spend.usd)}${budget !== undefined ? ` of ${usd(budget)} budget` : ""}`);
      const isLocal = (name: string) => {
        const p = reg.providers.get(name);
        return p instanceof OpenAICompatibleProvider && p.local;
      };
      const est = estimateMonthly(config.models.routes, isLocal);
      out(`  estimate for ${WORKLOAD.messagesPerDay} messages/day (each triaged and extracted, one synthesize brief a day):`);
      const estRows = est.map((e) => [e.tier, e.route ? `${e.route.provider}/${e.route.model}` : "-", e.usd === null ? "unknown" : usd(e.usd), s.dim(e.note)]);
      const known = est.filter((e) => e.usd !== null).reduce((n, e) => n + (e.usd ?? 0), 0);
      const anyUnknown = est.some((e) => e.usd === null);
      estRows.push(["total", "", anyUnknown ? `${usd(known)} + unknown` : usd(known), s.dim("per month")]);
      for (const l of table(estRows, { indent: "    ", align: ["left", "left", "right", "left"] })) out(l);
      return 0;
    },
  };
}
