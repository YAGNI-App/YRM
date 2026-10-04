# @yrm/pi

A [pi](https://github.com/earendil-works/pi) package for YRM. It gives the pi coding agent the user's relationship record: tools that answer from facts with provenance, a `/yrm` command, a skill that teaches the model when to use which tool, and a `/yrm-brief` prompt for a morning brief.

This is one optional client of YRM, on the same footing as any MCP client (ADR 0004). YRM does not depend on pi.

## Install

Once published:

```sh
pi install npm:@yrm/pi
```

For now, from a YRM checkout (`bun install` first, so the package's workspace dependencies resolve):

```sh
pi install /path/to/YRM/packages/pi           # personal
pi install -l /path/to/YRM/packages/pi        # this project only
pi -e /path/to/YRM/packages/pi                # one session, nothing saved
```

The package holds `extensions/yrm.ts`, `skills/yrm/` and `prompts/yrm-brief.md`, declared under `"pi"` in `package.json`.

## Two modes

On load the extension looks for `yrm.config.ts` from pi's working directory upward.

- **No config:** only `/yrm` is registered, and it explains how to run `yrm init`.
- **pi on Bun (in-process):** YRM's host boots inside pi's process, from the same config `yrm` uses, when a tool first needs it, and closes when the session ends. This is the full mode: five tools, the `/yrm` command and automatic context. pi runs on Bun when you use its Bun-compiled binary or start it with `bun`.
- **pi on Node (MCP):** YRM's store uses `bun:sqlite`, which Node does not have, so the extension does not load YRM. It registers YRM's MCP server with `pi.registerMcpServer("yrm", ...)`, which runs `bun run <YRM>/packages/cli/src/main.ts serve` in the config's directory. Tools show up as `mcp__yrm__yrm_*`, with the same exposure as below. If the pi runtime cannot register MCP servers, `/yrm` prints the `.pi/mcp.json` entry to add instead. There is no `/yrm today|who|facts` and no automatic context in this mode; ask the model, or use the `yrm` CLI.

Bun must be installed in both modes. Only the in-process mode is covered by this package's tests; the MCP mode runs `yrm serve` from `@yrm/ext-mcp`.

## Tools (in-process)

| Tool | Exposure | What it does |
|---|---|---|
| `yrm_context` | direct | A token-budgeted brief for `entities` (names, email addresses, domains or ids) or a `thread` (a key, or a subject such as "Re: Pricing for Q4"). |
| `yrm_facts` | codemode | The bi-temporal fact query: `validAt` (true in the world then) and `asOf` (what YRM believed then). Returns `structuredContent` so a codemode script can filter facts before they reach context. |
| `yrm_today` | direct | The attention queue, with reasons and evidence. |
| `yrm_search_entities` | deferred | Name or identifier search; found through tool search. |
| `yrm_record_fact` | direct | Records a human-origin fact as `agent:pi`. It must cite an `eventId`, or pass `note` and the note is recorded first and cited. pi asks the user to approve every write; without a UI the call needs `confirm: true`. |

A `codemode` tool is not declared to the model; it is reached from pi's `codemode` tool, so turn codemode on (see pi's `docs/cli.md`) or `yrm_facts` stays out of reach. `yrm_context` covers most questions without it.

These call the tools `@yrm/ext-mcp` registers on the host, so pi and MCP clients get the same answers and the same write rules.

## Automatic context

Before each prompt runs, the extension looks for email addresses, domains, full entity names and unambiguous capitalized first names that resolve in YRM. If any match (at most five entities), it adds a `<yrm_context>` system prompt section of at most 1,200 tokens: fact statements with type, dates, origin and the event each one cites. Raw event text is never injected. Prompts that name no one get no section.

## Configuration

```ts
// yrm.config.ts
settings: {
  pi: {
    autoContext: true, // default; false turns the automatic section off
  },
},
```

Everything else (storage, providers, extensions) is the normal YRM config. The MCP mode also reads `settings.mcp` (see `@yrm/ext-mcp`).

## Commands

```text
/yrm today [YYYY-MM-DD]
/yrm who <name|address|domain>
/yrm facts <entity> [--at <iso>] [--as-of <iso>] [--all]
/yrm-brief [YYYY-MM-DD]          prompt template: a morning brief from yrm_today
```

Output appears as a notification in the TUI, or as a transcript message where there is no UI.

## Demo

```text
> /yrm who acme-robotics.example
Acme Robotics  organization  [confirmed]  01K6...  domain:acme-robotics.example
> draft a reply to marcus@acme-robotics.example about pricing
  <yrm_context> added: "Marcus asked for Q4 pricing by Friday. [ask/asked_for; 2026-09-01; model; event 01K6...]"
> Priya says Marcus needs CFO sign-off; record it  ->  yrm_record_fact (note first)  ->  approve? yes
```

## Embedding and tests

`createYrmPiExtension({ cwd, bun, boot, cliMain })` from `@yrm/pi` builds the extension with overrides; `boot` hands it a host you built yourself. `src/pi-types.ts` declares the slice of pi's `ExtensionAPI` the package uses, checked against pi 1.0.2. We do not install `@earendil-works/pi-coding-agent` for types because it is the whole pi runtime. `typebox` is a peer dependency because pi supplies it to extensions.
