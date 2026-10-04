import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHost, silentLogger, type CommandContext, type Host, type SourceEvent, type YrmConfig } from "@yrm/core";
import resolve, { manifest as resolveManifest } from "@yrm/ext-resolve";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import slack, { cursorKey, KV_NAMESPACE, manifest, parseCursor, USERS_KEY, type SlackSettings, type UserMap } from "../src/index.ts";
import { EXPORT_DIR, FakeSlack } from "./fake-slack.ts";

let fake: FakeSlack;
let store: MemoryStore;
let host: Host;

async function makeHost(extra: SlackSettings = {}, s: MemoryStore = store): Promise<Host> {
  const settings: SlackSettings = { token: fake.token, apiBase: fake.base, selfUserIds: ["U01JACK"], ...extra };
  const config: YrmConfig = {
    tenant: { id: "t", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
    storage: { driver: "memory" },
    models: { routes: {} },
    settings: { slack: settings as Record<string, unknown> },
  };
  const h = createHost(config, { store: s, models: new FakeRouter(), log: silentLogger });
  await h.use(resolve, resolveManifest);
  await h.use(slack, manifest);
  return h;
}

const all = (s: MemoryStore = store): Promise<SourceEvent[]> => s.listEvents({ source: "slack", limit: 1000 });
const byExt = (events: SourceEvent[], id: string): SourceEvent => {
  const found = events.find((e) => e.externalId === id);
  if (!found) throw new Error(`no event ${id}`);
  return found;
};

/** What a source decides; the host's ids and resolver assignments are left out. */
function comparable(events: SourceEvent[]): unknown[] {
  return events
    .map(({ id: _id, ingestedAt: _i, tenantId: _t, rawRef: _r, ...rest }) => ({
      ...rest,
      participants: rest.participants.map(({ entityId: _e, ...p }) => p),
    }))
    .sort((a, b) => a.externalId.localeCompare(b.externalId));
}

beforeEach(async () => {
  fake = new FakeSlack().start();
  store = new MemoryStore("t");
  host = await makeHost();
});

afterEach(() => fake.stop());

const PARENT = "C01SALES:1782918000.000200";
const REPLY1 = "C01SALES:1782918600.000300";
const REPLY2 = "C01SALES:1783000800.000100";
const PRICING = "C01SALES:1783004400.000300";

describe("slack sync against a fake API", () => {
  test("one event per message, threads grouped, noise dropped and reported", async () => {
    fake.throttleOnce.add("conversations.history");
    const res = await host.ingest("slack");
    const events = await all();
    expect(events.map((e) => e.externalId).sort()).toEqual(
      [
        PARENT,
        REPLY1,
        REPLY2,
        PRICING,
        "C02RANDOM:1782920000.000100",
        "D01JACKMARIA:1783008000.000100",
        "D01JACKMARIA:1783008300.000200",
        "G01GROUP:1783010000.000100",
      ].sort(),
    );
    expect(res.events.length).toBe(8);
    // join, bot_message, topic, bot user, leave: dropped and counted through report().
    expect(res.dropped).toBe(5);
    expect(fake.throttled).toBe(1);
    // users.list paginated: 6 users at 4 per page.
    expect(fake.calls("users.list").length).toBe(2);
    expect(Object.keys((await store.kvGet<UserMap>(KV_NAMESPACE, USERS_KEY))!).length).toBe(6);

    // Thread replies: fetched through conversations.replies, grouped by the parent's ts.
    const thread = events.filter((e) => e.threadKey === PARENT);
    expect(thread.map((e) => e.externalId).sort()).toEqual([PARENT, REPLY1, REPLY2].sort());
    expect(byExt(events, REPLY1).inReplyTo).toEqual([PARENT]);
    expect(byExt(events, PARENT).inReplyTo).toBeUndefined();
    expect(fake.calls("conversations.replies").map((u) => u.searchParams.get("ts"))).toContain("1782918000.000200");

    // Markup normalized; mentions become participants with emails where Slack has them.
    const parent = byExt(events, PARENT);
    expect(parent.content.text).toBe("Hi @Jack Collins, the RFP (https://acme.example/rfp) is up & ready. Notes in #random.");
    expect(parent.content.title).toBe("#sales");
    expect(parent.occurredAt).toBe("2026-07-01T15:00:00.000Z");
    expect(parent.participants).toEqual([
      { role: "from", address: "maria@acme.example", name: "Maria Lopez" },
      { role: "mentioned", address: "jack@yagni.example", name: "Jack Collins", self: true },
    ]);
    expect(parent.meta).toMatchObject({ channel: "C01SALES", channelName: "sales", ts: "1782918000.000200", threadTs: "1782918000.000200", reactions: [{ name: "eyes", count: 2 }] });
    const reply = byExt(events, REPLY1);
    expect(reply.participants.filter((p) => p.role === "mentioned").map((p) => p.address)).toEqual(["maria@acme.example", "tom@acme.example"]);
    expect(byExt(events, REPLY2).content.text).toBe("We need SOC 2 Type II <by Q3>.");

    // No email: addressed by Slack id. Files and edits in meta.
    const pricing = byExt(events, PRICING);
    expect(pricing.participants[0]).toEqual({ role: "from", address: "slack:U04PRIYA", name: "Priya Raman" });
    expect(pricing.content.text).toBe("Pricing sheet for @Maria Lopez, see deals@yagni.example");
    expect(pricing.meta).toMatchObject({ files: ["pricing.pdf"], edited: "1783004500.000000" });

    // DMs: `to` is the other member; channels have no `to`.
    const dm = byExt(events, "D01JACKMARIA:1783008000.000100");
    expect(dm.content.title).toBe("DM with Maria Lopez");
    expect(dm.participants.map((p) => [p.role, p.address])).toEqual([
      ["from", "maria@acme.example"],
      ["to", "jack@yagni.example"],
    ]);
    const group = byExt(events, "G01GROUP:1783010000.000100");
    expect(group.content.title).toBe("DM with Maria Lopez, Tom Fischer");
    expect(group.participants.filter((p) => p.role === "to").map((p) => p.address)).toEqual(["jack@yagni.example", "maria@acme.example"]);
    expect(parent.participants.some((p) => p.role === "to")).toBe(false);

    // No bot text anywhere.
    expect(events.some((e) => /Deploy finished|Nightly build/.test(e.content.text))).toBe(false);

    // Cursors: per channel in kv, summarized in the source cursor.
    expect(await store.kvGet<string>(KV_NAMESPACE, cursorKey("C01SALES"))).toBe("1783005000.000400");
    expect(parseCursor(await store.getCursor("t", "slack")).channels).toMatchObject({ C01SALES: "1783005000.000400", D01JACKMARIA: "1783008300.000200" });
  });

  test("a second sync asks only for newer messages and emits only those", async () => {
    await host.ingest("slack");
    fake.requests.length = 0;
    fake.add("C01SALES", { type: "message", ts: "1783100000.000100", user: "U02MARIA", text: "Signed! <@U06NEW> will onboard you." });
    fake.add("C01SALES", { type: "message", ts: "1783100100.000200", user: "U06NEW", text: "Hello all" });
    fake.users = [...fake.users, { id: "U06NEW", name: "lee", real_name: "Lee Park", profile: { email: "lee@acme.example", title: "CSM" } }];

    const res = await host.ingest("slack");
    expect(res.events.map((e) => e.externalId)).toEqual(["C01SALES:1783100000.000100", "C01SALES:1783100100.000200"]);
    expect(res.duplicates).toBe(0);
    const salesHistory = fake.calls("conversations.history").filter((u) => u.searchParams.get("channel") === "C01SALES");
    expect(salesHistory.every((u) => u.searchParams.get("oldest") === "1783005000.000400")).toBe(true);
    // The unknown user triggered one refresh of the map.
    expect(fake.calls("users.list").length).toBe(2);
    expect(res.events[1]!.participants[0]).toEqual({ role: "from", address: "lee@acme.example", name: "Lee Park" });
    expect(res.events[0]!.content.text).toBe("Signed! @Lee Park will onboard you.");

    // Nothing new: nothing emitted, no refresh.
    fake.requests.length = 0;
    expect((await host.ingest("slack")).events.length).toBe(0);
    expect(fake.calls("users.list").length).toBe(0);
  });

  test("maxPerSync pauses after a whole thread and the next runs continue", async () => {
    host = await makeHost({ maxPerSync: 2, channels: ["#sales"], includeDMs: false });
    const first = await host.ingest("slack");
    // join (dropped) + parent with both replies, then the budget is spent.
    expect(first.events.map((e) => e.externalId)).toEqual([PARENT, REPLY1, REPLY2]);
    expect(await store.kvGet<string>(KV_NAMESPACE, cursorKey("C01SALES"))).toBe("1782918000.000200");
    // Runs that only see dropped noise still move the cursor.
    const cursors: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await host.ingest("slack");
      cursors.push(await store.kvGet<string>(KV_NAMESPACE, cursorKey("C01SALES")));
    }
    expect(cursors).toEqual(["1783001000.000200", "1783005000.000400", "1783005000.000400", "1783005000.000400"]);
    expect((await all()).map((e) => e.externalId).sort()).toEqual([PARENT, REPLY1, REPLY2, PRICING].sort());
    expect(fake.calls("conversations.history").every((u) => u.searchParams.get("channel") === "C01SALES")).toBe(true);
  });

  test("includeBots keeps bot messages", async () => {
    host = await makeHost({ includeBots: true, channels: ["C01SALES"], includeDMs: false });
    await host.ingest("slack");
    const texts = (await all()).map((e) => e.content.text);
    expect(texts).toContain("Deploy finished");
    expect(texts).toContain("Nightly build green");
  });

  test("bot tokens skip DMs by default", async () => {
    fake.token = "xoxb-test";
    host = await makeHost({ token: "xoxb-test" });
    await host.ingest("slack");
    expect(fake.calls("conversations.list")[0]!.searchParams.get("types")).toBe("public_channel,private_channel");
    expect((await all()).some((e) => e.externalId.startsWith("D01"))).toBe(false);
  });

  test("without a token, sync degrades to a warning", async () => {
    host = await makeHost({ token: "", tokenEnv: "YRM_SLACK_TOKEN_UNSET_IN_TESTS" });
    expect((await host.ingest("slack")).events.length).toBe(0);
    expect(fake.requests.length).toBe(0);
  });
});

