# 0011. Distribute YRM as a compiled binary, wrapped by Docker

Date: 2026-10-04
Status: accepted

## Context

ADR 0001 chose Bun partly because `bun build --compile` gives the single-binary deployment we wanted from Rust, and said releases would ship as that binary and as npm packages under `@yrm/*`. Until now nothing shipped: running YRM meant cloning the repository and installing Bun. A self-hostable tool needs an artifact a person can download and run, and a container image for servers.

Compiling turned up three things the source tree assumed. The CLI found built-in extensions with `import(spec)` on a computed specifier, which the bundler cannot follow, so a compiled binary shipped without them. The dashboard read its CSS and JS from disk next to its source, which does not exist inside a binary. And a user's `yrm.config.ts` and `.yrm/extensions/*.ts`, still imported from disk at runtime, `import ... from "@yrm/core"`, which has no `node_modules` to resolve from beside a downloaded binary.

## Decision

The compiled Bun executable is the unit of distribution. Docker wraps that same binary. npm publishing of `@yrm/*` is deferred.

- `scripts/build.ts` compiles `packages/cli/src/main.ts` for one target or all release targets (`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`), cross-compiling from a single Linux runner.
- Every first-party extension is a static `import("@yrm/ext-…")` in `packages/cli/src/builtins.ts`. A test fails if a new `packages/ext-*` is missing from that map. `disable` in config still turns any of them off.
- Static assets are imported `with { type: "text" }` so the bundler embeds them.
- Inside a compiled binary, `@yrm/core` imported by runtime-loaded files resolves to the binary's own copy (a `Bun.plugin` virtual module). User extensions and TypeScript configs keep working, with no build step, as ADR 0004 promises.
- The version comes from the root `package.json`. The release workflow refuses a `v*` tag that does not match it.
- A release has one binary per target, `SHA256SUMS`, and `ghcr.io/yagni-app/yrm:<tag>` and `:latest` for `linux/amd64` and `linux/arm64`. `scripts/install.sh` verifies the checksum before installing.
- No auto-update. Upgrading means running the install script again or pulling a new image.

## Consequences

Easier: one download with no runtime to install. The binary, the Docker image and CI's smoke test all run the same artifact. Self-hosting is a volume and a port.

Harder: binaries are 62 to 85 MB, because each one embeds the Bun runtime. Linux binaries need glibc, so Alpine users need the image or a source checkout. Third-party extensions that import npm packages other than `@yrm/core` must bring their own `node_modules` next to the project. macOS binaries are not notarized, so a browser download is quarantined; the install script uses `curl`, which does not set the quarantine flag. Any new runtime file read relative to `import.meta.url` will break in the binary, and only the smoke test catches it.

Given up for now: `bun add @yrm/core` for people embedding YRM or writing typed extensions outside this repository. Publishing waits until the contracts in `packages/core/src/contracts/` settle. Each npm release is a public API promise for every package at once, and the packages export TypeScript source (`./src/index.ts`), which would need a build step or Bun-only consumers. We give up auto-update too: it would need signing keys and a trust story. That is not worth it before 1.0.

## Alternatives considered

- **npm packages first (`bunx @yrm/cli`).** Needs Bun installed and the contracts frozen, and ties every release to a semver promise on internal packages.
- **Docker only.** Leaves out desktop users. Gmail OAuth and the dashboard work best on the user's own machine.
- **Building the image from `bun run` on source instead of the binary.** Bigger image, a second artifact to test, and drift between what Docker users and binary users run.
- **Loading built-ins by computed specifier and shipping `node_modules` beside the binary.** Defeats the point of a single file.
