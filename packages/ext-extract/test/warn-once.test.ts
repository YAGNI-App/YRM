import { describe, expect, it } from "bun:test";
import { createHost, RouterError, type Logger, type Route, type YrmConfig } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import extract, { manifest } from "../src/index.ts";
import { ELENA, JACK, MARCUS, message } from "./helpers.ts";

const ROUTE: Route[] = [{ provider: "openai-compatible", model: "qwen3:8b" }];

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: ["jack@yagni.example"] },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: { triage: ROUTE, extract: ROUTE } },
};

function capture(): { log: Logger; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    log: {
      debug: () => {},
      info: (m) => infos.push(m),
      warn: (m) => warns.push(m),
      error: () => {},
    },
  };
}

const failed = (tier: string) => new RouterError("ALL_ROUTES_FAILED", tier, `every route for tier "${tier}" failed: NETWORK`);

// Long enough that the rule gate lets the model extractor run.
const TEXT = "I will send you our SOC 2 Type II report by September 30. Can you confirm the pilot dates?";

describe("ext-extract with an unreachable model", () => {
  it("warns once per tier per run, then stays quiet and keeps rule facts", async () => {
    const events = [1, 2, 3].map(() => message(JACK, [ELENA, MARCUS], TEXT));
    // Each event: one triage call fails; triage wrote nothing, so the model extractor gates on rules and fails too.
    const responses = events.flatMap(() => [failed("triage"), failed("extract")]);
    const models = new FakeRouter(responses, { triage: ROUTE, extract: ROUTE });
    const { log, warns } = capture();
    const host = createHost(config, { store: new MemoryStore(), models, log });
    await host.use(extract, manifest);
    await host.start();

    let facts = 0;
    for (const e of events) facts += (await host.extract(e)).facts.length;
    expect(facts).toBeGreaterThan(0);
    expect(warns.filter((w) => w.includes("triage call failed"))).toHaveLength(1);
    expect(warns.filter((w) => w.includes("extract call failed"))).toHaveLength(1);

    // A new run (host:start) warns again.
    models.push(failed("triage"), failed("extract"));
    await host.stop();
    await host.start();
    await host.extract(message(JACK, [ELENA, MARCUS], TEXT));
    expect(warns.filter((w) => w.includes("triage call failed"))).toHaveLength(2);
  });
});
