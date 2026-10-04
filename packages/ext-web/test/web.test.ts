import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHost, silentLogger, SqliteStore, type Entity, type Fact, type Host, type SourceEvent, type YrmConfig } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { classify, createWebExtension, locateQuote, manifest, startWebServer, type RunningWeb, type TimeMachine } from "../src/index.ts";

let clock = new Date("2026-06-01T00:00:00.000Z");
const now = (): Date => clock;

const config: YrmConfig = {
  tenant: { id: "local", name: "Jack", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

interface Seed {
  acme: Entity;
  marcus: Entity;
  evil: Entity;
  intro: SourceEvent;
  scoping: SourceEvent;
  oldTitle: Fact;
  newTitle: Fact;
}

let store: SqliteStore;
let host: Host;
let web: RunningWeb;
let seed: Seed;
let base: string;
const merged: Array<[string, string]> = [];
const confirmed: string[] = [];

async function seedStore(s: SqliteStore): Promise<Seed> {
  const acme = await s.createEntity({
    kind: "organization",
    name: "Acme Robotics",
    identifiers: [{ type: "domain", value: "acme-robotics.example", confidence: 1, source: "resolve" }],
    status: "confirmed",
  });
  const marcus = await s.createEntity({
    kind: "person",
    name: "Marcus Bell",
    identifiers: [{ type: "email", value: "marcus.bell@acme-robotics.example", confidence: 1, source: "resolve" }],
    status: "proposed",
    summary: { parentId: acme.id, eventCount: 2 },
  });
  const evil = await s.createEntity({
    kind: "person",
    name: `<script>alert("pwned")</script> Mallory`,
    identifiers: [{ type: "email", value: "mallory@acme-robotics.example", confidence: 1, source: "resolve" }],
    status: "proposed",
    summary: { parentId: acme.id },
  });
  const participants = [
    { role: "from", address: "marcus.bell@acme-robotics.example", name: "Marcus Bell", entityId: marcus.id },
    { role: "to", address: "jack@yagni.example", name: "Jack Collins", self: true },
  ];
  const { event: intro } = await s.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<intro@acme>",
    occurredAt: "2026-06-02T15:00:00.000Z",
    threadKey: "intro@acme-robotics.example",
    participants,
    content: { title: "Intro: Marcus, meet Jack", text: "Hi Jack. I run operations here as VP Operations.", stripped: "> earlier quoted text" },
    meta: {},
  });
  const { event: scoping } = await s.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<scoping@acme>",
    occurredAt: "2026-07-09T16:00:00.000Z",
    threadKey: "intro@acme-robotics.example",
    participants,
    content: { title: "Re: Pilot scope", text: "Now SVP Operations. Order form back from procurement by July 17." },
    meta: {},
  });
  const speaker = { entityId: marcus.id, name: "Marcus Bell" };
  clock = new Date("2026-06-03T00:00:00.000Z");
  const oldTitle = await s.recordFact({
    type: "attribute",
    subject: { entityId: marcus.id, name: "Marcus Bell" },
    predicate: "title",
    value: { title: "VP Operations" },
    statement: "Marcus Bell is VP Operations at Acme Robotics.",
    validFrom: intro.occurredAt,
    provenance: [{ eventId: intro.id, speaker, quote: "VP Operations" }],
    confidence: 0.8,
    origin: { kind: "model", by: "extract", model: "fake", version: "1" },
  });
  clock = new Date("2026-07-10T00:00:00.000Z");
  const newTitle = await s.recordFact({
    type: "attribute",
    subject: { entityId: marcus.id, name: "Marcus Bell" },
    predicate: "title",
    value: { title: "SVP Operations" },
    statement: "Marcus Bell is SVP Operations at Acme Robotics.",
    validFrom: scoping.occurredAt,
    provenance: [{ eventId: scoping.id, speaker, quote: "Now SVP Operations.", span: { start: 0, end: 19 } }],
    confidence: 0.9,
    origin: { kind: "model", by: "extract", model: "fake", version: "1" },
    supersedes: oldTitle.id,
  });
  clock = new Date("2026-10-03T12:00:00.000Z");
  return { acme, marcus, evil, intro, scoping, oldTitle, newTitle };
}

