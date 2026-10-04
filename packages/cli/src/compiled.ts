import * as core from "@yrm/core";

/**
 * True inside a binary from `bun build --compile`, whose own modules live on
 * Bun's embedded filesystem (`/$bunfs/` on POSIX, `B:/~BUN/` on Windows).
 */
export function isCompiled(url: string = import.meta.url): boolean {
  return url.includes("$bunfs") || url.includes("~BUN");
}

/**
 * A compiled binary still imports `yrm.config.ts` and `.yrm/extensions/*.ts`
 * from disk at runtime, and those files usually `import ... from "@yrm/core"`.
 * There is no node_modules beside the binary to resolve that from, so hand
 * them the binary's own copy. Sharing one instance also keeps `instanceof`
 * checks on core's error classes working across the boundary. A source
 * checkout resolves `@yrm/core` normally and never calls this.
 */
export function provideCoreToRuntimeImports(): void {
  Bun.plugin({
    name: "yrm-embedded-core",
    setup(build) {
      build.module("@yrm/core", () => ({ exports: { ...core }, loader: "object" }));
    },
  });
}
