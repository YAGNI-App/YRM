import { createHost, silentLogger, SqliteStore, type Command, type Host, type NewSourceEvent, type SourceEvent, type YrmConfig } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import resolveExtension, { manifest } from "../src/index.ts";

export const TENANT = "local";

export function configWith(settings: Record<string, unknown> = {}): YrmConfig {
  return {
    tenant: { id: TENANT, selfAddresses: ["jack@yagni.example"], selfDomains: ["yagni.example"], timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
    settings: {
      resolve: { freemailDomains: ["mailhub.example"], selfDomains: ["yagni.example"], selfOrgName: "YAGNI", ...settings },
    },
  };
}

export async function setup(settings: Record<string, unknown> = {}): Promise<{ host: Host; store: SqliteStore }> {
  const store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  const host = createHost(configWith(settings), { store, models: new FakeRouter(), log: silentLogger });
  await host.use(resolveExtension, manifest);
  return { host, store };
}

/** Ingest through a throwaway source, then resolve each new event in log order. */
export async function ingestAndResolve(host: Host, events: NewSourceEvent[]): Promise<SourceEvent[]> {
  const result = await host.ingest({
    name: "fake",
    kinds: ["message"],
    async sync(ctx) {
      await ctx.emit(events);
    },
  });
  const out: SourceEvent[] = [];
  for (const e of result.events) out.push((await host.resolve(e)).event);
  return out;
}

export async function runCommand(host: Host, name: string, args: string[], flags: Record<string, string | boolean> = {}) {
  const cmd = host.registry.commands.get(name) as Command;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await cmd.run({
    tenantId: TENANT,
    args,
    flags,
    store: host.store,
    models: host.models,
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    log: silentLogger,
  });
  return { code, stdout, stderr };
}

type Addr = string | { name: string; address: string };

function party(role: string, a: Addr) {
  return typeof a === "string" ? { role, address: a } : { role, address: a.address, name: a.name };
}

export function message(
  id: string,
  occurredAt: string,
  from: Addr,
  to: Addr[],
  opts: { cc?: Addr[]; thread?: string; text?: string } = {},
): NewSourceEvent {
  const ev: NewSourceEvent = {
    source: "fake",
    kind: "message",
    externalId: id,
    occurredAt,
    participants: [party("from", from), ...to.map((a) => party("to", a)), ...(opts.cc ?? []).map((a) => party("cc", a))],
    content: { text: opts.text ?? "Hello." },
    meta: {},
  };
  if (opts.thread !== undefined) ev.threadKey = opts.thread;
  return ev;
}
