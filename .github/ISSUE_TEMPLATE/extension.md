---
name: Extension
about: Propose a new source, extractor, resolver, ranker or provider
title: ""
labels: extension
---

## Kind

- [ ] Source (new place events come from)
- [ ] Extractor (new fact types or predicates)
- [ ] Resolver
- [ ] Ranker
- [ ] Provider
- [ ] Tool or command

## What it does

One paragraph. For a source: the system, the event kinds it emits, and its `externalId`. For an extractor: the facts it records, with one example input and the expected facts.

## Model use

Which tier it calls (none, `triage`, `extract`, `synthesize`, `embed`), how often, and the estimated cost per event. What it does with no API keys configured.

## Hooks and contracts

Hooks it subscribes to. Any contract change it needs (that goes in a separate PR).

## Where it lives

- [ ] Built-in (`packages/ext-*`), because:
- [ ] Separate package or repository
