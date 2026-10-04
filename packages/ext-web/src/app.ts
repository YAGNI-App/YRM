import { StoreError, YrmError, todayIn } from "@yrm/core";
import type { View } from "./components.ts";
import {
  dismissItem,
  earliestDay,
  entityPage,
  entitySummary,
  eventPage,
  factsPage,
  mergeEntities,
  mergeSuggestions,
  orgDirectory,
  peopleDirectory,
  RankCache,
  setEntityStatus,
  threadPage,
  timeMachine,
  todayPage,
  type TimeMachine,
  type WebDeps,
} from "./data.ts";
import type { Html } from "./html.ts";
import { entityView, eventView, factsView, messagePage, orgsView, peopleView, threadView, todayView } from "./pages.ts";
import {
  CSRF_COOKIE,
  CSRF_FIELD,
  CSRF_HEADER,
  csrfCookie,
  hostAllowed,
  newToken,
  readCookie,
  sameOrigin,
  SECURITY_HEADERS,
  tokensMatch,
} from "./security.ts";
import { isDate, parseWhen } from "./time.ts";

export interface WebAppOptions {
  /** Refuse non-loopback Host headers (set when bound to a loopback address). Default true. */
  loopbackOnly?: boolean;
}

export interface WebApp {
  fetch(req: Request): Promise<Response>;
  /** Ranked queues kept per date; cleared by writes and by "Re-rank". */
  rankCache: RankCache;
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/static/styles.css": { file: "./static/styles.css", type: "text/css; charset=utf-8" },
  "/static/app.js": { file: "./static/app.js", type: "text/javascript; charset=utf-8" },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Req {
  req: Request;
  url: URL;
  csrf: string;
}

export function createWebApp(deps: WebDeps, opts: WebAppOptions = {}): WebApp {
  const loopbackOnly = opts.loopbackOnly ?? true;
  const rankCache = new RankCache();
  const staticCache = new Map<string, string>();

  async function staticFile(path: string): Promise<Response | null> {
    const entry = STATIC[path];
    if (!entry) return null;
    let body = staticCache.get(path);
    if (body === undefined) {
      body = await Bun.file(new URL(entry.file, import.meta.url)).text();
      staticCache.set(path, body);
    }
    return new Response(body, { headers: { "content-type": entry.type, "cache-control": "no-cache" } });
  }

  function view(r: Req): View {
    const tz = deps.timezone();
    const today = todayIn(tz, deps.now());
    return { tz, csrf: r.csrf, today, earliest: today, path: r.url.pathname, here: `${r.url.pathname}${r.url.search}` };
  }

  async function fullView(r: Req): Promise<View> {
    const v = view(r);
    v.earliest = await earliestDay(deps, v.tz);
    return v;
  }

  function travel(r: Req): TimeMachine {
    const tz = deps.timezone();
    const valid = parseWhen(r.url.searchParams.get("validAt"), tz);
    const asOf = parseWhen(r.url.searchParams.get("asOf"), tz);
    if (valid.error) throw new HttpError(400, `validAt: ${valid.error}`);
    if (asOf.error) throw new HttpError(400, `asOf: ${asOf.error}`);
    return timeMachine(deps.now().toISOString(), tz, valid, asOf);
  }

  function queueDate(r: Req): string {
    const d = r.url.searchParams.get("date");
    if (d === null || d === "") return todayIn(deps.timezone(), deps.now());
    if (!isDate(d)) throw new HttpError(400, `date must be YYYY-MM-DD, got "${d}"`);
    return d;
  }

  // ---- GET -----------------------------------------------------------------

  type Handler = (r: Req, params: string[]) => Promise<Response>;
  const page = (render: (r: Req, params: string[]) => Promise<Html>): Handler => async (r, params) => htmlResponse(await render(r, params));

  const routes: Array<[RegExp, Handler]> = [
    [
      /^\/$/,
      page(async (r) => todayView(await fullView(r), await todayPage(deps, rankCache, queueDate(r)))),
    ],
    [/^\/api\/today$/, async (r) => json(await todayPage(deps, rankCache, queueDate(r)))],
    [
      /^\/people$/,
      page(async (r) => {
        const { groups, rejected } = await peopleDirectory(deps);
        return peopleView(view(r), groups, rejected, await mergeSuggestions(deps));
      }),
    ],
    [/^\/orgs$/, page(async (r) => orgsView(view(r), await orgDirectory(deps)))],
    [
      /^\/api\/entities$/,
      async (r) => {
        const kind = r.url.searchParams.get("kind");
        const status = r.url.searchParams.get("status");
        const q = r.url.searchParams.get("q");
        const query: Parameters<typeof deps.store.findEntities>[0] = { tenantId: deps.tenantId };
        if (kind) query.kind = kind;
        if (status) query.status = status as NonNullable<typeof query.status>;
        if (q) query.nameLike = q;
        const entities = (await deps.store.findEntities(query)).map(entitySummary);
        return json({ count: entities.length, entities, suggestions: await mergeSuggestions(deps) });
      },
    ],
    [
      /^\/entity\/([^/]+)$/,
      page(async (r, [id]) => {
        const data = await entityPage(deps, id!, travel(r));
        if (!data) throw new HttpError(404, `No entity ${id}.`);
        return entityView(await fullView(r), data);
      }),
    ],
    [
      /^\/api\/entity\/([^/]+)$/,
      async (r, [id]) => {
        const data = await entityPage(deps, id!, travel(r));
        if (!data) throw new HttpError(404, `No entity ${id}.`);
        return json(data);
      },
    ],
    [
      /^\/facts$/,
      page(async (r) => {
        const f = factsFilter(r);
        const data = await factsPage(deps, f);
        return factsView(await fullView(r), data.facts, f, data.predicates, data.truncated);
      }),
    ],
    [/^\/api\/facts$/, async (r) => json(await factsPage(deps, factsFilter(r)))],
    [
      /^\/event\/([^/]+)$/,
      page(async (r, [id]) => {
        const e = await deps.store.getEvent(id!);
        if (!e) throw new HttpError(404, `No event ${id}.`);
        return eventView(view(r), await eventPage(deps, e));
      }),
    ],
    [
      /^\/api\/event\/([^/]+)$/,
      async (_r, [id]) => {
        const e = await deps.store.getEvent(id!);
        if (!e) throw new HttpError(404, `No event ${id}.`);
        return json(await eventPage(deps, e));
      },
    ],
    [
      /^\/thread\/(.+)$/,
      page(async (r, [key]) => {
        const list = await threadPage(deps, key!);
        if (list.length === 0) throw new HttpError(404, `No thread ${key}.`);
        return threadView(view(r), key!, list);
      }),
    ],
    [
      /^\/api\/thread\/(.+)$/,
      async (_r, [key]) => {
        const list = await threadPage(deps, key!);
        if (list.length === 0) throw new HttpError(404, `No thread ${key}.`);
        return json({ threadKey: key, events: list });
      },
    ],
  ];

  function factsFilter(r: Req) {
    const sp = r.url.searchParams;
    const f: { type?: string; predicate?: string; q?: string; tm: TimeMachine } = { tm: travel(r) };
    const type = sp.get("type");
    const predicate = sp.get("predicate");
    const q = sp.get("q");
    if (type) f.type = type;
    if (predicate) f.predicate = predicate.trim();
    if (q) f.q = q;
    return f;
  }

  // ---- POST ----------------------------------------------------------------

  type Action = (body: Record<string, string>, params: string[]) => Promise<unknown>;

  const actions: Array<[RegExp, Action]> = [
    [
      /^\/api\/entity\/([^/]+)\/(confirm|reject)$/,
      async (_b, [id, verb]) => {
        const e = await setEntityStatus(deps, id!, verb === "confirm" ? "confirmed" : "rejected");
        if (!e) throw new HttpError(404, `No entity ${id}.`);
        rankCache.clear();
        return { entity: entitySummary(e) };
      },
    ],
    [
      /^\/api\/merge$/,
      async (b) => {
        if (!b["from"] || !b["into"]) throw new HttpError(400, "merge needs `from` and `into` entity ids");
        const { from, into } = await mergeEntities(deps, b["from"], b["into"]);
        rankCache.clear();
        return { from: entitySummary(from), into: entitySummary(into) };
      },
    ],
    [
      /^\/api\/dismiss$/,
      async (b) => {
        const key = b["key"];
        if (!key) throw new HttpError(400, "dismiss needs the item `key`");
        const until = b["until"] ? b["until"] : null;
        if (until !== null && !isDate(until.slice(0, 10))) throw new HttpError(400, `until must be YYYY-MM-DD, got "${until}"`);
        return { dismissed: await dismissItem(deps, key, until) };
      },
    ],
    [
      /^\/api\/rank$/,
      async (b) => {
        const date = b["date"];
        if (date !== undefined && date !== "" && !isDate(date)) throw new HttpError(400, `date must be YYYY-MM-DD, got "${date}"`);
        rankCache.clear(date || undefined);
        return { cleared: date || "all" };
      },
    ],
  ];

  async function handlePost(r: Req): Promise<Response> {
    const match = findRoute(actions, r.url.pathname);
    if (!match) throw new HttpError(404, "No such action.");
    const { body, isForm } = await readBody(r.req);
    if (!sameOrigin(r.req)) throw new HttpError(403, "Cross-origin request refused.");
    const presented = r.req.headers.get(CSRF_HEADER) ?? body[CSRF_FIELD] ?? null;
    if (!tokensMatch(readCookie(r.req, CSRF_COOKIE), presented)) throw new HttpError(403, "Missing or wrong CSRF token. Reload the page and try again.");
    const [action, params] = match;
    const result = await action(body, params);
    if (isForm) return redirectBack(r, body["next"]);
    return json({ ok: true, ...(result as object) });
  }

  function redirectBack(r: Req, next: string | undefined): Response {
    let to = "/";
    // Only same-site paths: never "//evil.example", "/\\evil.example" or a full URL.
    if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) to = next;
    else {
      const ref = r.req.headers.get("referer");
      try {
        if (ref) {
          const u = new URL(ref);
          if (u.host === r.url.host) to = `${u.pathname}${u.search}`;
        }
      } catch {
        // Keep "/".
      }
    }
    return new Response(null, { status: 303, headers: { location: to } });
  }

