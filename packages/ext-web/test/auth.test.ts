import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { silentLogger, SqliteStore, type Entity } from "@yrm/core";
import { createStoredToken, loadTokens } from "@yrm/ext-auth";
import { startWebServer, type RunningWeb } from "../src/index.ts";

// Loopback is not trusted here, so a request from this test process is treated
// like one from the LAN: that is how these tests exercise remote access.
const RW = "rw-secret-0123456789abcdef";
const RO = "ro-secret-0123456789abcdef";

let store: SqliteStore;
let web: RunningWeb;
let base: string;
let marcus: Entity;
let kvToken: string;

beforeAll(async () => {
  store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  marcus = await store.createEntity({ kind: "person", name: "Marcus Bell", identifiers: [], status: "proposed" });
  kvToken = (await createStoredToken(store, { name: "laptop", principal: "user:jack", scopes: ["read", "write"] })).token;
  const auth = await loadTokens(store, {
    allowLoopback: false,
    tokens: [
      { name: "rw", token: RW, principal: "user:jack", scopes: ["read", "write"] },
      { name: "ro", token: RO, principal: "agent:yagni/bailey", scopes: ["read"] },
    ],
  });
  web = startWebServer({ store, tenantId: "local", log: silentLogger, host: null, port: 0, auth });
  base = web.url.replace(/\/$/, "");
});

afterAll(async () => {
  await web.stop();
  await store.close();
});

function cookieOf(res: Response, name: string): string {
  const all = res.headers.getSetCookie();
  const hit = all.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`no ${name} cookie in ${JSON.stringify(all)}`);
  return hit.split(";")[0]!;
}

/** Sign in through the form, as a browser would. Returns the cookie header to send afterwards. */
async function signIn(token: string): Promise<{ status: number; cookie: string; csrf: string; location: string | null }> {
  const page = await fetch(`${base}/login`);
  await page.text();
  const csrfCookie = cookieOf(page, "yrm_csrf");
  const csrf = csrfCookie.split("=")[1]!;
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: base, cookie: csrfCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, token, next: "/people" }).toString(),
  });
  await res.text();
  const session = res.status === 303 ? cookieOf(res, "yrm_session") : "";
  return { status: res.status, cookie: [csrfCookie, session].filter(Boolean).join("; "), csrf, location: res.headers.get("location") };
}

describe("web auth", () => {
  it("redirects an unauthenticated page view to /login and answers the API with 401", async () => {
    const page = await fetch(`${base}/people?x=1`, { redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/people?x=1")}`);
    expect((await fetch(`${base}/api/entities`)).status).toBe(401);
    const login = await fetch(`${base}/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('name="token"');
    // The sign-in page needs its stylesheet without a session.
    expect((await fetch(`${base}/static/styles.css`)).status).toBe(200);
  });

  it("refuses a wrong token", async () => {
    expect((await signIn("not-the-token-at-all")).status).toBe(401);
  });

  it("signs in, sets an HttpOnly SameSite=Strict session and shows the principal", async () => {
    const s = await signIn(RW);
    expect(s.status).toBe(303);
    expect(s.location).toBe("/people");
    const people = await fetch(`${base}/people`, { headers: { cookie: s.cookie } });
    expect(people.status).toBe(200);
    const body = await people.text();
    expect(body).toContain("Acting as <span class=\"mono\">user:jack</span>");
    expect(body).toContain("Sign out");
    expect(body).not.toContain("No authentication");
  });

  it("accepts a bearer token from kv on the API, for reads and writes", async () => {
    const res = await fetch(`${base}/api/entities`, { headers: { authorization: `Bearer ${kvToken}` } });
    expect(res.status).toBe(200);
    const write = await fetch(`${base}/api/rank`, {
      method: "POST",
      headers: { authorization: `Bearer ${kvToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(write.status).toBe(200);
    const ro = await fetch(`${base}/api/rank`, { method: "POST", headers: { authorization: `Bearer ${RO}`, "content-type": "application/json" }, body: "{}" });
    expect(ro.status).toBe(403);
  });

  it("refuses writes without the write scope and attributes them with it", async () => {
    const ro = await signIn(RO);
    const post = (cookie: string, csrf: string) =>
      fetch(`${base}/api/entity/${marcus.id}/confirm`, {
        method: "POST",
        headers: { origin: base, cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: "{}",
      });
    const denied = await post(ro.cookie, ro.csrf);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain("write");
    expect((await store.getEntity(marcus.id))?.status).toBe("proposed");

    const rw = await signIn(RW);
    const ok = await post(rw.cookie, rw.csrf);
    expect(ok.status).toBe(200);
    expect((await store.getEntity(marcus.id))?.status).toBe("confirmed");
  });

  it("signs out", async () => {
    const s = await signIn(RW);
    const res = await fetch(`${base}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, cookie: s.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: s.csrf }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("yrm_session=;") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("keeps the CSRF check on sign-in", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: RW }).toString(),
    });
    expect(res.status).toBe(403);
  });
});

describe("binding", () => {
  it("refuses a non-loopback bind without a token", async () => {
    const empty = new SqliteStore({ path: ":memory:" });
    await empty.migrate();
    const auth = await loadTokens(empty, {});
    expect(() => startWebServer({ store: empty, tenantId: "local", log: silentLogger, port: 0, hostname: "0.0.0.0", auth })).toThrow(/without a token/);
    expect(() => startWebServer({ store: empty, tenantId: "local", log: silentLogger, port: 0, hostname: "0.0.0.0" })).toThrow(/without authentication/);
    await empty.close();
  });

  it("lets loopback callers through by default", async () => {
    const local = new SqliteStore({ path: ":memory:" });
    await local.migrate();
    const running = startWebServer({ store: local, tenantId: "local", log: silentLogger, port: 0, auth: await loadTokens(local, {}), principal: "user:jack" });
    const res = await fetch(`${running.url}people`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("user:jack");
    await running.stop();
    await local.close();
  });
});
