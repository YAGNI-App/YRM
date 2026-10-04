# @yrm/ext-resolve

Entity resolution, all deterministic: addresses to people, domains to organizations, same-name merge suggestions, and job changes. The extension name is `resolve`, so its facts carry `origin: { kind: "rule", by: "resolve", version: "1" }`.

- **header-resolver** (priority 0): one proposed person per address (plus-tags fold into the base mailbox), one proposed organization per non-freemail domain, and a `relationship/works_at` from the person to it, valid from the earliest message that shows it. Self domains all point at the tenant's own organization, created confirmed.
- **name-link-resolver**: links an address-less attendee to the one person with that name.
- **same-name suggestions** (`resolve:after`): two people with the same full name get a `signal/possibly_same_person` fact and a suggestion you can act on with `yrm resolve:suggestions` and `yrm resolve:merge <from> <into>`.

## Job changes

The `resolve:job-change` extractor reads phrases such as "my last day at", "I'm leaving", "I've accepted a role at" and records a `signal/job_change` for the sender, `value: { leaving?, joining? }`, valid from the message date rather than the import date. A message delivered late (Priya's goodbye sat in a DLP quarantine for three weeks) is still dated when it was written.

It also moves the employment edge:

- A rule- or model-origin `works_at` from the sender to the organization being left (matched by name prefix, so "Acme" names "Acme Robotics", or by the first label of its domain) that is open at the message date gets `validTo` = the message date, via `Store.endFactValidity`. A human-origin `works_at` is never ended.
- If the organization being joined is named, it is looked up the same way (or proposed, with no domain, if nothing matches) and a `works_at` to it starts at the message date, with the job-change message as provenance. A `works_at` that already covers that date is left alone; one that starts later (the new address showed up weeks after the move) is superseded so the edge starts at the move.
- The signal's `object` is the organization joined, so the attention `job-change` rule can tell the new employer from a stale one.

Both steps check before they write, so extracting the same message twice ends nothing twice and creates no second edge.

On the Acme corpus, Priya's Acme `works_at` is valid on 2026-08-01 and ended at 2026-08-15T00:02:45Z (17:02 on August 14, Pacific); her Northwind `works_at` starts at the same instant.
