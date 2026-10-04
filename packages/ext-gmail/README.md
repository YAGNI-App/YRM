# @yrm/ext-gmail

The `gmail` source. It signs in to Gmail through your own Google Cloud project, backfills your mail, then pulls only what changed using Gmail's history ids. Parsing, bulk-mail filtering and quote stripping are the same code as [`@yrm/ext-mail`](../ext-mail/README.md), so a Gmail event looks like a mail event with Gmail's ids and labels added. There is no Google SDK: the extension talks to the REST API with `fetch`.

No Google account yet, or not ready to set up OAuth? Import a Takeout export instead (see [Takeout](#takeout-no-oauth)).

## Set up Google Cloud

You do this once. `yrm gmail:setup` prints the same checklist with your settings filled in.

1. **Create a project** at <https://console.cloud.google.com/projectcreate>.
2. **Enable the Gmail API** at <https://console.cloud.google.com/apis/library/gmail.googleapis.com>.
3. **Configure the OAuth consent screen** (APIs & Services > OAuth consent screen).
   - **Google Workspace: choose User type _Internal_.** Internal apps are limited to your organization and need no Google verification, even for the restricted Gmail scope.
   - Personal `@gmail.com`: choose _External_, leave the app in _Testing_ and add yourself under _Test users_. Testing apps get refresh tokens that expire after 7 days, so you will re-run setup weekly; Internal does not have this limit.
   - Add the scope `https://www.googleapis.com/auth/gmail.readonly` on the Data access page.
4. **Create an OAuth client** (Credentials > Create credentials > OAuth client ID) with **Application type: Desktop app**. Desktop clients accept a loopback redirect on any port, so there is no redirect URI to register.
5. **Put the client id in `yrm.config.ts`**, and the secret in an environment variable:

```ts
// yrm.config.ts
export default defineConfig({
  extensions: ["@yrm/ext-gmail"],
  settings: {
    gmail: {
      clientId: "1234567890-abc.apps.googleusercontent.com",
      clientSecretEnv: "YRM_GOOGLE_CLIENT_SECRET", // or clientSecret: "GOCSPX-..."
      account: "you@yourcompany.com",
      labels: ["INBOX", "SENT"],
      query: "newer_than:1y",
    },
  },
  // ...
});
```

```sh
export YRM_GOOGLE_CLIENT_SECRET=GOCSPX-...
```

Google calls a Desktop app's secret non-confidential, but its token endpoint still requires it. Keeping it in the environment keeps it out of a file you might commit.

6. **Sign in**:

```sh
yrm gmail:setup              # opens your browser
yrm gmail:setup --no-browser # prints the URL only (SSH, containers)
```

Setup listens on `http://127.0.0.1:<port>/` (`redirectPort`, random by default), prints the authorization URL, and waits for Google's redirect. The flow is the authorization code grant with PKCE (S256), `access_type=offline` and `prompt=consent`, so Google returns a refresh token. The `state` parameter is checked; anything else hitting the listener is ignored.

7. **Sync**:

```sh
yrm sync gmail
yrm gmail:status   # account, token expiry, history cursor, last sync, messages ingested
```

## Settings (`settings.gmail`)

| Key | Default | Meaning |
|---|---|---|
| `clientId` | required | OAuth client id of the Desktop app client. |
| `clientSecret` | unset | The client secret. Prefer `clientSecretEnv`. |
| `clientSecretEnv` | `YRM_GOOGLE_CLIENT_SECRET` | Environment variable read when `clientSecret` is unset. |
| `account` | learned at sign-in | Mailbox address; tokens are stored per account. |
| `scopes` | `["https://www.googleapis.com/auth/gmail.readonly"]` | Scopes requested at sign-in. |
| `labels` | `["INBOX", "SENT"]` | Label ids to backfill. Each is listed separately, and history mode keeps only messages carrying one of them. |
| `query` | unset | Gmail search applied during backfill, e.g. `newer_than:1y`. |
| `maxPerSync` | `500` | Messages fetched per run during backfill. |
| `redirectPort` | `0` (random) | Loopback port for the OAuth redirect. |
| `keepNoise`, `noiseLocalParts`, `noiseDomains` | as in ext-mail | Bulk-mail filtering, same meaning as `settings.mail`. |

## How sync works

- **Backfill** (no cursor yet). Takes the profile's current `historyId` first, then for each label calls `messages.list` (with `q` when set), paginating, up to `maxPerSync` messages per run. Each id is fetched with `messages.get?format=raw` ten at a time; the raw RFC 822 text goes through ext-mail's `parseEml`, `classifyNoise`, `stripQuotes` and `toEvent`. Events go to the host in chunks of 50. When `maxPerSync` is reached, the label and page token are saved in kv (`backfill:pageToken`) and the next `yrm sync gmail` continues from there. When every label is done, the `historyId` taken at the start becomes the cursor, so mail that arrived during a long backfill is picked up by the first history run.
- **History** (cursor set). `users.history.list?historyTypes=messageAdded` since the cursor, paginated; new message ids are deduplicated, fetched and emitted as above; the cursor moves to the response's `historyId`.
- **Expired history.** Gmail keeps history for a limited time (about a week, sometimes less). A 404 logs a warning, refills with `q: newer_than:30d`, and resumes history mode from a fresh `historyId`.
- **Idempotent.** The event's `externalId` is the Message-ID, so a message seen under two labels, re-listed after a crash, or replayed from history is a duplicate, never a new event.
- **Errors.** A 401 triggers one token refresh and a retry. Tokens are also refreshed 60 seconds before they expire. A 429 (or a 403 rate-limit reason, or a 5xx) is retried up to five times, honoring `Retry-After`, else waiting 1, 2, 4, 8, 16 s (capped at 32 s). A message deleted between list and get is skipped.
- **Noise** dropped is counted and logged at the end of each run, with the reasons.

## The event

Same as [ext-mail's event](../ext-mail/README.md#the-event), with these differences:

| Field | Value |
|---|---|
| `source` | `gmail` |
| `threadKey` | `gmail:<threadId>` when Gmail gives a thread id. Gmail's threading survives clients that drop `References`. |
| `meta.labels` | Gmail label ids, e.g. `["INBOX", "UNREAD"]`. |
| `meta.gmailId`, `meta.threadId` | Gmail's message and thread ids. |
| `rawRef` | `gmail:<account>/<gmailId>`; for Takeout, `<file>#<n>`. |
| `occurredAt` | `Date` header, then the latest `Received`, then Gmail's `internalDate`. |

## Takeout (no OAuth)

```ts
await host.importPath("gmail", "~/Downloads/Takeout/Mail/All mail Including Spam and Trash.mbox");
```

`yrm import <file.mbox>` currently routes every `.mbox` to the `mail` source, which works too but without Gmail labels and thread ids; a way to pick the `gmail` source from the CLI is a follow-up in `@yrm/cli`.

The source's `importPath` reads a `.mbox` (or `.eml` files, or a directory of either) with ext-mail's `parseMbox`. Takeout's `X-Gmail-Labels` header becomes `meta.labels` (`Inbox` maps to `INBOX`, `Sent` to `SENT`, and so on) and `X-GM-THRID` becomes the same `gmail:<hex thread id>` thread key the API gives. A later live sync therefore adds to the same threads, and messages already imported come back as duplicates. Importing does not set the sync cursor, so the first `yrm sync gmail` still backfills; messages the import already brought in are fetched again but stored only once.

## What is stored where

- **Tokens** (`refresh_token`, `access_token`, expiry, account) live in the store's kv table, namespace `gmail`, key `tokens:<account>`: the SQLite file under `.yrm/`. They are never written to `yrm.config.ts`. To sign out, revoke the app at <https://myaccount.google.com/permissions>.
- **Cursor**: the last `historyId`, in the store's cursor table for source `gmail`.
- **Progress and counters**: kv keys `backfill:pageToken`, `lastSync`, `ingested`.
- **Mail**: the event log holds the message text (quoted history split out into `content.stripped`), participants and headers in `meta`. The raw RFC 822 message is not stored.

## Quotas

Gmail allows 250 quota units per user per second. `messages.get` and `messages.list` cost 5 units each, `history.list` 2. The extension fetches at most 10 messages at a time, 50 units per batch, and backs off on 429, so it stays under the limit. A first backfill of 10,000 messages takes 20 runs at the default `maxPerSync`; raise it if you want fewer, longer runs.

## Privacy

Mail goes from Google to your machine and into a local SQLite file. It leaves your machine again only if a model route sends it somewhere: extractors see event text through the `triage` and `extract` tiers. Point those tiers at a local model (Ollama, llama.cpp, vLLM) through the [OpenAI-compatible provider](../provider-openai/README.md) and nothing leaves the machine. The `synthesize` tier sees facts, not mail.

The only scope requested is `gmail.readonly`. YRM cannot send, modify or delete mail.

## Limitations

- No push notifications (Pub/Sub `users.watch`) yet: run `yrm sync gmail` on a schedule.
- Attachments are ignored; `meta.hasAttachments` records that there were some.
- One account per config. Tokens are stored per account, but the cursor is per source.
- History mode processes everything since the cursor in one run; `maxPerSync` only bounds backfill.
- Google Calendar is a separate, planned extension.
