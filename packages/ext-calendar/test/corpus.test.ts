import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, silentLogger, type SourceEvent, type YrmConfig } from "@yrm/core";
// Test doubles are not part of @yrm/core's public exports.
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import calendarExtension, { manifest } from "../src/index.ts";
import groundTruth from "../../../fixtures/acme/ground-truth.json";

const ACME = join(import.meta.dir, "../../../fixtures/acme");
const ICS = join(ACME, "calendar/acme.ics");

function config(settings?: Record<string, unknown>): YrmConfig {
  const c: YrmConfig = {
    tenant: { id: "local", ...groundTruth.tenant, timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
  };
  if (settings) c.settings = { calendar: settings };
  return c;
}

async function setup(settings?: Record<string, unknown>) {
  const store = new MemoryStore();
  const host = createHost(config(settings), { store, models: new FakeRouter(), log: silentLogger });
  await host.use(calendarExtension, manifest);
  return { host, store };
}

describe("calendar source on the Acme corpus", () => {
  it("registers a source named calendar emitting meetings", async () => {
    const { host } = await setup();
    expect(host.registry.sources.get("calendar")?.kinds).toEqual(["meeting"]);
  });

  it("imports four meetings, one cancelled, with lowercased attendees and self marked", async () => {
    const { host, store } = await setup();
    const result = await host.importPath("calendar", ICS);
    expect(result.events).toHaveLength(groundTruth.corpus.counts.calendarEvents);
    expect(result.events).toHaveLength(4);

    const meetings = await store.listEvents({ tenantId: "local", source: "calendar" });
    expect(meetings.every((e) => e.kind === "meeting")).toBe(true);
    expect(meetings.filter((e) => e.meta["cancelled"] === true).map((e) => e.content.title)).toEqual([
      "YAGNI x Acme Robotics: Reno pilot kickoff",
    ]);

    for (const e of meetings) {
      for (const p of e.participants) {
        expect(p.address).toBe(p.address!.toLowerCase());
        expect(p.self === true).toBe(p.address!.endsWith("@yagni.example"));
      }
      expect(e.participants.filter((p) => p.role === "organizer")).toHaveLength(1);
    }

    const review = meetings.find((e) => e.content.title === "YAGNI x Acme Robotics: security review") as SourceEvent;
    expect(review).toBeDefined();
    expect(review.externalId).toBe("acme-security-review-20260826@yagni.example");
    expect(review.occurredAt).toBe("2026-08-26T17:00:00.000Z");
    expect(review.content.text).toContain("Type II window closes Sept 30");
    expect(review.meta).toMatchObject({
      start: "2026-08-26T17:00:00.000Z",
      end: "2026-08-26T18:00:00.000Z",
      durationMinutes: 60,
      cancelled: false,
      status: "CONFIRMED",
    });
    expect(review.participants.filter((p) => p.role === "attendee").map((p) => p.address)).toEqual([
      "jack@yagni.example",
      "elena.vasquez@acme-robotics.example",
      "marcus.bell@acme-robotics.example",
      "tom.fischer@acme-robotics.example",
      "dana@yagni.example",
    ]);
    expect(review.participants.find((p) => p.address === "elena.vasquez@acme-robotics.example")?.name).toBe("Elena Vasquez");
  });

  it("is idempotent: re-importing the same calendar creates nothing", async () => {
    const { host } = await setup();
    await host.importPath("calendar", join(ACME, "calendar"));
    const again = await host.importPath("calendar", ICS);
    expect(again.events).toHaveLength(0);
    expect(again.duplicates).toBe(4);
  });

  it("syncs from settings.calendar.watchPath, and does nothing without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrm-cal-"));
    try {
      writeFileSync(join(dir, "a.ics"), await Bun.file(ICS).text());
      writeFileSync(join(dir, ".hidden.ics"), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
      const watched = await setup({ watchPath: dir });
      expect((await watched.host.ingest("calendar")).events).toHaveLength(4);

      const idle = await setup();
      expect((await idle.host.ingest("calendar")).events).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
