import { YrmError, type Host } from "@yrm/core";

/**
 * The slice of the host this extension needs beyond `ExtensionAPI`: ranking,
 * context bundles, ingest (so notes fire hooks), projection, hooks and the
 * full tool registry for `serve`. `ExtensionAPI` does not expose these, so
 * the host is handed in explicitly (see `createMcpExtension`) or announced on
 * the cross-extension bus under `HOST_READY_TOPIC`.
 */
export type McpHost = Pick<
  Host,
  "config" | "store" | "models" | "log" | "registry" | "hooks" | "rank" | "buildContext" | "ingest" | "project"
>;

/** `host.events.emit(HOST_READY_TOPIC, host)` after loading extensions binds the host. */
export const HOST_READY_TOPIC = "host:ready";

export class HostBinding {
  #host: McpHost | null;

  constructor(host: McpHost | null = null) {
    this.#host = host;
  }

  bind(host: McpHost): void {
    this.#host = host;
  }

  get current(): McpHost | null {
    return this.#host;
  }

  require(what: string): McpHost {
    if (!this.#host) {
      throw new YrmError(
        "MCP_HOST_NOT_BOUND",
        `${what} needs the YRM host, which was not handed to the mcp extension. ` +
          `Register it with createMcpExtension({ host }) or emit "${HOST_READY_TOPIC}" with the host after loading extensions.`,
      );
    }
    return this.#host;
  }
}

export function isMcpHost(v: unknown): v is McpHost {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h["rank"] === "function" && typeof h["buildContext"] === "function" && typeof h["registry"] === "object";
}
