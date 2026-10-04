import type { NewSourceEvent, Store, SyncContext } from "@yrm/core";
import { SlackApiError, type SlackChannel, type SlackClient, type SlackMessage } from "./api.ts";
import {
  channelKind,
  dropReason,
  isDM,
  toSlackEvent,
  toUserMap,
  userIdsIn,
  type ChannelInfo,
  type MapContext,
  type UserMap,
} from "./convert.ts";
import {
  AUTH_KEY,
  channelSelected,
  CHANNELS_KEY,
  cursorKey,
  dmsEnabled,
  KV_NAMESPACE,
  LAST_SYNC_KEY,
  USERS_KEY,
  type ResolvedSettings,
} from "./settings.ts";

/** Events handed to the host per `emit` call. */
export const EMIT_BATCH = 50;

/** Errors that mean "this channel is not readable with this token", not "the sync failed". */
const UNREADABLE = new Set(["not_in_channel", "channel_not_found", "missing_scope", "is_archived"]);

export type Kv = Pick<Store, "kvGet" | "kvSet" | "kvDelete">;

/** What `auth.test` said, kept for `slack:status` and for knowing who "self" is. */
export interface StoredAuth {
  team?: string;
  teamId?: string;
  userId?: string;
  url?: string;
  tokenType: "bot" | "user";
}

/** A channel as `slack:status` lists it. */
export interface SyncedChannel {
  id: string;
  name?: string;
  kind: ChannelInfo["kind"];
}

/** The JSON kept in `SyncContext.cursor`: a summary of the per-channel kv cursors. */
export interface CursorSummary {
  v: 1;
  channels: Record<string, string>;
}

export interface SlackSyncStats {
  channels: number;
  fetched: number;
  emitted: number;
  created: number;
  dropped: number;
  dropReasons: Record<string, number>;
  /** Channels the token could not read. */
  skipped: number;
  /** True when `maxPerSync` stopped the run; the next sync continues. */
  partial: boolean;
}

export function emptyStats(): SlackSyncStats {
  return { channels: 0, fetched: 0, emitted: 0, created: 0, dropped: 0, dropReasons: {}, skipped: 0, partial: false };
}

export function parseCursor(raw: string | null): CursorSummary {
  if (!raw) return { v: 1, channels: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<CursorSummary>;
    if (parsed && typeof parsed.channels === "object" && parsed.channels !== null) return { v: 1, channels: { ...parsed.channels } };
  } catch {
    // A cursor from another format: start over; events are idempotent.
  }
  return { v: 1, channels: {} };
}

/** Order Slack timestamps exactly; `Number()` loses the last microsecond digits. */
export function compareTs(a: string, b: string): number {
  const [as = "0", af = ""] = a.split(".");
  const [bs = "0", bf = ""] = b.split(".");
  const s = Number(as) - Number(bs);
  if (s !== 0) return s;
  return af.padEnd(6, "0").localeCompare(bf.padEnd(6, "0"));
}

export const byTs = (a: SlackMessage, b: SlackMessage): number => compareTs(a.ts, b.ts);

/** Maps, filters, batches and emits messages; counts what it drops. Shared by sync and export import. */
export class Ingester {
  private batch: NewSourceEvent[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly ctx: SyncContext,
    readonly map: MapContext,
    readonly stats: SlackSyncStats,
  ) {}

  async add(msg: SlackMessage, channel: ChannelInfo): Promise<void> {
    const key = `${channel.id}:${msg.ts}`;
    // A thread_broadcast reply shows up in both history and replies.
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.stats.fetched++;
    const reason = dropReason(msg, this.map.users, this.map.includeBots);
    if (reason !== null) {
      this.stats.dropped++;
      this.stats.dropReasons[reason] = (this.stats.dropReasons[reason] ?? 0) + 1;
      return;
    }
    const event = toSlackEvent(msg, channel, this.map);
    if (event) this.batch.push(event);
    if (this.batch.length >= EMIT_BATCH) await this.flush();
  }

  async flush(): Promise<void> {
    while (this.batch.length > 0) {
      const chunk = this.batch.splice(0, EMIT_BATCH);
      this.stats.emitted += chunk.length;
      this.stats.created += (await this.ctx.emit(chunk)).length;
    }
  }

  /** Tell the host what was filtered, if it listens. */
  report(): void {
    if (this.stats.dropped > 0 || this.stats.skipped > 0) this.ctx.report?.({ dropped: this.stats.dropped, skipped: this.stats.skipped });
  }
}

export async function refreshUsers(client: SlackClient, kv: Kv): Promise<UserMap> {
  const users = toUserMap(await client.listUsers());
  await kv.kvSet(KV_NAMESPACE, USERS_KEY, users);
  return users;
}

export interface SyncDeps {
  client: SlackClient;
  kv: Kv;
  settings: ResolvedSettings;
}

function selfIdsFor(settings: ResolvedSettings, auth: StoredAuth): Set<string> {
  const ids = new Set(settings.selfUserIds);
  // A user token acts as you; a bot token's user is the bot.
  if (auth.tokenType === "user" && auth.userId) ids.add(auth.userId);
  return ids;
}

/**
 * One sync run. For each selected conversation, read history after its kv
 * cursor, oldest first, fetching each thread's replies right after its
 * parent. The cursor only moves past a parent once its whole thread is in
 * the log, so a run cut short by `maxPerSync` or an abort resumes cleanly.
 */
