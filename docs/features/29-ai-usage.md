# 29 AI usage

## Context

Coding agents run on several machines, signed in to subscriptions whose
limits are rate-limit windows (five hours, a week, a model's own), credits
and balances. Each CLI shows its own numbers on its own machine; nothing
shows them together, says which window runs out first, or whether the
current pace runs it out before the reset. The credentials are spread over
machines, and the same account is often signed in on several.

The CLIs' logs also record every response's tokens. At API prices they say
what a subscription is worth. OpenCode, a client of many providers, keeps
the same in its sessions' database.

## Goals / non-goals

- Every account the machines' CLIs are signed in to, once, with the
  machines it was seen on: windows with reset countdowns and pace, credits
  and balances, the provider's status page.
- Alerts when a window reaches a threshold, starts over, or its pace runs it
  out before its reset.
- The logs' cost by day, model, project and machine, with weekly and
  monthly equivalents; OpenCode as a service with spend and no windows.
- What the session of the coding agent in the focused pane has used, at API
  prices, with its context.
- Credentials stay on their machines and are never sent to the core. They
  are read only, except Kimi Code's sign-in, which is renewed in place as
  Kimi Code renews it.
- Non-goals: importing browser cookies, hooks that run commands, refreshing
  other CLIs' OAuth tokens or writing their files, spending Codex reset
  credits. Providers that need a browser session have no data source.

## Design

### Machine side

`internal/usage` reads one machine; the agent's plugin
(`internal/agent/plugin/usage`) runs its actions:

- `limits`: asks each enabled provider in parallel (15 s per request,
  through `HTTPS_PROXY`, one shared HTTP client, no redirects followed);
  another core's same request through the same node within a minute gets
  the same answer ([39](39-nodes.md)). It returns a list of accounts with windows, credits, balances and a
  `status`: `ok`, `stale` (expired token, or numbers from a log), `unauth`,
  `error` (with `code`) or `missing`. Accounts the core names in `skip` /
  `skipLocal` are answered `skipped` without a request; a 429 returns
  `rate_limited` with its `Retry-After`.
- `cost`: the logs' tokens and cost by day, provider, model and project.
  Answers carry an `etag`; a repeat scan with a matching `ifNoneMatch`
  returns `notModified` without the rows.
- `setDeepseekKey`: writes or removes the DeepSeek key file.
- `session`: what one session of a coding agent used (below).

| Provider | Credentials | Source of the numbers | Account id |
| --- | --- | --- | --- |
| Claude | `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR`); on macOS the keychain item `Claude Code-credentials` when the file has none (`usage.claudeKeychain`) | `GET api.anthropic.com/api/oauth/usage`: five-hour, seven-day and per-model windows, extra usage | `oauthAccount.accountUuid` of `~/.claude.json`, else `/api/oauth/profile` |
| Codex | `$CODEX_HOME` or `~/.codex/auth.json`, plus `usage.codexHomes` | `GET chatgpt.com/backend-api/wham/usage`; without an answer or with an expired token, the newest session log's `rate_limits` (`stale`, `from_log`) | `tokens.account_id` |
| Grok | `$GROK_HOME` or `~/.grok/auth.json` | `GET cli-chat-proxy.grok.com/v1/billing`: the credit period, named by its length (7 days: weekly), per-product usage | `user_id` |
| Antigravity | none: the running language server | The user's own `language_server` process (via `ps`), its CSRF token and loopback port; `GetUserStatus` on `127.0.0.1`. Without one, `agy -p /usage` at most every 10 minutes | a hash of the email |
| Kimi Code | `$KIMI_CODE_HOME` or `~/.kimi-code/credentials/kimi-code*.json` | `GET api.kimi.com/coding/v1/usages`: 5-hour, 7-day and monthly limits, the booster wallet | the token's `user_id` claim |
| DeepSeek | the key file written from the panel, else `DEEPSEEK_API_KEY`, else Claude Code's `settings.json` when its `ANTHROPIC_BASE_URL` is an `https` host under `deepseek.com` | `GET api.deepseek.com/user/balance` (balances, no windows) | a hash of the key |

OpenCode has no row: it has no quota of its own, only the providers the
user set up in it. It shows only the spend of its sessions.

Tokens are read from the files at each poll, sent only to their provider's
fixed host and never returned. An expired token is not sent at all.

