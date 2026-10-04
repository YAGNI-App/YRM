import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, silentLogger, type Host, type NewSourceEvent, type SyncContext, type YrmConfig } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import mail, { EMIT_BATCH, importMail, manifest, parseEml, toEvent, type MailSettings } from "../src/index.ts";

const ACME = join(import.meta.dir, "../../../fixtures/acme/mail");

function makeHost(settings: MailSettings = {}): Host {
  const config: YrmConfig = {
    tenant: { id: "t", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
    storage: { driver: "memory" },
    models: { routes: {} },
    settings: { mail: settings as Record<string, unknown> },
  };
  return createHost(config, { store: new MemoryStore("t"), models: new FakeRouter(), log: silentLogger });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "yrm-mail-"));
  dirs.push(d);
  return d;
};

const eml = (n: number, extra = ""): string =>
  `Message-ID: <m${n}@x.example>\nDate: Mon, 01 Jun 2026 10:00:00 +0000\nFrom: A <a@x.example>\nTo: jack@yagni.example\nSubject: n${n}\n${extra}\nHello ${n}\n`;

describe("toEvent", () => {
  test("falls back to a content hash and own id for threadKey", () => {
    const msg = parseEml("From: a@x.example\nDate: Mon, 01 Jun 2026 10:00:00 +0000\n\nhello");
    const e = toEvent(msg)!;
    expect(e.externalId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e.threadKey).toBe(e.externalId);
    expect(toEvent(parseEml("From: a@x.example\nDate: Mon, 01 Jun 2026 10:00:00 +0000\n\nhello"))!.externalId).toBe(e.externalId);
  });

  test("threads on In-Reply-To when References is absent", () => {
    const e = toEvent(parseEml("Message-ID: <b@x>\nIn-Reply-To: <a@x>\nFrom: a@x.example\n\nok"))!;
    expect(e.threadKey).toBe("a@x");
    expect(e.inReplyTo).toEqual(["<a@x>"]);
  });

  test("noise is null by default and tagged with keepNoise", () => {
    const msg = parseEml(eml(1, "Precedence: bulk"));
    expect(toEvent(msg)).toBeNull();
    expect(toEvent(msg, { keepNoise: true })!.meta["noise"]).toBe("precedence:bulk");
  });
});

describe("mail extension", () => {
  test("registers the mail source and the inspect command", async () => {
    const host = makeHost();
    await host.use(mail, manifest);
    expect(host.registry.sources.get("mail")?.kinds).toEqual(["message"]);
    expect(host.registry.commands.get("mail:inspect")).toBeDefined();
  });

  test("imports .mbox and nested .eml files, emitting in chunks of 50", async () => {
    const dir = tempDir();
    const mbox = Array.from({ length: 60 }, (_, i) => `From a@x.example Mon Jun  1 10:00:00 2026\n${eml(i)}`).join("\n");
    writeFileSync(join(dir, "archive.mbox"), mbox);
    const nested = join(dir, "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, "b.eml"), eml(100));
    writeFileSync(join(nested, "a.eml"), eml(101, "List-Unsubscribe: <mailto:u@x.example>"));
    writeFileSync(join(nested, "ignore.txt"), "not mail");

    const batches: number[] = [];
    const cursors: string[] = [];
    const logs: Array<Record<string, unknown> | undefined> = [];
    const ctx: SyncContext = {
      tenantId: "t",
      cursor: null,
      emit: async (evs: NewSourceEvent[]) => {
        batches.push(evs.length);
        return [];
      },
      setCursor: async (c) => {
        cursors.push(c);
      },
      signal: new AbortController().signal,
      log: { ...silentLogger, info: (_m, data) => logs.push(data) },
    };
    const stats = await importMail(dir, ctx);
    expect(batches).toEqual([EMIT_BATCH, 11]);
    expect(stats).toMatchObject({ files: 3, messages: 62, emitted: 61, noise: 1, noiseReasons: { "list-unsubscribe": 1 } });
    expect(cursors.at(-1)).toBe(join(nested, "b.eml"));
    expect(logs.at(-1)).toMatchObject({ noiseDropped: 1, messages: 62 });
  });

  test("sync without watchPath logs and emits nothing; with it, imports", async () => {
    const quiet = makeHost();
    await quiet.use(mail, manifest);
    expect((await quiet.ingest("mail")).events.length).toBe(0);

    const watching = makeHost({ watchPath: ACME });
    await watching.use(mail, manifest);
    expect((await watching.ingest("mail")).events.length).toBe(33);
  });

  test("keepNoise emits noise with meta.noise", async () => {
    const host = makeHost({ keepNoise: true });
    await host.use(mail, manifest);
    const res = await host.importPath("mail", ACME);
    expect(res.events.length).toBe(40);
    expect(res.events.filter((e) => e.meta["noise"] !== undefined).length).toBe(7);
  });

  test("mail:inspect prints headers, verdict and both columns", async () => {
    const host = makeHost();
    await host.use(mail, manifest);
    const cmd = host.registry.commands.get("mail:inspect")!;
    const out: string[] = [];
    const err: string[] = [];
    const base = { tenantId: "t", flags: {}, store: host.store, models: host.models, log: silentLogger, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
    expect(await cmd.run({ ...base, args: [] })).toBe(1);
    expect(err[0]).toContain("usage");
    expect(await cmd.run({ ...base, args: [join(ACME, "003-re-intro-marcus-pricing-ask.eml")] })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("noise        no");
    expect(text).toContain("KEPT (content.text)");
    expect(out.some((l) => l.startsWith("Two things that would help") && l.includes(" |"))).toBe(true);
    expect(text).toMatch(/\| > Priya, thank you/);
  });
});
