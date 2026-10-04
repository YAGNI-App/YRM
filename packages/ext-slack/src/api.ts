import { YrmError } from "@yrm/core";

/**
 * A thin Slack Web API client over `fetch`: the read methods sync needs,
 * cursor pagination, and backoff on 429. No Slack SDK.
 */

/** Slack answered `ok: false` (or a non-retryable HTTP error). `code` is Slack's error string. */
export class SlackApiError extends YrmError {
  constructor(
    readonly error: string,
    readonly method: string,
    message: string,
  ) {
    super(`slack_${error}`, message);
  }
}

/** A user as `users.list` and an export's `users.json` describe it (only the fields we read). */
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: {
    email?: string;
    title?: string;
    real_name?: string;
    display_name?: string;
  };
}

/** A conversation from `conversations.list`, or `channels.json`/`groups.json`/`dms.json`/`mpims.json`. */
export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  /** For IMs: the other member. */
  user?: string;
  /** Exports list members inline. */
  members?: string[];
}

export interface SlackFile {
  name?: string;
  title?: string;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count?: number; users?: string[] }>;
  files?: SlackFile[];
  edited?: { user?: string; ts?: string };
}

export interface AuthInfo {
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
  url?: string;
}

interface Page {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

export interface ClientOptions {
  apiBase: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for 429 and 5xx. Default 5. */
  maxRetries?: number;
  signal?: AbortSignal;
}

export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 60_000;
export const MAX_RETRIES = 5;

/**
 * Delay before retry `attempt` (0-based). Slack sends `Retry-After` in seconds
 * on every 429 and expects it honored; without one, back off exponentially.
 */
export function backoffDelay(attempt: number, retryAfter?: string | null, baseMs = BASE_DELAY_MS, maxMs = MAX_DELAY_MS): number {
  if (retryAfter !== undefined && retryAfter !== null && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, maxMs);
  }
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SlackClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Retries taken and requests made, for logs and tests. */
  retries = 0;
  requests = 0;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async call<T extends Page>(method: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
    const url = `${this.opts.apiBase}/${method}${[...qs.keys()].length > 0 ? `?${qs}` : ""}`;
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES;
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { headers: { authorization: `Bearer ${this.opts.token}`, accept: "application/json" } };
      if (this.opts.signal) init.signal = this.opts.signal;
      this.requests++;
      const res = await this.fetchImpl(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        this.retries++;
        await res.body?.cancel();
        await this.sleep(backoffDelay(attempt, res.headers.get("retry-after")));
        continue;
      }
      if (!res.ok) throw new SlackApiError(`http_${res.status}`, method, `Slack ${method} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as T;
      if (!body.ok) {
        const error = body.error ?? "unknown_error";
        if (error === "ratelimited" && attempt < maxRetries) {
          this.retries++;
          await this.sleep(backoffDelay(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw new SlackApiError(error, method, `Slack ${method} failed: ${error}`);
      }
      return body;
    }
  }

  /** Follow `response_metadata.next_cursor` until it runs out. */
  async *paginate<T extends Page, I>(method: string, params: Record<string, string | undefined>, items: (page: T) => I[] | undefined): AsyncGenerator<I[]> {
    let cursor: string | undefined;
    do {
      const page = await this.call<T>(method, cursor ? { ...params, cursor } : params);
      yield items(page) ?? [];
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor && !this.opts.signal?.aborted);
  }

  async authTest(): Promise<AuthInfo> {
    return this.call<Page & AuthInfo>("auth.test");
  }

  async listUsers(): Promise<SlackUser[]> {
    const out: SlackUser[] = [];
    for await (const page of this.paginate<Page & { members?: SlackUser[] }, SlackUser>("users.list", { limit: "200" }, (p) => p.members)) out.push(...page);
    return out;
  }

  async listConversations(types: string[]): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    const params = { types: types.join(","), exclude_archived: "true", limit: "200" };
    for await (const page of this.paginate<Page & { channels?: SlackChannel[] }, SlackChannel>("conversations.list", params, (p) => p.channels)) out.push(...page);
    return out;
  }

  async members(channel: string): Promise<string[]> {
    const out: string[] = [];
    for await (const page of this.paginate<Page & { members?: string[] }, string>("conversations.members", { channel, limit: "200" }, (p) => p.members)) out.push(...page);
    return out;
  }

  /** Top-level messages after `oldest` (exclusive), every page. Slack returns them newest first. */
  async history(channel: string, oldest: string | undefined): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    const params = { channel, oldest, limit: "200" };
    for await (const page of this.paginate<Page & { messages?: SlackMessage[] }, SlackMessage>("conversations.history", params, (p) => p.messages)) out.push(...page);
    return out;
  }

  /** A thread: the parent first, then replies. */
  async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    const params = { channel, ts, limit: "200" };
    for await (const page of this.paginate<Page & { messages?: SlackMessage[] }, SlackMessage>("conversations.replies", params, (p) => p.messages)) out.push(...page);
    return out;
  }
}
