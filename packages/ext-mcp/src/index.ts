import {
  todayIn,
  type Command,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionManifest,
  type Tool,
  type ToolContext,
} from "@yrm/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContextAdditions } from "./context.ts";
import { dropDismissed } from "./dismiss.ts";
import { clampLimit } from "./format.ts";
import { HOST_READY_TOPIC, HostBinding, isMcpHost, type McpHost } from "./host.ts";
import { getEntityView, readTools, todayView } from "./read-tools.ts";
import { createMcpServer, serveStdio } from "./server.ts";
import { noteSource, writeTools, type WriteSettings } from "./write-tools.ts";

export { buildContextAdditions, HOW_TO_READ, OPEN_ITEMS_TITLE } from "./context.ts";
export { ATTENTION_NS, dismissKey, dropDismissed, type Dismissal } from "./dismiss.ts";
export { HOST_READY_TOPIC, HostBinding, type McpHost } from "./host.ts";
export { classify, openItems, type OpenItem } from "./open-items.ts";
export { jsonSchemaToZod } from "./schema.ts";
export { createMcpServer, exposedTools, serveStdio, toolError, type McpResources, type McpServerOptions } from "./server.ts";
export { STORY_MARKDOWN } from "./story.ts";
export { ConfirmationRequiredError, DEFAULT_PRINCIPAL, NOTE_SOURCE, ORIGIN_VERSION } from "./write-tools.ts";

export const manifest: ExtensionManifest = {
  name: "mcp",
  version: "0.1.0",
  description: "MCP server and agent tools: facts with provenance, entities, events, the attention queue and context bundles.",
};

/** Settings under `settings.mcp` in yrm.config.ts. */
export interface McpSettings {
  /** Let write tools run without `confirm: true`. Only for trusted, non-interactive agents. */
  unattendedWrites?: boolean;
  /** Who MCP callers act as, e.g. "user:jack". Default `agent:mcp/<client name>`. */
  principal?: string;
}

export interface McpExtensionOptions {
  /** The host, when the caller has it at registration time (CLI, embedding, tests). */
  host?: McpHost;
}

/** Entities advertised in resources/list. */
const RESOURCE_ENTITY_LIMIT = 50;

/**
 * Build the extension. Ranking, context bundles, note ingest and `serve` need
 * the host, which `ExtensionAPI` does not expose: pass it here, or let
 * `host.start()` announce it under `HOST_READY_TOPIC` (the default path).
 * Store-only tools work either way.
 */
export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
  return (yrm: ExtensionAPI) => {
    const binding = new HostBinding(options.host ?? null);
    yrm.events.on(HOST_READY_TOPIC, (payload) => {
      if (isMcpHost(payload)) binding.bind(payload);
    });

    const settings = (): McpSettings => yrm.config.get<McpSettings>() ?? {};
    const writeSettings = (): WriteSettings => ({ unattendedWrites: settings().unattendedWrites === true });
    const own = [...readTools(binding), ...writeTools(binding, writeSettings)];
    for (const tool of own) yrm.registerTool(tool);
    yrm.registerSource(noteSource());

    yrm.on("queue:after_rank", async (ctx, items) =>
      dropDismissed(ctx.store, items, todayIn(binding.current?.config.tenant.timezone)),
    );
    yrm.on("context:build", buildContextAdditions);

    yrm.registerCommand(serveCommand(yrm, binding, own, settings));
  };
}

/** Build an MCP server for a host: all its registered tools, with calls running as `principal`. */
export function createServerForHost(
  host: McpHost,
  opts: { principal?: string; tools?: Tool[] } = {},
): McpServer {
  const binding = new HostBinding(host);
  const tenantId = host.config.tenant.id;
  return createMcpServer({
    tools: opts.tools ?? host.registry.tools.list(),
    log: host.log,
    context: (client) => toolContext(tenantId, host, opts.principal, client),
    resources: resourcesFor(binding, { tenantId, store: host.store }),
  });
}

function toolContext(
  tenantId: string,
  deps: Pick<ToolContext, "store" | "models" | "log">,
  principal: string | undefined,
  client: string | undefined,
): ToolContext {
  const ctx: ToolContext = { tenantId, store: deps.store, models: deps.models, log: deps.log };
  const who = principal ?? (client ? `agent:mcp/${client}` : undefined);
  if (who !== undefined) ctx.principal = who;
  return ctx;
}

function resourcesFor(binding: HostBinding, ctx: Pick<ToolContext, "tenantId" | "store">) {
  return {
    entity: (id: string) => getEntityView(ctx.store, ctx.tenantId, id),
    today: () => todayView(binding, ctx, undefined, clampLimit(undefined)),
    listEntities: async () =>
      (
        await ctx.store.findEntities({
          tenantId: ctx.tenantId,
          status: ["confirmed", "proposed"],
          limit: RESOURCE_ENTITY_LIMIT,
        })
      ).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  };
}

function serveCommand(yrm: ExtensionAPI, binding: HostBinding, own: Tool[], settings: () => McpSettings): Command {
  return {
    name: "serve",
    description: "Serve YRM to agents over MCP (stdio). Reads are open; writes need confirm: true.",
    usage: "serve [--mcp] [--http <port>]",
    async run(ctx) {
      if (ctx.flags["http"] !== undefined) {
        ctx.stderr("yrm serve --http is planned for a later release. Use stdio (the default): yrm serve --mcp");
        return 2;
      }
      const host = binding.current;
      if (!host) {
        ctx.log.warn(
          `mcp: no host bound; serving only this extension's tools, and yrm_today, yrm_context and yrm_record_note will fail. ` +
            `Start the host after loading extensions (it emits "${HOST_READY_TOPIC}"), or use createMcpExtension({ host }).`,
        );
      }
      const tools = host ? host.registry.tools.list() : own;
      const principal = settings().principal;
      const server = createMcpServer({
        tools,
        log: ctx.log,
        context: (client) => toolContext(ctx.tenantId, { store: ctx.store, models: ctx.models, log: ctx.log }, principal, client),
        resources: resourcesFor(binding, { tenantId: ctx.tenantId, store: ctx.store }),
      });
      ctx.log.info("mcp tools", { count: tools.length, extension: yrm.manifest.name });
      await serveStdio(server, ctx.log);
      return 0;
    },
  };
}

const mcpExtension: ExtensionFactory = createMcpExtension();
export default mcpExtension;
