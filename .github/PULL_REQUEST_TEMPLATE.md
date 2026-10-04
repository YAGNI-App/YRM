## What

What changed, in a few sentences.

## Why

The problem it solves. Link the issue if there is one.

## Testing

How you tested it. Which tests were added or changed.

## Checklist

- [ ] One concern; title is imperative and under 70 characters
- [ ] `bun run check` passes, offline, with no API keys set
- [ ] No event is mutated and no fact is edited
- [ ] No provider SDK imported outside `packages/provider-*`
- [ ] No raw event text sent to the `synthesize` tier, or an ADR is included
- [ ] Every recorded fact has provenance (at least one event id) and an origin with a version
- [ ] Degrades, does not crash, with no API keys configured
- [ ] Contract changes, if any, are in their own PR with a justification
- [ ] ADR added if this makes a decision with consequences
- [ ] No AI attribution in commits or this description
