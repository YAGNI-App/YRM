# The seven-minute demo

A script for showing YRM on the Acme Robotics corpus (`fixtures/acme`, story in [`fixtures/acme/STORY.md`](../fixtures/acme/STORY.md)). Each step has the command, what to say, and what to point at. The output below was captured from `main` on 2026-10-04 with no model running and no API keys; ids are ULIDs and change on every import, so copy them from your own screen. Wide tables are trimmed to the columns that matter.

Everything runs offline. Rehearse once from a clean state (see [Reset](#reset)) before presenting.

## Setup (before the audience arrives)

From the repository root:

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run build                                   # dist/yrm-bun-<os>-<arch>, for the close
alias yrm="bun run $PWD/packages/cli/src/main.ts"
cd fixtures/acme
rm -rf .yrm && yrm import .                     # see step 2; import again live if you like
```

The fixture's own `yrm.config.ts` sets Jack as the tenant, `yagni.example` as the self domain, `mailhub.example` as freemail, routes `triage` and `extract` to a local Ollama, and defines four model views (step 6). If Ollama is not running, `import` prints one warning for the triage tier and carries on with rules.

For step 8, create a read-only token for the agent and start the MCP server in a second terminal, also in `fixtures/acme`:

```sh
yrm auth token create claude --principal agent:claude --scopes read
yrm serve --http 7788
claude mcp add --transport http yrm http://127.0.0.1:7788/mcp --header "Authorization: Bearer <token>"
```

Make the terminal at least 160 columns wide; `who --facts` and `facts` print wide tables.

## The script

### 1. The thesis (0:00, 20 seconds)

No command. Say:

> "Your mail, meetings and notes go into a log that is never edited. YRM pulls facts out of it, each one pointing at the message it came from and carrying when it was true and when we learned it. People and companies are proposals you confirm. Agents read the facts over MCP, so understanding is paid for once per message, not once per question."

### 2. Import (0:20, 30 seconds)

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
  superseding earlier facts    19
time                         96ms
```

Say: "Four months of a sales pilot: 40 mails, four meetings, three call notes. Seven mails were newsletters and notifications and were dropped. No model answered; this is rules only, in about a tenth of a second. Nineteen facts replace earlier ones: an ask that got answered, a commitment that was kept, a job that ended."

Point at: `dropped 7`, `time`, `facts recorded 62`. Run it again to show `duplicates 40`: the log is idempotent.

### 3. Facts with provenance (0:50, 30 seconds)

```sh
yrm who marcus --facts
```

```
Marcus Bell  person  [proposed]  01M443EJAHZXX2C80JSCPKBJ8K
  email:marcus.bell@acme-robotics.example
  events 29  ·  first 2026-06-02  ·  last 2026-09-22  ·  open commitments 0  ·  open asks 2
  views last_contact=2026-09-22  ·  open_items=2
  statement                                                        type/predicate     valid         known       conf  origin          evidence
  Marcus Bell works at Acme Robotics.                              [relationship/...] 2026-06-02..  2026-06-02  0.80  rule:resolve@1  ← 01M443EJA82P...
  Marcus Bell asked Jack Collins: One question I'll get from our
    CFO: what happens to our data if we end after the pilot?
    (answered by Jack Collins on 2026-07-01)                       [ask/asked]        2026-07-01..  2026-07-01  0.60  rule:extract@1  ← 01M443EJA913...
  Marcus Bell communicated a decision: Following yesterday's
    scoping session: we're going with Option A.                    [decision/decided] 2026-07-09..  2026-07-09  0.60  rule:extract@1  ← 01M443EJA913...
  Marcus Bell asked Jack Collins: If your Type II report slips
    past September 30, will you let us exit the pilot order with
    no fee?                                                        [ask/asked]        2026-09-03..  2026-09-03  0.60  rule:extract@1  ← 01M443EJAA6B...
```

Say: "Every line is a fact, not a field. Each one has the message it came from, when it became true, how confident the extractor was, and who produced it: `rule:extract@1` is the rule extractor, version 1. A model fact would name the model; a fact you type says `human` and outranks both."

Point at: the `evidence` column, `origin`, and the September ask with no "(answered ...)" suffix, unlike the July one above it.

### 4. The time machine (1:20, 90 seconds)

```sh
yrm who priya
```

There are two Priya Ramans: her Acme address and her Northwind one. Copy the id of the one with `email:priya.raman@acme-robotics.example`.

Say: "Priya was our champion at Acme. Her farewell mail is dated August 14, but Acme's data-loss gateway held it until September 3. So it was true in August, and we did not know until September. Facts carry both times: `--at` is what was true in the world, `--as-of` is what we knew."

Ask about August 20, as we knew it on August 20:

```sh
yrm facts <priya-acme-id> --at 2026-08-20 --as-of 2026-08-20
```

```
  facts true at 2026-08-20 23:59, as known on 2026-08-20 23:59

statement                                                         type/predicate             valid         known
x Priya Raman works at Acme Robotics.                             [relationship/works_at]    2026-06-02..  2026-06-02
Jack Collins committed to Priya Raman (due 2026-06-05): ...       [commitment/committed_to]  2026-06-05..  2026-06-05
Priya Raman committed to Jack Collins (due 2026-06-23): ...       [commitment/committed_to]  2026-06-23..  2026-06-23
Jack Collins committed to Priya Raman (due 2026-06-26): ...       [commitment/committed_to]  2026-06-26..  2026-06-26
```

The same day, as we knew it on September 5:

```sh
yrm facts <priya-acme-id> --at 2026-08-20 --as-of 2026-09-05
```

```
  facts true at 2026-08-20 23:59, as known on 2026-09-05 23:59

statement                                                                  type/predicate             valid         known       recorded
Jack Collins committed to Priya Raman (due 2026-06-05): ...                [commitment/committed_to]  2026-06-05..  2026-06-05  2026-10-04 18:40
Priya Raman committed to Jack Collins (due 2026-06-23): ...                [commitment/committed_to]  2026-06-23..  2026-06-23  2026-10-04 18:40
Jack Collins committed to Priya Raman (due 2026-06-26): ...                [commitment/committed_to]  2026-06-26..  2026-06-26  2026-10-04 18:40
Priya Raman is changing jobs: leaving Acme, joining Northwind Automation.  [signal/job_change]        2026-08-15..  2026-09-03  2026-10-04 18:40
Priya Raman works at Northwind.                                            [relationship/works_at]    2026-08-15..  2026-09-03  2026-10-04 18:40
```

Say: "Same day in the world, two days of knowing. On August 20 our records had her at Acme and no job change. Ask again as of September 5 and she has left: the job change and her Northwind job are true from August 14, known from September 3, when the mail actually arrived. We imported all of this today; `known` is when you could have known it, `recorded` is when YRM wrote it."

Point at: `known 2026-09-03` against `valid 2026-08-15` (the UTC date of an evening mail on the 14th) and `recorded` (today).

Then the closed job, as known now:

```sh
yrm facts <priya-acme-id> --at 2026-08-01
```

Point at: `Priya Raman works at Acme Robotics.  2026-06-02..2026-08-15  known 2026-09-03`. The Acme job now has an end, and that end was itself learned on September 3. The open-ended version was not edited: it was superseded, and both stay in the store.

Be ready for the `x` on the first row of the August 20 table. `x` means "retracted at some point", and that retraction happened on September 3, after the day we asked about; the row is right, the marker is not ([#51](https://github.com/YAGNI-App/YRM/issues/51)). How knowledge time is set for imported history is [ADR 0008](decisions/0008-known-at-for-backfilled-facts.md).

Optional, if the browser is ready: `yrm web`, open Priya, and drag the "known by" slider from August to September to show the same change.

### 5. What needs you today (2:50, 60 seconds)

```sh
yrm today --date 2026-10-03
```

The story is set on the morning of October 3, and the top three match [`STORY.md`](../fixtures/acme/STORY.md):

```
Today, 2026-10-03 for YAGNI  (6 items)

1. ██████████ 1.00  Reply to Marcus Bell about: If your Type II report slips past September 30, will you let us exit the pilot…
   Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.
   about: Marcus Bell

2. ██████████ 0.95  Deliver to Elena Vasquez: I will send you our SOC 2 Type II report by September 30.
   You promised this to Elena Vasquez; it was due 2026-09-30 and is 3 days late with no delivery recorded.
   about: Elena Vasquez  ·  due: 2026-09-30

3. ███████░░░ 0.70  Re-engage Acme Robotics: quiet for 31 days with 6 open items
   Nobody at Acme Robotics has written or met with you since Marcus Bell on 2026-09-02, and 6 asks, commitments or objections involving them are still open.
   about: Acme Robotics, Marcus Bell

4. ██████░░░░ 0.64  Reply to Dana Okafor about: Do you want to tell them, or should I send the bridge letter to Elena directly?
5. ██████░░░░ 0.55  Address Elena Vasquez's concern: The Reno pilot is on hold until I have the Type II report in hand and have revi…
6. ████░░░░░░ 0.40  Address Elena Vasquez's concern: Before I schedule anything I want to flag a concern up front so nobody is surpr…
```

Say: "Six things, each with a reason you can check. Marcus asked a yes-or-no question a month ago and never got an answer; that is why Acme went quiet. We promised Elena the Type II report and missed it. And nobody at Acme has written since."

Then show why the first one is there:

```sh
yrm today --date 2026-10-03 --json | grep '"key"' | head -1
yrm attention:explain <key>
```

```
unanswered-ask:01M443EJCVCT6C01QM6QC9F4HD  (score 1.00, by attention/unanswered-ask)
Action: Reply to Marcus Bell about: If your Type II report slips past September 30, will you let us exit the pilot…
Reason: Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.
About:  Marcus Bell [01M443EJAHZXX2C80JSCPKBJ8K]

Evidence: 1 fact(s), 1 event(s)
  fact 01M443EJCVCT6C01QM6QC9F4HD [ask/asked, rule extract v1, confidence 0.6]
    valid 2026-09-03, recorded 2026-10-04, known 2026-09-03
    - event 01M443EJAA6B6BV6EGR4QSDXSR: 2026-09-02 mail/message 'Re: Security review follow-ups'
      speaker: Marcus Bell
      "If your Type II report slips past September 30, will you let us exit the pilot order with no fee?"
```

Point at: the quote and the event. The ranking is a function over facts; you can argue with it.

The time machine works here too: `yrm today --date 2026-10-03 --as-of 2026-09-01` gives 4 items, without Marcus's September question (it arrived on September 2) and with Acme's open items at 4.

Item 4 is a weak spot worth naming if asked: Dana is a colleague, and `extract:eval` in step 7 lists her question as spurious.

### 6. Views: fields in plain English (3:50, 45 seconds)

```sh
yrm view show "Acme Robotics"
```

```
Acme Robotics  organization  01M443EJAGHEWJWY93JZ8X9FEN
  view            value       conf  origin      evidence
  champion        -                             not computed: extract tier unavailable (NO_ELIGIBLE_ROUTE)
  deal_stage      -                             not computed: extract tier unavailable (NO_ELIGIBLE_ROUTE)
  economic_buyer  -                             not computed: extract tier unavailable (NO_ELIGIBLE_ROUTE)
  last_contact    2026-09-22  0.95  rule:views  01M443EJABAJ6RG4WVN2W7B66P
  open_items      4           0.95  rule:views  01M443EJABAJ6RG4WVN2W7B66P, 01M443EJAA6B6BV6EGR4QSDXSR, ...
  risk_summary    -                             not computed: extract tier unavailable (NO_ELIGIBLE_ROUTE)
```

Say: "A CRM field here is a sentence. `deal_stage` is defined in the config as 'where our commercial conversation with this organization stands'. Two views are rules and need no model: last contact and open items. The other four are filled by the extract tier, and with no model running YRM says so instead of guessing. Every value is a fact with evidence, so the time machine works on fields too."

Point at: the two rule views with evidence, and `not computed` with its reason. `last_contact` is Jack's own September 22 check-in, which is why it differs from the "quiet since September 2" in step 5; `open_items` counts asks and commitments, not objections, so it is 4 where `today` says 6.

Then set one by hand:

```sh
yrm view set "Acme Robotics" economic_buyer "Marcus Bell"
```

```
economic_buyer for Acme Robotics: Marcus Bell. Recorded as user:jack@yagni.example; models will not override it.
```

With Ollama running (`ollama serve`, `ollama pull qwen3:8b`), `yrm view backfill deal_stage` and the other three fill these from Acme's facts and recent mail, each value with a confidence, `origin` naming the model, and the events it rests on. The story points at Marcus as economic buyer, Priya as champion until August, a stalled deal and the Type II report as the risk; what a given model returns varies, and these values were not captured for this script. A human value, like the one just set, always wins.

### 7. How good is rules-only? (4:35, 30 seconds)

```sh
yrm extract:eval --corpus .
```

```
Fact extraction scorecard

ask             7/7   recall  100%  precision   77%  F1   87%
commitment      8/8   recall  100%  precision  100%  F1  100%
decision        2/2   recall  100%  precision   67%  F1   80%
objection       1/1   recall  100%  precision  100%  F1  100%
relationship    2/2   recall  100%  precision  100%  F1  100%
role            1/3   recall   33%  precision  100%  F1   50%
signal          1/2   recall   50%  precision  100%  F1   67%
overall        22/25  recall   88%  precision   88%  F1   88%
closure        14/15  status and resolvedBy (answeredBy) correct on recalled commitments and asks
```

Say: "The corpus comes with hand-written ground truth. With no model and no keys, the rules find 88% of the facts that matter, and 88% of what they find is right. Commitments close across threads: 14 of 15 are marked kept or answered by the right message. Models are for the rest: roles and quiet signals."

Point at: `overall`, `closure`, and the `role` row as the weak spot.

### 8. Models and an agent over HTTP (5:05, 75 seconds)

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

Say: "Code never names a model; it asks for a tier. The frequent work goes to an open-weight model on your machine, and the one expensive call a day goes to a frontier model you choose, with your key. That call sees facts, never your mailbox. About two dollars a month."

Switch to the second terminal: `yrm serve --http 7788` is running and printed `YRM MCP over HTTP: http://127.0.0.1:7788/mcp`. Say: "Agents reach it over MCP. Locally no token is needed; bind it to the network and it refuses to start until a token exists, and every call without one gets a 401."

If asked about the agent's read-only token: on loopback the bypass runs first, so today the header is not checked and the agent acts as the local user ([#53](https://github.com/YAGNI-App/YRM/issues/53)). It matters once the server is on the network.

Ask Claude Code:

> "What do we owe Acme, and what did we know on September 1st?"

Point at: the tool calls (`yrm_open_items`, `yrm_facts`, `yrm_views`), the Type II commitment and Marcus's unanswered ask with their quotes, and, for September 1st, `asOf` in the call and the answer that the job change was true since August 14 but not yet known.

### Close: ship it (6:20, 40 seconds)

```sh
ls -lh ../../dist/
../../dist/yrm-bun-darwin-arm64 --version
../../dist/yrm-bun-darwin-arm64 today --date 2026-10-03 | head -1
```

```
-rwxr-xr-x@ 1 jack  staff    62M Oct  4 12:42 yrm-bun-darwin-arm64
yrm 0.1.0
Today, 2026-10-03 for YAGNI  (6 items)
```

Say: "Everything you saw is one 62 MB binary: no runtime, no `node_modules`. The same binary goes in a Docker image with one volume for config and data; SQLite by default, Postgres if you point it at one. It is open source and was built by YAGNI's agent Teams in public. What they build next is in the backlog."

Show [`docs/BACKLOG.md`](BACKLOG.md) and the first week plan in [`docs/TEAMS.md`](TEAMS.md). Releases are built by a workflow on `v*` tags; no release has been cut yet ([#52](https://github.com/YAGNI-App/YRM/issues/52)), so `install.sh` and `ghcr.io/yagni-app/yrm` have nothing to fetch until then.

## Extra, if asked

- **Merging people.** `yrm resolve:suggestions` lists Tom Fischer (0.90, same name in the same thread; he wrote from a personal address) and Priya Raman (0.60, same name at different domains). `yrm resolve:merge <from-id> <into-id> --user jack` merges; YRM never merges on its own. Ids change afterwards, so do this after step 4.
- **Docker.** `docker build -t yrm .` from the repository root, then `docker run --rm -v yrm-data:/data yrm auth token create me --principal user:me --scopes read,write` and `docker run -d -p 127.0.0.1:7777:7777 -v yrm-data:/data yrm`. The token step is required for now: the image listens on `0.0.0.0` inside the container, which needs a token ([#52](https://github.com/YAGNI-App/YRM/issues/52)).
- **Slack and Gmail.** `yrm slack:setup` prints the app manifest steps; `yrm slack:import <export-dir>` reads a workspace export. Gmail syncs through your own Google Cloud OAuth client ([`packages/ext-gmail/README.md`](../packages/ext-gmail/README.md)).

## Reset

Delete the local database and import again:

```sh
rm -rf .yrm/local          # in fixtures/acme
yrm import .
```

`.yrm/local/` holds the SQLite file, which includes auth tokens and view values set by hand. The config stays. After a reset, ids change (re-copy them for steps 4 and 5) and the agent's token is gone: create it again and update the header with `claude mcp remove yrm` and `claude mcp add ...` as in Setup.

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| One `[warn] model-triage: triage call failed (ALL_ROUTES_FAILED)` line during import | Routes point at Ollama and it is not running | Harmless; rules still run. Start Ollama (`ollama serve`, `ollama pull qwen3:8b`) to use it. |
| `today` says "Follow up with Jack Collins on ..." and Marcus's unanswered ask is missing | `tenant.selfAddresses` does not include `jack@yagni.example`, so YRM does not know which person is you | Use `fixtures/acme/yrm.config.ts`, `rm -rf .yrm/local`, import again. |
| `today --as-of ...` prints "Nothing needs you today", or `facts --as-of` prints `(no facts)` | The store was imported with `--live`, so facts are known from the import time | `rm -rf .yrm/local` and `yrm import .` again without `--live`. |
| `"priya" matches 2 entities; pass an id` | Two addresses, not merged | Expected. Use the id from `yrm who priya`. |
| `view show` says `not computed` for the model views | No reachable extract route | Expected without Ollama. Start it and run `yrm view backfill <name>`, or skip to `view set`. |
| `serve --http` or `web` refuses to start: "will not listen on 0.0.0.0 without a token" | `--host` is not loopback and no token exists | Leave `--host` off for the demo, or `yrm auth token create`. |
| The agent's MCP calls fail with 401 | The token was revoked or the store was reset | Create a token again and re-add the server with the new header. |
| `who` or `facts` tables wrap and are unreadable | Terminal too narrow | Widen to 160+ columns or reduce font size. |
| Anything else | | `yrm doctor`, then `yrm <command> --verbose`. Reset and retry. |

To remove the MCP server from Claude Code afterwards: `claude mcp remove yrm`.
