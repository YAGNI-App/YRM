# @yrm/ext-mcp

YRM's MCP server and agent tools. Agents read facts, entities, events, the attention queue and context bundles, and every fact comes back with its provenance (event, speaker, quote, event title and date), both time ranges, confidence and origin, so the agent can judge how far to trust it.

The tools are registered with `yrm.registerTool`, so in-process agents get the same tools as MCP clients. `yrm serve` exposes **every** registered tool, not only these (codemode tools excepted).

## Connect

Over stdio (the default) or Streamable HTTP (`--http`, below). On stdio, logs go to stderr; stdout is the transport.

```sh
bun run /path/to/YRM/packages/cli/src/main.ts serve        # --mcp is the default
```

### Claude Code

```sh
claude mcp add yrm -- bun run /path/to/YRM/packages/cli/src/main.ts serve
```

Run it from the YRM project directory, or the one holding your `yrm.config.ts`, so the server finds your config and database.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "yrm": {
      "command": "bun",
      "args": ["run", "/path/to/YRM/packages/cli/src/main.ts", "serve"],
      "cwd": "/path/to/your/yrm/project"
    }
  }
}
```

### pi

`.pi/mcp.json`:

```json
{
  "mcpServers": {
    "yrm": {
      "command": "bun",
      "args": ["run", "/path/to/YRM/packages/cli/src/main.ts", "serve"]
    }
  }
}
```

### Over HTTP

```sh
yrm serve --http 7788                     # http://127.0.0.1:7788/mcp
yrm serve --http 7788 --host 0.0.0.0      # beyond loopback: needs a token
```

The endpoint is `/mcp` (Streamable HTTP, stateless, JSON responses); `/healthz` answers without authentication. Every request needs `Authorization: Bearer <token>`, except from loopback while `settings.auth.allowLoopback` is true (the default), where calls run as `settings.mcp.principal` or `agent:mcp/http`. A non-loopback bind is refused until at least one token exists. See `@yrm/ext-auth` for the token settings.

Create a token for the agent and add it to Claude Code:

```sh
yrm auth token create claude-code --principal agent:claude-code --scopes read
claude mcp add --transport http yrm http://127.0.0.1:7788/mcp --header "Authorization: Bearer yrm_..."
```

Or in `.mcp.json` (Claude Code expands `${VAR}`):

```json
{
  "mcpServers": {
    "yrm": {
      "type": "http",
      "url": "http://127.0.0.1:7788/mcp",
      "headers": { "Authorization": "Bearer ${YRM_TOKEN}" }
    }
  }
}
```

The token decides who the caller is and what it may do. Its `principal` becomes `origin.by` on every write. Without the `write` scope, write tools stay listed but refuse with `WRITE_SCOPE_REQUIRED`, even with `confirm: true`. Give agents that read mail a read-only token unless a person approves each write.

## Tools

| Tool | Kind | Use it for |
|---|---|---|
| `yrm_search_entities` | read | Turn "Marcus" or `acme-robotics.example` into an entity id. |
| `yrm_get_entity` | read | One entity: identifiers, organization, up to 30 current facts, last 10 events. |
| `yrm_facts` | read | The bi-temporal query. `validAt` = what was true then; `asOf` = what we knew then. |
| `yrm_open_items` | read | Open asks, open and overdue commitments, unresolved objections. |
| `yrm_today` | read | The attention queue with reasons, evidence and the day's headline. |
| `yrm_context` | read | A token-budgeted bundle for entities or a thread. The context-layer entry point. |
| `yrm_events` | read, deferred | Raw events, newest first, text cut at 1,500 characters. Prefer facts. |
| `yrm_thread` | read, deferred | One thread, oldest first, same truncation. |
| `yrm_record_note` | write | Append a note event; returns the `eventId` facts can cite. |
| `yrm_record_fact` | write | Record a human-origin fact (confidence 1) that cites an event. |
| `yrm_confirm_entity` / `yrm_reject_entity` | write | Curate proposed entities. |
| `yrm_merge_entities` | write | Merge two entities that are the same person or company. |
| `yrm_dismiss` | write | Hide a queue item, optionally until a date. |

Lists default to 50 rows (`limit`, max 200).

### Resources

- `yrm://story`: a short explainer of the data model and which tool answers which question. Agents connecting cold should read it first.
- `yrm://today`: same JSON as `yrm_today`.
- `yrm://entity/{id}`: same JSON as `yrm_get_entity`.

## Questions an agent can answer

| Question | Tool |
|---|---|
| "What should I do this morning?" | `yrm_today` |
| "Why has Acme gone quiet?" | `yrm_open_items { orgId }`: an unanswered ask from Marcus and an overdue commitment to Elena |
| "What did Marcus ask on September 2, exactly?" | `yrm_facts { entityId, type: "ask" }`, then `yrm_events` to read the quote in context |
| "Where does Priya work now? Where did we think she worked on August 20?" | `yrm_facts { entityId, predicate: "works_at" }` and the same with `asOf: "2026-08-20"` |
| "Brief me before I reply to this thread." | `yrm_context { threadKey }` |
| "Tom's two addresses are the same person." | `yrm_merge_entities` (after the user agrees) |
| "Priya told me on a call that Marcus needs CFO sign-off." | `yrm_record_note`, then `yrm_record_fact` citing its `eventId` |

## Writes need confirmation

Hosts confirm writes with the user. MCP gives the server no way to prompt, so every write tool takes `confirm: true` and refuses without it, saying nothing was written. The agent should show the user what it is about to record, get approval, and call again with `confirm: true`. The model sets that flag, so it is a prompt to ask, not a human gate: an agent misled by text in a mail can set it too. The hard limit is the token's `write` scope over HTTP.

Facts written through MCP have `origin: { kind: "human", by: <principal>, version: "mcp/1" }` and confidence 1, so they outrank model and rule facts and are never overturned by re-extraction. Every fact must cite an existing event: write a note with `yrm_record_note` first if nothing in the log says it yet.

## Settings

```ts
// yrm.config.ts
settings: {
  mcp: {
    // Skip confirm: true. Only for trusted, non-interactive agents.
    unattendedWrites: false,
    // Who stdio and loopback HTTP callers act as. Default: "agent:mcp/<client name>" (stdio), "agent:mcp/http" (HTTP).
    // Token callers act as their token's principal.
    principal: "user:jack",
  },
},
```

## Host binding

`ExtensionAPI` does not expose ranking, context bundles, ingest or the tool registry, and `yrm_today`, `yrm_context`, `yrm_record_note` and `serve` need them. `host.start()` emits `HOST_READY_TOPIC` (`"host:ready"`) with the host on the extension event bus, and this extension binds to it, so a host that loads extensions and then starts (as the CLI does) needs nothing extra. To bind before start, hand it over explicitly:

```ts
import { createMcpExtension, manifest } from "@yrm/ext-mcp";

await host.use(createMcpExtension({ host }), manifest);
```

Without it, store-only tools still work and the others return a `MCP_HOST_NOT_BOUND` error that says how to fix it.

## Untrusted content

Event text is written by third parties and may contain instructions aimed at the agent. `yrm_events` and `yrm_thread` results start with an `untrusted` note, and each event's `text` is fenced between `fence.open` and `fence.close` markers carrying a per-call random nonce. The quoted history the mail ingester stripped is never returned. `yrm_context` carries the same note, and its reading guide says so too. See [the threat model](../../docs/SECURITY-MODEL.md).