beforeAll(async () => {
  store = new SqliteStore({ path: ":memory:", clock: () => clock });
  await store.migrate();
  host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  seed = await seedStore(store);
  await host.use(createWebExtension({ host }), manifest);
  await host.use(
    (yrm) => {
      yrm.registerRanker({
        name: "fake-ranker",
        async rank(_ctx, candidates) {
          return [
            ...candidates,
            {
              key: "title-change:marcus",
              action: "Congratulate Marcus on the promotion",
              reason: "Marcus signed his July 9 mail as SVP Operations.",
              score: 0.82,
              about: [{ entityId: seed.marcus.id, name: "Marcus Bell" }],
              evidence: { factIds: [seed.newTitle.id], eventIds: [seed.scoping.id, seed.intro.id] },
              dueAt: "2026-10-05T00:00:00.000Z",
              by: "fake-ranker",
            },
          ];
        },
      });
      yrm.on("entity:merged", async (_ctx, from, into) => {
        merged.push([from.id, into.id]);
      });
      yrm.on("entity:confirmed", async (_ctx, e) => {
        confirmed.push(e.id);
      });
    },
    { name: "test-fakes" },
  );
  web = startWebServer({ store, tenantId: "local", log: silentLogger, host, port: 0, now });
  base = web.url.replace(/\/$/, "");
});

afterAll(async () => {
  await web.stop();
  await store.close();
});

async function get(path: string): Promise<{ status: number; body: string; res: Response }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text(), res };
}

async function csrfToken(): Promise<string> {
  const res = await fetch(`${base}/people`);
  await res.text();
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = /yrm_csrf=([^;]+)/.exec(cookie);
  if (!m) throw new Error(`no csrf cookie in "${cookie}"`);
  return m[1]!;
}

/** The <li> for one fact on a rendered page. */
function factBlock(body: string, id: string): string {
  const start = body.indexOf(`id="fact-${id}"`);
  if (start < 0) return "";
  const end = body.indexOf("</li>", start);
  return body.slice(body.lastIndexOf("<li", start), end);
}

describe("extension", () => {
  it("registers the web command", () => {
    expect(host.registry.commands.get("web")?.name).toBe("web");
    expect(manifest.name).toBe("web");
  });
});

describe("Today", () => {
  it("renders the queue with reason, about link and explain evidence", async () => {
    const { status, body, res } = await get("/?date=2026-10-03");
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(body).toContain("Congratulate Marcus on the promotion");
    expect(body).toContain("Marcus signed his July 9 mail as SVP Operations.");
    expect(body).toContain(`href="/entity/${seed.marcus.id}"`);
    expect(body).toContain('<details class="explain">');
    // Evidence: the fact with its quote, linked to the source event.
    expect(body).toContain("Marcus Bell is SVP Operations at Acme Robotics.");
    expect(body).toContain("<blockquote class=\"quote\">Now SVP Operations.</blockquote>");
    expect(body).toContain(`href="/event/${seed.scoping.id}"`);
    // The intro event is cited directly, not through a fact.
    expect(body).toContain(`href="/event/${seed.intro.id}"`);
  });

  it("a past day's queue links into the entity at that day", async () => {
    const { body } = await get("/?date=2026-09-01");
    expect(body).toContain(`href="/entity/${seed.marcus.id}?validAt=2026-09-01&amp;asOf=2026-09-01"`);
  });

  it("serves the same queue as JSON", async () => {
    const res = await fetch(`${base}/api/today?date=2026-10-03`);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = (await res.json()) as { date: string; source: string; items: Array<{ key: string; evidence: { facts: Array<{ id: string }> } }> };
    expect(data.date).toBe("2026-10-03");
    expect(data.source).toBe("ranked");
    expect(data.items.map((i) => i.key)).toEqual(["title-change:marcus"]);
    expect(data.items[0]!.evidence.facts[0]!.id).toBe(seed.newTitle.id);
  });

  it("rejects a malformed date", async () => {
    expect((await get("/?date=yesterday")).status).toBe(400);
    expect((await fetch(`${base}/api/today?date=2026-13-45`)).status).toBe(400);
  });
});

