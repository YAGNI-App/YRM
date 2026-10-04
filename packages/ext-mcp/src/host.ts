import { HOST_READY_TOPIC, YrmError, type Host } from "@yrm/core";

/**
 * The slice of the host this extension needs beyond `ExtensionAPI`: ranking,
 * context bundles, ingest (so notes fire hooks), projection, hooks and the
 * full tool registry for `serve`. `ExtensionAPI` does not expose these, so
 * the host is handed in explicitly (see `createMcpExtension`) or, normally,
 * announced by `host.start()` on the cross-extension bus under `HOST_READY_TOPIC`.
 */
export type McpHost = Pick<
  Host,
  "config" | "store" | "models" | "log" | "registry" | "hooks" | "rank" | "buildContext" | "ingest" | "project"
>;

/** The core host emits this with itself in `start()`, which binds it here. */
export { HOST_READY_TOPIC };

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
          `Call host.start() after loading extensions (it emits "${HOST_READY_TOPIC}"), or register with createMcpExtension({ host }).`,
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
