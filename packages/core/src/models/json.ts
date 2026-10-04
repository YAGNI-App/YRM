import type { JsonSchema } from "../contracts/models.ts";

/**
 * Parse model text as JSON. Tolerates a markdown code fence and prose around a
 * single top-level object or array, which is what models produce when they
 * were asked for JSON but not constrained to it. Returns undefined on failure.
 */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Shallow check of a value against a JSON Schema: top-level type and required
 * keys. Full validation belongs to the caller; this catches the common failure
 * of a model answering in the wrong shape. Returns a reason, or null if it fits.
 */
export function checkSchemaShape(value: unknown, schema: JsonSchema): string | null {
  const type = schema["type"];
  const required = Array.isArray(schema["required"])
    ? schema["required"].filter((k): k is string => typeof k === "string")
    : [];
  if (type === "array") return Array.isArray(value) ? null : "expected a JSON array";
  if (type === "object" || required.length > 0) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "expected a JSON object";
    const missing = required.filter((k) => !(k in value));
    if (missing.length > 0) return `missing required keys: ${missing.join(", ")}`;
  }
  return null;
}
