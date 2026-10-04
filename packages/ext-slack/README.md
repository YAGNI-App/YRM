# @yrm/ext-slack

The `slack` source. It reads public and private channels, DMs and group DMs, thread replies included, and turns each message into one `message` event. Participants are addressed by the email on their Slack profile, so the header resolver in [`@yrm/ext-resolve`](../ext-resolve/README.md) links a Slack user to the same person as their mail. There is no Slack SDK: the extension calls the Web API with `fetch`.

No app yet, or no admin to approve one? Import a workspace export instead (see [Importing an export](#importing-an-export-no-app)).

## Scopes

The app only reads. It asks for the same scopes as a user token and as a bot token:

| Scope | Why |
|---|---|
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Messages and thread replies in public channels, private channels, DMs and group DMs. |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | List conversations and DM members. |
| `users:read` | Names, titles, time zones, bot flags. |
| `users:read.email` | Emails, which is how a Slack user becomes the same person as in your mail. Without it every participant is `slack:<userId>`. |

## Set up the app

`yrm slack:setup` prints the same steps.

1. Open <https://api.slack.com/apps>, choose **Create New App > From an app manifest**, pick the workspace, choose YAML and paste:

```yaml
display_information:
  name: YRM
  description: Reads conversations into your local YRM log.
features:
  bot_user:
    display_name: YRM
    always_online: false
oauth_config:
  scopes:
    user:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - users:read
      - users:read.email
    bot:
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - users:read
      - users:read.email
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

2. **Install to Workspace** (OAuth & Permissions). Your workspace may require an admin to approve it.
3. Copy a token from **OAuth & Permissions**:
   - **User OAuth Token** (`xoxp-...`): reads what you can read, including your own DMs. Usually what you want.
   - **Bot User OAuth Token** (`xoxb-...`): reads only channels the bot was invited to (`/invite @YRM`), and DMs with the bot.
4. Put it in the environment, not in a file you might commit:

```sh
export YRM_SLACK_TOKEN=xoxp-...
```

5. Sync:

```sh
yrm sync slack
yrm slack:status   # workspace, token type, users cached, channels with their cursors
```

## Settings (`settings.slack`)

```ts
// yrm.config.ts
export default defineConfig({
  settings: {
    slack: {
      channels: ["#sales", "C0123ABCD"],
      includeDMs: true,
    },
  },
  // ...
});
```

| Key | Default | Meaning |
|---|---|---|
| `tokenEnv` | `YRM_SLACK_TOKEN` | Environment variable holding the token. |
| `token` | unset | The token itself. Prefer `tokenEnv`. |
| `channels` | every unarchived channel the token can read | Channel names (`#sales` or `sales`) or ids (`C0123`). Applies to channels, not DMs. |
| `includeDMs` | `true` for user tokens and exports, `false` for bot tokens | Read DMs and group DMs. |
| `includeBots` | `false` | Keep bot messages and bot participants. |
| `selfUserIds` | `[]` | Slack user ids that are you. Marked `self` even without an email. With a user token, the token's own user is always you. |
| `maxPerSync` | `2000` | Messages (thread replies included) handled per run. The next run continues. |
| `apiBase` | `https://slack.com/api` | For tests and proxies. |

## Events

One event per message, `source: "slack"`, `kind: "message"`:

- `externalId`: `<channel>:<ts>`. Re-reading a message is a duplicate, never a new event.
- `occurredAt`: from `ts`.
- `threadKey`: `<channel>:<thread_ts>` for thread messages, `<channel>:<ts>` otherwise, so a thread is one conversation.
- `inReplyTo`: `[<channel>:<thread_ts>]` for replies.
- `content.title`: `#channel`, or `DM with Maria Lopez[, ...]` (the members who are not you).
- `content.text`: the text with Slack markup made readable: `<@U123>` becomes `@Name`, `<#C123|sales>` becomes `#sales`, `<https://x|label>` becomes `label (https://x)`, `<mailto:a@b|a@b>` becomes `a@b`, `<!here>` becomes `@here`, and `&amp;`, `&lt;`, `&gt;` are unescaped.
- `participants`: the author as `from`; for DMs and group DMs the other members as `to`; each mentioned user as `mentioned`. Channel members are not added (they are an audience, not recipients). The address is the profile email (lowercased) when Slack gives one, else `slack:<userId>`, always with the display name. `meta.slackUserIds` lists the Slack user id of each participant, in the same order.
- `meta`: `channel`, `channelName`, `channelKind`, `ts`, `threadTs`, `reactions` (`[{ name, count }]`), `files` (names only), `edited` (the edit's `ts`, or null), plus `subtype` and `replyCount` when present.

Dropped before emit, and reported to the host as `dropped`: joins and leaves, topic, purpose and name changes, archive notices, pins, and bot messages (subtype `bot_message`, bot users and Slackbot) unless `includeBots`.

### Titles

Slack profiles often carry a job title that mail does not. The `slack-title` extractor records an `attribute` fact `title` (rule origin, confidence 0.7, tag `slack-profile`) for each resolved participant whose profile has one. It records each user's title once (kv `slack/title/<userId>`); a changed title is proposed again.

## How sync works

1. `auth.test` for the workspace and the token's user.
2. `users.list` (paginated) into kv `slack/users`: user id to `{ name, realName, email, title, tz, isBot, deleted }`. A message from or mentioning someone not in the map refreshes it once per run.
3. `conversations.list` with `types=public_channel,private_channel` (plus `im,mpim` when DMs are on), `exclude_archived=true`, filtered by `channels`. DM members come from `conversations.members`.
4. Per conversation, `conversations.history` with `oldest` = that conversation's cursor (kv `slack/cursor/<channel>`), every page, processed oldest first. Each message with replies is followed by `conversations.replies` for its thread. The cursor moves past a message only once its thread is emitted, so a run cut short by `maxPerSync` resumes cleanly. The source cursor holds a JSON summary of the per-channel cursors.
5. Conversations the token cannot read (`not_in_channel`, `channel_not_found`, `missing_scope`) are skipped with a warning and counted as `skipped`.

**Rate limits.** `conversations.history` and `conversations.replies` are tier 3 (about 50 requests a minute). A 429 (or `ratelimited`) is retried up to five times, waiting `Retry-After` seconds, else 1, 2, 4, 8, 16 s. `maxPerSync` keeps one run bounded; a large first backfill takes a few runs.

## Importing an export (no app)

A workspace admin can export data under **Workspace settings > Import/Export Data**. Unzip it and:

```sh
yrm slack:import ~/Downloads/acme-slack-export
```

or from code, `host.importPath("slack", dir)`. The importer reads `users.json`, `channels.json`, and `groups.json`, `dms.json` and `mpims.json` when present, then every `<conversation>/<date>.json`. Thread replies are inline in the day files, and the mapping is the same as the API path, so an export and a later live sync produce the same events and the overlap comes back as duplicates. Importing does not move the sync cursors. The `channels`, `includeDMs` and `includeBots` settings apply; `maxPerSync` does not.

## Privacy

- The token lives in your environment (or config, if you put it there). The user map, cursors and title bookkeeping live in the local store's kv table, namespace `slack`.
- Message text goes into your local event log. It leaves your machine only through the model route configured for extraction (`models.routes.extract`), like every other source's text. With no route configured, nothing is sent anywhere.
- File contents are never downloaded; only file names are kept.

## Limitations

- Pull only: no Socket Mode or Events API yet, so new messages arrive on the next `yrm sync slack`.
- New replies to a thread whose parent is older than the channel cursor are not picked up by history; they arrive on a re-import or a future events-based sync.
- Edits and deletions after a message was read are not re-read. An edited message carries `meta.edited` when it was edited before we read it.
- No file contents, canvases, huddles or call transcripts.
- Slack Connect channels work like any other channel, but external users' emails are only visible if their organization shares them.
