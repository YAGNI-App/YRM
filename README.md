# YRM

**Your relationship manager. Also, YAGNI Relationship Management.**

YRM is a minimal, self-hosted CRM: people, companies, deals, a timeline built from your mail and calendar, and a queue of who to follow up with today. One static binary and a Postgres database. Written in Rust.

It is being built in public by [YAGNI](https://yagni.app)'s agent Teams. Every proposal, plan, pull request, review, and decision lands in this repository where you can read it.

> **Status: name reserved, nothing to run yet.** Version 0.0.1 on crates.io is a placeholder so the name exists. Real releases start at 0.1. Watch the repository or the issues to follow along.

## Why another CRM

Most CRMs are ninety percent things you aren't gonna need. YRM keeps the parts a small team actually uses:

- People and companies, matched automatically from the addresses in your mail.
- Deals with stages.
- A timeline per person and per deal, assembled from Gmail threads and Calendar events.
- A follow-up queue: who you owe a reply, whose commitment is due, who has gone quiet.

The part that is different: YRM keeps records an agent can read. Commitments, objections, and next steps are first-class records with provenance (which message, who said it, when), not free text in a notes field. That makes it a useful grounding source for AI agents, YAGNI's included, and it will ship with an MCP server so any agent can read it.

## How it is built

YRM is a demonstration of what an engineering team can do with YAGNI's agent Teams: build their own internal tools. The loop runs entirely on GitHub.

1. **Bailey** proposes work from the open issues.
2. **Wright** builds it to a draft pull request.
3. **Proctor** reviews it. **Fletcher** tests it in a browser.
4. A person reviews and merges.

Decisions the Teams make will be recorded as ADRs under `docs/decisions`. The pull request history is the changelog.

## Self-hosting (planned)

- A Docker image with the binary. You bring Postgres.
- Mail and calendar sync through your own Google Cloud project. If your company uses Google Workspace, an Internal OAuth app needs no Google verification. The setup wizard prints the exact scopes and redirect URI to paste in.
- Polling by default. Pub/Sub push as an optional upgrade.
- Fallbacks that need no Google API at all: a private calendar feed URL and a BCC address for mail.

## Roadmap

- **0.1** People, companies, deals. Gmail timeline. The Internal OAuth setup wizard.
- **0.2** The follow-up queue. Commitments and next steps with provenance.
- **0.3** Calendar sync. Meetings on the timeline.
- **0.4** MCP server and webhooks.
- **Later** A hosted edition, if anyone asks for one.

## Relationship to YAGNI

YRM is not a YAGNI product. It is a reference application and a proving ground: YAGNI's own staging Teams work this repository, and YAGNI connects to YRM the way it connects to any other tool, through its API and MCP server. If you want the Teams on your own codebase, start at [yagni.app](https://yagni.app).

## Contributing

Issues and planning are public here. Most of the code is written by the Teams; human pull requests are welcome and go through the same review. Report security issues privately through GitHub's private vulnerability reporting, not a public issue.

## License

Apache 2.0. See [LICENSE](LICENSE).
