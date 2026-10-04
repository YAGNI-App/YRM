import type { NewSourceEvent, Participant } from "@yrm/core";
import type { SlackChannel, SlackMessage, SlackUser } from "./api.ts";
import { normalizeMarkup } from "./markup.ts";
import { SOURCE_NAME } from "./settings.ts";

/** What we keep about a Slack user, cached in kv `slack/users`. */
export interface UserInfo {
  name: string;
  realName?: string;
  email?: string;
  title?: string;
  tz?: string;
  isBot: boolean;
  deleted: boolean;
}

export type UserMap = Record<string, UserInfo>;

export type ChannelKind = "channel" | "group" | "im" | "mpim";

export interface ChannelInfo {
  id: string;
  name?: string;
  kind: ChannelKind;
  /** Members, for DMs and group DMs only: they become `to` participants. */
  members: string[];
}

/** Everything `toSlackEvent` needs besides the message. */
export interface MapContext {
  users: UserMap;
  /** Channel names by id, for `<#C123>` references without a label. */
  channelNames: Map<string, string>;
  includeBots: boolean;
  /** User ids that are the tenant's own user: marked `self`, left out of DM titles. */
  selfIds: ReadonlySet<string>;
}

/** Subtypes that are channel housekeeping, not conversation. */
export const NOISE_SUBTYPES: ReadonlySet<string> = new Set([
  "channel_join",
  "channel_leave",
  "group_join",
  "group_leave",
  "channel_topic",
  "group_topic",
  "channel_purpose",
  "group_purpose",
  "channel_name",
  "group_name",
  "channel_archive",
  "channel_unarchive",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  // Only seen through the Events API, but an export can contain them; they would mutate history.
  "message_changed",
  "message_deleted",
]);

export const SLACKBOT = "USLACKBOT";

export function toUserInfo(u: SlackUser): UserInfo {
  const info: UserInfo = { name: u.name ?? u.id, isBot: u.is_bot === true || u.id === SLACKBOT, deleted: u.deleted === true };
  const realName = u.real_name || u.profile?.real_name || u.profile?.display_name;
  if (realName) info.realName = realName;
  if (u.profile?.email) info.email = u.profile.email.trim().toLowerCase();
  if (u.profile?.title) info.title = u.profile.title.trim();
  if (u.tz) info.tz = u.tz;
  return info;
}

export function toUserMap(users: SlackUser[]): UserMap {
  const map: UserMap = {};
  for (const u of users) map[u.id] = toUserInfo(u);
  return map;
}

export function channelKind(c: SlackChannel): ChannelKind {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  if (c.is_private || c.is_group) return "group";
  return "channel";
}

export function isDM(kind: ChannelKind): boolean {
  return kind === "im" || kind === "mpim";
}

export function displayName(users: UserMap, id: string): string | undefined {
  const u = users[id];
  return u ? u.realName || u.name : undefined;
}

export function isBotUser(users: UserMap, id: string): boolean {
  return id === SLACKBOT || users[id]?.isBot === true;
}

/** `1767225600.000200` to an ISO timestamp, keeping milliseconds. */
export function tsToIso(ts: string): string {
  return new Date(Math.floor(Number(ts) * 1000)).toISOString();
}

/** Why a message is dropped before it becomes an event, or null to keep it. */
export function dropReason(msg: SlackMessage, users: UserMap, includeBots: boolean): string | null {
  if (msg.subtype !== undefined && NOISE_SUBTYPES.has(msg.subtype)) return msg.subtype;
  if (includeBots) return null;
  if (msg.subtype === "bot_message") return "bot_message";
  if (msg.user === undefined) return msg.bot_id !== undefined ? "bot_message" : "no_user";
  if (isBotUser(users, msg.user)) return "bot_user";
  return null;
}

