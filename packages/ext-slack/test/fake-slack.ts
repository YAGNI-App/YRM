import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import type { SlackChannel, SlackMessage, SlackUser } from "../src/api.ts";
import { compareTs } from "../src/sync.ts";

export const EXPORT_DIR = join(import.meta.dir, "fixtures/export");

const read = <T>(file: string): T => JSON.parse(readFileSync(join(EXPORT_DIR, file), "utf-8")) as T;

/**
 * An in-process stand-in for the Slack Web API, built from the same synthetic
 * export the import tests read, so both paths see identical data. Faithful
 * enough for sync: bearer auth, `ok: false` errors, cursor pagination, an
 * exclusive `oldest`, newest-first history, and scripted 429s.
 */
export class FakeSlack {
  users: SlackUser[] = read<SlackUser[]>("users.json");
  readonly conversations: SlackChannel[] = [];
  /** Every message per conversation id, replies included, as the export has them. */
  readonly messages = new Map<string, SlackMessage[]>();
  token = "xoxp-test";
  authUserId = "U01JACK";
  /** Page sizes, small to force pagination. */
  userPage = 4;
  historyPage = 2;
  /** Methods whose next call answers 429 once. */
  readonly throttleOnce = new Set<string>();
  throttled = 0;
  readonly requests: URL[] = [];
  private server: Server<undefined> | null = null;

  constructor() {
    const groups: Array<[string, Partial<SlackChannel>]> = [
      ["channels.json", { is_channel: true }],
      ["dms.json", { is_im: true }],
      ["mpims.json", { is_mpim: true }],
    ];
    for (const [file, flags] of groups) {
      for (const c of read<SlackChannel[]>(file)) {
        const { members, ...rest } = c;
        const conv: SlackChannel & { _members?: string[] } = { ...rest, ...flags };
        if (flags.is_im) conv.user = members?.find((m) => m !== this.authUserId) ?? "";
        conv._members = members ?? [];
        this.conversations.push(conv);
        const dir = join(EXPORT_DIR, c.name ?? c.id);
        const msgs = readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as SlackMessage[]);
        this.messages.set(c.id, msgs);
      }
    }
  }

  get base(): string {
    return `http://127.0.0.1:${this.server!.port}/api`;
  }

  add(channel: string, msg: SlackMessage): void {
    this.messages.get(channel)!.push(msg);
  }

  calls(method: string): URL[] {
    return this.requests.filter((u) => u.pathname === `/api/${method}`);
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private json(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private page<T>(items: T[], q: URLSearchParams, size: number): { slice: T[]; meta: { next_cursor: string } } {
    const offset = Number(q.get("cursor") ?? "0");
    const slice = items.slice(offset, offset + size);
    return { slice, meta: { next_cursor: offset + size < items.length ? String(offset + size) : "" } };
  }

  private handle(req: Request): Response {
    const url = new URL(req.url);
    this.requests.push(url);
    const method = url.pathname.replace(/^\/api\//, "");
    const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (auth !== this.token) return this.json({ ok: false, error: "invalid_auth" });
    if (this.throttleOnce.delete(method)) {
      this.throttled++;
      return this.json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" });
    }
    const q = url.searchParams;

    switch (method) {
      case "auth.test":
        return this.json({ ok: true, team: "Yagni", team_id: "T01", user: "jack", user_id: this.authUserId, url: "https://yagni.slack.com/" });
      case "users.list": {
        const { slice, meta } = this.page(this.users, q, this.userPage);
        return this.json({ ok: true, members: slice, response_metadata: meta });
      }
      case "conversations.list": {
        const types = new Set((q.get("types") ?? "public_channel").split(","));
        const wanted = this.conversations.filter(
          (c) => (c.is_im ? types.has("im") : c.is_mpim ? types.has("mpim") : c.is_private ? types.has("private_channel") : types.has("public_channel")),
        );
        const { slice, meta } = this.page(
          wanted.map(({ _members, ...c }: SlackChannel & { _members?: string[] }) => c),
          q,
          100,
        );
        return this.json({ ok: true, channels: slice, response_metadata: meta });
      }
      case "conversations.members": {
        const c = this.conversations.find((x) => x.id === q.get("channel")) as (SlackChannel & { _members?: string[] }) | undefined;
        if (!c) return this.json({ ok: false, error: "channel_not_found" });
        return this.json({ ok: true, members: c._members ?? [], response_metadata: { next_cursor: "" } });
      }
      case "conversations.history": {
        const msgs = this.messages.get(q.get("channel") ?? "");
        if (!msgs) return this.json({ ok: false, error: "channel_not_found" });
        const oldest = q.get("oldest");
        const top = msgs
          .filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts)
          .filter((m) => oldest === null || compareTs(m.ts, oldest) > 0)
          .sort((a, b) => compareTs(b.ts, a.ts));
        const { slice, meta } = this.page(top, q, this.historyPage);
        return this.json({ ok: true, messages: slice, has_more: meta.next_cursor !== "", response_metadata: meta });
      }
      case "conversations.replies": {
        const msgs = this.messages.get(q.get("channel") ?? "");
        const ts = q.get("ts");
        if (!msgs || !ts) return this.json({ ok: false, error: "thread_not_found" });
        const thread = msgs.filter((m) => m.ts === ts || m.thread_ts === ts).sort((a, b) => compareTs(a.ts, b.ts));
        const { slice, meta } = this.page(thread, q, 2);
        return this.json({ ok: true, messages: slice, response_metadata: meta });
      }
      default:
        return this.json({ ok: false, error: "unknown_method" });
    }
  }
}