describe("Entity and the time machine", () => {
  it("shows what is believed now and hides the superseded fact", async () => {
    const { status, body } = await get(`/entity/${seed.marcus.id}`);
    expect(status).toBe(200);
    expect(body).toContain("Marcus Bell is SVP Operations at Acme Robotics.");
    expect(factBlock(body, seed.oldTitle.id)).toBe("");
    expect(body).toContain("1 superseded or retracted fact hidden");
    expect(body).toContain(`href="/entity/${seed.acme.id}"`);
  });

  it("with asOf before the supersession shows the old fact and marks the new one not yet known", async () => {
    const { status, body } = await get(`/entity/${seed.marcus.id}?asOf=2026-07-01`);
    expect(status).toBe(200);
    const old = factBlock(body, seed.oldTitle.id);
    const now = factBlock(body, seed.newTitle.id);
    expect(old).toContain("Marcus Bell is VP Operations at Acme Robotics.");
    expect(old).toContain("state-current");
    expect(old).toContain("superseded on Jul 10, 2026");
    expect(now).toContain("state-not-yet-known");
    expect(now).toContain("not yet known");
    expect(body).toContain('class="time-machine engaged"');
  });

  it("after the supersession, with the time machine on, strikes the old fact through", async () => {
    const { body } = await get(`/entity/${seed.marcus.id}?asOf=2026-08-01`);
    expect(factBlock(body, seed.oldTitle.id)).toContain("state-retracted");
    expect(factBlock(body, seed.newTitle.id)).toContain("state-current");
  });

  it("the provenance toggle highlights the quote inside the source text", async () => {
    const { body } = await get(`/entity/${seed.marcus.id}`);
    const block = factBlock(body, seed.newTitle.id);
    expect(block).toContain('<details class="prov"');
    expect(block).toContain('<pre class="source"><mark>Now SVP Operations.</mark> Order form back from procurement by July 17.</pre>');
  });

  it("finds a quote without a span by searching the text", () => {
    const loc = locateQuote({ content: { text: "Hi. I run operations here as VP Operations." } }, "VP Operations", undefined);
    expect(loc).toEqual({ in: "text", start: 29, end: 42, how: "search" });
    expect(locateQuote({ content: { text: "nothing", stripped: "> VP Operations" } }, "VP Operations", undefined)?.in).toBe("stripped");
    expect(locateQuote({ content: { text: "nothing" } }, "absent", undefined)).toBeNull();
  });

  it("classifies facts against both times", () => {
    const tm = (validAt: string, asOf: string): TimeMachine => ({ validAt, asOf, validDate: null, asOfDate: null, engaged: true });
    const f = { ...seed.newTitle, recordedAt: "2026-07-10T00:00:00.000Z" } as Fact;
    const nowIso = clock.toISOString();
    expect(classify(f, tm(nowIso, nowIso), nowIso)).toBe("current");
    expect(classify(f, tm(nowIso, "2026-07-01T00:00:00.000Z"), nowIso)).toBe("not-yet-known");
    expect(classify(f, tm("2026-06-15T00:00:00.000Z", nowIso), nowIso)).toBe("future");
    expect(classify(f, tm("2026-06-15T00:00:00.000Z", "2026-07-01T00:00:00.000Z"), nowIso)).toBeNull();
  });

  it("serves the entity as JSON with time-machine states", async () => {
    const res = await fetch(`${base}/api/entity/${seed.marcus.id}?asOf=2026-07-01`);
    const data = (await res.json()) as { entity: { name: string }; facts: Array<{ id: string; state: string }> };
    expect(data.entity.name).toBe("Marcus Bell");
    const states = Object.fromEntries(data.facts.map((f) => [f.id, f.state]));
    expect(states[seed.oldTitle.id]).toBe("current");
    expect(states[seed.newTitle.id]).toBe("not-yet-known");
  });

  it("404s an unknown entity and 400s a bad date", async () => {
    expect((await get("/entity/nope")).status).toBe(404);
    expect((await get(`/entity/${seed.marcus.id}?asOf=last-tuesday`)).status).toBe(400);
  });
});

describe("threads, events and facts", () => {
  it("renders a thread with stripped text collapsed and facts under each message", async () => {
    const { status, body } = await get(`/thread/${encodeURIComponent("intro@acme-robotics.example")}`);
    expect(status).toBe(200);
    expect(body).toContain("Intro: Marcus, meet Jack");
    expect(body).toContain("Re: Pilot scope");
    expect(body).toContain('<details class="stripped">');
    expect(body).toContain("&gt; earlier quoted text");
    expect(body).toContain(`href="/entity/${seed.marcus.id}"`);
    expect(body).toContain("Facts from this message");
  });

  it("serves an event as JSON with the facts that cite it", async () => {
    const res = await fetch(`${base}/api/event/${seed.scoping.id}`);
    const data = (await res.json()) as { event: { title: string }; facts: Array<{ id: string }> };
    expect(data.event.title).toBe("Re: Pilot scope");
    expect(data.facts.map((f) => f.id)).toEqual([seed.newTitle.id]);
  });

  it("filters facts by type and text", async () => {
    const all = (await (await fetch(`${base}/api/facts`)).json()) as { facts: Array<{ id: string }> };
    expect(all.facts.map((f) => f.id)).toEqual([seed.newTitle.id]);
    const none = (await (await fetch(`${base}/api/facts?type=commitment`)).json()) as { facts: unknown[] };
    expect(none.facts).toHaveLength(0);
    const { body } = await get("/facts?q=svp");
    expect(body).toContain("Marcus Bell is SVP Operations");
    const past = (await (await fetch(`${base}/api/facts?asOf=2026-07-01`)).json()) as { facts: Array<{ id: string }> };
    expect(past.facts.map((f) => f.id)).toEqual([seed.oldTitle.id]);
  });
});

