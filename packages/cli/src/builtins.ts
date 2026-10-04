/**
 * Extensions the CLI loads by default, in this order. List a name in
 * `disable` in yrm.config.ts to turn one off.
 */
export const BUILTINS = [
  "@yrm/ext-mail",
  "@yrm/ext-calendar",
  "@yrm/ext-notes",
  "@yrm/ext-resolve",
  "@yrm/ext-extract",
  "@yrm/ext-attention",
  "@yrm/ext-mcp",
  "@yrm/ext-web",
  "@yrm/ext-slack",
] as const;

/**
 * Every first-party extension the CLI ships with, as static imports. Bun's
 * bundler follows `import("<literal>")` but not a computed specifier, so this
 * map is what puts these packages inside the binary that `bun build --compile`
 * produces; there is no node_modules next to it to resolve them from at
 * runtime. BUILTINS load by default; the rest (ext-gmail) load when named in
 * `extensions`, from this map rather than from disk.
 */
export const BUNDLED: Readonly<Record<string, () => Promise<unknown>>> = {
  "@yrm/ext-mail": () => import("@yrm/ext-mail"),
  "@yrm/ext-calendar": () => import("@yrm/ext-calendar"),
  "@yrm/ext-notes": () => import("@yrm/ext-notes"),
  "@yrm/ext-resolve": () => import("@yrm/ext-resolve"),
  "@yrm/ext-extract": () => import("@yrm/ext-extract"),
  "@yrm/ext-attention": () => import("@yrm/ext-attention"),
  "@yrm/ext-mcp": () => import("@yrm/ext-mcp"),
  "@yrm/ext-web": () => import("@yrm/ext-web"),
  "@yrm/ext-gmail": () => import("@yrm/ext-gmail"),
};

/** Which package provides each source the `import` command knows how to route to. */
export const SOURCE_PACKAGES: Readonly<Record<string, string>> = {
  mail: "@yrm/ext-mail",
  calendar: "@yrm/ext-calendar",
  notes: "@yrm/ext-notes",
};

/** `@yrm/ext-mail` -> `ext-mail`, matching the loader's derived names. */
export function packageShortName(spec: string): string {
  const parts = spec.split("/");
  return (spec.startsWith("@") ? parts[1] : parts[0]) ?? spec;
}
