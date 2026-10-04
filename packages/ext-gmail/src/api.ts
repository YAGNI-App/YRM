import { YrmError } from "@yrm/core";

/**
 * A thin Gmail REST client over `fetch`: the handful of endpoints sync needs,
 * bearer auth with one refresh on 401, and backoff on rate limits.
 */

export class GmailHttpError extends YrmError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`gmail_http_${status}`, message);
  }
}

export interface Profile {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
}

export interface MessageRef {
  id: string;
  threadId?: string;
}

export interface MessageList {
  messages?: MessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface RawMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  historyId?: string;
  /** Milliseconds since epoch, as a string. */
  internalDate?: string;
  /** The RFC 822 message, base64url. */
  raw: string;
}

export interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
}

export interface HistoryList {
  history?: HistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

export interface TokenSource {
  accessToken(): Promise<string>;
  refresh(): Promise<{ access_token: string }>;
}

export interface ClientOptions {
  apiBase: string;
  tokens: TokenSource;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for rate limits and 5xx. Default 5. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 32_000;
export const MAX_RETRIES = 5;

/**
 * Delay before retry `attempt` (0-based): `Retry-After` when the server gave
 * one, else base * 2^attempt capped at max. Deterministic, so tests can pin it.
 */
export function backoffDelay(attempt: number, retryAfter?: string | null, baseMs = BASE_DELAY_MS, maxMs = MAX_DELAY_MS): number {
  if (retryAfter !== undefined && retryAfter !== null && retryAfter.trim() !== "") {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, maxMs);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), maxMs);
  }
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/** 403 with a rate-limit reason is Gmail's other way of saying 429. */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body);
}

/** Query strings for `users.messages.list`. Exported for tests. */
export function listParams(opts: { labelId?: string; query?: string; pageToken?: string; maxResults: number }): URLSearchParams {
  const p = new URLSearchParams();
  if (opts.labelId) p.append("labelIds", opts.labelId);
  if (opts.query) p.set("q", opts.query);
  if (opts.pageToken) p.set("pageToken", opts.pageToken);
  p.set("maxResults", String(Math.max(1, Math.min(500, opts.maxResults))));
  p.set("includeSpamTrash", "false");
  return p;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GmailClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Count of retries taken, for logs and tests. */
  retries = 0;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private url(path: string, params?: URLSearchParams): string {
    const qs = params && [...params.keys()].length > 0 ? `?${params}` : "";
    return `${this.opts.apiBase}/gmail/v1/users/me${path}${qs}`;
  }

  async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? MAX_RETRIES;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.accessToken();
      const init: RequestInit = { headers: { authorization: `Bearer ${token}`, accept: "application/json" } };
      if (this.opts.signal) init.signal = this.opts.signal;
      const res = await this.fetchImpl(this.url(path, params), init);
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.opts.tokens.refresh();
        attempt--;
        continue;
      }
      if ((isRateLimited(res.status, body) || res.status >= 500) && attempt < maxRetries) {
        this.retries++;
        await this.sleep(backoffDelay(attempt, res.headers.get("retry-after"), this.opts.baseDelayMs, this.opts.maxDelayMs));
        continue;
      }
      throw new GmailHttpError(res.status, `Gmail ${path} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }

  getProfile(): Promise<Profile> {
    return this.request<Profile>("/profile");
  }

  listMessages(opts: { labelId?: string; query?: string; pageToken?: string; maxResults: number }): Promise<MessageList> {
    return this.request<MessageList>("/messages", listParams(opts));
  }

  getRaw(id: string): Promise<RawMessage> {
    return this.request<RawMessage>(`/messages/${encodeURIComponent(id)}`, new URLSearchParams({ format: "raw" }));
  }

  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryList> {
    const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
    if (pageToken) p.set("pageToken", pageToken);
    return this.request<HistoryList>("/history", p);
  }
}
