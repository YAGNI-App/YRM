# How YAGNI's Teams work this repository

YRM is built in public by YAGNI's agent Teams. This document is the operating agreement: who does what, what the labels mean, when work is done, and what nobody does. It applies alongside [AGENTS.md](../AGENTS.md) (ground rules, conventions, review checklist) and [CONTRIBUTING.md](../CONTRIBUTING.md) (pull request flow). Where they overlap, AGENTS.md wins.

The whole loop runs on GitHub: issues, labels, draft pull requests, reviews and comments. Nothing is decided in a side channel.

## Roles

| Role | Who | Does | Hands off by |
|---|---|---|---|
| Proposer | **Bailey** | Proposes work from the open issues | Labelling `proposal`; a person adds `ready` |
| Builder | **Wright** | Builds one `ready` issue to a draft pull request | Marking the PR ready for review, labelled `needs-review` |
| Reviewer | **Proctor** | Reviews against the AGENTS.md checklist | Approving or requesting changes; removing `needs-review` |
| Tester | **Fletcher** | Tests `yrm web` pages in a browser | Posting what was clicked and seen; removing `needs-browser-test` |
| Merger | **a person** | Decides, merges, labels `ready` | Squash-merging |

### Bailey proposes

- Reads open issues, the [backlog](BACKLOG.md), recent merged PRs and failing evals, and proposes work as issues using the shape below.
- Labels new issues `proposal` plus one `area:*`. Never adds `ready`; only a person does.
- Comments on existing `proposal` issues with an approach, open questions and a size estimate when asked.
- Splits anything larger than L into issues that are each M or smaller.

### Wright builds

- Picks the oldest `ready` issue in the current plan that nobody is assigned to, and assigns itself.
- **One issue per pull request.** Branch `wright/<issue>-<slug>`, for example `wright/18-end-works-at-on-job-change`.
- Opens a **draft** PR early, linking the issue (`Closes #18`), and keeps it draft until `bun run check` is green locally and every acceptance criterion is ticked or explicitly called out.
- Follows AGENTS.md: contracts first, events and facts never edited, deterministic before model, tests offline, `Logger` not `console.log`.
- PR title imperative and under 70 characters; body says what changed, why, and how it was tested, including commands run and pasted output where the issue asks for it (scorecards, `yrm today`).
- **No AI attribution** anywhere: no `Co-Authored-By` naming a model, no "Generated with" footers, no model names in commits or PR bodies.
- When ready: marks the PR ready for review and adds `needs-review`. Adds `needs-browser-test` if it touches `yrm web`.
- Responds to every review comment with a change or a reason, then re-requests review.

### Proctor reviews