describe("slack export import", () => {
  test("produces the same events as the API path", async () => {
    await host.ingest("slack");
    const fromApi = await all();

    const exportStore = new MemoryStore("t");
    const exportHost = await makeHost({ token: "", tokenEnv: "YRM_SLACK_TOKEN_UNSET_IN_TESTS" }, exportStore);
    const res = await exportHost.importPath("slack", EXPORT_DIR);
    expect(res.dropped).toBe(5);
    const fromExport = await all(exportStore);
    expect(fromExport.length).toBe(8);
    expect(comparable(fromExport)).toEqual(comparable(fromApi));
    // Import leaves the sync cursor alone.
    expect(await exportStore.getCursor("t", "slack")).toBeNull();
  });

  test("re-importing is idempotent", async () => {
    const h = await makeHost({ token: "", tokenEnv: "YRM_SLACK_TOKEN_UNSET_IN_TESTS" });
    await h.importPath("slack", EXPORT_DIR);
    const again = await h.importPath("slack", EXPORT_DIR);
    expect(again.events.length).toBe(0);
    expect(again.duplicates).toBe(8);
  });
});

describe("title facts", () => {
  test("recorded once per user from the Slack profile, only for resolved people", async () => {
    const res = await host.ingest("slack");
    const extractAll = async (events: SourceEvent[]): Promise<number> => {
      let n = 0;
      for (const e of events) {
        const r = await host.resolve(e);
        n += (await host.extract(r.event)).facts.filter((f) => f.predicate === "title").length;
      }
      return n;
    };
    expect(await extractAll(res.events)).toBe(2);
    const facts = await store.queryFacts({ predicate: "title" });
    const byName = Object.fromEntries(facts.map((f) => [f.subject.name, f]));
    expect(Object.keys(byName).sort()).toEqual(["Jack Collins", "Maria Lopez"]);
    expect(byName["Maria Lopez"]).toMatchObject({ type: "attribute", value: { title: "VP Operations" }, confidence: 0.7, origin: { kind: "rule", by: "slack" } });
    expect(byName["Maria Lopez"]!.provenance.length).toBe(1);
    // Priya has a title but no email, so no entity to hang it on.

    // Extracting again records nothing new.
    expect(await extractAll(await all())).toBe(0);
    expect((await store.queryFacts({ predicate: "title" })).length).toBe(2);
  });
});

describe("slack commands", () => {
  const run = async (name: string): Promise<string> => {
    const out: string[] = [];
    const ctx: CommandContext = { tenantId: "t", args: [], flags: {}, store, models: new FakeRouter(), stdout: (l) => out.push(l), stderr: (l) => out.push(l), log: silentLogger };
    expect(await host.registry.commands.get(name)!.run(ctx)).toBe(0);
    return out.join("\n");
  };

  test("slack:status shows workspace, channels, cursors and user map size", async () => {
    await host.ingest("slack");
    const text = await run("slack:status");
    expect(text).toContain("Yagni");
    expect(text).toMatch(/users\s+6 cached, 4 with email/);
    expect(text).toMatch(/channels\s+4/);
    expect(text).toContain("#sales");
    expect(text).toContain("(1783005000.000400)");
  });

  test("slack:setup prints the manifest and scopes", async () => {
    const text = await run("slack:setup");
    expect(text).toContain("From an app manifest");
    expect(text).toContain("users:read.email");
  });
});
