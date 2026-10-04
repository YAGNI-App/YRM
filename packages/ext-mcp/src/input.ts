import { YrmError } from "@yrm/core";

/**
 * Tool inputs arrive validated by the MCP SDK, but in-process agents call
 * `Tool.run` directly, so every tool narrows its own input with these.
 */
export type Input = Record<string, unknown>;

export class ToolInputError extends YrmError {
  constructor(message: string) {
    super("INVALID_TOOL_INPUT", message);
  }
}

export function asInput(raw: unknown): Input {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError("tool input must be an object");
  return raw as Input;
}

export function str(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  return v;
}

export function optStr(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolInputError(`"${key}" must be a string`);
  return v;
}

export function optNum(input: Input, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`"${key}" must be a number`);
  return v;
}

export function optBool(input: Input, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolInputError(`"${key}" must be a boolean`);
  return v;
}

export function optStrArray(input: Input, key: string): string[] | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ToolInputError(`"${key}" must be an array of strings`);
  return v as string[];
}

export function optTime(input: Input, key: string): string | undefined {
  const v = optStr(input, key);
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new ToolInputError(`"${key}" must be an ISO 8601 date or time, got ${JSON.stringify(v)}`);
  return new Date(t).toISOString();
}

export function optDate(input: Input, key: string): string | undefined {
  const v = optStr(input, key);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ToolInputError(`"${key}" must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(v)}`);
  }
  return v.slice(0, 10);
}
