# Contributing to YRM

Read [AGENTS.md](AGENTS.md) before your first change. It has the ground rules, toolchain, layout, code conventions and review checklist, and it applies to people and agents equally.

## Pull request flow

1. Open or pick an issue. For anything larger than a bug fix, start with a proposal issue so the approach can be discussed before code is written.
2. Branch from `main`. Keep the PR to one concern. Title in imperative mood, under 70 characters.
3. Run `bun run check` locally. It must pass, offline, with no API keys set.
4. Open the PR with the template filled in: what changed, why, how it was tested.
5. Agent reviewers (Proctor, Fletcher) and a person review. A person merges, by squash.

Changes to `packages/core/src/contracts/` go in their own small PR with a one-paragraph justification. They are reviewed harder than anything else.

## ADRs

If a change makes a decision with consequences (a new dependency, a change to how facts are stored, a new model tier, anything that sends raw event text to the `synthesize` tier), include an ADR in the same PR. Copy `docs/decisions/0000-template.md` to the next number. ADRs are never deleted; a superseded one says so at the top and links its replacement.

## No AI attribution

Commits and pull requests carry no AI attribution. No `Co-Authored-By` trailers naming an AI or a model, no "Generated with" footers, no model names in commit messages or PR bodies. This applies whether the change was written by a person, an agent Team or both. Review judges the work, not who or what produced it.

## Extensions

New sources, extractors, resolvers, rankers and providers should be extensions, not core changes. Use the extension issue template to propose one. An extension can live in your own repository; it does not need to be merged here to be useful.
