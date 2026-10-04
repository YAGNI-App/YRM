# Working in this repository

This file is for any agent or person contributing to YRM. Read it before your first change.

## What YRM is

YRM is an open context layer for relationships. The append-only log of source events (mail, meetings, notes) is the source of truth. Facts are bi-temporal edges with provenance, extracted from events. People, companies and deals are projections the system proposes and a human confirms. Agents read all of it through an MCP server. See `docs/ARCHITECTURE.md` for the design and `docs/decisions/` for why.

## Ground rules

1. **No AI attribution in commits or pull requests.** No `Co-Authored-By` trailers naming an AI, no "Generated with" footers, no model names in commit messages. The work speaks for itself.
2. **Contracts first.** `packages/core/src/contracts/` is the shared interface. If you need to change a contract, do it in its own small PR with a one-paragraph justification, and expect it to be reviewed harder than anything else.
3. **Events are never mutated. Facts are never edited.** Append a new event; record a superseding fact. If you find yourself writing an UPDATE on either table, stop.
4. **Human beats model.** A human-origin fact outranks model and rule origins and never flips back. The store enforces it; do not work around it.
5. **The expensive model sees facts, not corpora.** Any code path that feeds raw event text to the `synthesize` tier for more than one event at a time needs an ADR.
6. **Everything is an extension.** New sources, extractors, resolvers, rankers, providers, commands and tools register through `ExtensionAPI`. Core gets smaller, not bigger.
7. **Deterministic before model.** If a header, a regex or a rule can do it, it does. Models are for meaning.
8. **No provider lock-in.** Nothing outside a provider package imports a provider SDK. Routing is by tier in config.

## Toolchain

- Runtime: Bun (`>=1.2`). TypeScript runs directly; there is no build step.
- Install: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun test` (colocate tests as `*.test.ts` next to the code, or under `packages/<pkg>/test/`)
- Both: `bun run check`
- Run the CLI from source: `bun run yrm -- <command>`

Tests must not need network or API keys. Mock providers through the `ModelProvider` interface. Fixtures live under `fixtures/`.

## Layout

```
packages/core            @yrm/core      contracts, store (sqlite), extension host, router, pipeline
packages/cli             @yrm/cli       the `yrm` command
packages/provider-*      @yrm/provider-*  model providers (anthropic, openai-compatible)
packages/ext-*           @yrm/ext-*     built-in extensions (mail, calendar, notes, extract, resolve, attention, views, mcp, web)
fixtures/                synthetic corpora with ground-truth facts, used by tests and demos
docs/ARCHITECTURE.md     the design
docs/decisions/          ADRs, numbered, never deleted; superseded ADRs say so at the top
```

Package names are `@yrm/<dir>`. Each package has `package.json` with `"exports": { ".": "./src/index.ts" }` and a `src/index.ts`.

## Code conventions

- `strict` TypeScript with `exactOptionalPropertyTypes`. Do not use `any`; use `unknown` and narrow.
- ESM only. Import with explicit `.ts` extensions inside a package; import other packages as `@yrm/<name>`.
- ULIDs for ids (`ulid` package). ISO 8601 strings for all times. Lowercase email addresses and domains at the edge.
- Small functions, named exports, no default exports except extension entry points (which must default-export the factory).
- Errors: throw `Error` subclasses from `@yrm/core` (`YrmError`, `ConfigError`, `ProviderError`, `StoreError`). Never swallow.
- Logging through the `Logger` passed in; never `console.log` in library code.
- Comment the why, not the what. Match the density of the surrounding file.

## Pull requests

- One concern per PR. Title in imperative mood under 70 characters.
- Body: what changed, why, how it was tested. Link the issue if there is one.
- CI must be green: typecheck and tests.
- Squash-merge. The squash message is the PR title plus body; keep rule 1 in mind.
- Decisions with consequences get an ADR in the same PR (`docs/decisions/NNNN-title.md`, copy the template in `0000-template.md`).

## Review checklist

- Does it mutate an event or edit a fact? Reject.
- Does it import a provider SDK outside `packages/provider-*`? Reject.
- Does it send raw event text to the `synthesize` tier? Needs an ADR.
- Is every fact it records carrying provenance (at least one event id) and an origin with a version?
- Will it still work with no API keys configured? It must degrade, not crash.
- Are tests present and do they run offline?
