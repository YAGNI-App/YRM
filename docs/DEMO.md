# The seven-minute demo

A script for showing YRM on the Acme Robotics corpus (`fixtures/acme`, story in [`fixtures/acme/STORY.md`](../fixtures/acme/STORY.md)). Each step has the command, what to say, and what to point at. The output below was captured from `main`; ids are ULIDs and change on every import, so copy them from your own screen.

Everything runs offline with no API keys. Rehearse once from a clean state (see [Reset](#reset)) before presenting.

## Setup (before the audience arrives)

From the repository root:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install
alias yrm="bun run $PWD/packages/cli/src/main.ts"
```

Then use the fixture's own config, which sets Jack as the tenant, `yagni.example` as the self domain and `mailhub.example` as freemail:

```sh
cd fixtures/acme
```

Its routes are the ones `yrm init` writes: `triage` and `extract` on a local Ollama. If Ollama is not running, `import` prints one warning for the triage tier and carries on with rules; the router then skips the unreachable endpoint for a minute instead of trying it per event. For a silent import, copy the config elsewhere with `models: { routes: {} }`.

Keep a second terminal in a scratch directory where you have run a plain `yrm init` (default routes), for step 8.

Make the terminal at least 160 columns wide; `who --facts` and `facts` print wide tables.

## The script

### 1. The thesis (0:00, 20 seconds)

No command. Say:

> "Your mail, meetings and notes go into a log that is never edited. YRM pulls facts out of it, each one pointing at the message it came from and carrying when it was true and when we learned it. People and companies are proposals you confirm. Agents read the facts over MCP, so understanding is paid for once per message, not once per question."

### 2. Import (0:20, 40 seconds)

```sh
yrm import .
```

```
source    path      created  dup  dropped  skipped
--------  --------  -------  ---  -------  -------
mail      mail           33    0        7        0
calendar  calendar        4    0        0        0
notes     notes           3    0        0        0

events created                 40
duplicates                      0
dropped                         7
participants resolved         147
entities proposed              13
facts recorded                 62
  superseding earlier facts    15
time                         81ms
```

Say: "Four months of a sales pilot: 40 mail files, four meetings, three call notes. Seven of the mails were newsletters and notifications and were dropped. No model answered; this is rules only, in under 100 milliseconds. Fifteen facts replace earlier ones: an ask that got answered, a commitment that was kept."

Point at: `dropped 7`, `time`, `facts recorded 62`, `entities proposed 13`. Run it again to show `duplicates 40`: the log is idempotent.

### 3. Facts with provenance (1:00, 50 seconds)

```sh
yrm who marcus --facts
```

```
Marcus Bell  person  [proposed]  01M43TY7M181733JEFS62KNFXE
  email:marcus.bell@acme-robotics.example
  events 29  ·  first 2026-06-02  ·  last 2026-09-22  ·  open commitments 2  ·  open asks 3
    statement                                                            type/predicate           valid         conf  origin          evidence
    Marcus Bell works at Acme Robotics.                                  [relationship/works_at]  2026-06-02..  0.80  rule:resolve@1  ← 01M43TY7KNH2...
    Marcus Bell holds the role VP of Operations at acme-robotics.example [role/holds_role]        2026-06-02..  0.50  rule:extract@1  ← 01M43TY7KNH2...
    Marcus Bell communicated a decision: Following yesterday's scoping
      session: we're going with Option A.                                [decision/decided]       2026-07-09..  0.60  rule:extract@1  ← 01M43TY7KQQX...
    Marcus Bell asked Jack Collins: If your Type II report slips past
      September 30, will you let us exit the pilot order with no fee?    [ask/asked]              2026-09-03..  0.60  rule:extract@1  ← 01M43TY7KSP6...
```

(Trimmed; the real table also has a `recorded` column.)

Say: "Every line is a fact, not a field. Each one has the message it came from, when it became true, how confident the extractor was, and who produced it: `rule:extract@1` means the rule extractor, version 1. A model fact would name the model; a fact you type would say `human` and outrank both."

Point at: the `evidence` column (event ids), `origin`, `conf`, and the September 2 ask with no "(answered ...)" suffix, unlike the June asks above it.

### 4. The time machine (1:50, 60 seconds)

```sh
yrm who priya
```

There are two Priya Ramans (her Acme and Northwind addresses). Copy the id of the one with `email:priya.raman@acme-robotics.example`.

```sh
yrm facts <priya-acme-id> --at 2026-07-01
yrm facts <priya-acme-id> --at 2026-08-20
```

```
  facts true at 2026-07-01 23:59, as known now
Priya Raman works at Acme Robotics.
Jack Collins committed to Priya Raman (due 2026-06-05): ... (fulfilled 2026-06-05)
Jack Collins committed to Priya Raman (due 2026-06-26): I'll send a written pilot proposal ...
Priya Raman committed to Jack Collins (due 2026-06-23): Priya will share two weeks of ... pick data ...

  facts true at 2026-08-20 23:59, as known now
  ... the same four, plus:
Priya Raman is changing jobs: leaving Acme, joining Northwind Automation.   [signal/job_change]  2026-08-15..
```

Say: "`--at` is world time: what was true on that day. On July 1 she is our champion at Acme. By August 20 she has left for Northwind. Her farewell mail is dated August 14, but Acme's data-loss gateway held it until September 3. So it was true in August and we did not know until September. Facts carry both times, and `--as-of` asks what we knew."

Then:

```sh
yrm facts <priya-acme-id> --all
```

Point at: the line starting `x` (a retracted fact: the open June 5 commitment, superseded by the fulfilled version) and the `recorded` column. Nothing is overwritten; superseded facts stay, marked.

**Known gap, say it plainly if asked:** `facts --as-of 2026-08-20` exists, but on a backfilled import it prints `(no facts)`, because every fact's belief time is the moment of the import, not the moment the mail arrived. Issue [#35](https://github.com/YAGNI-App/YRM/issues/35) records backfilled facts at the time the event was received; once it lands, `--as-of 2026-08-20` shows Priya at Acme with no job change and `--as-of 2026-09-04` shows the change. Also, her Acme `works_at` is still open after the job change; [#18](https://github.com/YAGNI-App/YRM/issues/18) closes it at August 14.

### 5. The human confirms the view (2:50, 40 seconds)

```sh
yrm resolve:suggestions
```

```
01M43TY7M9X2H8YNX3BT2AN7J5 -> 01M43TY7M6KS4CZEZEM62WRVE7  0.90  Tom Fischer / Tom Fischer: same name, seen in the same thread (14 events)
01M43TY7NFTBTCV710B52R02J6 -> 01M43TY7KYR1S74RXA9YSSGW2S  0.60  Priya Raman / Priya Raman: same name at different domains (3 events)
```

Say: "The system proposes; a person decides. Tom wrote from his personal address because Acme's gateway was stripping attachments. Priya changed jobs. YRM suspects both, with different confidence, and does not merge on its own."

```sh
yrm resolve:merge <tom-from-id> <tom-into-id> --user jack
yrm resolve:merge <priya-from-id> <priya-into-id> --user jack
yrm who priya
```

```
Merged 01M43TY7NFTBTCV710B52R02J6 into 01M43TY7KYR1S74RXA9YSSGW2S (Priya Raman).
Priya Raman  person  [proposed]  01M43TY7KYR1S74RXA9YSSGW2S
  email:priya.raman@acme-robotics.example, email:priya@northwind.example
```

Point at: one Priya, two addresses. The merge is recorded with who did it, and re-importing never undoes it. Optionally `yrm confirm <priya-id>` to move her from `proposed` to `confirmed`.

### 6. What needs you today (3:30, 60 seconds)

```sh
yrm today --date 2026-10-03
```

The story is set on the morning of October 3, and the top three should match [`STORY.md`](../fixtures/acme/STORY.md):

```
 1. ██████████ 1.00  Reply to Marcus Bell about: If your Type II report slips past September 30, will you let us exit the pilot…
    Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.

 2. ██████████ 0.95  Deliver to Elena Vasquez: I will send you our SOC 2 Type II report by September 30.
    You promised this to Elena Vasquez; it was due 2026-09-30 and is 3 days late with no delivery recorded.

 8. ███████░░░ 0.70  Re-engage Acme Robotics: quiet for 31 days with 11 open items
    Nobody at Acme Robotics has written or met with you since Marcus Bell on 2026-09-02, and 11 asks,
    commitments or objections involving them are still open.
```

`--date` ranks that day using everything known now. `--as-of <date>` adds the time machine: only what had been recorded by then. On a fresh import that is nothing, since every fact was recorded today (see [#35](https://github.com/YAGNI-App/YRM/issues/35)).

Say: "Three things, each with a reason you can check. Marcus asked a yes-or-no question a month ago and never got an answer; that is why Acme went quiet. We promised Elena the Type II report and missed it. And nobody at Acme has written since."

Then show why the first one is there:

```sh
yrm today --json | grep '"key"' | head -3
yrm attention:explain unanswered-ask:<fact-id>
```

```
unanswered-ask:01M43TY7PDX0R67QRR2EA0R9Q5  (score 1.00, by attention/unanswered-ask)
Action: Reply to Marcus Bell about: If your Type II report slips past September 30, will you let us exit the pilot…
Reason: Asked 32 days ago in 'Re: Security review follow-ups'; no reply from you since.

Evidence: 1 fact(s), 1 event(s)
  fact 01M43TY7PDX0R67QRR2EA0R9Q5 [ask/asked, rule extract v1, confidence 0.6]
    valid 2026-09-03, recorded 2026-10-04
    - event 01M43TY7KSP6EPP2JM9KYPHA7S: 2026-09-02 mail/message 'Re: Security review follow-ups'
      speaker: Marcus Bell
      "If your Type II report slips past September 30, will you let us exit the pilot order with no fee?"
```

Point at: the quote and the event. The ranking is a function over facts; you can argue with it.

Be ready for the item "Deliver to Priya Raman: ... pilot proposal ... 100 days late". It is wrong: the proposal was sent on June 26 in a new thread, and the rule extractor only closes commitments in the same thread. Say so; it is issue [#16](https://github.com/YAGNI-App/YRM/issues/16), and it is a good example of an extractor gap showing up as a visible, checkable mistake rather than a silent one. Lower down, "Address Jack Collins's concern: Cancelled at Marcus Bell's request..." is the rule extractor reading the cancelled kickoff's calendar description as an objection; `extract:eval` lists it as spurious in step 7.

### 7. How good is rules-only? (4:30, 30 seconds)

```sh
yrm extract:eval --corpus <repo>/fixtures/acme
```

```
Fact extraction scorecard

ask             7/7   recall  100%  precision   71%  F1   83%
commitment      8/8   recall  100%  precision   80%  F1   89%
decision        2/2   recall  100%  precision   50%  F1   67%
objection       1/1   recall  100%  precision   67%  F1   80%
relationship    2/2   recall  100%  precision  100%  F1  100%
role            1/3   recall   33%  precision  100%  F1   50%
signal          1/2   recall   50%  precision   75%  F1   60%
overall        22/25  recall   88%  precision   74%  F1   80%
```

Say: "The corpus comes with hand-written ground truth. With no model and no keys, the rule extractor finds 88% of the facts that matter. Models are for the rest: roles, quiet signals, and precision."

Point at: `overall 22/25 recall 88%`, and the `role` row as the weak spot.

### 8. Models: open-weight by default, priced per tier (5:00, 40 seconds)

In the scratch directory with the default `yrm init` config:

```sh
yrm doctor
```

```
models
  triage      openai-compatible/qwen3:8b
  extract     openai-compatible/qwen3:8b
  synthesize  anthropic/claude-opus-5

providers
  openai-compatible  http://localhost:11434/v1 unreachable (connection refused), local
  anthropic          no key (ANTHROPIC_API_KEY not set)

spend
  month to date  $0.00
  estimate for 40 messages/day (each triaged and extracted, one synthesize brief a day):
    triage      openai-compatible/qwen3:8b  $0.00  local
    extract     openai-compatible/qwen3:8b  $0.00  local
    synthesize  anthropic/claude-opus-5     $2.33  30 calls
    total                                   $2.33  per month
```

Say: "Code never names a model; it asks for a tier. The default sends the frequent work to an open-weight model on your own machine, and the one expensive call a day goes to whatever frontier model you choose, with your key. The synthesize tier sees facts, never your mailbox. About two dollars a month."

Point at: `local` next to triage and extract, and the `total`.

### 9. An agent reads it over MCP (5:40, 60 seconds)

Before the demo, from the demo directory:

```sh
claude mcp add yrm -- bun run <repo>/packages/cli/src/main.ts serve
```

(Snippets for Claude Desktop and pi's `.pi/mcp.json` are in [`packages/ext-mcp/README.md`](../packages/ext-mcp/README.md). For pi there is also a native package: `pi -e <repo>/packages/pi` from the demo directory; see [`packages/pi/README.md`](../packages/pi/README.md).)

Ask the agent:

> "What do we owe Acme, and what did we know on September 1st?"

Say while it works: "The agent calls `yrm_open_items` and `yrm_facts`. Every fact comes back with its quote, speaker, message and both time ranges, so the agent can cite its sources and you can check them."

Point at: the agent citing the Type II commitment (due September 30) and Marcus's unanswered ask with their quotes, and the tool calls it made. Until [#35](https://github.com/YAGNI-App/YRM/issues/35) lands, "what did we know on September 1st" is answered with world time (`validAt`); expect the agent to say the job change was already true by then.

### 10. The web view (6:40, 20 seconds, only if `@yrm/ext-web` is on `main`)

```sh
yrm web
```

Open the printed URL, go to Priya, and drag the time slider from July to September. Point at the job change appearing and the `works_at` edge changing. If `ext-web` has not merged, skip this step and go to the close.

### Close (7:00)

Say: "Everything you saw is open source and was built by YAGNI's agent Teams in public. What they build next is in the issue backlog."

Show [`docs/BACKLOG.md`](BACKLOG.md) and the [issues](https://github.com/YAGNI-App/YRM/issues): closing commitments across threads (#16), ending `works_at` on a job change (#18), honest belief time for backfills (#35), and the first week plan in [`docs/TEAMS.md`](TEAMS.md).

## Reset

Delete the local database and import again:

```sh
rm -rf .yrm/local          # in fixtures/acme
yrm import .
```

`.yrm/local/` holds only the SQLite file. The config stays. Ids change after a reset, so re-copy them for steps 4, 5 and 6.

To remove the MCP server from Claude Code afterwards: `claude mcp remove yrm`.

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| One `[warn] model-triage: triage call failed (ALL_ROUTES_FAILED)` line during import | Routes point at Ollama and it is not running | Harmless; rules still run. Start Ollama (`ollama serve`, `ollama pull qwen3:8b`) to use it. |
| `today` says "Follow up with Jack Collins on ..." and Marcus's unanswered ask is missing | `tenant.selfAddresses` does not include `jack@yagni.example`, so YRM does not know which person is you | Use `fixtures/acme/yrm.config.ts`, `rm -rf .yrm/local`, import again. |
| `today --date 2026-10-03 --as-of ...` prints "Nothing needs you today" | Facts were recorded today, after the `--as-of` time | Drop `--as-of`. Tracked in #35. |
| `"priya" matches 2 entities; pass an id` | Two addresses, not yet merged | Expected before step 5. Use the id from `yrm who priya`. |
| `facts --as-of <date>` prints `(no facts)` | Backfilled facts carry the import time as belief time | Use `--at`. Tracked in #35. |
| `unknown command "web"` | `@yrm/ext-web` not on `main` yet | Skip step 10. |
| MCP tools return `MCP_HOST_NOT_BOUND` | A custom embedding loaded extensions but never called `host.start()` | Start it with `yrm serve` from the demo directory, as in step 9. |
| `who` or `facts` tables wrap and are unreadable | Terminal too narrow | Widen to 160+ columns or reduce font size. |
| Anything else | | `yrm doctor`, then `yrm <command> --verbose`. Reset and retry. |
