# 0004. Model the extension architecture on pi without depending on it

Date: 2026-10-04
Status: accepted

## Context

YRM needs many integrations that we will not all write: mail providers, calendars, chat, call transcripts, ticketing systems, domain-specific extractors ("pull procurement steps out of enterprise deals"), rankers tuned to one team's habits, and model providers. If each of these lives in core, core grows with every integration and every contributor needs to understand all of it.

pi ([repository](https://github.com/earendil-works/pi), [docs](https://pi.dev/docs/latest)) is a coding agent harness built on the opposite principle. Its core is small. TypeScript extensions are loaded at runtime with no build step and receive a typed API. Hooks fire at every seam and can rewrite or veto what passes through. Tools carry an exposure level (direct, deferred, codemode) so the model's context only holds the few tools it needs, and the rest are found by search or called from sandboxed code. Packages are the unit of distribution. That shape matches what we need closely.

pi is an agent harness, not a data system. Taking it as a dependency would tie our core to its release cadence and pull in machinery we would not use.

## Decision

YRM copies pi's architecture, not its code. `@yrm/core` contains the contracts, the store, the extension host, the model router and the pipeline. Everything else is an extension registered through `ExtensionAPI` (`packages/core/src/contracts/extensions.ts`).

Specifics:

- An extension is a module whose default export is a factory receiving `ExtensionAPI`. It can register sources, extractors, resolvers, rankers, providers, commands and tools, and subscribe to hooks.
- Hooks: `ingest`, `resolve`, `extract`, `fact`, `entity`, `queue`, `model`, `context:build`, `host`. Returning a value replaces the subject; `null` vetoes where allowed.
- Tools declare `exposure: "direct" | "deferred" | "codemode"` and `readOnly`. Writes need confirmation in interactive hosts.
- Load order: built-ins, then packages in `yrm.config.ts`, then `.yrm/extensions/*.ts`, then `~/.yrm/extensions/*.ts`. Hooks run in load order.
- Extensions never see SQL, never write to stdout, and must work in CLI, MCP and embedded hosts.
- YRM has no dependency on pi. A thin `@yrm/pi` package may exist later as one optional client, on equal footing with any other MCP or embedded client.

## Consequences

Easier: a new source is a file, not a fork. Built-ins use the same API as third parties, so the API gets exercised. Hooks give users a place to enforce policy (drop a sender, redact a field, block a model call) without patching core. Exposure levels keep the MCP tool list short as the package count grows.

Harder: the extension API is a public contract from 0.1. Changing it breaks third-party code, so contract PRs get stricter review (AGENTS.md rule 2). Hooks that rewrite their subject make behavior depend on load order, which is hard to debug; we will need `yrm doctor` to print the hook chain. Loading arbitrary TypeScript from a user's home directory runs that code with full privileges. There is no sandbox in 0.1; extensions are trusted the way npm packages are.

Given up: pi's own improvements for free. When pi changes a pattern for a good reason, we have to notice and port it ourselves.

## Alternatives considered

- **Depend on pi and build YRM as a pi extension.** Fastest start, but ties a data system to an agent harness's lifecycle and runtime.
- **Monolith with built-in integrations.** Simpler to ship 0.1, but every source becomes core code and core review load.
- **Out-of-process plugins over RPC or MCP.** Strong isolation, but every extractor call crosses a process boundary and authors lose shared types.
- **WASM components.** Sandboxed and language-neutral, but heavy for authors and poor access to model SDKs.
