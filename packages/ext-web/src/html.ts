/**
 * A tiny tagged template for server-rendered HTML. Every interpolated value is
 * escaped unless it is already `Html` (the result of another `html` call or of
 * `raw`). There is no other way to put a string into a page.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Renderable = Html | string | number | boolean | null | undefined | Renderable[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function render(v: Renderable): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new Html(out);
}

/** Trusted markup only: never pass anything derived from the store. */
export function raw(s: string): Html {
  return new Html(s);
}

/** A query string from the defined, non-empty values, with its leading `?`. */
export function qs(params: Record<string, string | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
