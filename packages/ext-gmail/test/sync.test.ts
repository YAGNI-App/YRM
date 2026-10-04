import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHost, silentLogger, type CommandContext, type Host, type YrmConfig } from "@yrm/core";
import { parseEml, toEvent } from "@yrm/ext-mail";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import gmail, {
  BACKFILL_KEY,
  INGESTED_KEY,
  KV_NAMESPACE,
  loadTokens,
  manifest,
  RECOVERY_QUERY,
  saveTokens,
  type BackfillState,
  type GmailSettings,
} from "../src/index.ts";
import { FakeGmail, type FakeMessage } from "./fake-gmail.ts";

const ACME = join(import.meta.dir, "../../../fixtures/acme/mail");
const FILES = readdirSync(ACME).filter((f) => f.endsWith(".eml")).sort();
/** The last four arrive after the initial backfill, through history. */
const INITIAL = FILES.slice(0, -4);
const LATER = FILES.slice(-4);

const isSignal = (file: string): boolean => toEvent(parseEml(readFileSync(join(ACME, file), "utf-8"))) !== null;

function fakeMessage(file: string, i: number): FakeMessage {
  const eml = readFileSync(join(ACME, file), "utf-8");
  const fromJack = /^From:.*jack@yagni\.example/m.test(eml);
  // 002 is filed under both labels, to check a message seen twice is fetched once per run.
  const labelIds = file.startsWith("002-") ? ["SENT", "INBOX"] : fromJack ? ["SENT"] : ["INBOX", "UNREAD"];
  return { id: `18f${i.toString(16).padStart(5, "0")}`, threadId: `t${i}`, labelIds, eml };
}

let fake: FakeGmail;
let store: MemoryStore;
let host: Host;