describe("escaping", () => {
  it("never puts a stored name into the page unescaped", async () => {
    const { body } = await get("/people");
    expect(body).not.toContain('<script>alert("pwned")</script>');
    expect(body).toContain("&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; Mallory");
    const entity = await get(`/entity/${seed.evil.id}`);
    expect(entity.body).not.toContain("<script>alert");
    expect(entity.body).toContain("<title>&lt;script&gt;");
  });
});

describe("writes", () => {
  it("refuses a POST without a CSRF token", async () => {
    const res = await fetch(`${base}/api/entity/${seed.marcus.id}/confirm`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await store.getEntity(seed.marcus.id))?.status).toBe("proposed");
  });

  it("refuses a cross-origin POST even with the token", async () => {
    const token = await csrfToken();
    const res = await fetch(`${base}/api/entity/${seed.marcus.id}/confirm`, {
      method: "POST",
      headers: { origin: "http://evil.example", cookie: `yrm_csrf=${token}`, "x-csrf-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await store.getEntity(seed.marcus.id))?.status).toBe("proposed");
  });

  it("confirms with a matching token and fires entity:confirmed", async () => {
    const token = await csrfToken();
    const res = await fetch(`${base}/api/entity/${seed.marcus.id}/confirm`, {
      method: "POST",
      headers: { origin: base, cookie: `yrm_csrf=${token}`, "x-csrf-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; entity: { status: string } };
    expect(data.ok).toBe(true);
    expect(data.entity.status).toBe("confirmed");
    expect((await store.getEntity(seed.marcus.id))?.status).toBe("confirmed");
    expect(confirmed).toContain(seed.marcus.id);
  });

  it("a form POST redirects back to the page it came from", async () => {
    const token = await csrfToken();
    const form = new URLSearchParams({ _csrf: token, next: "/people?x=1" });
    const res = await fetch(`${base}/api/entity/${seed.evil.id}/reject`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, cookie: `yrm_csrf=${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/people?x=1");
    expect((await store.getEntity(seed.evil.id))?.status).toBe("rejected");
  });

  it("never redirects off-site", async () => {
    const token = await csrfToken();
    const res = await fetch(`${base}/api/dismiss`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, cookie: `yrm_csrf=${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token, key: "nothing", next: "//evil.example/" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("dismissing an item removes it from Today", async () => {
    const token = await csrfToken();
    const res = await fetch(`${base}/api/dismiss`, {
      method: "POST",
      headers: { origin: base, cookie: `yrm_csrf=${token}`, "x-csrf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ key: "title-change:marcus", until: "2026-10-10" }),
    });
    expect(res.status).toBe(200);
    const today = (await (await fetch(`${base}/api/today?date=2026-10-03`)).json()) as { items: unknown[] };
    expect(today.items).toHaveLength(0);
    const later = (await (await fetch(`${base}/api/today?date=2026-10-11`)).json()) as { items: unknown[] };
    expect(later.items).toHaveLength(1);
  });

  it("merges, clears the resolver's suggestion and fires entity:merged", async () => {
    const twin = await store.createEntity({
      kind: "person",
      name: "Marcus Bell",
      identifiers: [{ type: "email", value: "marcus@mailhub.example", confidence: 1, source: "resolve" }],
      status: "proposed",
    });
    const key = `suggest:${[twin.id, seed.marcus.id].sort().join(":")}`;
    await store.kvSet("resolve", key, { from: twin.id, into: seed.marcus.id, reason: "same name, one address is on a freemail domain", evidence: [seed.intro.id], score: 0.8 });
    await store.kvSet("resolve", "suggestions:local", [key]);
    const people = await get("/people");
    expect(people.body).toContain("Possibly the same person");
    expect(people.body).toContain("marcus@mailhub.example");

    const token = await csrfToken();
    const res = await fetch(`${base}/api/merge`, {
      method: "POST",
      headers: { origin: base, cookie: `yrm_csrf=${token}`, "x-csrf-token": token, "content-type": "application/json" },
      body: JSON.stringify({ from: twin.id, into: seed.marcus.id }),
    });
    expect(res.status).toBe(200);
    expect((await store.getEntity(twin.id))?.status).toBe("merged");
    expect(merged).toContainEqual([twin.id, seed.marcus.id]);
    expect(await store.kvGet("resolve", key)).toBeNull();
    expect(await store.kvGet<string[]>("resolve", "suggestions:local")).toEqual([]);
    expect((await get("/people")).body).not.toContain("Possibly the same person");
  });
});

describe("transport security", () => {
  it("answers only to loopback Host headers when bound to loopback", async () => {
    const res = await fetch(`${base}/`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(421);
  });

  it("serves the stylesheet and script from itself", async () => {
    const css = await fetch(`${base}/static/styles.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("prefers-color-scheme: dark");
    const js = await fetch(`${base}/static/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
  });
});

describe("known by on imported history (ADR 0008)", () => {
  it("compares Known by against knownAt, not the import time", async () => {
    const saved = clock;
    clock = new Date("2026-10-04T12:00:00.000Z");
    try {
      const priya = await store.createEntity({
        kind: "person",
        name: "Priya Raman",
        identifiers: [{ type: "email", value: "priya.raman@acme-robotics.example", confidence: 1, source: "resolve" }],
        status: "proposed",
      });
      const { event: farewell } = await store.appendEvent({
        source: "mail",
        kind: "message",
        externalId: "<farewell@acme>",
        occurredAt: "2026-08-14T17:00:00.000Z",
        participants: [{ role: "from", address: "priya.raman@acme-robotics.example", name: "Priya Raman", entityId: priya.id }],
        content: { title: "Leaving Acme", text: "Today is my last day at Acme." },
        meta: { receivedAt: "2026-09-03T09:00:00.000Z" },
      });
      const change = await store.recordFact({
        type: "signal",
        subject: { entityId: priya.id, name: "Priya Raman" },
        predicate: "job_change",
        value: { leaving: "Acme" },
        statement: "Priya Raman is changing jobs: leaving Acme.",
        validFrom: farewell.occurredAt,
        knownAt: "2026-09-03T09:00:00.000Z",
        provenance: [{ eventId: farewell.id }],
        confidence: 0.7,
        origin: { kind: "rule", by: "resolve", version: "1" },
      });

      const aug = await get(`/entity/${priya.id}?validAt=2026-08-20&asOf=2026-08-20`);
      expect(factBlock(aug.body, change.id)).toContain("state-not-yet-known");
      const sep = await get(`/entity/${priya.id}?validAt=2026-08-20&asOf=2026-09-05`);
      const row = factBlock(sep.body, change.id);
      expect(row).toContain("state-current");
      expect(row).toMatch(/known <time datetime="2026-09-03T09:00:00.000Z">Sep 3, 2026/);
      expect(row).toMatch(/recorded <time [^>]+>Oct 4, 2026/);

      const api = (await (await fetch(`${base}/api/entity/${priya.id}?asOf=2026-09-05`)).json()) as {
        facts: Array<{ id: string; knownAt: string; recordedAt: string }>;
      };
      const json = api.facts.find((f) => f.id === change.id)!;
      expect(json.knownAt).toBe("2026-09-03T09:00:00.000Z");
      expect(json.recordedAt).toBe("2026-10-04T12:00:00.000Z");
    } finally {
      clock = saved;
    }
  });

  it("a fact superseded in knowledge time reads as superseded from then", () => {
    const tm = (asOf: string): TimeMachine => ({ validAt: asOf, asOf, validDate: null, asOfDate: null, engaged: true });
    const old = {
      ...seed.oldTitle,
      recordedAt: "2026-10-04T12:00:00.000Z",
      knownAt: "2026-06-02T15:00:00.000Z",
      retractedAt: "2026-10-04T12:00:01.000Z",
      knownUntil: "2026-09-03T09:00:00.000Z",
    } as Fact;
    const nowIso = "2026-10-04T13:00:00.000Z";
    expect(classify(old, tm("2026-08-20T00:00:00.000Z"), nowIso)).toBe("current");
    expect(classify(old, tm("2026-09-05T00:00:00.000Z"), nowIso)).toBe("retracted");
  });
});
