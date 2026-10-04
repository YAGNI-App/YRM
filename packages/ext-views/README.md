# @yrm/ext-views

Views are fields you describe in English. YRM fills them from what it already knows and keeps them current, so adding "economic buyer" to every organization is a sentence, not a migration. See [ADR 0010](../../docs/decisions/0010-natural-language-views.md) for the design.

A view value is an ordinary `attribute` fact with predicate `view.<name>`. It has provenance (the events it rests on), a confidence, an origin and valid/recorded times like every other fact, so `yrm facts --as-of` shows what a view said last week.

## Commands

```sh
yrm view define economic_buyer --for organization --type entity \
  "the person at this organization who controls the budget for our deal; usually the one who approves pricing or signs"
yrm view define deal_stage --for organization --type enum \
  --enum discovery,evaluation,security_review,pilot,closed_won,closed_lost,stalled \
  "where our commercial conversation with this organization stands"
yrm view list
yrm view backfill economic_buyer --dry-run      # calls, tokens and estimated cost; nothing spent
yrm view backfill economic_buyer [--limit 10]
yrm view show "Acme Robotics"                   # values, confidence, origin, evidence; why any are empty
yrm view set "Acme Robotics" economic_buyer "Marcus Bell"   # human value; models never override it
yrm view drop economic_buyer                    # removes the definition; facts stay
```

Types: `string`, `number`, `boolean`, `date` (stored as `YYYY-MM-DD`), `enum` (with `--enum`), `entity` (a person or organization, stored as `{ entityId, name }` and as the fact's object), `json`. `--by model` (default) or `--by rule`.

`yrm who <query>` prints current view values under each entity. Agents read them with the `yrm_views` tool (`{ entityId }`) and in the "Views" section of `context:build` bundles. The web dashboard shows them on the entity page.

## How values are computed

- **Rule views** are functions over facts and events, free and always on. Built in: `last_contact` (date of the last event involving the person, or anyone at the organization) and `open_items` (unanswered asks plus open commitments, either side).
- **Model views** make one call on the `extract` tier per entity: the definition, the entity, its current facts with ids, and the newest event texts up to `maxEventTokens`. The answer must cite evidence it was shown and match the type, or it is dropped. Confidence is capped at 0.9. The `synthesize` tier is never used.

Values are recomputed by `yrm view backfill`, and for entities touched by `yrm sync` or `yrm import`, once each when the command finishes. A changed value supersedes the old one; an unchanged one is not recorded again. With no reachable model, model views stay empty and `view show` says why; rule views still fill.

## Settings

```ts
settings: {
  views: {
    maxEventTokens: 3000,   // event text a model view reads per entity; 0 means facts only
    maxFacts: 40,           // current facts shown per entity
    incremental: "all",     // "rules" skips model views after sync/import; "off" disables
    definitions: [          // applied at startup; same fields as ViewDefinition
      { name: "champion", appliesTo: "organization", valueType: "entity", populatedBy: "model",
        description: "The person at this organization who pushes for our product internally." },
    ],
  },
},
```

A view you drop stays dropped, even if it is still listed in `definitions`, until you define it again with `--force`.

## Adding a rule view from another extension

```ts
export default function (yrm: ExtensionAPI) {
  yrm.events.emit("views:rule", {
    name: "meetings_last_30d",
    rule: async ({ events, now }) => { /* return { value, provenance: [{ eventId }], validFrom } or null */ },
  });
}
```

Then define it with `--by rule`, or list it in `settings.views.definitions` with `populatedBy: "rule"`.
