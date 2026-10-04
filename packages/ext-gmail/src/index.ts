import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Command, ExtensionAPI, ExtensionManifest, NewSourceEvent, SourceAdapter, SyncContext } from "@yrm/core";
import { classifyNoise, listMailFiles, parseEml, parseMbox } from "@yrm/ext-mail";
import { GmailClient } from "./api.ts";
import { takeoutMeta, toGmailEvent } from "./convert.ts";
import { isExpired, loadTokens, resolveAccount, runLoopbackLogin, TokenManager } from "./oauth.ts";
import { setupText } from "./setup.ts";
import { KV_NAMESPACE, resolveSettings, SOURCE_NAME, type GmailSettings, type ResolvedSettings } from "./settings.ts";
import { BACKFILL_KEY, EMIT_BATCH, INGESTED_KEY, LAST_SYNC_KEY, syncGmail, type BackfillState } from "./sync.ts";

export * from "./api.ts";
export * from "./convert.ts";
export * from "./oauth.ts";
export * from "./settings.ts";
export * from "./setup.ts";
export * from "./sync.ts";

export const manifest: ExtensionManifest = {
  name: SOURCE_NAME,
  version: "0.1.0",
  description: "Gmail source: OAuth loopback login, incremental history sync, Takeout .mbox import.",
};

export interface TakeoutStats {
  messages: number;
  emitted: number;
  created: number;
  dropped: number;
}

/**
 * Import a Google Takeout `.mbox` (or `.eml` files) as `gmail` events, without
 * OAuth. Leaves the sync cursor alone: that is Gmail's history id.
 */
export async function importTakeout(path: string, ctx: SyncContext, s: ResolvedSettings): Promise<TakeoutStats> {
  const stats: TakeoutStats = { messages: 0, emitted: 0, created: 0, dropped: 0 };
  let batch: NewSourceEvent[] = [];
  const flush = async (all: boolean): Promise<void> => {
    while (batch.length >= EMIT_BATCH || (all && batch.length > 0)) {
      const chunk = batch.splice(0, EMIT_BATCH);
      stats.emitted += chunk.length;
      stats.created += (await ctx.emit(chunk)).length;
    }
  };
  for (const file of await listMailFiles(path)) {
    if (ctx.signal.aborted) break;
    const raw = await readFile(file, "utf-8");
    const mtime = (await stat(file)).mtime.toISOString();
    const isMbox = extname(file).toLowerCase() === ".mbox";
    const messages = isMbox ? parseMbox(raw) : [parseEml(raw)];
    messages.forEach((msg, index) => {
      stats.messages++;
      const verdict = classifyNoise(msg, s.noise);
      if (verdict.noise && !s.keepNoise) stats.dropped++;
      const { labels, threadId } = takeoutMeta(msg);
      const opts: Parameters<typeof toGmailEvent>[1] = {
        labels,
        rawRef: isMbox ? `${file}#${index}` : file,
        fallbackDate: mtime,
        noise: s.noise,
        keepNoise: s.keepNoise,
        verdict,
      };
      if (threadId !== undefined) opts.threadId = threadId;
      const event = toGmailEvent(msg, opts);
      if (event) batch.push(event);
    });
    await flush(false);
  }
  await flush(true);
  ctx.log.info("gmail takeout import finished", { path, ...stats, duplicates: stats.emitted - stats.created });
  return stats;
}

/** Open a URL in the default browser. Best effort: the URL is always printed too. */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener available; the printed URL is enough.
  }
}