async function makeHost(extra: GmailSettings = {}): Promise<Host> {
  const settings: GmailSettings = {
    clientId: "client-1",
    clientSecret: "secret-1",
    account: "jack@yagni.example",
    apiBase: fake.base,
    tokenEndpoint: `${fake.base}/token`,
    maxPerSync: 20,
    ...extra,
  };
  const config: YrmConfig = {
    tenant: { id: "t", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
    storage: { driver: "memory" },
    models: { routes: {} },
    settings: { gmail: settings as Record<string, unknown> },
  };
  const h = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  await h.use(gmail, manifest);
  return h;
}

beforeEach(async () => {
  fake = new FakeGmail().start();
  INITIAL.forEach((f, i) => fake.add(fakeMessage(f, i)));
  store = new MemoryStore("t");
  // A stale access token that looks valid by expiry: the first call gets a 401 and must refresh.
  await saveTokens(store, { account: "jack@yagni.example", refresh_token: "rt-1", access_token: "stale", expiry: new Date(Date.now() + 3_600_000).toISOString() });
  host = await makeHost();
});

afterEach(() => fake.stop());

async function backfillAll(): Promise<{ created: number; runs: number }> {
  let created = 0;
  let runs = 0;
  while ((await store.getCursor("t", "gmail")) === null) {
    if (++runs > 10) throw new Error("backfill did not finish");
    created += (await host.ingest("gmail")).events.length;
  }
  return { created, runs };
}

describe("gmail sync against a fake API", () => {
  test("backfills across runs, refreshes on 401, retries 429, sets the cursor", async () => {
    fake.throttleOnce.add(fake.messages[3]!.id);
    const first = await host.ingest("gmail");
    // maxPerSync 20: the first run stops mid-INBOX and leaves a resume point, no cursor.
    expect(first.events.length).toBeGreaterThan(0);
    expect(await store.getCursor("t", "gmail")).toBeNull();
    const state = await store.kvGet<BackfillState>(KV_NAMESPACE, BACKFILL_KEY);
    expect(state).toMatchObject({ labelIndex: 0, pageToken: "20", historyId: String(fake.historyId) });

    const rest = await backfillAll();
    const all = await store.listEvents({ source: "gmail", limit: 1000 });
    expect(all.length).toBe(INITIAL.filter(isSignal).length);
    expect(first.events.length + rest.created).toBe(all.length);
    expect(await store.getCursor("t", "gmail")).toBe(String(fake.historyId));
    expect(await store.kvGet(KV_NAMESPACE, BACKFILL_KEY)).toBeNull();
    expect(await store.kvGet<number>(KV_NAMESPACE, INGESTED_KEY)).toBe(all.length);

    expect(fake.throttled).toBe(1);
    expect(fake.refreshes).toBe(1);
    const tokens = await loadTokens(store, "jack@yagni.example");
    expect(tokens?.access_token).toBe("at-1");
    expect(tokens?.refresh_token).toBe("rt-1");

    // Gmail ids, labels and the Gmail thread as threadKey.
    const intro = all.find((e) => e.meta["gmailId"] === fake.messages[0]!.id)!;
    expect(intro.source).toBe("gmail");
    expect(intro.meta["gmailId"]).toBe(fake.messages[0]!.id);
    expect(intro.meta["threadId"]).toBe("t0");
    expect(intro.meta["labels"]).toEqual(["INBOX", "UNREAD"]);
    expect(intro.threadKey).toBe("gmail:t0");
    expect(intro.rawRef).toBe(`gmail:jack@yagni.example/${fake.messages[0]!.id}`);
    // Quote stripping came along from ext-mail.
    expect(all.some((e) => (e.content.stripped ?? "").length > 0)).toBe(true);
  });

  test("drops noise and asks for each label separately with the query", async () => {
    host = await makeHost({ query: "newer_than:1y", maxPerSync: 500 });
    await backfillAll();
    const all = await store.listEvents({ source: "gmail", limit: 1000 });
    const subjects = all.map((e) => String(e.meta["subject"]));
    expect(subjects.some((s) => /ops weekly|trackly|early bird/i.test(s))).toBe(false);
    expect(INITIAL.length - INITIAL.filter(isSignal).length).toBeGreaterThan(0);

    const lists = fake.requests.filter((u) => u.pathname.endsWith("/messages"));
    expect(new Set(lists.map((u) => u.searchParams.getAll("labelIds").join(",")))).toEqual(new Set(["INBOX", "SENT"]));
    expect(lists.every((u) => u.searchParams.get("q") === "newer_than:1y")).toBe(true);
    // 002 sits under INBOX and SENT but is fetched once in a single run.
    const id002 = fake.messages.find((m) => m.labelIds.length === 2 && m.labelIds.includes("SENT"))!.id;
    expect(fake.gets.filter((g) => g === id002).length).toBe(1);
  });

  test("history mode emits only new ids; replays are duplicates", async () => {
    await backfillAll();
    const before = (await store.listEvents({ source: "gmail", limit: 1000 })).length;
    const getsBefore = fake.gets.length;

    LATER.forEach((f, i) => fake.add(fakeMessage(f, INITIAL.length + i), true));
    // A draft also shows up in history and must be ignored.
    fake.add({ id: "draft1", threadId: "td", labelIds: ["DRAFT"], eml: "Message-ID: <draft@x>\nFrom: jack@yagni.example\n\nwip" }, true);

    const next = await host.ingest("gmail");
    expect(next.events.length).toBe(LATER.filter(isSignal).length);
    expect(fake.gets.slice(getsBefore).sort()).toEqual(LATER.map((_, i) => fakeMessage(LATER[i]!, INITIAL.length + i).id).sort());
    expect(await store.getCursor("t", "gmail")).toBe(String(fake.historyId));
    expect((await store.listEvents({ source: "gmail", limit: 1000 })).length).toBe(before + next.events.length);

    // Nothing new: an empty run.
    expect((await host.ingest("gmail")).events.length).toBe(0);

    // Re-delivered history (cursor rewound): duplicates, never new events.
    await store.setCursor("t", "gmail", "100");
    LATER.forEach((f, i) => fake.history.push({ id: 101 + i, message: fakeMessage(f, INITIAL.length + i) }));
    const replay = await host.ingest("gmail");
    expect(replay.events.length).toBe(0);
    expect(replay.duplicates).toBe(LATER.filter(isSignal).length);
  });

  test("an expired history id falls back to a 30-day backfill, then resumes history", async () => {
    await backfillAll();
    await store.setCursor("t", "gmail", "1");
    fake.historyFloor = 50;
    fake.requests.length = 0;

    const res = await host.ingest("gmail");
    expect(res.events.length).toBe(0);
    expect(res.duplicates).toBeGreaterThan(0);
    const lists = fake.requests.filter((u) => u.pathname.endsWith("/messages"));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((u) => u.searchParams.get("q") === RECOVERY_QUERY)).toBe(true);

    // maxPerSync 20 may need a second run; either way history resumes at the profile's id.
    await backfillAllRecovery();
    expect(await store.getCursor("t", "gmail")).toBe(String(fake.historyId));
    fake.requests.length = 0;
    await host.ingest("gmail");
    expect(fake.requests.some((u) => u.pathname.endsWith("/history"))).toBe(true);
  });

  test("sync without tokens degrades to a warning", async () => {
    const empty = new MemoryStore("t");
    store = empty;
    host = await makeHost();
    const res = await host.ingest("gmail");
    expect(res.events.length).toBe(0);
    expect(fake.requests.length).toBe(0);
  });
});

async function backfillAllRecovery(): Promise<void> {
  for (let i = 0; i < 10 && (await store.kvGet(KV_NAMESPACE, BACKFILL_KEY)) !== null; i++) await host.ingest("gmail");
}

describe("gmail:status", () => {
  test("shows account, tokens, cursor and counters", async () => {
    await backfillAll();
    const out: string[] = [];
    const ctx: CommandContext = {
      tenantId: "t",
      args: [],
      flags: {},
      store,
      models: new FakeRouter(),
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      log: silentLogger,
    };
    expect(await host.registry.commands.get("gmail:status")!.run(ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("jack@yagni.example");
    expect(text).toContain(`historyId ${fake.historyId}`);
    expect(text).toContain("refresh token present");
    expect(text).toMatch(/ingested\s+\d+/);
  });
});