export async function syncSlack(ctx: SyncContext, deps: SyncDeps): Promise<SlackSyncStats> {
  const { client, kv, settings } = deps;
  const stats = emptyStats();
  const token = settings.token;
  const info = await client.authTest();
  const auth: StoredAuth = { tokenType: token?.startsWith("xoxb-") ? "bot" : "user" };
  if (info.team) auth.team = info.team;
  if (info.team_id) auth.teamId = info.team_id;
  if (info.user_id) auth.userId = info.user_id;
  if (info.url) auth.url = info.url;
  await kv.kvSet(KV_NAMESPACE, AUTH_KEY, auth);

  let users = (await kv.kvGet<UserMap>(KV_NAMESPACE, USERS_KEY)) ?? (await refreshUsers(client, kv));
  let refreshed = false;
  const map: MapContext = { users, channelNames: new Map(), includeBots: settings.includeBots, selfIds: selfIdsFor(settings, auth) };
  const ing = new Ingester(ctx, map, stats);
  /** Refresh the user map at most once per run, when a message names someone we have not seen. */
  const ensureUsers = async (ids: string[]): Promise<void> => {
    if (refreshed || ids.every((id) => users[id] !== undefined)) return;
    refreshed = true;
    ctx.log.debug("unknown slack user; refreshing the user map", { ids: ids.filter((id) => users[id] === undefined) });
    users = await refreshUsers(client, kv);
    map.users = users;
  };

  const dms = dmsEnabled(settings, token);
  const types = ["public_channel", "private_channel", ...(dms ? ["im", "mpim"] : [])];
  const all = await client.listConversations(types);
  for (const c of all) if (!isDM(channelKind(c)) && c.name) map.channelNames.set(c.id, c.name);
  const selected = all
    .filter((c) => !c.is_archived)
    .filter((c) => (isDM(channelKind(c)) ? dms : channelSelected(settings.channels, c.id, c.name)))
    .sort((a, b) => a.id.localeCompare(b.id));

  const summary = parseCursor(ctx.cursor);
  const synced: SyncedChannel[] = [];
  let budget = settings.maxPerSync;

  for (const c of selected) {
    if (ctx.signal.aborted) break;
    if (budget <= 0) {
      stats.partial = true;
      break;
    }
    const channel = await channelInfo(client, c);
    const oldest = (await kv.kvGet<string>(KV_NAMESPACE, cursorKey(c.id))) ?? summary.channels[c.id];
    let messages: SlackMessage[];
    try {
      messages = (await client.history(c.id, oldest)).sort(byTs);
    } catch (err) {
      if (err instanceof SlackApiError && UNREADABLE.has(err.error)) {
        ctx.log.warn("slack channel not readable with this token; skipping", { channel: c.id, name: c.name, error: err.error });
        stats.skipped++;
        continue;
      }
      throw err;
    }
    stats.channels++;
    synced.push(channel.name !== undefined ? { id: c.id, name: channel.name, kind: channel.kind } : { id: c.id, kind: channel.kind });
    if (isDM(channel.kind)) await ensureUsers(channel.members);

    let last = oldest;
    for (const msg of messages) {
      if (ctx.signal.aborted) break;
      if (budget <= 0) {
        stats.partial = true;
        break;
      }
      await ensureUsers(userIdsIn(msg));
      await ing.add(msg, channel);
      budget--;
      const isParent = (msg.reply_count ?? 0) > 0 && (msg.thread_ts === undefined || msg.thread_ts === msg.ts);
      if (isParent) {
        const thread = (await client.replies(c.id, msg.ts)).filter((r) => r.ts !== msg.ts).sort(byTs);
        for (const reply of thread) {
          await ensureUsers(userIdsIn(reply));
          await ing.add(reply, channel);
          budget--;
        }
      }
      last = msg.ts;
    }
    await ing.flush();
    if (last !== undefined && last !== oldest) {
      await kv.kvSet(KV_NAMESPACE, cursorKey(c.id), last);
      summary.channels[c.id] = last;
      await ctx.setCursor(JSON.stringify(summary));
    }
  }

  await ing.flush();
  const previous = (await kv.kvGet<SyncedChannel[]>(KV_NAMESPACE, CHANNELS_KEY)) ?? [];
  const merged = new Map(previous.map((c) => [c.id, c]));
  for (const c of synced) merged.set(c.id, c);
  await kv.kvSet(KV_NAMESPACE, CHANNELS_KEY, [...merged.values()]);
  await kv.kvSet(KV_NAMESPACE, LAST_SYNC_KEY, new Date().toISOString());
  ing.report();
  ctx.log.info("slack sync finished", {
    channels: stats.channels,
    fetched: stats.fetched,
    created: stats.created,
    duplicates: stats.emitted - stats.created,
    dropped: stats.dropped,
    dropReasons: stats.dropReasons,
    skipped: stats.skipped,
    partial: stats.partial,
    requests: client.requests,
    retries: client.retries,
  });
  return stats;
}

/** DMs need their members (they become `to`); channels do not. */
async function channelInfo(client: SlackClient, c: SlackChannel): Promise<ChannelInfo> {
  const kind = channelKind(c);
  const info: ChannelInfo = { id: c.id, kind, members: [] };
  if (c.name !== undefined) info.name = c.name;
  if (isDM(kind)) info.members = c.members ?? (await client.members(c.id));
  return info;
}
