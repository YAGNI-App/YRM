import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, type SyncContext } from "@yrm/core";
import type { SlackChannel, SlackMessage, SlackUser } from "./api.ts";
import { channelKind, isDM, toUserMap, type ChannelInfo, type MapContext, type UserMap } from "./convert.ts";
import { channelSelected, dmsEnabled, KV_NAMESPACE, USERS_KEY, type ResolvedSettings } from "./settings.ts";
import { byTs, emptyStats, Ingester, type Kv, type SlackSyncStats } from "./sync.ts";

/**
 * Import a Slack workspace export (Workspace settings > Import/Export data):
 * `users.json`, `channels.json`, optionally `groups.json`, `dms.json` and
 * `mpims.json`, and one directory per conversation holding `<date>.json`
 * files. Thread replies sit inline in the day files, so the same mapping as
 * the API path yields the same events. Cursors are left alone.
 */

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

/** Exports name public and private channel folders by name, DM folders by id. */
async function folderFor(root: string, c: SlackChannel): Promise<string | undefined> {
  for (const candidate of [c.name, c.id]) {
    if (candidate === undefined) continue;
    const dir = join(root, candidate);
    if (existsSync(dir) && (await stat(dir)).isDirectory()) return dir;
  }
  return undefined;
}

async function readMessages(dir: string): Promise<SlackMessage[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out: SlackMessage[] = [];
  for (const f of files) {
    const day = JSON.parse(await readFile(join(dir, f), "utf-8")) as unknown;
    if (Array.isArray(day)) for (const m of day as SlackMessage[]) if (m && typeof m.ts === "string") out.push(m);
  }
  return out.sort(byTs);
}

export interface ExportDeps {
  kv: Kv;
  settings: ResolvedSettings;
}

export async function importExport(root: string, ctx: SyncContext, deps: ExportDeps): Promise<SlackSyncStats> {
  const { kv, settings } = deps;
  const exportUsers = await readJson<SlackUser[]>(join(root, "users.json"));
  if (exportUsers === undefined) throw new ConfigError("slack_export_invalid", `${root} does not look like a Slack export: users.json is missing`);

  // Merge into the cached map so the title extractor and later syncs see these users too.
  const users: UserMap = { ...((await kv.kvGet<UserMap>(KV_NAMESPACE, USERS_KEY)) ?? {}), ...toUserMap(exportUsers) };
  await kv.kvSet(KV_NAMESPACE, USERS_KEY, users);

  const groups: Array<[string, Partial<SlackChannel>]> = [
    ["channels.json", { is_channel: true }],
    ["groups.json", { is_private: true }],
    ["dms.json", { is_im: true }],
    ["mpims.json", { is_mpim: true }],
  ];
  const conversations: SlackChannel[] = [];
  for (const [file, flags] of groups) {
    for (const c of (await readJson<SlackChannel[]>(join(root, file))) ?? []) conversations.push({ ...c, ...flags });
  }

  const map: MapContext = { users, channelNames: new Map(), includeBots: settings.includeBots, selfIds: new Set(settings.selfUserIds) };
  for (const c of conversations) if (!isDM(channelKind(c)) && c.name) map.channelNames.set(c.id, c.name);
  const dms = dmsEnabled(settings, undefined);
  const stats = emptyStats();
  const ing = new Ingester(ctx, map, stats);

  for (const c of conversations.sort((a, b) => a.id.localeCompare(b.id))) {
    if (ctx.signal.aborted) break;
    const kind = channelKind(c);
    if (c.is_archived) continue;
    if (isDM(kind) ? !dms : !channelSelected(settings.channels, c.id, c.name)) continue;
    const dir = await folderFor(root, c);
    if (dir === undefined) {
      ctx.log.debug("slack export has no folder for conversation", { id: c.id, name: c.name });
      continue;
    }
    const channel: ChannelInfo = { id: c.id, kind, members: isDM(kind) ? (c.members ?? (c.user ? [c.user] : [])) : [] };
    if (c.name !== undefined) channel.name = c.name;
    stats.channels++;
    for (const msg of await readMessages(dir)) await ing.add(msg, channel);
    await ing.flush();
  }
  ing.report();
  ctx.log.info("slack export import finished", {
    path: root,
    channels: stats.channels,
    messages: stats.fetched,
    created: stats.created,
    duplicates: stats.emitted - stats.created,
    dropped: stats.dropped,
    dropReasons: stats.dropReasons,
  });
  return stats;
}