Antigravity's fallback `agy` takes seconds and a few hundred MB, so it runs
at most every 10 minutes (the polls between get its last answer), backs off
30 minutes after a failure, and runs in its own process group, killed when
it exits or times out (20 s).

Each provider has its own settings group (its switch
`usage.providers.<id>` and its options). The plugin's settings page has two
levels (`SettingsPage.tsx`, the plugin's `settings.layout`,
[27](27-plugins.md)): the plugin's own groups, then a **Providers** list
whose rows open a page per provider.

### Renewing Kimi Code's sign-in

Kimi Code's access token lasts about 15 minutes and Kimi Code renews it
only while it runs, so its numbers would otherwise be unreadable most of the
time. Its refresh token is single-use: a renewal that kept the new tokens
to itself would sign Kimi Code out. So with `usage.kimiRefresh` on (the
default) and the core not `--read-only`, the agent renews the token exactly
as Kimi Code 2.2.0 does (`internal/usage/kimiauth.go`) and writes the new
tokens back where Kimi Code reads them:

- **When**: a `kimi-code.json` token that ends within a minute. Other
  hosts' slots (`kimi-code-env-<hash>.json`) and agents run with
  `KIMI_DISABLE_OAUTH_LOCK=1` are not renewed.
- **Lock**: Kimi Code's own lock (proper-lockfile on
  `<home>/oauth/kimi-code`). A held lock is waited for up to 8 s (else
  `stale` with `lock_busy`) and never broken; one untouched for 30 s is
  taken over. Kimi Code throws when a lock it holds is taken, so its own
  5-second staleness rule is not used. Under the lock the file is read
  again, in case Kimi Code renewed meanwhile.
- **Refresh**: `POST https://auth.kimi.com/api/oauth/token` with Kimi
  Code's client id and identity headers. Up to three attempts on network
  errors and 429/5xx. Once sent, the answer is awaited even if the core
  stopped waiting, because the old refresh token is then spent.
- **Write-back**: in Kimi Code's format, keeping the file's other members
  and mode, through a temporary file, fsynced and renamed. Written even if
  the lock was taken over meanwhile: Kimi Code rereads the file when its
  own refresh is refused.
- **Refusal** (`invalid_grant`, 401, 403): the account is `unauth` and the
  refresh is not sent again until the file's content changes.

### Cost of the logs

The parsers (`internal/usage/cost_*.go`) read:

- Claude: `projects/**/*.jsonl`, assistant messages' `usage`, deduplicated
  by request and message id.
- Codex: `sessions/**` and `archived_sessions/**` rollouts.
- Grok: `sessions/*/*/updates.jsonl` and the legacy `logs/unified.jsonl*`.
- Kimi Code: `sessions/*/*/agents/*/wire.jsonl` `usage.record` events.
- Antigravity and OpenCode: their SQLite databases (below).

`internal/usage/pricing.json` has the prices by provider and longest model
prefix, with long-prompt tiers and cache-write prices. Weekly and monthly
equivalents scale the range's cost to 168 and 750 hours.

The scanner keeps its cache in the machine's database
(`machine-<host>.db`, tables `usage_cost_files` and `usage_cost_state`;
[38](38-sqlite-state.md)) and in memory, reading the database again only
when another agent of the instance saved since. Per log it records size,
time, the offset after the last complete line and its records. Unchanged
logs are not read again; grown logs are read on from the offset. Logs and
records older than 90 days leave the cache. Changed entries are saved in
one transaction at most every 5 minutes (or after 8 MiB of logs), every
20 s during a long scan, and on cancel, so a scan never starts over.

#### One session's usage

The action `session` (`internal/usage/session.go`, `SessionCost`) answers
what one session of a coding agent used, for the status bar's session item.
It takes an agent kind whose transcripts are priced (`claude`, `codex`;
`SessionProvider`) and a session UUID. The agent finds the session's
transcript and its subagents' (Claude Code's `<session>/subagents/`,
Codex's rollouts whose `session_meta` names the session as
`parent_thread_id` or `session_id`: a review or a spawned agent;
[35](35-agent-native-view.md)), and reads them with the cost parsers,
decoding only the usage members. A
response recorded in several transcripts counts once, and records are
priced exactly as the spend prices them (`TestSessionCostEqualsCost`).

