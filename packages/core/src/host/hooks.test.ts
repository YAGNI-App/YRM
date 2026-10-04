import { describe, expect, it } from "bun:test";
import type { HookContext, NewFact, NewSourceEvent, SourceEvent } from "../contracts/index.ts";
import { MemoryStore } from "../testing/memory-store.ts";
import { FakeRouter } from "../testing/fake-router.ts";
import { HookError } from "./errors.ts";
import { HookBus } from "./hooks.ts";
import { createLogger, type LogRecord } from "./logger.ts";

function setup() {
  const records: LogRecord[] = [];
  const log = createLogger("debug", (r) => records.push(r));
  const bus = new HookBus(log);
  const ctx: HookContext = { tenantId: "local", store: new MemoryStore(), models: new FakeRouter(), log };
  return { bus, ctx, records };
}

const newEvent = (text: string): NewSourceEvent => ({
  source: "test",
  kind: "note",
  externalId: text,
  occurredAt: "2026-01-01T00:00:00.000Z",
  participants: [],
  content: { text },
  meta: {},
});

describe("HookBus", () => {
  it("runs handlers in registration order", async () => {
    const { bus, ctx } = setup();
    const order: string[] = [];
    bus.on("host:start", async () => void order.push("a"), "a");
    bus.on("host:start", async () => void order.push("b"), "b");
    bus.on("host:start", async () => void order.push("c"), "c");
    await bus.emit("host:start", ctx);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("threads a replaced subject to the next handler; undefined leaves it", async () => {
    const { bus, ctx } = setup();
    const seen: string[] = [];
    bus.on("ingest:before", async (_c, e) => ({ ...e, content: { text: `${e.content.text}+a` } }), "a");
    bus.on("ingest:before", async (_c, e) => {
      seen.push(e.content.text);
      return undefined;
    }, "b");
    bus.on("ingest:before", async (_c, e) => ({ ...e, content: { text: `${e.content.text}+c` } }), "c");
    const out = await bus.pipe("ingest:before", ctx, newEvent("x"));
    expect(seen).toEqual(["x+a"]);
    expect(out?.content.text).toBe("x+a+c");
  });

  it("passes fixed arguments through and replaces only the last one", async () => {
    const { bus, ctx } = setup();
    const event = { id: "e1" } as SourceEvent;
    const fact = { statement: "s" } as NewFact;
    bus.on("extract:after", async (_c, ev, facts) => {
      expect(ev.id).toBe("e1");
      return [...facts, fact];
    });
    const out = await bus.pipe("extract:after", ctx, event, []);
    expect(out).toEqual([fact]);
  });

  it("vetoes on null where allowed and stops calling later handlers", async () => {
    const { bus, ctx } = setup();
    let later = false;
    bus.on("ingest:before", async () => null, "dropper");
    bus.on("ingest:before", async () => {
      later = true;
      return undefined;
    }, "later");
    expect(await bus.pipe("ingest:before", ctx, newEvent("x"))).toBeNull();
    expect(later).toBe(false);
  });

  it("rejects null on hooks that do not allow a veto", async () => {
    const { bus, ctx } = setup();
    bus.on("queue:after_rank", (async () => null) as never, "bad");
    await expect(bus.pipe("queue:after_rank", ctx, [])).rejects.toBeInstanceOf(HookError);
  });

  it("logs and rethrows handler errors wrapped with the extension name", async () => {
    const { bus, ctx, records } = setup();
    const boom = new Error("boom");
    bus.on("host:stop", async () => {
      throw boom;
    }, "breaker");
    const err = await bus.emit("host:stop", ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HookError);
    const he = err as HookError;
    expect(he.extension).toBe("breaker");
    expect(he.hook).toBe("host:stop");
    expect(he.cause).toBe(boom);
    expect(he.message).toContain("breaker");
    expect(records.some((r) => r.level === "error" && r.data?.["extension"] === "breaker")).toBe(true);
  });

  it("unsubscribes", async () => {
    const { bus, ctx } = setup();
    let n = 0;
    const off = bus.on("host:start", async () => void n++);
    await bus.emit("host:start", ctx);
    off();
    await bus.emit("host:start", ctx);
    expect(n).toBe(1);
  });
});
