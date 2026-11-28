# 29 · AI usage

## Context

Coding agents run on several machines, signed in (often to the same account) to subscriptions whose limits are rate-limit windows (five hours, a week, a model's own), credits and balances. Each CLI shows its own numbers on its own machine; nothing shows them together, says which window runs out first, or whether the current pace runs it out before the reset. The CLIs' logs (and OpenCode's database) also record every response's tokens, which at API prices say what a subscription is worth.

## Goals / non-goals

- Every account the machines' CLIs are signed in to, once, with the machines it was seen on: windows with reset countdowns and pace, credits and balances, the provider's status page.
- Alerts when a window reaches a threshold, starts over, or its pace runs it out before its reset.
- The logs' cost by day, model, project and machine, with weekly and monthly equivalents; OpenCode as a service with spend and no windows.
- What the session of the coding agent in the focused pane has used, at API prices, with its context.
- Credentials stay on their machines, only read, except Kimi Code's sign-in, renewed in place as Kimi Code renews it.
- Non-goals: importing browser cookies, hooks that run commands, refreshing other CLIs' OAuth tokens or writing their files, spending Codex reset credits. Providers that need a browser session have no data source.

## Design

### Machine side

`backend/features/usage/machine.ts` and its modules in `machine/` ([42](42-typescript-backend.md)) answer four actions: `limits` (the accounts, providers asked in parallel), `cost` (the logs' spend, with an `etag`), `setDeepseekKey` and `session`. An account's `status` is `ok`, `stale` (expired token, or numbers from a log), `unauth`, `error`, `missing` or `skipped` (named in the hub's `skip`). Hubs sharing a node ([39](39-nodes.md)) get one answer to the same `limits` request unless a manual refresh sets `force`.

| Provider    | Credentials                                                                                                                      | Source (`machine/limits.ts` unless named)                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claude      | `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR`); on macOS the keychain item when the file has none (`usage.claudeKeychain`) | `api.anthropic.com/api/oauth/usage`                                                     |
| Codex       | `auth.json` of `$CODEX_HOME` or `~/.codex`, plus `usage.codexHomes`                                                              | `chatgpt.com/backend-api/wham/usage`, else the newest session log (`stale`)             |
| Grok        | `$GROK_HOME` or `~/.grok/auth.json`                                                                                              | `cli-chat-proxy.grok.com` billing and settings; the credit period named by its length   |
| Antigravity | none: the user's running `language_server` processes                                                                             | `GetUserStatus` on their loopback port, else `agy -p /usage` (`machine/antigravity.ts`) |
| Kimi Code   | `$KIMI_CODE_HOME` or `~/.kimi-code/credentials/`                                                                                 | `api.kimi.com/coding/v1/usages` (`machine/kimi.ts`)                                     |
| DeepSeek    | the panel's key file, `DEEPSEEK_API_KEY`, or Claude Code's settings pointing at `deepseek.com`                                   | `api.deepseek.com/user/balance` (balances only)                                         |

OpenCode has only spend. URLs are fixed in `machine/env.ts`. Tokens are read at each poll, sent only to their provider's host and never returned; an expired one is not sent. Requests honor `HTTPS_PROXY`/`NO_PROXY` and follow no redirect; programs (`security`, `ps`, `lsof`, `agy`) run in process groups of their own (`machine/run.ts`), the slow and large `agy` seldom. Each provider has its settings group (`usage.providers.<id>` and its options) under **Providers** on the plugin's settings page (`SettingsPage.tsx`, [27](27-plugins.md)).

### Renewing Kimi Code's sign-in

Kimi Code's access token lasts about 15 minutes, Kimi Code renews it only while it runs, and its refresh token is single-use, so a renewal that kept the new tokens would sign Kimi Code out. With `usage.kimiRefresh` on and the hub not `--read-only`, the agent renews an ending token as Kimi Code does (`machine/kimi.ts`) and writes the tokens back in Kimi Code's format, atomically, under Kimi Code's own lock (proper-lockfile's protocol, spoken directly to keep the library's patches out of the node), which it never breaks. A sent refresh's answer is awaited even if the hub stopped waiting, since the old token is spent; a refusal makes the account `unauth` until the file changes.

### Cost of the logs

The parsers (`machine/parsers.ts`) read Claude Code's `projects/**/*.jsonl`, Codex's session rollouts, Grok's session updates, Kimi Code's `wire.jsonl` records, and Antigravity's and OpenCode's databases (below). `spec/pricing/pricing.json` prices them by provider and longest model prefix; the machine side and the hub import that one file.

The scanner (`machine/scan.ts`, `cache.ts`) caches per log its size, offset and records, in memory and in the machine's database (`machine-<host>.db`, [38](38-sqlite-state.md)): unchanged logs are not read again, grown ones are read on, entries past 90 days leave, and changes are saved seldom and when a scan is cut short, so a scan never starts over. The ETag carries a token of the agent's own, so one agent's report never answers another's `ifNoneMatch`. Reads are chunked and SQLite runs in workers, so a slow disk never holds the node's event loop.

#### One session's usage

The action `session` (`machine/session.ts`) answers what one agent session used (with its subagents), priced as the spend prices it, for every kind the spend reads (`sessionProvider`): by session id, or by working directory when the agent reports none and no other terminal runs it there. Claude Code's and Codex's transcripts are found with the agents' session locator (`backend/machine/agents`) and opened as the files it located, through no link; for the other kinds `cwd` is only compared with metadata in the agent's own session root or database. Nothing is written, and reads are bounded (`too_large`).

#### Antigravity's and OpenCode's databases

Antigravity keeps conversations under `~/.gemini/antigravity{,-cli,-ide}/conversations/` (tokens in protobuf blobs), OpenCode its sessions in `opencode*.db` (or `$OPENCODE_DB`), read whole when it changed, since a step's tokens are written into an existing row. These files belong to other programs, so a damaged or crafted one must fail the read, never crash or exhaust the node. They are read with the runtime's SQLite (`machine/databases.ts`), read-only and only the needed columns, in a worker (`machine/sqlworker.ts`) ended when a batch takes too long:

- The database and its `-wal`, `-shm` and `-journal` names must be regular files of the user, not links.
- Without a WAL it is opened `immutable` (no lock, no file made); with one it is read as a snapshot that never holds the writer up; a locked database is `busy`, without waiting.
- Oversized records are skipped unread, too many fail as `too_large`, a damaged file as `damaged`; protobuf lengths are all checked (`protoFields`).

OpenCode's steps are priced at the user's or the table's price of the API that served them (OpenCode records subscription use as free), else at OpenCode's own cost.

#### Keeping prices current

Each release runs `bun backend/scripts/pricecheck.ts` ([RELEASING.md](../../RELEASING.md)), which compares the table with LiteLLM's public one and lists differing, missing and unpriced models, each checked against the provider's page; the hub and agents never fetch prices. `usage.prices` holds the user's own (`<model> <input> <cached> <output> [<cache write>]`, USD per million tokens), overriding the table's entry of the same name, edited as a form (`PricesEditor.tsx`) that offers the models found without a price.

### Hub

`backend/features/usage` runs a scheduler (`usage.ts`) by `usage.refresh`: `manual`, a fixed interval, or `adaptive` (`usage.refreshOpen` while a panel is visible, `usage.refreshWorking` while an agent works ([25](25-agent-detection.md)), else `usage.refreshIdle`). `POST /api/p/usage/refresh` forces a poll, at most one per 30 s. A hub on Windows reads SSH machines only.

- A poll asks the machines one after another, the local one first, passing the accounts already fetched in `skip`: an account signed in on several machines is asked once and lists every machine it was seen on.
- Per account the best answer wins (provider numbers, then log numbers, then expired, failed, refused), the worse ones being its `issues`; an answer without numbers keeps the last good ones. A machine that reports another account or none leaves the stale ones at once; accounts unseen for 7 days are forgotten.
- History (the hub's database, [38](38-sqlite-state.md)) keeps windows' points for 30 days, the last accounts and the alerts' records. Pace compares a window's use with the share of its time gone.
- The snapshot goes to pages over `/ws` and `GET /api/p/usage`; enabled providers' status pages are read periodically.
- `GET /api/p/usage/cost` (`cost.ts`) asks the machines in parallel with per-machine `ifNoneMatch`. Besides the days' rows it carries each machine's quarters of an hour of spend (`recent`, `CostSlot`), since a subscription window starts at any minute. An offline machine's last report stays in the total until the machine is removed.
- `GET /api/m/{id}/p/usage/session` runs the `session` action, bounded per machine (`429 busy`); a provider turned off is not read (`404 provider_off`). It only reads, so a read-only hub answers it, unaudited.

### Web UI

`web/src/plugins/usage`: the panel **AI Usage** (`view.panel.usage`, `UsagePanel.tsx`; logic in `model.ts`, state in `state.ts`).

- **Overview**: the spend of the last 7, 30 or 90 days at API prices or in tokens, by day, project, machine and model, then a row per service; reread after `usage.costRefresh` and when `usage.prices` or a provider's switch changes.
- **A service**: per account its windows with reset countdown, even pace and projected run-out, and what each window has cost so far at API prices (`windowSpend`, from the quarters of an hour since its start); credits, balances, machines, and the service's spend.
- **Several accounts of a provider** are merged (`mergeProviderAccounts`): compared over a cycle they all share (5 h, 7 d, 30 d), weighted by plan tier (`estimatePlanWeight`), valued at the API price of the logged spend when the logs cover the cycle, plus explicit USD credits. Antigravity's unentitled third-party quotas at 100% are left out of the tightest window and the alerts.

The **status bar item** (`StatusItem.tsx`) shows the window that counts the coding agent in the focused pane: its service's tightest on its machine, or the window of the session's latest model (`tightestFor`). Settings: `usage.statusBar`, `usage.statusBarWindow`, `usage.statusBarProvider` (with no agent focused); warning color from the first of `usage.thresholds`.

The **session item** (`usage.session`, `SessionItem.tsx`, `session.ts`) shows the focused terminal's agent session: latest model, cost at API prices and context in use; nothing for a session the machine only guessed ([35](35-agent-native-view.md)), and no reads from a hidden page. A chat pane has its own item, `chat.usage` (`web/src/plugins/chat/UsageItem.tsx`, [37](37-agent-chats.md)).

### Alerts

With `usage.alerts` on, the hub (`alerts.ts`) fires after a poll for a window read in it: **threshold** (use reached one of `usage.thresholds`), **pace** (it runs out before its reset), **reset** (it started over after the first threshold). Each fires at most once per period of its window, recorded with the history so a restart does not repeat it, and re-arms only when the window really starts over, which absorbs use hovering at a threshold, drifting resets and machines answering in turn. Pages show new alerts as a toast, or a system notification while hidden (`notifications.system`), coordinated across a browser's tabs through storage and a Web Lock.

## Alternatives considered

- **Credentials copied to the hub**: tokens would leave their machines; the agents already run where the CLIs do.
- **Refreshing every CLI's expired tokens**: writing their files races the CLIs and can sign them out. Kimi Code is the exception (above).
- **Browser cookies**: reads another program's secrets.
- **Every machine asked for every account, or `agy` at every poll**: against the providers' rate limits, or seconds and hundreds of MB per run, for slow-changing numbers.
- **`sqlite3`, `opencode db` or a reader of our own**: often missing, a large runtime taking the database's locks, or new code to fuzz.
- **Reading only rows added since the last read**: tokens are written into existing rows.
- **Each page deciding alerts from its snapshots**: pages raced, re-fired on jitter and forgot on reload.

## Failure modes

- No internet: `network`; Codex falls back to its newest log, the others keep their last numbers.
- A provider changes its response: an unreadable answer is `bad_response`, the last numbers stay.
- Expired token: `stale` with `token_expired` and a hint to run the CLI; nothing is sent.
- 429: the account is skipped until its `Retry-After`.
- `agy` fails: `agy_failed`, last numbers stay, retried after a backoff.
- A redirect: not followed (`http_3xx`), so credentials reach only the fixed hosts.
- Unreadable log or database, or a machine offline: last numbers stay; the spend names the machine.
- macOS keychain over ssh: `security` cannot prompt; the provider counts as missing.
- Several accounts of a provider on one machine: the status item shows the tightest, not necessarily the agent's.

## Security

[SECURITY.md](../../SECURITY.md)'s AI usage rows are the threat model (credential files, hosts asked, the language server, Kimi Code's renewal, the DeepSeek key file, databases, transcripts); resources and retention: [deployment](../deployment.md#remote-resources).

Invariants: tokens are sent only to their provider's fixed host, never redirected, never returned to the hub; the only credential written is Kimi Code's, in place and under its lock, never by a `--read-only` hub; foreign databases are read by bounded, read-only code that never holds their writer up.

## Testing

- The hub: `backend/features/usage/usage.test.ts`, `alerts.test.ts`, `store.test.ts`, `hub.test.ts` (scheduling, merging, the cost cache, alerts across restarts, route guards).
- The machine side: `machine.test.ts` (the actions through the wire, no token in a reply) and `machine/*.test.ts`: providers against fake loopback servers and faked programs, Kimi's renewal byte for byte, the cache, real SQLite databases with damage and FIFOs, a session's numbers matching the spend's.
- `backend/scripts/pricecheck.test.ts`; `web/src/__tests__/usage.test.ts`, `usagePanelCost.test.tsx`, `usageSettings.test.ts`, `hoverOpen.test.ts`, `usageSession.test.tsx`.
- `e2e/tests/usage.spec.ts`: a log's cost in the panel, and OpenCode's database read by the compiled executable.