The answer (`agentproto.SessionUsage`) has the tokens by kind, requests,
cost, whether every model was priced, the latest model and the context in
use with the context window (Codex's model window; unknown, 0, for Claude
Code). Unchanged transcripts are not read again and grown ones are read on;
at most 2 reads run at once; a transcript over 256 MiB or a session over
200 000 records is `too_large`. Nothing is written. Codes: `not_found` (no
transcript yet), `compressed`, `too_large`, `bad_params`.

#### Antigravity's and OpenCode's databases

Antigravity keeps each conversation in an SQLite database under
`~/.gemini/antigravity{,-cli,-ide}/conversations/`
(`internal/usage/cost_antigravity.go`). Token counts and model come from
protobuf blobs in `gen_metadata`; timestamps from `steps` split
conversations by day; `trajectory_metadata_blob` gives the project.
Records are keyed by request id, so databases that overlap across the three
directories are not double-counted. Each database is cached by its and its
WAL's size and time.

OpenCode keeps its sessions in `opencode.db` (and `opencode-<channel>.db`)
in its XDG data directory, or `$OPENCODE_DB`. Each assistant message of
table `message` is a step with its model, provider, directory, tokens and
OpenCode's own cost. The database is read whole whenever it or its WAL
changed, since a step's tokens are written into an existing row when it
ends.

