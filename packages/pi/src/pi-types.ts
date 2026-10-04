/**
 * The slice of pi's extension API this package uses, declared structurally.
 *
 * The real declarations live in `@earendil-works/pi-coding-agent`
 * (`src/core/extensions/types.ts`, pi 1.0.x). That package is the pi runtime
 * itself (22 MB unpacked plus provider SDKs), so we do not install it for
 * types. Every name and signature below was checked against pi 1.0.2; pi
 * passes its full `ExtensionAPI`, which is assignable to this subset.
 */
import type { TSchema } from "typebox";

/** pi's `ToolExposure`. */
export type PiToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

export interface PiTextContent {
  type: "text";
  text: string;
}

/** pi's `AgentToolResult` plus the optional `structuredContent` codemode scripts receive. */
export interface PiToolResult<TDetails = unknown> {
  content: PiTextContent[];
  details: TDetails;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PiUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
}

/** pi's `ExtensionContext` (handlers, tools) and `ExtensionCommandContext` share these fields. */
export interface PiContext {
  cwd: string;
  /** Dialogs work (TUI and RPC modes). */
  hasUI: boolean;
  ui: PiUI;
}

/** MCP tool annotations, as pi's `ToolAnnotations`. */
export interface PiToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** pi's `ToolDefinition`, minus rendering hooks we do not use. */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;
  outputSchema?: TSchema;
  exposure?: PiToolExposure;
  annotations?: PiToolAnnotations;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiContext,
  ): Promise<PiToolResult>;
}

/** pi's `RegisteredCommand` without `name` and `sourceInfo`. */
export interface PiCommandOptions {
  description?: string;
  handler: (args: string, ctx: PiContext) => Promise<void>;
}

/** pi's `BeforeAgentStartEvent`; `systemPromptOptions.sections` become XML-tagged system prompt sections. */
export interface PiBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPromptOptions?: { sections?: Record<string, string> };
}

/** pi's `CustomMessage` fields accepted by `sendMessage` and `before_agent_start` results. */
export interface PiCustomMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export interface PiBeforeAgentStartResult {
  message?: PiCustomMessage;
}

/** pi's `McpStdioServerConfig`. */
export interface PiMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  description?: string;
  exposure?: "codemode" | "deferred" | "direct" | "hidden";
  toolExposure?: Record<string, "codemode" | "deferred" | "direct" | "hidden">;
  timeout?: number;
}

export interface PiExtensionAPI {
  on(
    event: "before_agent_start",
    handler: (event: PiBeforeAgentStartEvent, ctx: PiContext) => Promise<PiBeforeAgentStartResult | void>,
  ): () => void;
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: PiContext) => Promise<void> | void): () => void;
  registerTool(tool: PiToolDefinition): void;
  registerCommand(name: string, options: PiCommandOptions): void;
  sendMessage(message: PiCustomMessage, options?: { triggerTurn?: boolean }): void;
  /** Added in pi 1.0. Optional here so older or replaced MCP runtimes degrade to printed instructions. */
  registerMcpServer?(name: string, config: PiMcpServerConfig): void;
}