  // ---- dispatch --------------------------------------------------------------

  async function dispatch(req: Request, csrf: string): Promise<Response> {
    const url = new URL(req.url);
    if (!hostAllowed(req, loopbackOnly)) return text(421, "This dashboard only answers to localhost.");
    const r: Req = { req, url, csrf };
    const wantsJson = url.pathname.startsWith("/api/");
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const s = await staticFile(url.pathname);
        if (s) return s;
        const match = findRoute(routes, url.pathname);
        if (!match) throw new HttpError(404, "Nothing here.");
        return await match[0](r, match[1]);
      }
      if (req.method === "POST") return await handlePost(r);
      return text(405, "Method not allowed.");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof StoreError || err instanceof YrmError ? 400 : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) deps.log.error("web request failed", { path: url.pathname, error: message });
      if (wantsJson) return json({ ok: false, error: message }, status);
      const title = status === 404 ? "Not found" : status === 403 ? "Refused" : status < 500 ? "That did not work" : "Something went wrong";
      return htmlResponse(messagePage(view(r), title, message, String(status)), status);
    }
  }

  function htmlResponse(body: Html, status = 200): Response {
    return new Response(body.value, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  return {
    rankCache,
    async fetch(req) {
      // Pages embed the token in forms; the cookie carries the same value (double submit).
      const existing = readCookie(req, CSRF_COOKIE);
      const token = existing ?? newToken();
      const res = await dispatch(req, token);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      if (existing === null) headers.append("set-cookie", csrfCookie(token));
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    },
  };
}

function findRoute<H>(table: Array<[RegExp, H]>, path: string): [H, string[]] | null {
  for (const [re, h] of table) {
    const m = re.exec(path);
    if (m) {
      try {
        return [h, m.slice(1).map((s) => decodeURIComponent(s))];
      } catch {
        throw new HttpError(400, "Malformed URL.");
      }
    }
  }
  return null;
}

async function readBody(req: Request): Promise<{ body: Record<string, string>; isForm: boolean }> {
  const type = req.headers.get("content-type") ?? "";
  const body: Record<string, string> = {};
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) if (typeof v === "string") body[k] = v;
    return { body, isForm: true };
  }
  if (type.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      throw new HttpError(400, "Body is not valid JSON.");
    }
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") body[k] = v;
    }
    return { body, isForm: false };
  }
  const textBody = await req.text();
  if (textBody.trim() !== "") throw new HttpError(415, "Send application/json or a form.");
  return { body, isForm: false };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