/** User ids a message refers to: author and mentions. Used to spot users missing from the cache. */
export function userIdsIn(msg: SlackMessage): string[] {
  const ids = new Set<string>();
  if (msg.user) ids.add(msg.user);
  for (const m of (msg.text ?? "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(m[1]!);
  return [...ids];
}

export function conversationTitle(channel: ChannelInfo, ctx: Pick<MapContext, "users" | "selfIds">): string {
  if (!isDM(channel.kind)) return `#${channel.name ?? channel.id}`;
  const others = channel.members.filter((m) => !ctx.selfIds.has(m));
  const shown = others.length > 0 ? others : channel.members;
  const names = shown.map((m) => displayName(ctx.users, m) ?? m);
  return names.length > 0 ? `DM with ${names.join(", ")}` : `DM ${channel.id}`;
}

export function threadKeyOf(channel: string, msg: Pick<SlackMessage, "ts" | "thread_ts">): string {
  return `${channel}:${msg.thread_ts ?? msg.ts}`;
}

/**
 * One Slack message to one event, or null when it is noise. Deterministic:
 * the API path and the export path give the same event for the same message.
 * Participants are addressed by email when Slack has one, so the header
 * resolver links them to the same person as their mail; otherwise by
 * `slack:<userId>`. `meta.slackUserIds` lines up with `participants`.
 */
export function toSlackEvent(msg: SlackMessage, channel: ChannelInfo, ctx: MapContext): NewSourceEvent | null {
  if (dropReason(msg, ctx.users, ctx.includeBots) !== null) return null;
  const { text, mentions } = normalizeMarkup(msg.text ?? "", {
    user: (id) => displayName(ctx.users, id),
    channel: (id) => ctx.channelNames.get(id),
  });

  const participants: Participant[] = [];
  const slackUserIds: string[] = [];
  const seen = new Set<string>();
  const add = (role: Participant["role"], id: string): void => {
    if (seen.has(`${role}\u0000${id}`)) return;
    if (role !== "from" && !ctx.includeBots && isBotUser(ctx.users, id)) return;
    seen.add(`${role}\u0000${id}`);
    const u = ctx.users[id];
    const p: Participant = { role, address: u?.email ?? `slack:${id}` };
    const name = displayName(ctx.users, id);
    if (name !== undefined) p.name = name;
    if (ctx.selfIds.has(id)) p.self = true;
    participants.push(p);
    slackUserIds.push(id);
  };
  const author = msg.user ?? msg.bot_id;
  if (author !== undefined) add("from", author);
  // Channel members are not recipients in any useful sense; DM members are.
  if (isDM(channel.kind)) for (const m of channel.members) if (m !== author) add("to", m);
  for (const m of mentions) if (m !== author) add("mentioned", m);

  const isReply = msg.thread_ts !== undefined && msg.thread_ts !== msg.ts;
  const meta: Record<string, unknown> = {
    channel: channel.id,
    channelName: channel.name ?? null,
    channelKind: channel.kind,
    ts: msg.ts,
    threadTs: msg.thread_ts ?? null,
    reactions: (msg.reactions ?? []).map((r) => ({ name: r.name, count: r.count ?? r.users?.length ?? 1 })),
    files: (msg.files ?? []).flatMap((f) => (f.name ?? f.title ? [f.name ?? f.title] : [])),
    edited: msg.edited?.ts ?? null,
    slackUserIds,
  };
  if (msg.subtype !== undefined) meta["subtype"] = msg.subtype;
  if (msg.reply_count !== undefined) meta["replyCount"] = msg.reply_count;

  const event: NewSourceEvent = {
    source: SOURCE_NAME,
    kind: "message",
    externalId: `${channel.id}:${msg.ts}`,
    occurredAt: tsToIso(msg.ts),
    participants,
    content: { text, title: conversationTitle(channel, ctx), mime: "text/plain" },
    threadKey: threadKeyOf(channel.id, msg),
    meta,
  };
  if (isReply) event.inReplyTo = [`${channel.id}:${msg.thread_ts}`];
  return event;
}
