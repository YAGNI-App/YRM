import { z } from "zod";

/**
 * YRM tools declare plain JSON Schema (`Tool.inputSchema`) so they stay
 * SDK-agnostic. The MCP SDK's `McpServer` wants zod, so this converts the
 * subset tools actually use: object, string, number/integer, boolean, array,
 * enum, nullable type unions and optional properties. Anything else becomes
 * `z.any()` so an unusual schema loosens validation instead of breaking the
 * server; the tool still validates its own input.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return z.any();
  const s = schema as Record<string, unknown>;
  const describe = <T extends z.ZodType>(t: T): T =>
    typeof s["description"] === "string" ? (t.describe(s["description"]) as T) : t;

  const en = s["enum"];
  if (Array.isArray(en) && en.length > 0) {
    if (en.every((v): v is string => typeof v === "string")) return describe(z.enum(en as [string, ...string[]]));
    const literals = en.filter(
      (v): v is string | number | boolean | null =>
        v === null || ["string", "number", "boolean"].includes(typeof v),
    );
    if (literals.length === en.length) {
      const opts = literals.map((v) => z.literal(v));
      return describe(opts.length === 1 ? opts[0]! : z.union(opts as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]));
    }
    return describe(z.any());
  }

  const type = s["type"];
  if (Array.isArray(type)) {
    const variants = type.map((t) => jsonSchemaToZod({ ...s, type: t, description: undefined }));
    if (variants.length === 0) return describe(z.any());
    if (variants.length === 1) return describe(variants[0]!);
    return describe(z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]));
  }

  switch (type) {
    case "string":
      return describe(z.string());
    case "number":
      return describe(z.number());
    case "integer":
      return describe(z.number().int());
    case "boolean":
      return describe(z.boolean());
    case "null":
      return describe(z.null());
    case "array":
      return describe(z.array(jsonSchemaToZod(s["items"])));
    case "object":
      return describe(objectSchema(s));
    default:
      return describe(z.any());
  }
}

function objectSchema(s: Record<string, unknown>): z.ZodType {
  const props = s["properties"];
  const required = new Set(Array.isArray(s["required"]) ? (s["required"] as unknown[]).filter((r) => typeof r === "string") : []);
  const shape: Record<string, z.ZodType> = {};
  if (typeof props === "object" && props !== null) {
    for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
      const t = jsonSchemaToZod(sub);
      shape[key] = required.has(key) ? t : t.optional();
    }
  }
  // Objects with declared properties strip unknown keys unless told otherwise;
  // free-form objects (no properties) pass everything through.
  if (s["additionalProperties"] === true || props === undefined) return z.looseObject(shape);
  return z.object(shape);
}

/** Tool input schemas must be objects at the top level for MCP. */
export function toolInputSchema(schema: Record<string, unknown>): z.ZodType {
  if (schema["type"] !== "object") return z.looseObject({});
  return jsonSchemaToZod(schema);
}
