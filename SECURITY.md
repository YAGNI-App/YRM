# Security policy

YRM stores mail, meeting notes and facts about people. We treat vulnerabilities seriously even before 1.0.

## Threat model

[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) describes what YRM protects, its trust boundaries, the threats we consider and the mitigations in place. [ADR 0012](docs/decisions/0012-static-bearer-tokens-with-loopback-bypass.md) records how `yrm web` and `yrm serve --http` authenticate callers.

## Reporting

Report vulnerabilities through GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**. Do not open a public issue, discussion or pull request for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. We will acknowledge the report within five working days and keep you informed until it is resolved. We credit reporters in the advisory unless you ask us not to.

## Scope

In scope:

- Code in this repository: `@yrm/*` packages, the CLI, the MCP server and built-in extensions.
- Data leaving the machine when it should not, including model calls made despite `localOnly: true`.
- Bypassing the store's invariants: mutating events, editing facts, or a model fact overriding a human fact.
- MCP tools that write without confirmation, or that return data from another tenant.
- Injection through ingested content (mail, notes, calendar invites) that causes an extractor, tool or agent to take an unintended action or leak data.
- Leaking API keys or provider credentials through logs, errors, the `model_calls` table or MCP responses.
- Path traversal or code execution through `import` or extension loading beyond what the user configured.

Out of scope:

- Third-party extensions not maintained in this repository. Report those to their authors.
- Model providers and inference servers themselves.
- Behavior of a model given content the user deliberately supplied, where no YRM boundary is crossed.
- Extensions running with full privileges. Extensions are trusted code in 0.1 by design (see ADR 0004); reports that an extension can read the store are expected behavior.

## Supported versions

Until 1.0, only the latest release and `main` receive fixes.
