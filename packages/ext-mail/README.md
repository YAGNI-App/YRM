# @yrm/ext-mail

The `mail` source. It reads `.eml` files and `.mbox` archives, drops bulk and automated mail, strips quoted history and signatures, and emits one `message` event per remaining email. Everything is deterministic: no model is called, and no dependency beyond `@yrm/core` is needed.

```ts
// yrm.config.ts
export default defineConfig({
  extensions: ["@yrm/ext-mail"],
  settings: {
    mail: {
      watchPath: "~/Mail/export",       // optional, see "sync" below
      keepNoise: false,
      noiseDomains: ["mailchimp.example"],
    },
  },
  // ...
});
```

```ts
await host.importPath("mail", "./fixtures/acme/mail"); // a directory, an .eml or an .mbox
```

## What it registers

- **Source `mail`** (`kinds: ["message"]`).
  - `importPath(path)` takes a file or a directory. Directories are walked recursively, entries sorted by name; `.eml` and `.mbox` files are read, anything else is ignored. Events go to the host in chunks of 50, and the cursor is set to the last file processed. Re-importing is safe: the host drops duplicates by `externalId`. A summary (files, messages, created, duplicates, noise dropped by reason) is logged at info.
  - `sync()` imports `settings.mail.watchPath` when it is set. Otherwise it logs that a live connector is needed (Gmail is planned for 0.2) and returns.
- **Command `mail:inspect <file.eml>`**: prints the parsed headers, the noise verdict, and the kept text next to the removed text.

The pure functions are exported too: `parseEml`, `parseMbox`, `splitMbox`, `classifyNoise`, `stripQuotes`, `toEvent` and helpers.

## Settings (`settings.mail`)

| Key | Default | Meaning |
|---|---|---|
| `keepNoise` | `false` | Emit noise anyway, with `meta.noise` set to the rule that fired. |
| `noiseLocalParts` | see below | Sender local parts that mark mail as noise. **Replaces** the default list; spread `DEFAULT_NOISE_LOCAL_PARTS` to extend it. |
| `noiseDomains` | `[]` | Sender domains that are always noise. Subdomains match. |
| `watchPath` | unset | File or directory `sync` imports until a connector exists. |

## The event

| Field | Value |
|---|---|
| `externalId` | `Message-ID` as written, brackets included (`<abc@host>`). Without one: `sha256:` of the raw headers and body. |
| `occurredAt` | The `Date` header in UTC. Falls back to the latest `Received` time, then the file's mtime. |
| `participants` | `from`, `to`, `cc`, `bcc` in that order, addresses lowercased, display names as given (RFC 2047 decoded). The host marks `self`. |
| `content.text` | The body with quotes and signatures stripped. |
| `content.stripped` | What was removed, for provenance spans. Omitted when nothing was. |
| `content.title` | Subject. |
| `content.tokens` | `ceil(text.length / 4)`. |
| `threadKey` | First id in `References` (the thread root), else `In-Reply-To`, else the message's own id, **without** angle brackets. |
| `inReplyTo` | `[In-Reply-To]` as an external id with brackets. The host does not map it to an event id. |
| `meta` | `subject`, `messageId`, `references` (bracketed ids), `hasAttachments`, `originalLength` (body length before stripping), plus `listId`, `receivedAt` (latest `Received` hop; differs from `occurredAt` when delivery was delayed), `dateMissing` and `noise` when they apply. |
| `rawRef` | The file path; `path#n` for the n-th message of an mbox. |

## Noise

The first matching rule wins:

1. `List-Unsubscribe` is present.
2. `Precedence` is `bulk`, `list` or `junk`.
3. `Auto-Submitted` is present and not `no` (RFC 3834).
4. The sender's local part (ignoring `+tag`) is one of `noreply`, `no-reply`, `donotreply`, `notifications`, `notification`, `mailer-daemon`, `postmaster`, `bounce`, `alerts`, `newsletter`, `news`, `marketing`, `digest`.
5. The sender's domain is in `noiseDomains`.

Not rules on their own: `X-Auto-Response-Suppress` (Outlook sets it on ordinary mail) and display names like "Jane via Docs" (SaaS tools relay real person-to-person mail that way).

## How quote stripping works

The body is processed line by line.

1. **Cut to the end** at the first of:
   - a reply attribution: `On <date>, <name> wrote:` (also wrapped over up to three lines), `Le ... a écrit :`, `Am ... schrieb ...:`, `El ... escribió:`, `Op ... schreef ...:`;
   - `-----Original Message-----` (and its French and German forms);
   - an Outlook-style header block: a `From:` line followed within four lines by at least two of `Sent:`, `Date:`, `To:`, `Subject:`, `Cc:`, optionally preceded by a `_____` rule;
   - the signature delimiter `-- `.
2. **Drop single lines** above the cut: anything starting with `>` (so interleaved replies keep the new lines), and mobile sign-offs such as `Sent from my iPhone` or `Get Outlook for iOS`.
3. **Contact block heuristic:** if a sign-off line (`Thanks,`, `Best,`, `Regards,`, `Cheers,` and similar) is followed by a short name line and then at most six short lines, at least one of which has a phone number, a job title or a URL, those trailing lines are removed. The sign-off and name stay.
4. **Never empty:** if nothing is left of a non-empty body, the first paragraph is restored as-is.
5. Runs of three or more newlines collapse to two.

## Parsing

`parse.ts` is a small RFC 5322/MIME parser written for this package: header unfolding, RFC 2047 encoded words, address lists (quoted names, comments, groups), RFC 2822 dates (numeric and obsolete zones), `Content-Type` parameters incl. RFC 2231, quoted-printable and base64 with charset decoding, nested multipart. It prefers `text/plain`; with only `text/html` it converts to text and turns `<blockquote>` into `>` lines so stripping still works.

## Limitations

- Files are read as UTF-8. A message whose 8bit body is in another charset will have mis-decoded characters; quoted-printable and base64 parts are decoded correctly.
- Attachments are listed (`hasAttachments`) but never read.
- Forwarded messages (`---------- Forwarded message ---------`) are kept in full; they are often the point of the mail.
- Top-posted replies are the common case and work well. Bottom-posted replies without `>` markers, or quoted text pasted without an attribution, are not detected.
- The contact-block heuristic can remove a short postscript that happens to contain a phone number or URL after `Thanks,\nName`. The removed text is always in `content.stripped`.
- `importPath` does not use the cursor to skip files; idempotency comes from the store.
- There is no live connector yet. `watchPath` re-imports the whole path on every `sync`.
