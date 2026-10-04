import type { Server } from "bun";
import { verifyPkce } from "../src/oauth.ts";

/**
 * An in-process stand-in for the Gmail REST API and Google's token endpoint,
 * just faithful enough for sync: bearer auth, list pagination, raw messages,
 * history with expiry, scripted 429s.
 */

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** RFC 822 text. */
  eml: string;
}

export class FakeGmail {
  readonly messages: FakeMessage[] = [];
  /** History records: each adds one message. */
  readonly history: Array<{ id: number; message: FakeMessage }> = [];
  historyId = 100;
  /** `startHistoryId` below this answers 404, like an expired id. */
  historyFloor = 0;
  /** Results per list page, whatever maxResults says, to force pagination. */
  pageSize = 5;
  readonly validTokens = new Set<string>();
  refreshToken = "rt-1";
  refreshes = 0;
  /** Message ids whose next `get` answers 429 once. */
  readonly throttleOnce = new Set<string>();
  throttled = 0;
  /** Authorization codes issued, with the PKCE challenge they were bound to. */
  readonly codes = new Map<string, string>();
  readonly requests: URL[] = [];
  readonly gets: string[] = [];
  email = "jack@yagni.example";
  private server: Server<undefined> | null = null;

  get base(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  add(msg: FakeMessage, viaHistory = false): void {
    this.messages.push(msg);
    this.historyId++;
    if (viaHistory) this.history.push({ id: this.historyId, message: msg });
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    if (form.get("client_id") !== "client-1" || form.get("client_secret") !== "secret-1") return this.json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") !== this.refreshToken) return this.json({ error: "invalid_grant" }, 400);
      const token = `at-${++this.refreshes}`;
      this.validTokens.add(token);
      return this.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "authorization_code") {
      const challenge = this.codes.get(form.get("code") ?? "");
      if (challenge === undefined || !verifyPkce(form.get("code_verifier") ?? "", challenge)) return this.json({ error: "invalid_grant" }, 400);
      this.validTokens.add("at-login");
      return this.json({ access_token: "at-login", refresh_token: this.refreshToken, expires_in: 3599 });
    }
    return this.json({ error: "unsupported_grant_type" }, 400);
  }

  private handle(req: Request): Response | Promise<Response> {
    const url = new URL(req.url);
    this.requests.push(url);
    if (url.pathname === "/token" && req.method === "POST") return this.token(req);

    const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validTokens.has(auth)) return this.json({ error: { code: 401, message: "Invalid Credentials" } }, 401);

    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    const q = url.searchParams;
    if (path === "/profile") return this.json({ emailAddress: this.email, historyId: String(this.historyId), messagesTotal: this.messages.length });

    if (path === "/messages") {
      const labels = q.getAll("labelIds");
      const matching = this.messages.filter((m) => labels.every((l) => m.labelIds.includes(l)));
      const offset = Number(q.get("pageToken") ?? "0");
      const size = Math.min(this.pageSize, Number(q.get("maxResults") ?? "100"));
      const page = matching.slice(offset, offset + size);
      const body: Record<string, unknown> = { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: matching.length };
      if (offset + size < matching.length) body["nextPageToken"] = String(offset + size);
      return this.json(body);
    }

    const get = /^\/messages\/([^/]+)$/.exec(path);
    if (get) {
      const id = decodeURIComponent(get[1]!);
      if (this.throttleOnce.delete(id)) {
        this.throttled++;
        return this.json({ error: { code: 429, message: "Too many concurrent requests for user" } }, 429, { "retry-after": "0" });
      }
      const m = this.messages.find((x) => x.id === id);
      if (!m) return this.json({ error: { code: 404 } }, 404);
      this.gets.push(id);
      return this.json({
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        internalDate: "1767225600000",
        raw: Buffer.from(m.eml, "utf-8").toString("base64url"),
      });
    }

    if (path === "/history") {
      const start = Number(q.get("startHistoryId"));
      if (start < this.historyFloor) return this.json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
      const records = this.history.filter((h) => h.id > start);
      const offset = Number(q.get("pageToken") ?? "0");
      const page = records.slice(offset, offset + 2);
      const body: Record<string, unknown> = {
        historyId: String(this.historyId),
        history: page.map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.message.id, threadId: h.message.threadId, labelIds: h.message.labelIds } }] })),
      };
      if (offset + 2 < records.length) body["nextPageToken"] = String(offset + 2);
      return this.json(body);
    }

    return this.json({ error: { code: 404 } }, 404);
  }
}
