import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, silentLogger, type CommandContext, type YrmConfig } from "@yrm/core";
import { parseEml } from "@yrm/ext-mail";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import gmail, {
  backoffDelay,
  decodeBase64Url,
  DEFAULT_LABELS,
  GMAIL_READONLY_SCOPE,
  listParams,
  manifest,
  resolveSettings,
  setupText,
  takeoutMeta,
} from "../src/index.ts";

const ACME = join(import.meta.dir, "../../../fixtures/acme/mail");

describe("base64url", () => {
  test("decodes Gmail's raw field, with or without padding, keeping UTF-8", () => {
    const text = "Subject: Café ✓\n\nbody ~~~ ??? >>>";
    const b64url = Buffer.from(text, "utf-8").toString("base64url");
    expect(b64url).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(b64url)).toBe(text);
    expect(decodeBase64Url(`${b64url}==`)).toBe(text);
    expect(decodeBase64Url(b64url.replace(/(.{10})/g, "$1\n"))).toBe(text);
  });

  test("a fixture survives the round trip and parses", () => {
    const eml = readFileSync(join(ACME, "001-intro-priya-marcus.eml"), "utf-8");
    const msg = parseEml(decodeBase64Url(Buffer.from(eml).toString("base64url")));
    expect(msg.messageId).toBeDefined();
    expect(msg.from.length).toBe(1);
  });
});

describe("backoff", () => {
  test("doubles from 1s and caps at 32s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000]);
  });

  test("Retry-After wins, in seconds or as an HTTP date, and is capped", () => {
    expect(backoffDelay(4, "3")).toBe(3000);
    expect(backoffDelay(0, "0")).toBe(0);
    expect(backoffDelay(0, "600")).toBe(32_000);
    const soon = new Date(Date.now() + 5000).toUTCString();
    expect(backoffDelay(0, soon)).toBeGreaterThan(3000);
    expect(backoffDelay(2, "garbage")).toBe(4000);
    expect(backoffDelay(1, null)).toBe(2000);
  });
});

describe("list parameters", () => {
  test("one label per list call, query, page token and a clamped page size", () => {
    const p = listParams({ labelId: "INBOX", query: "newer_than:1y", pageToken: "tok", maxResults: 900 });
    expect(p.getAll("labelIds")).toEqual(["INBOX"]);
    expect(p.get("q")).toBe("newer_than:1y");
    expect(p.get("pageToken")).toBe("tok");
    expect(p.get("maxResults")).toBe("500");
    const bare = listParams({ maxResults: 0 });
    expect(bare.has("q")).toBe(false);
    expect(bare.has("labelIds")).toBe(false);
    expect(bare.get("maxResults")).toBe("1");
  });

  test("settings defaults", () => {
    const s = resolveSettings({}, { YRM_GOOGLE_CLIENT_SECRET: "from-env" });
    expect(s.labels).toEqual([...DEFAULT_LABELS]);
    expect(s.scopes).toEqual([GMAIL_READONLY_SCOPE]);
    expect(s.maxPerSync).toBe(500);
    expect(s.redirectPort).toBe(0);
    expect(s.clientSecret).toBe("from-env");
    expect(s.query).toBeUndefined();
    expect(resolveSettings({ clientSecretEnv: "MY_SECRET" }, { MY_SECRET: "x" }).clientSecret).toBe("x");
    expect(resolveSettings({ clientSecret: "inline" }, { YRM_GOOGLE_CLIENT_SECRET: "env" }).clientSecret).toBe("inline");
    expect(resolveSettings({ maxPerSync: -3, labels: [] }).maxPerSync).toBe(500);
  });
});

describe("Takeout headers", () => {
  test("labels map to API ids and the decimal thread id becomes hex", () => {
    const msg = parseEml("X-GM-THRID: 1798223419137211234\nX-Gmail-Labels: Inbox,Opened,Category Updates,Sent\nFrom: a@x.example\n\nhi");
    expect(takeoutMeta(msg)).toEqual({ labels: ["INBOX", "Opened", "Category Updates", "SENT"], threadId: BigInt("1798223419137211234").toString(16) });
    expect(takeoutMeta(parseEml("From: a@x.example\n\nhi"))).toEqual({ labels: [] });
  });
});

const ctxFor = (store: MemoryStore, out: string[], flags: Record<string, string | boolean> = {}): CommandContext => ({
  tenantId: "t",
  args: [],
  flags,
  store,
  models: new FakeRouter(),
  stdout: (l) => out.push(l),
  stderr: (l) => out.push(l),
  log: silentLogger,
});

function hostWith(settings: Record<string, unknown>, store = new MemoryStore("t")) {
  const config: YrmConfig = {
    tenant: { id: "t", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
    storage: { driver: "memory" },
    models: { routes: {} },
    settings: { gmail: settings },
  };
  return createHost(config, { store, models: new FakeRouter(), log: silentLogger });
}

describe("gmail:setup", () => {
  test("text names Internal vs External, Desktop app, the scopes and the redirect URI", () => {
    const text = setupText(resolveSettings({ scopes: [GMAIL_READONLY_SCOPE, "https://www.googleapis.com/auth/calendar.readonly"] })).join("\n");
    expect(text).toContain("User type: Internal");
    expect(text).toContain("External");
    expect(text).toContain("Desktop app");
    expect(text).toContain(GMAIL_READONLY_SCOPE);
    expect(text).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(text).toContain("http://127.0.0.1:<random port>/");
    expect(text).toContain("YRM_GOOGLE_CLIENT_SECRET");
    expect(setupText(resolveSettings({ redirectPort: 8765 })).join("\n")).toContain("Redirect URI: http://127.0.0.1:8765/");
  });

  test("without a client id it prints the checklist and stops", async () => {
    const host = hostWith({});
    await host.use(gmail, manifest);
    const out: string[] = [];
    expect(await host.registry.commands.get("gmail:setup")!.run(ctxFor(new MemoryStore("t"), out))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(GMAIL_READONLY_SCOPE);
    expect(text).toContain("clientId is not set");
  });
});

describe("Takeout import", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("an .mbox becomes gmail events without touching the sync cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrm-gmail-"));
    dirs.push(dir);
    const files = ["001-intro-priya-marcus.eml", "002-re-intro-jack.eml", "005-noise-ops-weekly-212.eml"];
    const mbox = files
      .map((f, i) => `From ${1798223419137211234n + BigInt(i)}@xxx Mon Jun 01 10:00:00 +0000 2026\nX-GM-THRID: 1798223419137211234\nX-Gmail-Labels: Inbox,Opened\n${readFileSync(join(ACME, f), "utf-8")}`)
      .join("\n");
    const path = join(dir, "All mail Including Spam and Trash.mbox");
    writeFileSync(path, mbox);

    const store = new MemoryStore("t");
    const host = hostWith({}, store);
    await host.use(gmail, manifest);
    const res = await host.importPath("gmail", path);
    expect(res.events.length).toBe(2);
    for (const e of res.events) {
      expect(e.source).toBe("gmail");
      expect(e.meta["labels"]).toEqual(["INBOX", "Opened"]);
      expect(e.threadKey).toBe(`gmail:${BigInt("1798223419137211234").toString(16)}`);
      expect(e.rawRef).toMatch(/\.mbox#\d$/);
    }
    expect(await store.getCursor("t", "gmail")).toBeNull();
    expect((await host.importPath("gmail", path)).duplicates).toBe(2);
  });
});