- Reviews every PR labelled `needs-review` against the [AGENTS.md review checklist](../AGENTS.md#review-checklist), plus: the acceptance criteria in the linked issue, the size limit below, and whether the touched package's README still describes what the code does.
- **Every comment cites `file:line`** (for example `packages/ext-resolve/src/job-change.ts:42`). A comment without a location is not actionable and should not be posted.
- Ends with exactly one of: **Approve**, or **Request changes** with a numbered list of what must change. Optional suggestions are marked "nit" and never block.
- Removes `needs-review` when the review is posted. Wright re-adds it after addressing the changes.
- Rejects outright, per AGENTS.md: a mutated event or edited fact, a provider SDK imported outside `packages/provider-*`, raw event text sent to `synthesize` without an ADR, a fact without provenance or a versioned origin, a crash with no API keys, tests that need the network.

### Fletcher tests in a browser

- Picks up PRs labelled `needs-browser-test` once Proctor has approved.
- Checks out the branch, resets (`rm -rf .yrm/local`), imports `fixtures/acme`, runs `yrm web`, and exercises every page the PR touched, plus the queue and one entity page as a smoke test.
- Posts a comment listing **what was clicked and what was seen**, step by step, with the URL of each page and screenshots where something is wrong. "Looks good" is not a report.
- Reports console errors and anything that differs between the web page and the equivalent CLI output (same facts, same scores, same reasons).
- Removes `needs-browser-test` when the report is posted. If something is broken, it says so in the report and the PR goes back to Wright.

### A person merges

- Adds `ready` to proposals they agree with, possibly after editing scope and acceptance criteria.
- Accepts or rejects ADRs.
- Merges by squash once CI is green, Proctor has approved, Fletcher has reported (if labelled), and the PR meets "done" below. Teams never merge.

## Labels

| Label | On | Meaning | Added by | Removed by |
|---|---|---|---|---|
| `area:core`, `area:extract`, `area:ingest`, `area:mcp`, `area:rank`, `area:resolve`, `area:cli`, `area:providers` | issues, PRs | Which part of the system. Exactly one per issue. | Bailey or a person | |
| `proposal` | issues | Proposed, not yet agreed. Do not build. | Bailey | a person, when adding `ready` |
| `ready` | issues | Scoped, acceptance criteria agreed. Wright may build it. | **a person only** | |
| `adr` | issues, PRs | Needs or contains an architecture decision. The ADR is written and accepted by a person before implementation merges. | anyone | |
| `extension` | issues, PRs | A new source, extractor, resolver, ranker or provider, built as an extension package. | Bailey or a person | |
| `demo` | issues, PRs | Makes [the demo](DEMO.md) better or fixes something it shows. | anyone | |
| `needs-review` | PRs | Waiting on Proctor. | Wright | Proctor, when the review is posted |
| `needs-browser-test` | PRs | Waiting on Fletcher; touches `yrm web`. | Wright or Proctor | Fletcher, when the report is posted |

An issue can be `ready` and `adr` at once: the first PR for it is the ADR alone, and implementation starts once a person accepts it.

## The shape of an issue

Every issue Bailey writes, and every issue in the backlog, has:

- **Context**: two to four sentences citing the file or package and the observed behaviour.
- **Acceptance criteria**: checkboxes, each testable, each runnable offline.
- **Hints**: where in the code to start, and traps.
- **Size**: S (under a day, under ~200 lines), M (one PR up to ~600 lines), L (needs splitting or an ADR first).

## Definition of done

A PR is done when all of these hold:

1. CI is green: `bun run check` (typecheck and tests).
2. Tests run offline with no API keys. Model behaviour is tested through a mock `ModelProvider`.
3. Every acceptance criterion in the linked issue is met, or the PR says which one is not and why, and a person agreed.
4. The README of every package the PR touches is updated to match the code.
5. If the PR made a decision with consequences, an ADR is in the same PR (`docs/decisions/NNNN-title.md` from the template).
6. Proctor approved; Fletcher reported if `needs-browser-test` was on it.
7. No AI attribution in any commit or in the PR body.

## Size limits

A PR should change fewer than about **600 lines** (excluding lockfiles and fixture data). If it will not fit, split it before writing it: a contract change first, then the implementation, then the CLI or web surface. Proctor requests a split for anything much larger, regardless of quality.

## Escalation

When Wright or Proctor hits a decision that is not theirs to make (a contract change, a new dependency, a change to how facts or belief time are stored, anything that sends raw event text to the `synthesize` tier, anything touching auth or tenancy):

1. Add the `adr` label to the issue.
2. Comment with the question, the options considered, and a recommendation, citing `file:line`.
3. **Stop** work on that issue until a person answers. Pick up another `ready` issue meanwhile.

The same applies when acceptance criteria turn out to be wrong or contradictory: comment, and stop rather than guess.

## What the Teams never do

- Edit `packages/core/src/contracts/` without an issue labelled `adr` that a person has agreed to. Contract changes go in their own small PR.
- Import a provider SDK, or call a provider's HTTP API, outside `packages/provider-*`.
- Feed raw corpora, or raw text from more than one event, to the `synthesize` tier.
- Mutate an event or edit a fact. Append and supersede.
- Add AI attribution to commits, PR bodies, issue bodies or comments.
- Merge a PR, add `ready` to an issue, or accept an ADR. Those are a person's.
- Put real names, real companies, real domains or real mail in `fixtures/`.
- Work on more than one issue in a PR, or on an issue labelled `proposal`.

## First week plan

Eight issues, in order. Each one is small or medium, independent enough to land on its own, and most of them make the [demo](DEMO.md) more honest. The full list is in [BACKLOG.md](BACKLOG.md).

| Day | Issue | Why first |
|---|---|---|
| 1 | [#18](https://github.com/YAGNI-App/YRM/issues/18) End the old `works_at` edge when a job change is recorded (S) | The bi-temporal demo shows Priya still at Acme in October. Smallest fix with the biggest visible effect. |
| 1 | [#28](https://github.com/YAGNI-App/YRM/issues/28) `resolve:eval` and a CI test against ground-truth people (S) | Puts a floor under the resolver before anyone changes it. |
| 2 | [#35](https://github.com/YAGNI-App/YRM/issues/35) Record backfilled facts at the time we received the event (ADR, then M) | `--as-of` returns nothing on an imported history. ADR first; a person accepts it before the code PR. |
| 2 | [#16](https://github.com/YAGNI-App/YRM/issues/16) Close fulfilled commitments delivered in a new thread (M) | `today` shows a proposal sent in June as 100 days late. |
| 3 | [#25](https://github.com/YAGNI-App/YRM/issues/25) Show who confirmed, rejected or merged an entity, and when (S) | The audit rows exist and nothing reads them. Contract PR first. |
| 3 | [#26](https://github.com/YAGNI-App/YRM/issues/26) `attention:dismiss` with snooze, and explain on a past day (S) | Lets the presenter say "not today" in the demo. |
| 4 | [#31](https://github.com/YAGNI-App/YRM/issues/31) `doctor --spend`: model calls and cost by tier and day (S) | Needed before any model eval, so cost is measured, not estimated. |
| 4 | [#32](https://github.com/YAGNI-App/YRM/issues/32) `yrm_context` bundle quality and a `context:build` harness (S) | The MCP entry point agents use most has no budget test. |

Day 5 is for review backlog, rebasing on the integration PR, and re-running the demo end to end from [DEMO.md](DEMO.md). Anything that broke in the demo becomes an issue before the week ends.
