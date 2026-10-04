import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, silentLogger, type YrmConfig } from "@yrm/core";
// Test doubles are not part of @yrm/core's public exports.
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import notesExtension, { manifest } from "../src/index.ts";
import groundTruth from "../../../fixtures/acme/ground-truth.json";

const NOTES = join(import.meta.dir, "../../../fixtures/acme/notes");

function config(settings?: Record<string, unknown>): YrmConfig {
  const c: YrmConfig = {
    tenant: { id: "local", ...groundTruth.tenant, timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
  };
  if (settings) c.settings = { notes: settings };
  return c;
}

async function setup(settings?: Record<string, unknown>) {
  const store = new MemoryStore();
  const host = createHost(config(settings), { store, models: new FakeRouter(), log: silentLogger });
  await host.use(notesExtension, manifest);
  return { host, store };
}

const EXPECTED = [
  {
    path: "2026-06-16-discovery-call.md",
    occurredAt: "2026-06-16T00:00:00.000Z",
    title: "Acme Robotics discovery call",
    attendees: ["jack@yagni.example", "priya.raman@acme-robotics.example", "marcus.bell@acme-robotics.example", "tom.fischer@acme-robotics.example"],
  },
  {
    path: "2026-07-08-pilot-scoping.md",
    occurredAt: "2026-07-08T00:00:00.000Z",
    title: "Acme Robotics pilot scoping",
    attendees: [
      "jack@yagni.example",
      "dana@yagni.example",
      "priya.raman@acme-robotics.example",
      "marcus.bell@acme-robotics.example",
      "tom.fischer@acme-robotics.example",
    ],
  },
  {
    path: "2026-08-26-security-review.md",
    occurredAt: "2026-08-26T00:00:00.000Z",
    title: "Acme Robotics security review",
    attendees: [
      "jack@yagni.example",
      "dana@yagni.example",
      "elena.vasquez@acme-robotics.example",
      "marcus.bell@acme-robotics.example",
      "tom.fischer@acme-robotics.example",
    ],
  },
];

describe("notes source on the Acme corpus", () => {
  it("registers a source named notes emitting notes", async () => {
    const { host } = await setup();
    expect(host.registry.sources.get("notes")?.kinds).toEqual(["note"]);
  });

  it("imports three notes with the expected dates, titles and attendees", async () => {
    const { host, store } = await setup();
    const result = await host.importPath("notes", NOTES);
    expect(result.events).toHaveLength(groundTruth.corpus.counts.notes);

    const notes = (await store.listEvents({ tenantId: "local", source: "notes" })).sort((a, b) => a.externalId.localeCompare(b.externalId));
    expect(
      notes.map((e) => ({
        path: e.externalId,
        occurredAt: e.occurredAt,
        title: e.content.title,
        attendees: e.participants.filter((p) => p.role === "attendee").map((p) => p.address),
      })),
    ).toEqual(EXPECTED);

    for (const e of notes) {
      expect(e.kind).toBe("note");
      expect(e.meta["path"]).toBe(e.externalId);
      expect(e.meta["contentHash"]).toMatch(/^[0-9a-f]{64}$/);
      expect(e.content.text.startsWith("---")).toBe(false);
      expect(e.content.text.startsWith("# ")).toBe(true);
      expect(e.participants[0]).toEqual({ role: "author", self: true });
      // The host marks jack@ and dana@ (selfDomains) as self on attendees too.
      for (const p of e.participants.slice(1)) expect(p.self === true).toBe(p.address!.endsWith("@yagni.example"));
    }

    const review = notes[2]!;
    expect(review.threadKey).toBe("notes:acme-robotics-security-review");
    expect((review.meta["frontmatter"] as Record<string, unknown>)["event"]).toBe("acme-security-review-20260826@yagni.example");
    expect(review.content.text).toContain("SOC 2 Type II report by September 30");
  });

  it("is idempotent: re-importing creates nothing", async () => {
    const { host } = await setup();
    await host.importPath("notes", NOTES);
    const again = await host.importPath("notes", NOTES);
    expect(again.events).toHaveLength(0);
    expect(again.duplicates).toBe(3);
  });

  it("walks directories recursively, skips dotfiles and node_modules, and syncs from watchPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrm-notes-"));
    try {
      mkdirSync(join(dir, "acme"));
      mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
      mkdirSync(join(dir, ".obsidian"));
      writeFileSync(join(dir, "acme/one.md"), "# One\n");
      writeFileSync(join(dir, "two.markdown"), "# Two\n");
      writeFileSync(join(dir, ".draft.md"), "# Hidden\n");
      writeFileSync(join(dir, ".obsidian/x.md"), "# Hidden\n");
      writeFileSync(join(dir, "node_modules/pkg/README.md"), "# Vendor\n");
      writeFileSync(join(dir, "image.png"), "");

      const { host } = await setup({ watchPath: dir });
      const result = await host.ingest("notes");
      expect(result.events.map((e) => e.externalId).sort()).toEqual(["acme/one.md", "two.markdown"]);

      const idle = await setup();
      expect((await idle.host.ingest("notes")).events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
