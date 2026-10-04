# Fixtures

Synthetic corpora for tests, extractor/resolver benchmarks and demos. They need no network and no API keys.

## The rule: everything is fictional

Every company, person, address, phone number and URL in this directory is invented. Domains use the reserved `.example` TLD (`yagni.example`, `acme-robotics.example`, `mailhub.example`), phone numbers use the `555-01xx` fictional range, and IP addresses come from the documentation ranges (`198.51.100.0/24`, `203.0.113.0/24`). Do not add real names, real companies or real domains, and do not paste in real mail, not even redacted mail.

## `acme/`

The demo corpus. Jack, the tenant (`jack@yagni.example`), sells a pilot to Acme Robotics between 2026-06-01 and 2026-10-03. `yrm import fixtures/acme && yrm today` should tell the story in `acme/STORY.md`.

```
acme/
  STORY.md            the narrative and cast; read this first
  mail/NNN-slug.eml   40 RFC 5322 messages, one per file, numbered in Date order (7 are noise)
  calendar/acme.ics   4 meetings (one cancelled)
  notes/*.md          3 call notes by Jack, with frontmatter date and attendees
  ground-truth.json   what a correct pipeline should produce
  validate.test.ts    structural checks on all of the above; runs in CI
```

### `ground-truth.json`

- `tenant`: self addresses and domains.
- `noise`: Message-IDs that ingest must drop (newsletters, notifications, `noreply@` senders, `Precedence: bulk`, `Auto-Submitted`). This list must contain exactly the bulk mail. The test checks both directions.
- `people` and `organizations`: identity ground truth for resolvers. A person's `addresses` must all resolve to one entity. `organizations[].validFrom/validTo` gives employment in world time.
- `freemailDomains`: domains that must not become organizations.
- `facts`: the facts an extractor should find. `subject`/`object` are a person `key` or an organization `domain`. `evidence` items are Message-IDs (with angle brackets), ICS UIDs, or note paths relative to `acme/`. Commitments carry `dueAt`, `status` and `resolvedBy`. Asks carry `answered` and `answeredBy`. Signals and relationships carry `validFrom`/`validTo`. `knownAt` marks a fact we learned later than it became true.
- `expectedQueueOn`: what `yrm today` should surface on a given date, with the fact and evidence behind each item.

The fact list is the set an extractor must recall. It is not every sentence that could be read as a promise: incidental lines such as "I'll send an invite" are left out on purpose. A precision scorer should match on `(type, subject, object)` and count unlisted, low-stakes extractions as noise rather than as hard errors.

### Extending it

The files are plain text and edited by hand. To add a message:

1. Create `mail/NNN-slug.eml` with the next number. Its `Date` must not be earlier than the previous file's.
2. Use a unique `Message-ID` of the form `<local@sender-domain>`. Replies set `In-Reply-To` to the parent and `References` to the full chain ending with the parent, and their subject starts with `Re: `.
3. Use `Content-Type: text/plain; charset=utf-8`. Quote the parent with an `On <date>, <name> <<addr>> wrote:` line followed by `> `-prefixed lines, and put signatures after a `-- ` line.
4. If it is bulk mail, add its Message-ID to `noise`. If it carries a fact, add the fact to `facts` with evidence. Update `corpus.counts`.
5. Every non-noise address must belong to a person in `people`.
6. Run `bun test fixtures` to check the corpus.

ICS lines must use CRLF endings and be folded at 75 octets (see `.gitattributes`). New VEVENTs need a unique `UID`, `ORGANIZER`, and `ATTENDEE` lines with `CN` and `mailto:`.

## Adding a corpus

Make a sibling directory with the same layout and its own `validate.test.ts`. Keep each test under a second or two. These tests run in CI with `bun test`, and `tsconfig.json` typechecks `fixtures/**/*.test.ts`.
