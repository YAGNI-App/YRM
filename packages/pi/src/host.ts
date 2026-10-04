// Bun only: imports @yrm/core, whose store uses bun:sqlite.
import { bootstrap, findEntities } from "@yrm/cli";
import { createLogger, YrmError, type Entity, type Host, type ToolContext } from "@yrm/core";
import { HOST_READY_TOPIC } from "@yrm/ext-mcp";

/** Who facts and notes written from pi are attributed to. */
export const PI_PRINCIPAL = "agent:pi";

export type BootHost = () => Promise<Host>;

/**
 * Boot the same host `yrm` would for this directory (config, providers,
 * built-in extensions, `.yrm/extensions`), then bind it to `@yrm/ext-mcp`,
 * whose tools need ranking and context bundles.
 */
export function bootFromConfig(cwd: string): BootHost {
  return async () => {
    const { host } = await bootstrap({ cwd, log: createLogger("error") });
    host.events.emit(HOST_READY_TOPIC, host);
    return host;
  };
}

/**
 * Opens the store on first use, not at extension load: pi loads extensions
 * in contexts that never start a session and asks that resources start lazily.
 */
export class LazyHost {
  #boot: BootHost;
  #host: Promise<Host> | null = null;

  constructor(boot: BootHost) {
    this.#boot = boot;
  }

  get(): Promise<Host> {
    if (!this.#host) {
      const pending = this.#boot();
      // A failed boot is retried on the next call instead of caching the rejection.
      pending.catch(() => {
        if (this.#host === pending) this.#host = null;
      });
      this.#host = pending;
    }
    return this.#host;
  }

  async close(): Promise<void> {
    const pending = this.#host;
    this.#host = null;
    if (pending) await (await pending).close();
  }
}

export function toolContext(host: Host): ToolContext {
  return { tenantId: host.config.tenant.id, store: host.store, models: host.models, log: host.log, principal: PI_PRINCIPAL };
}

/** Run one of YRM's registered agent tools (from `@yrm/ext-mcp`) as `agent:pi`. */
export async function runYrmTool(host: Host, name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = host.registry.tools.get(name);
  if (!tool) {
    throw new YrmError(
      "YRM_TOOL_MISSING",
      `YRM has no "${name}" tool. It comes from @yrm/ext-mcp; check it is installed and not listed in \`disable\` in yrm.config.ts.`,
    );
  }
  return tool.run(input, toolContext(host));
}

/** Live (not rejected or merged) entities for a name, address, domain or id. */
export async function lookup(host: Host, query: string): Promise<Entity[]> {
  return (await findEntities(host, query)).filter((e) => e.status !== "rejected" && e.status !== "merged");
}

/** Exactly one entity for `query`, or an error that lists the candidates. */
export async function lookupOne(host: Host, query: string, field: string): Promise<Entity> {
  const found = await lookup(host, query);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new YrmError("YRM_NO_ENTITY", `"${field}": nothing in YRM matches "${query}"`);
  const list = found
    .slice(0, 10)
    .map((e) => `${e.id} (${e.kind}, ${e.name})`)
    .join("; ");
  throw new YrmError("YRM_AMBIGUOUS_ENTITY", `"${field}": "${query}" matches ${found.length} entities; pass one id: ${list}`);
}
