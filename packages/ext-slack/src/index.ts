import { HOST_READY_TOPIC, type Command, type ExtensionAPI, type ExtensionManifest, type Host, type SourceAdapter } from "@yrm/core";
import { SlackClient } from "./api.ts";
import type { UserMap } from "./convert.ts";
import { importExport } from "./export.ts";
import { setupText } from "./setup.ts";
import {
  AUTH_KEY,
  CHANNELS_KEY,
  cursorKey,
  KV_NAMESPACE,
  LAST_SYNC_KEY,
  resolveSettings,
  SOURCE_NAME,
  USERS_KEY,
  type ResolvedSettings,
  type SlackSettings,
} from "./settings.ts";
import { syncSlack, type StoredAuth, type SyncedChannel } from "./sync.ts";
import { titleExtractor } from "./title.ts";

export * from "./api.ts";
export * from "./convert.ts";
export * from "./export.ts";
export * from "./markup.ts";
export * from "./settings.ts";
export * from "./setup.ts";
export * from "./sync.ts";
export * from "./title.ts";

export const manifest: ExtensionManifest = {
  name: SOURCE_NAME,
  version: "0.1.0",
  description: "Slack source: channels, DMs and threads through the Web API, or a workspace export.",
};

export default function slackExtension(yrm: ExtensionAPI): void {
  const settings = (): ResolvedSettings => resolveSettings(yrm.config.get<SlackSettings>() ?? {});
  let host: Host | undefined;
  yrm.events.on(HOST_READY_TOPIC, (h) => {
    host = h as Host;
  });

  const source: SourceAdapter = {
    name: SOURCE_NAME,
    description: "Slack channels, DMs and threads through the Web API (per-channel cursors), or a workspace export directory.",
    kinds: ["message"],
    async sync(ctx) {
      const s = settings();
      // Degrade, do not crash: an unconfigured source is not an error for `yrm sync`.
      if (!s.token) {
        ctx.log.warn(`slack is not connected; set ${s.tokenEnv} (see yrm slack:setup)`);
        return;
      }
      const client = new SlackClient({ apiBase: s.apiBase, token: s.token, signal: ctx.signal });
      await syncSlack(ctx, { client, kv: yrm.store, settings: s });
    },
    async importPath(path, ctx) {
      await importExport(path, ctx, { kv: yrm.store, settings: settings() });
    },
  };
  yrm.registerSource(source);
  yrm.registerExtractor(titleExtractor(yrm.store));

  const setup: Command = {
    name: "slack:setup",
    description: "Print how to create the Slack app from a manifest, install it and configure the token.",
    usage: "slack:setup",
    async run(ctx) {
      for (const line of setupText(settings())) ctx.stdout(line);
      return 0;
    },
  };
  yrm.registerCommand(setup);

  const status: Command = {
    name: "slack:status",
    description: "Show the Slack workspace, token type, synced channels with cursors, and the user map size.",
    usage: "slack:status",
    async run(ctx) {
      const s = settings();
      const auth = await ctx.store.kvGet<StoredAuth>(KV_NAMESPACE, AUTH_KEY);
      const users = (await ctx.store.kvGet<UserMap>(KV_NAMESPACE, USERS_KEY)) ?? {};
      const channels = (await ctx.store.kvGet<SyncedChannel[]>(KV_NAMESPACE, CHANNELS_KEY)) ?? [];
      const lastSync = await ctx.store.kvGet<string>(KV_NAMESPACE, LAST_SYNC_KEY);
      const withEmail = Object.values(users).filter((u) => u.email !== undefined).length;
      const rows: Array<[string, string]> = [
        ["workspace", auth ? `${auth.team ?? "?"}${auth.url ? ` (${auth.url})` : ""}` : "(not synced yet)"],
        ["token", s.token ? `${s.token.startsWith("xoxb-") ? "bot" : "user"} token from ${s.token === process.env[s.tokenEnv] ? s.tokenEnv : "settings"}` : `none (set ${s.tokenEnv})`],
        ["users", `${Object.keys(users).length} cached, ${withEmail} with email`],
        ["channels", String(channels.length)],
        ["last sync", lastSync ?? "never"],
      ];
      for (const [k, v] of rows) ctx.stdout(`${k.padEnd(10)} ${v}`);
      for (const c of [...channels].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))) {
        const cursor = await ctx.store.kvGet<string>(KV_NAMESPACE, cursorKey(c.id));
        const label = c.name !== undefined ? `#${c.name}` : `${c.kind} ${c.id}`;
        ctx.stdout(`  ${label.padEnd(24)} ${c.id.padEnd(12)} ${cursor ? `after ${new Date(Number(cursor) * 1000).toISOString()} (${cursor})` : "(no messages yet)"}`);
      }
      return 0;
    },
  };
  yrm.registerCommand(status);

  const importCmd: Command = {
    name: "slack:import",
    description: "Import a Slack workspace export directory, then resolve, extract and project it.",
    usage: "slack:import <export-dir> [--no-extract]",
    async run(ctx) {
      const dir = ctx.args[0];
      if (!dir) {
        ctx.stderr("usage: yrm slack:import <export-dir> [--no-extract]");
        return 2;
      }
      if (!host) {
        ctx.stderr("slack:import needs a started host; use host.importPath(\"slack\", dir) from code");
        return 1;
      }
      const r = await host.importPath(SOURCE_NAME, dir);
      const touched = new Set<string>();
      let facts = 0;
      for (const e of r.events) {
        const resolved = await host.resolve(e);
        for (const ent of resolved.entities) touched.add(ent.id);
        facts += resolved.facts.length;
        if (ctx.flags["extract"] === false) continue;
        const x = await host.extract(resolved.event);
        facts += x.facts.length;
        for (const f of x.facts) touched.add(f.subject.entityId);
      }
      await host.project(touched);
      ctx.stdout(`created ${r.events.length}, duplicates ${r.duplicates}, dropped ${r.dropped}, facts ${facts}`);
      return 0;
    },
  };
  yrm.registerCommand(importCmd);
}