The agent has no SQLite library: `internal/usage/sqlite.go` reads the file
format itself, read-only, including the WAL up to its last valid commit. It
takes no lock, writes nothing and opens no `-shm`, so it never stands in the
writer's way. Only the schema's and the needed tables' pages are read
(OpenCode's `credential` and `account` tables are not). A read that a
concurrent checkpoint invalidated is retried up to three times.

The file belongs to another program and is read in the agent (and beside
the core for the local machine), so a damaged or crafted file must fail the
read, never crash the process or exhaust its memory:

- Database and WAL are opened only as regular files, non-blocking (a FIFO
  or device is refused as `unreadable`).
- Every offset and length is checked against what remains, without sums
  that could overflow.
- Cells must lie within their page without overlap; each page is read at
  most once per walk.
- A read has budgets: bytes read (3× the files' size plus 1 MiB), rows
  (2,000,000), steps kept (300,000), record size (64 KiB; Antigravity's
  generation rows up to 64 MiB), WAL size (1 GiB). Past a bound the read
  fails as `too_large` instead of silently dropping rows.
- The scan's context is checked before every page.
- A failed read keeps the last records and is reported per machine in the
  spend (`too_large`, `busy`, `damaged`, `unreadable`).
- `FuzzSQLite` checks that no input panics and that bytes read, rows and
  time stay bounded by the input's size; `make test` runs its seeds.

OpenCode's steps are priced by the user's prices, then the table of the API
that served them (OpenCode records subscription use as free), then the cost
OpenCode recorded; otherwise the tokens count without a price.

#### Keeping prices current

- Each release runs `go run ./scripts/pricecheck` ([RELEASING.md](../../RELEASING.md)),
  which compares the table with LiteLLM's public price table and lists
  differing, missing and unpriced models. It writes nothing; each finding is
  checked against the provider's page. Only this script uses the network;
  the core and agents read the embedded table.
- `usage.prices` holds the user's prices, one line per model prefix
  (`<model> <input> <cached> <output> [<cache write>]`, USD per million
  tokens). They are sent with each scan, override the table's entry of the
  same name, and key the core's cost cache. The settings page edits them as
  a form (`PricesEditor.tsx`): a row per model, saved when complete and
  valid, an invalid row explained and not saved; empty cache prices cost
  the input price. Models the spend found without a price are offered as
  rows to fill in.
- A model without a price still counts its tokens; the spend names such
  models with a link to `usage.prices`.

### Core

`backend/features/usage` runs a scheduler (a service of the feature,
`usage.ts`) that checks every 10 s
whether a poll is due by `usage.refresh`: `manual`, a fixed interval, or
`adaptive` (default). Adaptive uses `usage.refreshOpen` (5 min) while a
panel is visible, `usage.refreshWorking` (10 min) while a coding agent
works in any terminal ([25](25-agent-detection.md)), else
`usage.refreshIdle` (30 min). `POST /api/p/usage/refresh` polls at most once
per 30 s; concurrent requests share the poll. No poll runs while no machine
is connected.

A poll asks the connected machines one after another, the local one first,
passing the accounts already fetched in `skip`. So an account signed in on
several machines is asked once per poll and lists every machine it was seen
on. A machine that connects later is asked alone at the next tick. Accounts
are keyed `provider:id`; one without an id stays per machine until named.

Per account the best answer of a poll wins (provider numbers, then log
numbers, then expired, failed, refused), so one machine's expired sign-in
does not hide another's numbers. The machines that answered worse are the
account's `issues`. An answer without numbers keeps the last good ones with
the new status. Accounts unseen for 7 days are forgotten.

The history (the core's database `core[-<instance>].db`, tables
`usage_windows`, `usage_accounts`, `usage_alerts`, `usage_machine_costs`;
[38](38-sqlite-state.md)) keeps a point per window when the use changed or 15 minutes passed, for 30
days, plus the last accounts for a restart. A window's pace compares its use
with the share of its time gone and projects when it runs out.

Every 10 minutes the core reads the status pages of enabled providers
(Anthropic's and OpenAI's Statuspage summaries, Google's incident feed);
x.ai's and DeepSeek's are links.

Each poll's snapshot goes to every page over `/ws` (`plugin` message) and
is served by `GET /api/p/usage` with an `ETag`. `GET /api/p/usage/cost`
asks the connected machines in parallel (2 min each, per-machine
`ifNoneMatch`) and is cached for a minute per range, timezone, providers,
Codex homes and prices. Besides the days' rows it has each machine's
quarters of an hour with spend (`recent`: provider, tokens, requests, cost)
from the start of the UTC day 8 days back (`recentSince`, which moves once a
day so that the machines' `ETag`s hold): a subscription's window starts at
any minute and the days' rows cannot say what it has cost
(`CostOptions.RecentSince`, `CostSlot`). A disabled or offline machine's last report
(`usage_machine_costs`) stays in the total until the machine is removed. A
machine runs one scan at a time; requests for the same range share it.

`GET /api/m/{id}/p/usage/session?kind=&session=` runs the machine's
`session` action (30 s) with the user's prices. Kind and id are checked
first (`400 bad_request`), a provider turned off is not read
(`404 provider_off`), and only the decoded numbers reach the page. At most
8 run at once per machine (`429 busy`). It only reads, so a read-only core
answers it and it is not audited.

A core on Windows runs no local agent, so only SSH machines' CLIs are read.

### Web UI

`web/src/plugins/usage`: the panel **AI Usage** (command
`view.panel.usage`), laid out like CodexBar.

- **Tiles**: the overview and each service with an account or spend, each
  with its mark (Lobe Icons, `web/src/assets/ai-logos`) and a bar of its
  tightest window, in the service's color (`--usage-<provider>`,
  `usage.css`). Below: read times, used/left switch, refresh mode and
  Refresh. The shown panel rereads the cost after `usage.costRefresh`
  (15 min), and at once when `usage.prices` or a provider's switch
  changes.
- **Overview**: the spend of the last 7, 30 or 90 days at API prices, daily
  bars stacked by service (plain SVG), a ranking by project or machine, or
  by model: every model (the first 8, all on asking) with its cost, tokens,
  a bar of its kinds of tokens and their counts with its requests
  (`modelBreakdown`); unpriced models, machines whose logs failed; then a
  row per account, tightest window first.
- **Spend / Tokens** switch: the same views by tokens, with the shares of
  input, cache reads, cache writes and output. Unpriced models count fully
  in Tokens.
- **A service**: a card per account with plan, status-page incident, hints
  for a non-ok status, windows grouped by the models they count, each with
  reset countdown, bar, even-pace mark and projected run-out, and what the
  window has cost so far at API prices with the whole window at that rate
  (the spend over the share used, from 5% used on; `windowSpend`); credits,
  balances, machines; then the service's own spend with every model's use
  and, for DeepSeek, the key form. A window's spend is the quarters of an
  hour of the account's machines' logs of its service from the window's
  start (its reset less its length) on; a window of models has none (the
  logs' spend is of every model), and a machine where several accounts of
  the service were used counts for each. A window whose reset has passed is dimmed and left out of the
  tightest window and alerts until the next poll.

The status bar item shows the percentage of the window that counts the
coding agent in the focused terminal, with its service's mark: the tightest
of its service's accounts read on its machine (any of the service's when
none was), a window of models only when its label names the session's latest
model (Opus, Sonnet, a Codex model's own limit; `tightestFor`), so it moves
when the agent changes service, machine or model. Without such an agent it
shows the tightest window of all accounts with a gauge. It is in the
warning color from the first of `usage.thresholds` (80, 95);
`usage.statusBar` hides it. Hovering it with a mouse shows a card of the tightest accounts and
today's spend if already loaded (`web/src/components/useHoverOpen.ts`); a
click opens the panel. The daily bars' columns show a tooltip with the
date, cost, tokens, requests, per-service and per-kind breakdown.

The **session item** (`usage.session`, `SessionItem.tsx`, `session.ts`)
shows the session of the coding agent in the focused terminal: the
service's mark, the model of its latest request (without the vendor's
prefix and date), its cost at API prices and the context in use (a share
of the window, or tokens when the window is unknown). Its hover card adds
the full model, requests, tokens by kind and the window that counts that
model on that machine; a click opens the service's tab. It shows nothing without a
priced agent session, with the provider off, or for a session the machine
only guessed ([35](35-agent-native-view.md)). It reads when the focused
pane or session changes, every 30 s while the agent is in a turn, and once
when it stops; at most once per 10 s per session, never from a hidden
page. Failures keep the last numbers; the numbers of 64 sessions are kept.
A chat pane has its own item, `chat.usage` (`web/src/plugins/chat/UsageItem.tsx`),
from what the chat's agent states through its protocol
([37](37-agent-chats.md)).

### Alerts

With `usage.alerts` on (the default) the core fires, after a poll, for a
window read in that poll:

- **threshold**: its use reached one of `usage.thresholds`;
- **pace**: at its pace it runs out before its reset;
- **reset**: it started over after reaching the first threshold.

Each alert fires at most once per period of its window. The core records
the period's end per account, window (kind, label, length) and threshold
with the history, so a restart does not repeat it. A record re-arms only
when the window really starts over: a reset moving by more than 10 minutes,
or use falling 10 points for a window without a reset. This absorbs use
hovering around a threshold, reset times that drift by seconds, rolling
windows, and machines answering in turn.

The snapshot carries the last hour's alerts. A page shows the ones it has
not shown: a toast in a visible page, else a system notification while
`notifications.system` is on. Pages of one browser coordinate through
storage and a Web Lock, so a reload or another tab does not repeat an alert.
Reset and pace alerts share the thresholds' switch: a reset ends a
threshold warning, and a pace alert is that warning ahead of time.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Credentials copied to the core | Tokens would leave their machines; the agents already run where the CLIs do. |
| Refreshing every CLI's expired OAuth tokens | Writing the CLIs' credential files races the CLIs and can sign them out; running the CLI once renews them. Kimi Code is the exception: its 15-minute token made its numbers unreadable most of the time, and its lock and file format are known. |
| Renewing Kimi Code's token without writing it back | Its refresh tokens are single-use: Kimi Code would be signed out. |
| Breaking a Kimi Code lock stale by its own rule (5 s) | Kimi Code throws when a lock it holds changes; a holder whose event loop stalled would fail. |
| Browser cookies for providers without a CLI token | Reads another program's secrets. |
| Running `agy` at every poll | Seconds and hundreds of MB per run on every machine; its numbers change slowly. |
| Every machine asked for every account | The same account asked once per machine per poll, against the providers' rate limits. |
| Writing the cost cache after every scan | A log in use grows at every scan, and the whole cache was rewritten each time. |
| An SQLite library (pure Go or cgo) | Several MB in every machine binary, or broken cross builds, for reading one table. |
| `sqlite3` or `opencode db` on the machine | Often missing, or starts a large runtime; both take the database's locks. |
| Reading only rows added since the last read | Tokens are written into existing rows when a step ends. |
| Grok's credits as a monthly window | Its subscriptions' period is 7 days; the period's length names the window. |
| A chart library | A few SVG paths; no dependency. |
| Each page deciding alerts from the snapshots it saw | Pages raced, re-fired on jitter and drift, and forgot on reload. The core sees every poll and keeps one record per window and period. |

## Failure modes

- No internet on a machine: `network`; Codex falls back to its newest log,
  the others keep their last numbers.
- A provider changes its response: missing fields are left out, an
  unreadable answer is `bad_response`, the last numbers stay.
- Expired token: `stale` with `token_expired` and a hint to run the CLI;
  nothing is sent. Kimi Code's is renewed first (see above).
- 429: the account is skipped until its `Retry-After` (at most a day).
- `agy` fails or times out: `agy_failed`, last numbers stay, retried after
  30 minutes.
- An unreadable database: last records stay, the spend names the machine and
  reason.
- A redirect: not followed (`http_3xx`), so credentials reach only the fixed
  hosts.
- A machine offline: its accounts keep their numbers and machines.
- macOS keychain over ssh: `security` cannot prompt; the provider counts as
  missing.
- A session's context window unknown (Claude Code): the session item shows
  tokens without a share. Several accounts of a provider on one machine:
  its card shows the tightest window of those, not necessarily the agent's.
- A Codex subagent's rollout (a review) open in the agent's process, or made
  in its directory since it started: it stands for its parent session, never
  for one of its own, so the item shows the session with its subagents'
  spend rather than the subagent's few requests.

## Security

[SECURITY.md](../../SECURITY.md) lists the credential files read, the hosts
asked, the language server's loopback client, the DeepSeek key file, the
status pages, how the databases are read and how one session's
transcripts are found and read. Resources and retention:
[deployment](../deployment.md#remote-resources).

Key invariants: tokens are sent only to their provider's fixed host, never
redirected, never returned to the core; the only credential written is Kimi
Code's, in place and under its lock, never by a `--read-only` core; foreign
databases are parsed with bounded, read-only, lock-free code.

## Testing

- `internal/usage/usage_test.go`, `resources_test.go`: each provider
  against `httptest` servers or fixtures (headers, windows, expired tokens
  not sent, 401, 429, redirects, no token in a reply, `skip`), the
  Antigravity discovery and `agy` throttling, connection reuse.
- `internal/usage/kimiauth_test.go`: Kimi Code's renewal against a fake
  token endpoint: request, write-back byte for byte, the lock protocol,
  refusals, retries.
- `internal/usage/cost_test.go` (`TestCostRecent`: the quarters of an
  hour), `kimi_cost_test.go`,
  `antigravity_cost_test.go`, `opencode_test.go`: parsers, dedupe, pricing
  tiers, user prices (`TestOwnPrices`), the incremental cache, databases in
  `testdata/` (made by `make.sh` with `sqlite3`).
- `internal/usage/sqlite_test.go`, `sqlite_unix_test.go`: crafted databases
  (overflowing lengths, overlapping cells, loops, budgets, FIFOs);
  `FuzzSQLite`, `FuzzAntigravityProto`.
- `internal/usage/proc_unix_test.go`: `agy`'s process group killed.
- `internal/agent/plugin/usage/usage_test.go`: the actions and their codes.
- One session: `internal/usage/session_test.go` (same numbers as the spend,
  no content read `TestSessionCostReadsNoContent`, subagents, reading on,
  bounds), `internal/agent/plugin/usage/session_test.go`,
  `backend/features/usage/core.test.ts` (`a session’s params`, `a machine
  busy reading sessions`), `web/src/__tests__/usageSession.test.tsx` (the
  item, its card and the reads' schedule).
- `backend/features/usage/usage.test.ts`, `alerts.test.ts`,
  `store.test.ts`: cadence,
  dedupe across machines, best answer, `Retry-After`, refresh gap, history,
  status pages, cost cache and `ETag`s, no Kimi renewal from a read-only
  core; each alert at most once per period under jitter and drift, kept
  across a restart.
- `scripts/pricecheck/main_test.go`: the price comparison.
- `web/src/__tests__/usage.test.ts`, `usageSettings.test.ts`,
  `hoverOpen.test.ts`: the panel, the settings page and its form of prices, alerts shown once per
  browser, the status bar item and its card, a window's spend and its
  estimate of the whole, the breakdown by model; `usageSession.test.tsx`:
  the status bar item following the focused agent's service and model.
- `backend/features/usage/core.test.ts` (`guards`) walks the plugin's
  routes with `checkGuarded`.
