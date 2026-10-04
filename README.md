# YRM

**Your relationship manager. Also, YAGNI Relationship Management.**

YRM is an open context layer for relationships. It ingests your mail, meetings and notes into an append-only log, extracts facts with provenance (who said what, in which message, and when it was true), proposes people, companies and deals for you to confirm, ranks what needs your attention today, and serves all of it to agents over MCP. It runs locally on SQLite, works with open-weight models or your own API keys, and is extended with TypeScript packages.

## The thesis

- **The event log is the truth.** People, companies and deals are views derived from what actually happened. The system proposes them; a person confirms them.
- **Facts carry provenance and time.** Every fact points at the message it came from and records when it was true and when we learned it, so "what did we know on June 3rd" is a query.
- **Expensive models see facts, not corpora.** Understanding is paid for once per event. Questions are answered from facts, so cost does not grow with how often agents ask.

## Status

**0.1 is in progress.** The contracts, store, pipeline, CLI and built-in extensions are in place and run against the demo corpus (see [Try it](#try-it)). YRM ships as a single `yrm` binary and a Docker image (see [Install](#install)); the `@yrm/*` packages are not on npm. Watch the repository to follow along.

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

## Try it

The Acme fixture is a synthetic company: 40 emails, 4 meetings and 3 call notes from a pilot that goes quiet. It has its own `yrm.config.ts`, so you can run the CLI from inside it. No model or API key is needed; without one, extraction is rule-based and nothing leaves your machine.

```sh
bun install
cd fixtures/acme
bun run ../../packages/cli/src/main.ts import .                  # mail, calendar and notes
bun run ../../packages/cli/src/main.ts today --date 2026-10-03   # the attention queue on the corpus's last day
bun run ../../packages/cli/src/main.ts who                       # everyone, people under their organization
bun run ../../packages/cli/src/main.ts doctor                    # config, extensions, model routes, spend
```

The store goes to `fixtures/acme/.yrm/`, which is gitignored. Delete it to start over. If no local model is running, `import` prints one warning for the triage tier and carries on.

`import .`:

```
source    path      created  dup  dropped  skipped
--------  --------  -------  ---  -------  -------
mail      mail           33    0        7        0
calendar  calendar        4    0        0        0
notes     notes           3    0        0        0

events created                 40
duplicates                      0
dropped                         7
participants resolved         147
entities proposed              13
facts recorded                 62
  superseding earlier facts    15
time                         81ms
```

`today --date 2026-10-03` (13 items; the first two and the account that went quiet):

```
Today, 2026-10-03 for YAGNI  (13 items)

 1. ██████████ 1.00  Reply to Marcus Bell about: If your Type II report slips past September 30, will you let us exit the pilot…
    Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.
    about: Marcus Bell
    (facts: 1, events: 1)

 2. ██████████ 0.95  Deliver to Elena Vasquez: I will send you our SOC 2 Type II report by September 30.
    You promised this to Elena Vasquez; it was due 2026-09-30 and is 3 days late with no delivery recorded.
    about: Elena Vasquez  ·  due: 2026-09-30
    (facts: 1, events: 1)

   ...

 8. ███████░░░ 0.70  Re-engage Acme Robotics: quiet for 31 days with 11 open items
    Nobody at Acme Robotics has written or met with you since Marcus Bell on 2026-09-02, and 11 asks, commitments or objections involving them are still open.
    about: Acme Robotics, Marcus Bell
    (facts: 11, events: 10)
```

`--date` ranks a day using everything known now. Add `--as-of <date>` to see only what was known by then; imported mail counts from when it was received, not from when you imported it ([ADR 0008](docs/decisions/0008-known-at-for-backfilled-facts.md)).

The time machine. Priya Raman's farewell mail is dated August 14, but Acme's mail gateway held it until September 3. Take her Acme id from `who priya` (the one with `priya.raman@acme-robotics.example`) and ask what was true on August 20, as known on August 20 and then on September 5:

```sh
bun run ../../packages/cli/src/main.ts who priya
bun run ../../packages/cli/src/main.ts facts <priya-acme-id> --at 2026-08-20 --as-of 2026-08-20
bun run ../../packages/cli/src/main.ts facts <priya-acme-id> --at 2026-08-20 --as-of 2026-09-05
```

As of August 20 she works at Acme and there is no job change. As of September 5 the same day shows one more line (trimmed):

```
statement                                                                  type/predicate       valid         known       recorded
Priya Raman is changing jobs: leaving Acme, joining Northwind Automation.  [signal/job_change]  2026-08-15..  2026-09-03  2026-10-04 18:21
```

True from August 14 (the 15th in UTC), known from September 3, recorded at import.

## Install

Three ways, all the same program. The binary is the unit of distribution; Docker wraps it. See [ADR 0011](docs/decisions/0011-single-binary-and-docker.md).

**From source** (needs [Bun](https://bun.sh) 1.2 or later):

```sh
git clone https://github.com/YAGNI-App/YRM && cd YRM
bun install
bun run yrm -- --version          # run from source
bun run build                     # or compile dist/yrm-bun-<os>-<arch> for this machine
```

`bun run scripts/build.ts --target bun-linux-x64` cross-compiles; `--all` builds every release target.

**Binary**, once the first release is published: macOS and Linux on x64 or arm64.

```sh
curl -fsSL https://raw.githubusercontent.com/YAGNI-App/YRM/main/scripts/install.sh | sh
```

The script downloads `yrm-bun-<os>-<arch>` from the latest release to `~/.local/bin/yrm` and checks it against the release's `SHA256SUMS`. `YRM_VERSION=v0.1.0` pins a release; `YRM_INSTALL_DIR` changes where it goes. On Windows, download `yrm-bun-windows-x64.exe` from the release page. There is no auto-update: run the script again to upgrade.

**Docker**, once the first release is published (or `docker build -t yrm .` from a checkout):

```sh
docker run -d --name yrm -p 127.0.0.1:7777:7777 -v yrm-data:/data \
  -e YRM_SELF=you@example.com -e TZ=America/Denver ghcr.io/yagni-app/yrm
docker run --rm -v yrm-data:/data -v ~/mail:/import:ro ghcr.io/yagni-app/yrm import /import
```

The image runs `yrm web` on port 7777 as a non-root user. Any `yrm` command works as the container's arguments.

## Self-hosting

- **One volume holds everything.** `/data` in the container is the project directory: `yrm.config.ts`, the SQLite store under `.yrm/local/` and any `.yrm/extensions/*.ts`. On first start with an empty volume the image runs `yrm init` (filled from `YRM_SELF` and `YRM_NAME`); edit `/data/yrm.config.ts` after that. Back up the volume and you have backed up YRM. [docker-compose.yml](docker-compose.yml) is a starting point.
- **Keep it on localhost.** The dashboard and MCP server have no authentication in 0.1, and `yrm web` warns when it listens beyond loopback. Publish the port to `127.0.0.1`, or put it behind your own authenticating proxy. Token auth for non-loopback binds is in progress ([#33](https://github.com/YAGNI-App/YRM/issues/33)). MCP over stdio works today (`docker run -i --rm -v yrm-data:/data ghcr.io/yagni-app/yrm serve`); MCP over HTTP on port 7788 is planned.
- **Postgres is optional and in progress** ([#20](https://github.com/YAGNI-App/YRM/issues/20)). SQLite is the default and needs nothing else. The compose file has a `postgres:16` service behind a profile and the storage block to switch to once the store lands.
- **Gmail** syncs through your own Google Cloud project and OAuth client, so your mail never passes through anyone else's app. See [packages/ext-gmail/README.md](packages/ext-gmail/README.md). Sign-in redirects your browser to `127.0.0.1` on the machine running `yrm gmail:setup`, which a container's loopback is not; with Docker, bind-mount a host directory as `/data`, run `gmail:setup` there with the binary, and let the container sync from then on (tokens live in the store).
- **Models are local or bring-your-own-key.** Point the triage and extract tiers at Ollama, vLLM or any OpenAI-compatible endpoint (from a container, the host is `host.docker.internal`), and set `ANTHROPIC_API_KEY` or another provider's key in the environment for hosted tiers. With neither, YRM runs on rule-based extraction and ranking and nothing leaves the machine.

## Built in public by YAGNI's agent Teams

YRM is a demonstration of what an engineering team can do with [YAGNI](https://yagni.app)'s agent Teams: build their own internal tools. The loop runs entirely on GitHub.

1. **Bailey** proposes work from the open issues.
2. **Wright** builds it to a draft pull request.
3. **Proctor** reviews it. **Fletcher** tests it.
4. A person reviews and merges.

Decisions are recorded as ADRs in `docs/decisions/`. The pull request history is the changelog.

- **How the Teams work:** [docs/TEAMS.md](docs/TEAMS.md) (roles, labels, definition of done) and the [backlog](docs/BACKLOG.md).
- **Demo:** [docs/DEMO.md](docs/DEMO.md), a seven-minute script on the Acme corpus.

YRM is not a YAGNI product. It is a reference application and a candidate context layer for YAGNI itself, which connects to it the way any agent would: over MCP.

## Contributing

Read [AGENTS.md](AGENTS.md) first; it applies to people and agents alike. [CONTRIBUTING.md](CONTRIBUTING.md) covers the pull request flow. Most code is written by the Teams; human pull requests are welcome and go through the same review.

## Security

Report vulnerabilities privately through GitHub's private vulnerability reporting, not a public issue. See [SECURITY.md](SECURITY.md).

## License

Apache 2.0. See [LICENSE](LICENSE).
