# 29 AI usage

## Context

Coding agents run on several machines, signed in to subscriptions whose
limits are rate-limit windows (five hours, a week, a model's own), credits
and balances. Each CLI shows its own numbers in its own way, on the machine
it runs on; nothing shows them together, says which window runs out first
or whether its pace runs it out before the reset. CodexBar does this on one
Mac. Here the credentials are spread over machines, which reach the core
over ssh, and the same account is often signed in on several of them.

The CLIs' logs also record every response's tokens: at API prices they say
what a subscription is worth (the user's `ai-usage` report did this from a
script run over ssh).

## Goals / non-goals

- Every account the machines' CLIs are signed in to, once, with the
  machines it was seen on: its windows with their reset countdowns, pace and
  burndown, credits and balances, the provider's status page.
- Notifications when a window reaches a threshold, starts over, or its pace
  runs it out before its reset.
- The logs' cost by day, model, project and machine, with weekly and monthly
  equivalents.
- Credentials stay where they are: read only, never refreshed, never sent to
  the core.
- Non-goals (declined): importing browser cookies, hooks that run commands,
  refreshing OAuth tokens or writing the CLIs' files, spending Codex reset
  credits. Providers that need a browser session have no data source here.

## Design

### Machine side

`internal/usage` reads one machine; the agent's plugin
(`internal/agent/plugin/usage`) runs its actions:

- `limits {providers, codexHomes, claudeKeychain, skip, skipLocal}`: each
  provider in parallel, each request within 15 s through `HTTPS_PROXY`,
  following no redirect (a 3xx is `http_3xx`); a 429 returns
  `rate_limited` with its `Retry-After`. The answer is a list of accounts
  `{provider, id, email, plan, windows[{kind, label, usedPct, resetsAt,
  windowSec}], credits, balances, available, status, code, source, asOf}`;
  `status` is `ok`, `stale` (an expired token: run the CLI once to renew
  it; or numbers from a log), `unauth` (the provider refused the
  credentials), `error` (with `code`) or `missing`. An account the core
  names in `skip` (`provider:id`), or one without an id named in
  `skipLocal` (`provider`, or `provider:home` for a Codex home), is answered
  `skipped` without a request. The agent asks the providers through one
  HTTP client, so polls reuse its connections.
- `cost {since, tzOffset, codexHomes, providers}`: the logs' tokens and
  cost by day (the user's), provider, model and project. The scan stops
  between files when the request ends, keeping what it read.
- `setDeepseekKey {key}`: writes or removes the key file.

| Provider | Credentials | Asks | Account id |
| --- | --- | --- | --- |
| Claude | `~/.claude/.credentials.json` (`$CLAUDE_CONFIG_DIR`) `claudeAiOauth`; on macOS the keychain item `Claude Code-credentials` when the file has none (`usage.claudeKeychain`) | `GET api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`): `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` (`utilization`, `resets_at`), `extra_usage` (amounts in cents) | `~/.claude.json`'s `oauthAccount.accountUuid`, else `/api/oauth/profile` |
| Codex | `$CODEX_HOME` or `~/.codex/auth.json`, and each of `usage.codexHomes` | `GET chatgpt.com/backend-api/wham/usage` with `ChatGPT-Account-Id`: `rate_limit.primary_window`/`secondary_window`, `additional_rate_limits`, `credits`, `plan_type`. Without an answer (network) or with an expired token: the newest session log's `rate_limits` (read backwards from its end, and not again while the log is unchanged), as `stale` with `code: from_log` | `tokens.account_id`; email and plan from the id token's claims |
| Grok | `$GROK_HOME` or `~/.grok/auth.json`, x.ai's issuer first | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` (`X-XAI-Token-Auth: xai-grok-cli`): `creditUsagePercent` (else on-demand used over cap) for the period, `productUsage`; `/v1/settings` for the plan | `user_id` |
| Antigravity | none: the running language server | `/bin/ps` (else `ps` on the `PATH`) for the agent's user's own Antigravity `language_server` and its `--csrf_token`; its loopback ports (`/proc` on Linux, `/usr/sbin/lsof` on macOS); `POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus` (then HTTP, then an empty body; no connection is kept); without one, `agy -p /usage --output-format json` (20 s, in a process group of its own that is killed when it exits or times out), at most every 10 minutes (the polls in between get its last answer) and not again for 30 minutes after it failed: it takes seconds and a few hundred MB | a hash of the email; agy 1.5 names none, so the email comes from the end of agy's log, `~/.gemini/antigravity-cli/cli.log` (`authenticated successfully as …`), and the account merges with the language server's across machines |
| Kimi Code | `$KIMI_CODE_HOME` or `~/.kimi-code/credentials/kimi-code*.json` (its access token lasts about 15 minutes and Kimi Code renews it only while it runs, so numbers come from a machine where it ran lately) | `GET api.kimi.com/coding/v1/usages`: `usage` (weekly), `limits[]` (`window.duration` × `timeUnit`); numbers may be strings | the token's `user_id` (or `sub`) claim |
| DeepSeek | the key file the panel writes (the user's choice, first), `DEEPSEEK_API_KEY`, or Claude Code's `settings.json` when its `ANTHROPIC_BASE_URL` is DeepSeek's (`https` on `api.deepseek.com` or another host below `deepseek.com`; a gateway that only has deepseek in its name does not count) | `GET api.deepseek.com/user/balance`: `balance_infos`, `is_available` (no windows) | a hash of the key |

Tokens are read from the files at each poll, sent only to their provider's
host and never returned; expiry is checked first, so an expired token is not
even sent.

### Cost of the logs

The parsers follow the `ai-usage` report: Claude's
`projects/**/*.jsonl` (assistant messages' `usage`, 5-minute and 1-hour
cache writes apart, deduplicated by `(requestId, message.id)` keeping the
most output, `<synthetic>` left out); Codex's `sessions/**` and
`archived_sessions/**` rollouts (`token_usage_record` by `response_id`, the
model by `turn_id`; before the first of them the legacy `token_count`
events, an event whose total did not move being a replay); Grok's
`sessions/*/*/updates.jsonl` (`turn_completed`, by model, the tier by the
turn's average prompt) and the legacy `logs/unified.jsonl*` (also gzipped;
the model from the session's `events.jsonl`, retries only counted).
`internal/usage/pricing.json` has the prices by provider and the longest
model prefix, with tiers by prompt length and cache-write prices (5 minutes:
the input price unless given; 1 hour: twice it). A week is 168 hours and a
month 750 for the equivalents (cost × 168 or 750 / the range's hours).

The scanner keeps `usage/cost-cache.json` below the agent's data directory
(0600): per log its size, time, the offset after its last complete line,
its records, one per key (Claude logs a streamed response once per content
block), and for a Codex rollout the parser's state there (the last turn's
model, the project, the last legacy total). An unchanged log is not read
again; one that grew is read on from that offset when the byte before it
is still a newline (else from the start), and its last line counts once it
ends; gzipped logs are read whole. Claude's lines are decoded only when
they have both `"usage"` and `"assistant"` as JSON's own strings, so a
tool's long output is not. Logs and records older than 90 days leave the
cache. A scan that changed the cache writes it when the file is older than
5 minutes or the scan read at least 8 MiB of logs; otherwise the next scan
reads on from the file's offsets, which costs less than writing every
record again whenever a log in use grew a line. A long scan saves the cache
every 20 s, and one that is cancelled saves what it read, so the next one
goes on from there.

### Core

`internal/plugins/usage` is a `plugin.Starter`. Every 10 s it checks
whether a poll is due by `usage.refresh` (also chosen beside the panel's
Refresh): `manual`, every 1, 2, 5, 15, 30 or 60 minutes, or `adaptive`
(default), the shortest of these that applies, each a setting in whole
minutes: `usage.refreshOpen` (default 5, 1–60) while a panel is open in a
page that is shown (its `GET /api/p/usage?watch=1` every minute counts for
3; a hidden page sends none), `usage.refreshWorking` (default 10, 1–120)
while a coding
agent works in any terminal (the agent detection's events,
[25](25-agent-detection.md)), else `usage.refreshIdle` (default 30, 5–240). `POST /api/p/usage/refresh`
(and a new DeepSeek key) polls at once if the last poll is at least 30 s
old, else when it is: it answers 202 with `at`, when that poll runs, and
requests before then share it, so a client cannot make the machines ask
the providers more often than twice a minute. No poll runs, or counts as
the last one, while no machine is connected.

A poll asks the connected machines one after the other, the local one
first, with the accounts already fetched (and those waiting out a
`Retry-After`) in `skip`: an account signed in on several machines is asked
once and lists every machine it was seen on, keeping those whose poll
failed. An account without an id waiting out a `Retry-After` is in its own
machine's `skipLocal`. A machine that connects after a poll (the SSH ones
after the local one at start, or a reconnect) is asked at the next tick,
alone, with the accounts read within the cadence in `skip`, without moving
the cadence (not in `manual` mode). Accounts are keyed
`provider:id`; one without an id stays apart per machine. An answer without
numbers keeps the last good ones with the new status and code (the card
says how old they are). Per account the best answer of a poll counts,
whatever the order the machines answered in (numbers from the provider,
then numbers from a log, then an expired sign-in, a failed request, a
refused sign-in): a sign-in that expired on one machine does not hide the
numbers another machine read. The machines whose answer was not ok are the
account's `issues`, which its card lists by reason. Accounts no machine reported for 7 days are
forgotten; those of a provider turned off leave the snapshot at once.

The history (`usage-history[-<instance>].json` beside the settings, 0600)
keeps a point per window and poll when the use changed or 15 minutes
passed, only for numbers read in that poll (not those kept from an
earlier one), for 30 days, and the last accounts, shown again after a
restart. A window is told apart by its kind and label, and by its length
where two share them (Kimi's limits have no labels).
A window's pace compares its use with the share of its time gone, and
projects when it runs out at the rate of its history in this period (else
since the period began).

Every 10 minutes the core asks the status pages of the providers turned on
(Anthropic's and OpenAI's Statuspage summaries, Google's incident feed for
Antigravity's product); x.ai's and DeepSeek's pages are links. A page that
does not answer keeps what it said last.

Each poll's result goes to every page as `/ws` `plugin {plugin: "usage",
data: snapshot}`; `GET /api/p/usage` returns the same snapshot.
`GET /api/p/usage/cost?days=&tz=` asks the machines in parallel (2 min each)
and is served again for a minute; the reports of the last 4 ranges are
kept. A machine scans one range at a time: requests for the range being
scanned share that scan, others wait for it.

On a core on Windows no agent runs on the local machine, so its CLIs are
not read; SSH machines are.

### Web UI

`web/src/plugins/usage`: the panel **AI Usage** (command
`view.panel.usage`, no default key) is laid out as CodexBar.

- **Tiles** at the top: the overview and each service with an account or
  spend (in the order Claude, Codex, Grok, Antigravity, Kimi, DeepSeek):
  its mark and name and, in its color, a bar of what is left of its
  tightest window. The marks are Lobe Icons' (`web/src/assets/ai-logos`,
  MIT, drawn in one color, `logos.tsx`); each service's color is its own
  where it has one (Claude's clay, DeepSeek's blue), else a hue that keeps
  the services apart (`--usage-<provider>`, `usage.css`, darker in the
  light theme). Under the tiles: when the numbers were read and the next
  read, the switch between used and left, and Refresh (which also reads
  the cost again; so does showing the panel when the cost is older than 15
  minutes). The tile shown and the switch are kept per browser. A snapshot
  older than the one shown is ignored.
- **Overview**: the spend of the last 7, 30 or 90 days at API prices (a
  large total, tokens, the weekly and monthly equivalents), bars per day
  stacked in the services' colors (plain SVG) with a legend of each
  service's total, a ranking by model, project or machine, models without
  prices and machines whose logs could not be read; then a row per
  account, the tightest window first: its mark, plan, tightest window, its
  reset and a small bar; a click shows its service. While DeepSeek is
  turned on and no machine has its key, a link opens its page, which has
  the key form.
- **A service**: a card per account: its mark, email, plan, when it was
  read; its status page's incident and what to do about a status other
  than ok; its windows grouped by the group of models they count (a
  labelled session or weekly window, as Antigravity's groups; the
  unlabelled first; in a group the session before the week), each with its
  name (a session of whole hours says how long: 5 hours), the share used or
  left, the reset countdown and a bar in the service's color (the warning
  and error colors from the first threshold and when out) with quarter
  marks and the even pace's mark once the window is under way, then how far
  ahead of an even pace it is and when it runs out at this pace before the
  reset; credits and balances; the machines it was seen on. A window whose
  reset has passed since it was read says so, dimmed, and is left out of
  the tightest window and the alerts until the next poll. Then the
  service's own spend (today, 30 days, tokens today and in 30 days, its
  daily bars, its most used model) and, for DeepSeek, the form that
  writes a key file on a machine.

The status bar shows the tightest window's percentage, in the warning color
from the first of `usage.thresholds` (default 80 and 95); a click shows the
panel. A snapshot that takes a window over a threshold notifies once per
period (again after it fell below, or in a new period no page saw
start), as does a window that started over after reaching
the first threshold and one whose pace runs it out before its reset (once
per period): a toast, or a system notification while the page is in the
background with `notifications.system` on. What was notified is kept in the
browser's storage, so a reload or another tab does not repeat it.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Fetching from the core with credentials copied there | Tokens would leave their machines; the agents already run where the CLIs do. |
| A window's name as "group · kind" in one line | In a narrow panel two windows of a group (Antigravity's weekly and 5-hour) were cut to the same text with different numbers; a heading per group and the kind on each row keep them apart. |
| A burndown line per window | Drawn over the whole period, the few hours read so far were a stray dash; the even pace's mark and how far ahead of it the window is say the same at a glance. |
| Refreshing expired OAuth tokens | Writing the CLIs' credential files races the CLIs and can sign them out; running the CLI once renews them. |
| Browser cookies for providers without a CLI token | Reads another program's secrets; declined. |
| Running `agy` at every poll | Each run takes seconds and a few hundred MB, at every poll on every machine with `agy` while a panel is open; its numbers change slowly, so one run per 10 minutes serves the polls between. |
| Writing the cost cache after every scan that changed it | A log in use grows at every scan, and the cache (tens of thousands of records) was written whole each time; reading on from the file's older offsets costs a few minutes of lines. |
| Every machine asked for every account | The same account would be asked once per machine at every poll, against the providers' rate limits. |
| A chart library for the bars and burndown | A few SVG paths and rectangles; no dependency. |

## Failure modes

- No internet on a machine: its requests fail with `network`; Codex falls
  back to its newest log, the others show their last numbers with the
  code.
- A provider changes its response: fields the parser does not find are left
  out, an unreadable answer is `bad_response`, the last numbers stay.
- An expired token: `stale` with `token_expired` and the hint to run the
  CLI; nothing is sent.
- 429: the account is skipped until its `Retry-After` (at most a day), also
  one without an id, on its machine.
- `agy` fails or times out (20 s): `agy_failed` (or `bad_response`), the
  last numbers stay, and it is not run again for 30 minutes.
- A redirect: not followed; `http_3xx`, so credentials reach only the
  fixed hosts.
- A machine offline: its poll fails with `offline`; its accounts keep their
  numbers and machines until another poll sees them.
- macOS keychain over ssh: `security` cannot ask, the provider counts as
  missing.

## Security

[SECURITY.md](../../SECURITY.md) lists the credential files read, the hosts
asked, the language server's loopback client, the DeepSeek key file and the
status pages. Resources and retention:
[deployment](../deployment.md#remote-resources).

## Testing

- `internal/usage/usage_test.go`: each provider against an `httptest`
  server or fixture files: headers, windows, credits, expired tokens (not
  sent), 401, 429 with `Retry-After`, Kimi's string numbers, Codex's log
  fallback, the keychain, Antigravity's `ps` (other users' servers left
  out), `lsof`, `/proc` and `agy` paths, the loopback client, the key
  file's modes, no token in a reply, redirects not followed, a lookalike
  DeepSeek gateway, `skipLocal`.
- `internal/usage/resources_test.go`: the language server's client
  leaves no connection open, the agent's polls share one client, `agy` at
  most every 10 minutes and backed off after a failure, agy's account
  from its log, Antigravity's
  `skip` and `skipLocal`, the Codex log read backwards across long lines
  and once while unchanged.
- `internal/usage/proc_unix_test.go`: a fake `agy` leaving `sleep 300`
  behind; its process group is killed after it exits and when it times
  out.
- `internal/usage/cost_test.go`: the logs' dedupe rules, tiers and cache
  writes, the user's days, the incremental cache and its retention, one
  record per response in the cache (an older cache's duplicates dropped),
  Codex and Grok logs read on from their offsets (a rewritten one from
  the start, an unfinished line once it ends), the cache written seldom,
  a cancelled scan keeping its progress.
- `internal/agent/plugin/usage/usage_test.go`: the actions and their codes.
- `internal/plugins/usage/usage_test.go`: cadence, dedupe across machines,
  last good numbers, `Retry-After` (also without an id), the manual
  refresh's minimum gap on a fake clock, history and pace, status pages,
  the cost report, shared scans and its cache, settings, a machine that
  connects later asked alone, no poll without machines, machines kept
  when their poll fails, no history from kept numbers, a provider turned
  off hidden, windows' ids, the adaptive cadences as settings, the best
  answer of a poll winning with the others as issues.
- `internal/usage/cost_test.go` (`TestPricingTiers`): tier limits
  inclusive, the current Claude models' prices.
- `web/src/__tests__/usage.test.ts`: ordering, alerts (again in a new
  period, not for a reset time that moves a little, none for a window past
  its reset), the cost sums, windows grouped by their models, the panel
  (tiles, the overview's rows and spend, a service's cards, its spend,
  used or left) and the status bar item against a stubbed core, the panel
  with ready machines in the store (no render loop), no `watch` from a
  hidden page, DeepSeek's key form without an account, an older snapshot
  ignored, the machines that could not read an account, the interval
  picker.
- `internal/server`: `TestMutatingRoutesAreGuarded` covers the plugin's
  routes.
