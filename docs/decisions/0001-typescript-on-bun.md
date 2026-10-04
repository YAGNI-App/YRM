# 0001. Use TypeScript on Bun instead of Rust

Date: 2026-10-04
Status: accepted

## Context

YRM was first reserved as a Rust project: one static binary, a Postgres database and a fixed set of CRM tables (people, companies, deals, timeline). The crate `yrm` 0.0.1 on crates.io is a placeholder from that plan.

Three things changed the plan. First, the product moved from a CRM with fixed tables to a context layer where the event log is the truth and entities are projections (see 0002). Almost all of the interesting work in that design is calling models, parsing their structured output, extracting facts from text and storing records whose shape is not known in advance. That work is bound by model latency and by how fast we can change prompts and extractors, not by CPU throughput. A Rust binary would spend its time waiting on HTTP.

Second, the composability model we want is pi's (see 0004): extensions are TypeScript modules loaded at runtime with no build step, so a user can drop a file into `.yrm/extensions/` and it works. Doing the same in Rust means either dynamic libraries with an unstable ABI, WASM components with a much heavier authoring story, or an embedded scripting language that is not the one our contributors already write. Third, the deployment property we wanted from Rust, a single binary, is available from Bun: `bun build --compile` produces one executable that embeds the runtime.

## Decision

YRM is a TypeScript monorepo running on Bun (`>=1.2`). TypeScript runs directly with no build step for development and for extensions. Releases ship as a compiled single binary from `bun build --compile` and as npm packages under `@yrm/*`.

Specifics:

- Strict TypeScript with `exactOptionalPropertyTypes`, ESM only, explicit `.ts` imports.
- `bun:sqlite` for the default store (0006), `bun test` for tests, `bun x tsc --noEmit` for typechecking.
- Contracts live in `packages/core/src/contracts/` and are the shared interface for every package and extension.
- The `yrm` crate on crates.io stays reserved and is not developed further.

## Consequences

Easier: extensions are plain TypeScript files with full types from `@yrm/core`. Provider SDKs, MCP libraries and JSON Schema tooling are first-class in this ecosystem. Extractors and prompts change without a compile step.

Harder: we depend on Bun specifically, not just Node. `bun:sqlite` and `bun build --compile` have no exact Node equivalents, so running on Node later needs a store driver and a different packaging story. Bun is younger than Node and we will hit runtime bugs that Node users would not.

Given up: Rust's memory and type guarantees, predictable performance on very large logs, and a binary measured in single-digit megabytes. A compiled Bun binary is roughly 50 to 100 MB. If a hot path (bulk ingest of millions of messages, vector search) turns out to need native speed, we will isolate it behind an interface and write that piece natively rather than revisit this decision for the whole system.

## Alternatives considered

- **Rust with a fixed Postgres schema (the original plan).** Fast and small, but the schema-less, extension-heavy design would fight the language at every seam.
- **Rust core with WASM or Lua extensions.** Keeps a native core, but makes every extension author learn a second toolchain and gives up shared types.
- **TypeScript on Node.** Mature and portable, but needs a build step or loader for TypeScript, a native SQLite binding and a separate bundler for single-binary output.
- **Python.** Strong model and data tooling, but weaker static typing for contracts, slower startup and no comparable single-binary story.
