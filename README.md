# YRM

**Your relationship manager. Also, YAGNI Relationship Management.**

YRM is an open context layer for relationships. It ingests your mail, meetings and notes into an append-only log, extracts facts with provenance (who said what, in which message, and when it was true), proposes people, companies and deals for you to confirm, ranks what needs your attention today, and serves all of it to agents over MCP. It runs locally on SQLite, works with open-weight models or your own API keys, and is extended with TypeScript packages.

## The thesis

- **The event log is the truth.** People, companies and deals are views derived from what actually happened. The system proposes them; a person confirms them.
- **Facts carry provenance and time.** Every fact points at the message it came from and records when it was true and when we learned it, so "what did we know on June 3rd" is a query.
- **Expensive models see facts, not corpora.** Understanding is paid for once per event. Questions are answered from facts, so cost does not grow with how often agents ask.

## Status

**0.1 is in progress. There is nothing to install yet.** The contracts in `packages/core/src/contracts/` are written; the store, pipeline, CLI and built-in extensions are next. Watch the repository to follow along.

- [VISION.md](VISION.md): where this is going.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the design.
- [docs/decisions/](docs/decisions/): why it is built this way.

The `yrm` crate on crates.io is a placeholder from an earlier Rust plan and is not developed. See [ADR 0001](docs/decisions/0001-typescript-on-bun.md).

## How it works

```
 mail  calendar  notes  ...          sources (extensions)
   \      |      /
    v     v     v
 +--------------------+
 |  event log         |   append-only, idempotent, never mutated
 +--------------------+
           |
           v
 +--------------------+
 |  resolve           |   addresses -> people, domains -> companies
 +--------------------+
           |
           v
 +--------------------+
 |  extract           |   triage (small model) -> extract (~30%)
 +--------------------+
           |
           v
 +--------------------+
 |  facts             |   bi-temporal edges with provenance
 +--------------------+
       |          |
       v          v
 +-----------+  +-----------------+
 | entities  |  | attention queue |   proposed -> confirmed; ranked with reasons
 | and views |  |                 |
 +-----------+  +-----------------+
       \          /
        v        v
 +--------------------+
 |  MCP / CLI / embed |   agents read facts with provenance
 +--------------------+
```

## What it costs to run

Per active user per month on hosted models, estimated. Details in [ADR 0007](docs/decisions/0007-no-raw-corpora-to-synthesis-tier.md).

| Stage | Runs on | Monthly |
|---|---|---|
| Filter and resolve | rules | $0 |
| Triage | small model, every surviving event | $0.40 to $1.00 |
| Extract | larger model, ~30% of triaged | $1.50 to $3.60 |
| Synthesize | one ranking call per day | $0.60 to $1.50 |
| **Total** | | **~$2.50 to $6.50** |

On self-hosted open-weight models, triage and extract cost close to nothing. With no models configured, YRM falls back to rule-based extraction and ranking.

## Try it (target for 0.1)

These commands are what 0.1 will support. They do not work yet.

```sh
bun install
bun run yrm -- import fixtures/acme     # load a synthetic company's mail and meetings
bun run yrm -- today                    # the attention queue, with reasons
bun run yrm -- serve --mcp              # expose facts and entities to an agent
```

## Built in public by YAGNI's agent Teams

YRM is a demonstration of what an engineering team can do with [YAGNI](https://yagni.app)'s agent Teams: build their own internal tools. The loop runs entirely on GitHub.

1. **Bailey** proposes work from the open issues.
2. **Wright** builds it to a draft pull request.
3. **Proctor** reviews it. **Fletcher** tests it.
4. A person reviews and merges.

Decisions are recorded as ADRs in `docs/decisions/`. The pull request history is the changelog.

YRM is not a YAGNI product. It is a reference application and a candidate context layer for YAGNI itself, which connects to it the way any agent would: over MCP.

## Contributing

Read [AGENTS.md](AGENTS.md) first; it applies to people and agents alike. [CONTRIBUTING.md](CONTRIBUTING.md) covers the pull request flow. Most code is written by the Teams; human pull requests are welcome and go through the same review.

## Security

Report vulnerabilities privately through GitHub's private vulnerability reporting, not a public issue. See [SECURITY.md](SECURITY.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
