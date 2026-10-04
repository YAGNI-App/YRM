/**
 * Extensions the CLI loads by default, in this order. Each is optional: a
 * package that is not installed is skipped (logged at debug), so the CLI works
 * with whatever subset is present and picks the rest up once installed.
 * List a name in `disable` in yrm.config.ts to turn one off.
 */
export const BUILTINS = [
  "@yrm/ext-mail",
  "@yrm/ext-calendar",
  "@yrm/ext-notes",
  "@yrm/ext-resolve",
  "@yrm/ext-extract",
  "@yrm/ext-attention",
  "@yrm/ext-mcp",
] as const;

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