export default function gmailExtension(yrm: ExtensionAPI): void {
  const settings = (): ResolvedSettings => resolveSettings(yrm.config.get<GmailSettings>() ?? {});

  const clientFor = (s: ResolvedSettings, account: string, signal?: AbortSignal): GmailClient => {
    const tokens = new TokenManager(yrm.store, s, account);
    return new GmailClient(signal ? { apiBase: s.apiBase, tokens, signal } : { apiBase: s.apiBase, tokens });
  };

  const source: SourceAdapter = {
    name: SOURCE_NAME,
    description: "Gmail through the REST API (incremental via history ids), or a Takeout .mbox.",
    kinds: ["message"],
    async sync(ctx) {
      const s = settings();
      const account = await resolveAccount(yrm.store, s);
      // Degrade, do not crash: an unconfigured source is not an error for `yrm sync`.
      if (!s.clientId || account === undefined || !(await loadTokens(yrm.store, account))) {
        ctx.log.warn("gmail is not connected; run `yrm gmail:setup`");
        return;
      }
      await syncGmail(ctx, { client: clientFor(s, account, ctx.signal), kv: yrm.store, settings: s, account });
    },
    async importPath(path, ctx) {
      await importTakeout(path, ctx, settings());
    },
  };
  yrm.registerSource(source);

  const setup: Command = {
    name: "gmail:setup",
    description: "Print the Google Cloud checklist, then sign in to Gmail (loopback OAuth with PKCE).",
    usage: "gmail:setup [--no-browser]",
    async run(ctx) {
      const s = settings();
      for (const line of setupText(s)) ctx.stdout(line);
      if (!s.clientId) {
        ctx.stdout("");
        ctx.stdout("settings.gmail.clientId is not set yet; finish steps 1-5 and run this again.");
        return 0;
      }
      if (!s.clientSecret) ctx.stderr(`warning: no client secret (settings.gmail.clientSecret or ${s.clientSecretEnv}); Google requires it for Desktop app clients`);
      ctx.stdout("");
      const tokens = await runLoopbackLogin({
        settings: s,
        kv: yrm.store,
        onUrl: (url, uri) => {
          ctx.stdout(`Listening on ${uri}`);
          ctx.stdout("Open this URL to sign in:");
          ctx.stdout("");
          ctx.stdout(url);
          ctx.stdout("");
          if (ctx.flags["browser"] !== false) openBrowser(url);
        },
        lookupAccount: async (accessToken) => {
          const client = new GmailClient({ apiBase: s.apiBase, tokens: { accessToken: async () => accessToken, refresh: async () => ({ access_token: accessToken }) } });
          return (await client.getProfile()).emailAddress;
        },
      });
      if (s.account && s.account !== tokens.account) ctx.stderr(`warning: signed in as ${tokens.account}, but settings.gmail.account is ${s.account}`);
      ctx.stdout(`Signed in as ${tokens.account}. Tokens are stored in the local kv table. Next: yrm sync gmail`);
      return 0;
    },
  };
  yrm.registerCommand(setup);

  const status: Command = {
    name: "gmail:status",
    description: "Show the Gmail account, token state, history cursor and sync counters.",
    usage: "gmail:status",
    async run(ctx) {
      const s = settings();
      const account = await resolveAccount(ctx.store, s);
      const tokens = account === undefined ? null : await loadTokens(ctx.store, account);
      const cursor = await ctx.store.getCursor(ctx.tenantId, SOURCE_NAME);
      const backfill = await ctx.store.kvGet<BackfillState>(KV_NAMESPACE, BACKFILL_KEY);
      const lastSync = await ctx.store.kvGet<string>(KV_NAMESPACE, LAST_SYNC_KEY);
      const ingested = (await ctx.store.kvGet<number>(KV_NAMESPACE, INGESTED_KEY)) ?? 0;
      const tokenLine = !tokens
        ? "none (run yrm gmail:setup)"
        : `refresh token present; access token ${isExpired(tokens) ? "expired (refreshes on next sync)" : "valid"} until ${tokens.expiry}`;
      const rows: Array<[string, string]> = [
        ["account", account ?? "(not signed in)"],
        ["client id", s.clientId ?? "(not configured)"],
        ["tokens", tokenLine],
        ["cursor", cursor ? `historyId ${cursor}` : "(none: next sync backfills)"],
        ["backfill", backfill ? `in progress at label ${s.labels[backfill.labelIndex] ?? "?"}${backfill.query ? ` (q: ${backfill.query})` : ""}` : "idle"],
        ["last sync", lastSync ?? "never"],
        ["ingested", String(ingested)],
        ["labels", s.labels.join(", ")],
        ["query", s.query ?? "(none)"],
      ];
      for (const [k, v] of rows) ctx.stdout(`${k.padEnd(10)} ${v}`);
      return 0;
    },
  };
  yrm.registerCommand(status);
}
