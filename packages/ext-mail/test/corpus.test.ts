/**
 * Imports the Acme corpus through a real host (memory store, no models) and
 * checks the ingest contract against the corpus ground truth.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createHost, silentLogger, type Host, type SourceEvent, type YrmConfig } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import groundTruth from "../../../fixtures/acme/ground-truth.json";
import mail, { manifest } from "../src/index.ts";

const MAIL_DIR = join(import.meta.dir, "../../../fixtures/acme/mail");
const TENANT = "acme";

const config: YrmConfig = {
  tenant: { id: TENANT, ...groundTruth.tenant, timezone: "UTC" },
  storage: { driver: "memory" },
  models: { routes: {} },
};

let host: Host;
let store: MemoryStore;
let events: SourceEvent[];
let first: Awaited<ReturnType<Host["importPath"]>>;
const byId = (id: string): SourceEvent => {
  const e = events.find((x) => x.externalId === id);
  if (!e) throw new Error(`no event ${id}`);
  return e;
};

beforeAll(async () => {
  store = new MemoryStore(TENANT);
  host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  await host.use(mail, manifest);
  first = await host.importPath("mail", MAIL_DIR);
  events = first.events;
});

afterAll(async () => {
  await host.close();
});

describe("acme corpus import", () => {
  test("creates one event per non-noise message", () => {
    const files = readdirSync(MAIL_DIR).filter((f) => f.endsWith(".eml"));
    expect(files.length).toBe(groundTruth.corpus.counts.messages);
    expect(events.length).toBe(files.length - groundTruth.noise.length);
    expect(events.length).toBe(33);
    expect(first.duplicates).toBe(0);
    expect(events.every((e) => e.tenantId === TENANT && e.source === "mail" && e.kind === "message")).toBe(true);
  });

  test("drops exactly the ground-truth noise", () => {
    const ids = new Set(events.map((e) => e.externalId));
    for (const id of groundTruth.noise) expect(ids.has(id)).toBe(false);
    // Every other message made it: count above plus no noise present means the sets match.
    expect(ids.size).toBe(events.length);
  });

  test("quoted replies keep only the new text", () => {
    const reply = byId("<202606051530.overview@yagni.example>");
    expect(reply.content.text.split("\n").some((l) => l.startsWith(">"))).toBe(false);
    expect(reply.content.text).toContain("Pricing for three DCs");
    expect(reply.content.text).not.toContain("+1 646 555 0142");
    expect(reply.content.stripped).toContain("> Two things that would help me before a call.");
    expect(reply.meta["originalLength"]).toBeGreaterThan(reply.content.text.length);
    expect(reply.content.tokens).toBe(Math.ceil(reply.content.text.length / 4));
    for (const e of events) expect(e.content.text.split("\n").some((l) => l.startsWith(">"))).toBe(false);
  });

  test("replies share a threadKey with their root", () => {
    const intro = byId("<202606020914.intro@acme-robotics.example>");
    expect(intro.threadKey).toBe("202606020914.intro@acme-robotics.example");
    for (const id of [
      "<202606030840.pricing-ask@acme-robotics.example>",
      "<202606051530.overview@yagni.example>",
    ]) {
      expect(byId(id).threadKey).toBe(intro.threadKey!);
    }
    const followUps = byId("<202608271015.secfollowups@yagni.example>");
    const exitAsk = byId("<202609021748.exitask@acme-robotics.example>");
    expect(exitAsk.threadKey).toBe(followUps.threadKey!);
    expect(exitAsk.inReplyTo).toEqual(["<202608281140.hold@acme-robotics.example>"]);
    // Every reply's thread root is an event in the log.
    const keys = new Set(events.map((e) => e.externalId.replace(/^<|>$/g, "")));
    for (const e of events) expect(keys.has(e.threadKey!)).toBe(true);
  });

  test("participants carry roles, lowercase addresses, names and self", () => {
    const ack = byId("<202607100805.decision-ack@yagni.example>");
    expect(ack.participants.map((p) => [p.role, p.address, p.name])).toEqual([
      ["from", "jack@yagni.example", "Jack Collins"],
      ["to", "marcus.bell@acme-robotics.example", "Marcus Bell"],
      ["to", "priya.raman@acme-robotics.example", "Priya Raman"],
      ["cc", "rachel.kim@acme-robotics.example", "Rachel Kim"],
      ["cc", "tom.fischer@acme-robotics.example", "Tom Fischer"],
      ["cc", "dana@yagni.example", "Dana Okafor"],
    ]);
    for (const e of events) {
      for (const p of e.participants) {
        expect(p.address).toBe(p.address!.toLowerCase());
        if (p.address === "jack@yagni.example") expect(p.self).toBe(true);
        if (p.address!.endsWith("@acme-robotics.example")) expect(p.self).toBeUndefined();
      }
    }
  });

  test("records meta and keeps the Date as occurredAt for delayed mail", () => {
    const delayed = byId("<202608141702.leaving@acme-robotics.example>");
    expect(delayed.occurredAt).toBe("2026-08-15T00:02:45.000Z");
    expect(delayed.meta).toMatchObject({
      subject: "Some personal news",
      messageId: "<202608141702.leaving@acme-robotics.example>",
      references: [],
      hasAttachments: false,
      receivedAt: "2026-09-03T13:05:12.000Z",
    });
    expect(delayed.content.title).toBe("Some personal news");
    expect(delayed.rawRef).toEndWith("028-priya-leaving-acme-delayed.eml");
  });

  test("stores a cursor for the source", async () => {
    expect(await store.getCursor(TENANT, "mail")).toEndWith("040-dana-type-ii-slip.eml");
  });

  test("re-import is idempotent", async () => {
    const again = await host.importPath("mail", MAIL_DIR);
    expect(again.events.length).toBe(0);
    expect(again.duplicates).toBe(events.length);
  });
});
