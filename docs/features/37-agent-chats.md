# 37 · Agent chats

## Context

Coding agents run in the machines' terminals ([21](21-terminal-core.md)),
where the page knows which agent runs ([25](25-agent-detection.md)) and
which session it is in ([35](35-agent-native-view.md)). Reading a
program's screen and files cannot stream its text, answer its permission
prompts outside the terminal or confirm a message before the turn ends.

The agents have protocols of their own for running headless: Claude Code
the Agent SDK's (stream-json and control requests on stdio), Codex its
app-server (JSON-RPC on stdio), Kimi Code and Grok the Agent Client
Protocol (ACP). Through them a client starts and resumes sessions,
streams text, answers permissions, questions and plans, sets model,
effort and mode, compacts, sends images and reads usage and limits. A
chat is such a session, run by a process of the product's own on the
machine and drawn by the page.

Constraints: an agent runs where its files are, as the user, with the
user's sign-in; nothing listens on TCP on machines; whatever is started
has an owner and an end, whatever is written a bound
([10](10-remote-resource-lifecycle.md)); a session survives the page, the
core, ssh and the agent going away; the Claude protocol is unspecified
and Codex's app-server experimental, so both are pinned to recorded
versions.

## Goals / non-goals

Goals: chats with Claude Code, Codex, Kimi Code and Grok in panes on any
machine; streaming text and thoughts; permissions, questions and plans in
cards; model, effort and mode per chat, full access only where the
machine allows it; compacting, images, `@` files, queued messages;
usage, context and limits; subagents under the call that started them;
the same notifications and attention list as agents in terminals
([07](07-agent-native-workflow.md)); sessions moved between terminals
and chats; chats that outlive page, core and terminal core within bounds
set per machine.

Non-goals: agents that need a terminal; OpenCode (`opencode acp` listens
on an unauthenticated TCP port); editing the agents' configuration;
keeping a pending permission across a host restart (the turn ends);
subagents' conversations as chats.

## Design

```
page (chat pane) ──WebSocket──▶ core (plugin chat) ──yamux──▶ agent (plugin chat, action open)
  one per page                   relay, read-only, audit,        │ a stream per connection
                                 watch → /ws and notifications   ▼
                                                             <run>/chat.sock
                                                             chat host (`chat-host`, a hidden terminal
                                                             of the instance's terminal core)
                                                             ├─ journal: chat-<host>.db
                                                             └─ adapters: claude │ codex │ acp
                                                                  └─ one agent process per live chat
```

### Agent kinds with chats

A kind of `internal/agentkinds` has a chat when its row has a `Chat`
spec: the adapter, the command, added environment and, for ACP, the
`_meta` of `session/new`. Only the adapter's name reaches the page; the
command is looked up on the machine in the login shell's PATH.

| Kind | Adapter | Command |
| --- | --- | --- |
| `claude` | `claude` | `claude` and the SDK's arguments |
| `codex` | `codex` | `codex app-server --listen stdio://` |
| `kimi` | `acp` | `kimi acp` |
| `grok` | `acp` | `grok agent --no-leader stdio`, sessions made with `{"yoloMode": false}` |

### The chat host (`internal/chathost`, `backend/features/chat/machine/host`)

`chat-host --base <data dir> --run <run dir>` (the namespace's runtime
directory on the host, [40](40-shared-homes.md); the Go machine build's
`cmd/veldr/chathost_unix.go`, the TypeScript one's below; Linux and macOS
only) is the long-lived
process that runs the agents and keeps their conversations. It serves
`chat.sock` (0600) in the run directory (0700) under a lock; a second
host exits. It runs as a **hidden terminal** of the instance's terminal
core, so ssh, the agent and the core may come and go while it runs. It
ends after 60 s with no agent and no connection, when asked to make way
for a newer build (refused while a chat is busy), or with the terminal
core's stop (agents' process groups get SIGTERM, then SIGKILL); a host
not gone 30 s after it began to stop kills its agents and exits. Chats
stay in the journal and resume their sessions at the next prompt.

The terminal core does not read shell startup files, where agents'
programs are usually put on the PATH. So the host takes the environment
of an interactive login shell (`$SHELL -l -i -c env`, 10 s, 1 MiB),
cached 6 hours or until a startup file changes. Agents get it without
the host terminal's, ssh's and other agent sessions' variables, with
`PWD` the chat's directory; `HC_SESSION`, `HC_SOCKET` and `HC_SCOPE` stay
so the terminal core's crash sweep finds them. The host logs to
`chat-host-<host>.log` (0600, rotated at 1 MiB once).

The TypeScript machine build has the same host: the `chat-host` command
of its executable (`backend/hosts/machine/chathost.ts`), with the same
socket, lock, wire, journal tables and log, so a host of either build
takes over from the other with its chats. Its journal's statements run in
a worker thread, and a chat's events reach its clients once they are
stored, in the order made ([42](42-typescript-backend.md#the-chat-host)).

### Starting the host, and handover (`internal/agent/plugin/chat`, `backend/features/chat/machine.ts`)

The machine side has one action, `open`: a stream the core opens, joined
to the host's socket. When no host serves, the agent has the terminal
core run one (`plugin.Env.RunHidden`) with a minimal environment, named
`veldr-chat-host` and labeled `veldr.hidden=chat-host`. If a
user's own terminal holds that name, it is left alone and a fallback name
(`-1`..`-16`, `agentproto.IsChatHostName`) is used. The open waits up to
15 s; a name held by a host that serves nothing for that long plus 30 s
is killed (only when it carries the label and matching arguments) and
replaced.

A host of an older build (by `git describe`) is asked to make way when
idle, and the chats resume in its successor. A newer host, one of the
same commit (dirty builds carry a timestamp but compare by commit) or of
unknown age is used while it speaks this protocol, so two cores of
different builds do not keep replacing each other; one that speaks
another protocol fails the open with `upgrading` (503) until idle. The
core's watch opens with `start: false` and never starts or replaces a
host. Other errors: `no_terminal_core` (503), `start_failed`.

### Hidden terminals

A product helper's terminal is hidden when it has both the reserved name
and the label (`agentproto.Hidden`); labels are free-form, so a label
alone hides nothing, and clients may take neither. Every walker of the
terminal core's terminals uses that rule: the terminal protocol leaves it
out of snapshots, events and lists, refuses to set the label or take the
name, and answers calls naming it as for a missing terminal (audited
`denied.term`, `reason: hidden`, [22](22-terminal-protocol.md)); agent
detection does not watch it ([25](25-agent-detection.md)); terminal
history does not capture it ([36](36-terminal-history.md)).

### Chats

A chat (`c` + 16 hex digits) is one agent session in one directory. Its
state is `starting`, `idle`, `working`, `waiting`, `sleeping` (no agent
process), `failed` (with the end of the agent's stderr, in memory only)
or `closed`; its status, for dots and notifications, is the terminal
vocabulary `working`, `blocked`, `done`, `idle`.

- **Agent process.** Runs while used: idle for `chat.idleStopMinutes`
  (30) it ends and the chat sleeps; past `chat.maxLive` (8) the longest
  idle one ends. A prompt to a sleeping chat resumes the session (Claude
  `--resume`, Codex `thread/resume`, ACP `session/resume` or
  `session/load`); a session that never had a turn starts anew. Close
  ends the agent; archive also marks the chat seen and archived (removed
  first by the bounds); a prompt or unarchive brings it back; delete
  forgets it at once (the agent's session files stay).
- **Prompts.** ACP content blocks (text, images ≤ 5 MiB, `resource_link`
  for `@` files), ≤ 8 MiB. While a turn runs, a prompt is queued or
  steered into the turn where the agent can, reported by `queued` events.
  A prompt carries the page's `clientId`; a resend of one of the last 256
  is not sent twice. The first prompt names the chat until the agent's
  own title arrives, unless the user renamed it.
- **Permissions and questions.** The adapter asks the host, which stores
  a `permission` or `question` event; the first answer of any client wins
  (later ones get `not_found`). Secret answers are masked everywhere but
  to the agent. For Claude Code and Codex the host offers `allow_once`,
  `allow_session` (no setting written) and `reject_once`; ACP agents'
  own options are offered except those that allow or reject for good.
- **Plans.** In plan mode the plan is a permission of kind `plan` with
  options `plan:<mode>` (approve and continue in `default` or
  `acceptEdits`) and `reject_once`.
- **Modes and full access.** `default`, `acceptEdits`, `plan`, `full`; a
  new chat starts in `chat.permissionMode`. Full access needs
  `chat.allowFullAccess` (per machine, off by default). Adapters mark
  which mode values grant it (for ACP every mode not known to ask); the
  host refuses them (`not_allowed`), starts such chats in `default`, sets
  back an agent that switches itself, and starts with full access off
  until the core sends the machine's settings. A mode the agent changes
  to itself becomes the chat's mode.
- **Trusted folders.** An agent loads a project's own settings (hooks,
  MCP servers) only in a folder it trusts itself (Claude Code's
  `~/.claude.json`, read only) or the user trusted through the host;
  elsewhere it starts without them and the chat shows `untrusted_folder`
  with **Trust This Folder**. The host refuses `/`, the home and its
  ancestors, and folders others may change (`unsafe_folder`), pins the
  device and inode, and keeps at most 1000.
- **Model, effort, compacting, usage.** Set through the protocol, never by
  a slash command that saves them, and reapplied on restart. `compact`
  maps to Claude's `/compact` and Codex's `thread/compact/start`. Context,
  cost and limit windows come from each protocol's usage messages.
- **Subagents.** Their events carry `parent`, the tool call that started
  them; their permissions are the chat's.

### The protocol (`internal/chatproto`, version 2)

JSON lines (≤ 16 MiB) on the socket: the host's hello, then one request
per connection, except `attach` and `watch`, which stay open. Agents are
named by kind, never by command.

| Request | Answer |
| --- | --- |
| `agents {kinds}` | Availability and version per kind. |
| `chats` | Every chat, latest first. |
| `new {kind, cwd, resume?, import?, options?}` | The chat, `starting`. |
| `attach {chat, from, noCatchUp?}` | The chat, its first kept sequence number, stored events after `from`, then new ones. |
| `close`, `archive`, `unarchive`, `delete {chat}` | – |
| `sessions {kind, cwd, cursor}` | A page of the agent's sessions for the directory. |
| `watch` | Every chat's state, then each change. |
| `seen {chat, seq}` | – |
| `configure {settings}` | – (the machine's settings) |
| `shutdown` | – (`busy` while a chat is busy) |
| `trust`, `untrust {cwd}`, `trusted` | – / the trusted folders |
| `host_status` | Version, pid, connections, live agents, sizes, settings. |

An attached connection sends commands answered by `ack`: `prompt`,
`cancel`, `permission`, `answer`, `set_config`, `cancel_queued`,
`compact`, `rename`, `handoff`.

**Stored and live events.** A stored event has a sequence number and
stays in the journal. A live event is an increment of an item being
streamed (text, thought, tool output): unnumbered, sent only to attached
connections, never stored. When the item completes, one stored event with
its whole state replaces the increments, so a client that reattaches
from its last sequence number drops partial items and gets them whole.
Agents' stderr rides only on live events. Errors are codes the page
translates.

### The journal

`chat-<host>.db` in the data directory, the host's own SQLite database
([38](38-sqlite-state.md)): chats, their stored events, trusted folders
and settings.

| Bound | Setting | Default | Range |
| --- | --- | --- | --- |
| Bytes of a chat's events | `chat.maxChatMB` | 64 MB | 8–256 |
| Bytes of all events | `chat.maxTotalMB` | 512 MB | 64–2048 |
| Chats kept | `chat.maxChats` | 500 | 50–2000 |
| Days a closed chat is kept | `chat.retentionDays` | 30 | 1–365 |
| One stored event | – | 1 MiB | – |

A chat over its bytes loses its oldest events; past the other bounds
closed chats go, archived ones first, oldest first; a new chat with
nothing left to remove is refused (`too_many`). Oversized events are cut.
An event the journal refuses fails the chat, so a log never has a gap. A
newer host's journal is not used; other hosts' journals on a shared home
unopened for 30 days are removed.

### Adapters (`internal/chatadapter`)

The host owns chats, logs, clients, bounds and process decisions; an
adapter owns one agent process and turns its protocol into events. The
package comment states the rules: argv and environment as given;
unserved requests answered "method not found"; unknown members passed
over; the user's configuration never written; the agent in its own
process group, ended gracefully before SIGKILL; output never blocked;
increments live, complete items stored; a prompt recorded once;
full-access values marked; a session another process runs neither
resumed nor imported (`in_terminal`).

- **Claude Code** (`claude/`): the Agent SDK protocol in Go, after the
  TypeScript SDK's types and recordings of Claude Code 2.1.330. Full
  access needs `--allow-dangerously-skip-permissions`, so switching to it
  restarts the program on the same session. `CLAUDE_CODE_ENTRYPOINT`
  marks its sessions as the SDK's. `can_use_tool`, `AskUserQuestion` and
  `ExitPlanMode` become permission, question and plan; tool results are
  mapped by `internal/agent/transcript`. A session with a live
  `<claude dir>/sessions/<pid>.json` record is `in_terminal`. Sessions
  and imports read `~/.claude/projects`.
- **Codex** (`codex/`): `codex app-server`, protocol v2, one per live
  chat; the schema relied on is pinned in
  `spec/codex-app-server/summary.json` (`TestSchemaPinned`), made of
  Codex's own schema of the version pinned, which `spec/codex-app-server`
  keeps. A thread started writable records its directory in
  `~/.codex/config.toml`, so threads start read-only and each turn carries
  the mode as policy:

  | Mode | Approval policy | Sandbox | Collaboration mode |
  | --- | --- | --- | --- |
  | `default` | `untrusted` | `workspaceWrite` of the directory | default |
  | `acceptEdits` | `on-request` | `workspaceWrite` of the directory | default |
  | `plan` | `on-request` | `readOnly` | `plan` |
  | `full` | `never` | `dangerFullAccess` | default |

  (`default` is `untrusted` because under `on-request` the model refuses
  to write instead of asking.) Approvals never map to the amendments
  Codex saves. A command still running 2 s after an interrupt has the
  app-server restarted. Close closes stdin before SIGTERM: Codex killed
  outright leaves its shell snapshots.
- **ACP** (`acp/`, on `internal/acp`): Kimi Code and Grok. No file system
  or terminal capability is offered. One turn per prompt; prompts during
  a turn wait in the adapter. Sessions and imports run a short agent
  process (`session/list`, `session/load`, whose replay is lossy). An ACP
  agent cannot tell that a terminal runs a session.
- **ACP in the TypeScript build** (`backend/features/chat/machine/acp`, on
  `@agentclientprotocol/sdk`): the same behaviour. Every request of the
  agent but a permission is answered "method not found"; prompts during a
  turn wait in the adapter (at most 16); permissions offer the agent's
  `allow_once` and `reject_once` options only, at most 64 waiting. Its
  tests replay `spec/vectors/chat/acp` through a fake agent and compare the
  events with the Go adapter's of the same scenarios.
- **Codex in the TypeScript build** (`backend/features/chat/machine/codex`):
  the same behaviour, its policies, approvals, plans, steering, queue,
  interrupt and restart, compaction, usage and limits, sessions and
  imports. It is written against TypeScript types generated from the JSON
  schema Codex prints (`appserver.gen.ts`, by
  `backend/scripts/codex-schema.ts` from `spec/codex-app-server`, which
  `make check` holds them to), in place of the Go adapter's pinned
  summary: the typecheck holds the adapter to the protocol, and its tests
  validate the recordings and what it sends against the schema itself.
  Its framing is its own (no `jsonrpc` member, as Codex writes it; a line
  over 16 MiB passed over), every message handed on in the order of the
  app-server's output. What it keeps of the tool calls that started and
  did not complete and of the subagents' threads is bounded (4096 each,
  the oldest going: such a call is then not marked cancelled at its
  turn's end, and such a thread is its own parent). Its tests replay
  `spec/vectors/chat/codex` through a fake app-server and compare the
  events with the Go adapter's golden files of the same recordings.
- **Claude Code in the TypeScript build** (`backend/features/chat/machine/claude`,
  on `@anthropic-ai/claude-agent-sdk`): the same behaviour, the protocol
  spoken by Anthropic's Agent SDK rather than by hand
  ([42](42-typescript-backend.md#claude-code)), the program run through
  the host's processes, the user's own `claude`. Where it differs: a
  permission the program cancelled (an interrupt) is answered with a
  denial, as the SDK answers every request it hands on, where the Go
  adapter sent nothing; a mode set is the one asked for, the SDK passing
  on no answer of the program's; lines that are no JSON objects and
  `keep_alive` the SDK drops itself. Its tests replay
  `spec/vectors/chat/claude` through the SDK against a fake Claude Code
  and compare what the host gets with the Go adapter's golden files of the
  same recordings. The SDK is Anthropic's, all rights reserved, so no
  executable carries it: a machine gets the pinned npm tarball when a
  Claude Code chat needs it, downloading it itself or from the core,
  checked against the pinned integrity, into
  `<data>/claude-agent-sdk/<version>`, which the chat host loads; a
  machine that cannot refuses the chat with `sdk_unavailable`
  ([42](42-typescript-backend.md#claude-code)).

In the TypeScript build the seam is `backend/features/chat/machine/adapter.ts`,
whose comment states the same rules for one thread:

- `Adapter`: `start(p, sink, signal)` resolves with a `Session` once the
  session exists (`signal` bounds the start only), `sessions(p, signal)`
  a page of the agent's sessions, `history(p, emit, signal)` an import's
  or a catch-up's stored events, and, where the adapter can tell,
  `inTerminal(p, signal)` the `in_terminal` error of a session another
  process runs. Every call gets the kind, the resolved command, the whole
  environment, the directory, the logger and `procs`, the host's
  `AgentProcesses`, through which every program is started (a process
  group of its own, ended gracefully; the host signals the groups when it
  stops).
- `Session`: `id`, `pid` (its group's), `prompt`, `cancel`,
  `cancelQueued`, `setConfig`, `compact`, `close` (graceful), and `done`,
  which settles once the agent is gone and the sink had every event, with
  why it ended.
- `Sink`: `event` (stored or live, returns at once), `update` (what the
  chat states), and `permission` and `question`, promises the user's
  answer settles (or the turn's cancel, or the chat's end). An adapter may
  call the sink from within its own methods; the host calls a session's
  methods only where its own state is settled.

The host gets its adapters by name from its composition root
(`backend/hosts/machine/features.ts` `chatAdapters`): an adapter is added
there, the host unchanged. A kind whose adapter the host was not given is
refused as a kind without a chat (`unsupported`, "this host has no
adapter <name>"). The TypeScript build's host is given all three: the ACP
adapter, Codex's and Claude Code's (its Agent SDK fetched on use,
[42](42-typescript-backend.md#claude-code)).

### The core's plugin (`backend/features/chat`)

**Routes** below `/api/m/{id}/p/chat/` and `/api/p/chat/`
([reference](../reference.md#http-and-websocket-endpoints)). A GET never
starts a host; a read-only core starts nothing, refuses `GET agents` and
lists no sessions (both may run the agents' programs). Every change is
audited as `chat.<route>`. Before a request that may start an agent the
core sends the host the machine's settings. A machine has at most 128
core connections to its host.

**The page's WebSocket** (`wire.ts`, `page.ts`; mirrored by
`web/src/plugins/chat/protocol.ts`): one per page for every chat (browsers
allow six HTTP/1.1 connections per origin). Each subscription is its own
connection to the host; commands go on a subscription and get one `ack`
each (`lost` when the subscription ended first). Flow control bounds
what waits for a page; a subscription that falls too far behind is
dropped by the host and reattached, without stalling the page's other
chats. A read-only core refuses commands and omits agents' stderr.
Commands that change what an agent may do are audited (never a prompt's
text or an answer's).

**Watch and notifications** (`watch.ts`): while a machine's host is in
use, the core watches it without starting one, sends the states to pages
as the plugin's `/ws` message `states` (with the host's build and
`outdated`), and publishes an agent event when a chat becomes blocked or
done. When a machine disconnects its cached states become
sleeping/idle with `stale: true`; a state read before the machine left
never revives them (`a change after the machine left is dropped`).

### The page (`web/src/plugins/chat`, `web/src/conversation`)

- **The pane**: a layout leaf `{view: {plugin: chat, kind: chat, chat,
  agent}}`, drawn by the conversation view from a `ChatSource`. Markdown
  with tables, code and KaTeX (also `\[…\]` and `\(…\)`,
  `conversation/format.ts`); cards answer permissions, questions and
  plans; the composer sends on Enter, takes pasted or dropped images,
  `@` files and `/` commands, offers model, effort and mode selectors
  (full access shown unavailable where not allowed), and shows cost,
  context and the tightest limit. Menu: Rename, **Continue in Terminal**,
  Close, Delete.
- **New chats** from the new-tab menu, the command `chat.new` and the
  Chats panel, in the focused pane's directory.
- **The Chats panel** (right sidebar): the machine's chats by urgency,
  archived ones folded below, the agents' earlier sessions of the
  directory, and a link to the Agent Chats page in Settings (hosts,
  sessions and trusted folders per machine).
- **A host of another build** (`hostReminder.ts`): the panel, and a toast
  once idle, offer **Restart Chat Host** (`POST host/stop`, then
  `POST agents`).
- **Statuses** (`status.ts`, [27](27-plugins.md)): chats count in the
  attention inbox, badge and notifications as terminal agents do, also
  without an open pane; seeing a done chat posts `seen`.
- **Usage in the status bar**: `chat.usage` ([29](29-ai-usage.md)).
- **The connection** (`connection.ts`) reconnects with backoff and
  reattaches from each chat's last stored event; an unanswered prompt is
  shown pending and may be resent safely under its `clientId`.

### Importing a session, and continuing in a terminal

- **Import.** The Chats panel lists the sessions each agent kept for the
  directory; opening one makes a chat that resumes the session with its
  earlier conversation imported first (`new` with `resume` and `import`)
  and the agent's title. A session that already is a chat opens that
  chat. A terminal whose agent quit offers **Continue in Chat** in its
  header ([33](33-workspace-restore.md)). Two processes never write one
  session: the page refuses one a terminal's agent runs, the host one
  another process runs (`in_terminal`).
- **Handoff.** **Continue in Terminal** (Claude Code, Codex; no turn
  running) ends the chat's agent, marks the chat handed off, and opens a
  terminal tab in its directory that resumes the session by the kind's
  command, as a restore does ([33](33-workspace-restore.md)). A terminal
  already running the session is shown instead.
- **Catch-up.** When a handed-off chat is used again, the host first
  imports what the session did in the terminal since the last imported
  item, never twice.

### After the terminal core starts again

A terminal core stop ends the host and its agents. The next use starts a
host that reads the journal: chats whose agent ran sleep, their turn
ended in an error and pending requests cancelled. Panes reattach; the
next prompt resumes the session with its context.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The conversation drawn over the agent's terminal (the earlier version of 35) | Input pasted into a program, confirmation a turn late, permissions only in the terminal, no streaming. |
| ACP for every agent | Claude Code and Codex speak it only through third-party adapters, without their permissions, plans, questions, effort, usage and limits. |
| The Agent SDK in Node as a sidecar | A Node runtime per machine (often offline); the protocol is small enough to speak from Go, pinned and recorded. |
| `character-ai/claude-agent-sdk-go` | One-shot `claude --print` without control requests: no permissions, questions, plans, model changes, interrupts or queues. |
| The host as a child of the agent | It would die with every ssh drop and core restart; as a terminal of the terminal core it lives as the user's programs do. |
| A socket or port the core reaches directly | Nothing listens on TCP on machines; the agent's stream suffices. |
| JSONL files per chat | Bounds and eviction would need their own crash-safe rewriting; SQLite gives transactions ([38](38-sqlite-state.md)). |
| Storing live increments | Every token in the log; a reattach gets the whole item instead. |
| OpenCode through ACP | It listens on a TCP port without authentication. |

## Failure modes

- **No terminal core** → `no_terminal_core` (503).
- **Host not up in 15 s** → `start_failed`; a stuck host holding the name
  is killed and replaced.
- **A host of another build** → used while it speaks this protocol, else
  `upgrading` (503) until idle; the page offers a restart.
- **Agent not installed or not signed in** → `not_found` in the agents
  list; `auth_required` (the page suggests running it once in a terminal).
- **The agent exits or breaks protocol** → the chat fails with its stderr
  tail; the next prompt starts it again.
- **A resumed session the agent no longer has** → `not_found`.
- **The page falls behind or loses the connection** → reattach from the
  last sequence number; a resent prompt is taken once.
- **The journal refuses a write** → the chat fails, without a gap.
- **Pending permissions when the host ends** → cancelled, the turn ends in
  an error.
- **Two cores of one instance** → one host serves both; the last
  configure's settings apply.
- **Unused chats** → the watch lets go after 2 minutes, agents stop after
  `chat.idleStopMinutes`, the host exits a minute later.

## Security

Chats run agents as the user on the machine, as terminals do. New is a
long-lived product process running agents without a terminal. It is
reached only through the run directory (0700, socket 0600) and the
agent's stream; pages reach it only through the core's guarded routes
and WebSocket, whose inputs (kinds, chat ids, clean absolute directories,
session ids, option values) are checked on the core and again by the
host. What runs is the registry's command; no command line, path or
variable comes from a client. Full access is off unless the machine
allows it, also after a restart; project settings load only in trusted
folders no one else can change. Secret answers and stderr are never
stored; stderr reaches writable clients only. The hidden terminal is no
client's. See the agent-chat rows in [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/chatproto`, `internal/chatadapter`: wire, statuses, ids,
  clamping, rule types.
- `internal/chathost`: requests, the login environment, turns, prompts
  recorded once and resent (`TestPromptRecorded`, `TestPromptSentAgain`),
  permissions, idle stop and resume, handoff and catch-up
  (`TestHandoffAndCatchUp`, `TestCatchUpImportsOnce`), archive
  (`TestArchive`), trust, full access, the journal and its bounds
  (`journal_test.go`, `TestBoundsRemoveArchivedFirst`), signals
  (`signal_test.go`).
- Adapters against fake agents replaying the recordings in
  `spec/vectors/chat/` (its README names the versions):
  `internal/chatadapter/claude` (`TestReplay`, full access by restart,
  `in_terminal`), `internal/chatadapter/codex` (`TestSchemaPinned`,
  policies per mode, close order), `internal/chatadapter/acp`,
  `internal/acp`.
- `internal/agent/plugin/chat`: start, name taken, handover
  (`TestDirtyBuildKept`), a stuck host killed; `internal/agent`
  `hidden_test.go`.
- The TypeScript host (`backend/features/chat/machine/host`):
  `host.test.ts` (requests and refusals, turns, prompts sent again,
  queues, permissions, questions, failures, close, delete, archive, watch,
  shutdown, recovery, idle stop and resume, `maxLive`, handoff and
  catch-up, import, sessions, configuration, replay, slow subscribers,
  bounds, cut events, trust, full access, `an event the journal refuses`),
  `units.test.ts` (the environment, trust, events, the log, the terminal
  core's signals in a host of its own process); its open action
  (`backend/features/chat/machine.test.ts`: start, hosts of other builds
  and protocols, a stuck host killed); the agents' processes
  (`agentproc.test.ts`); the ACP adapter (`acp/*.test.ts`); the Codex
  adapter (`codex/*.test.ts`: the recordings replayed against the Go
  adapter's golden files, the server's requests answered or refused,
  lines passed over, close order, leftovers, queues, plans, configuration,
  sign-in, `in_terminal`, sessions and history, the recordings and what
  it sends validated against Codex's schema); Claude Code's adapter
  (`claude/*.test.ts`: `replay.test.ts` the recordings against the Go
  golden files, `session.test.ts` full access by restart, `in_terminal`,
  the program's end, `history.test.ts`, `sdk.test.ts` the SDK's
  undeclared `cancelAsyncMessage`, `installed.test.ts` the SDK loaded
  from a data directory, also by a compiled executable); the Agent SDK's
  way to the machines (`sdkstore.test.ts`,
  `backend/features/chat/sdkprovision.test.ts`: a registry on loopback,
  tampered tarballs refused, the machine's download, the core's upload,
  offline from `--seed-dir`, `sdk_unavailable`, the retention); every
  adapter given to the host and the kinds without a chat
  (`backend/hosts/machine/chathost.test.ts`).
- `backend/features/chat`: `routes.test.ts` (routes, read-only),
  `watch.test.ts` (the watch: `a host of build …`, `a change after the
  machine left is dropped`), `page.test.ts` (the WebSocket's `limits` and
  `flow control`), `wire.test.ts`.
- Hidden terminals: `backend/features/terminals/hidden.test.ts`,
  `TestDetectSkipsHelperTerminals`, `TestHiddenTerminalsNotCaptured`.
- End to end (`make e2e`, both machine builds): `tests/chat.spec.ts`
  with a fake ACP agent (`e2e/fakeacp`), `tests/chat-codex.spec.ts` with
  a fake Codex app-server (`e2e/fakecodex`, which records a thread that
  is not read-only, a turn without its policies and an approval with an
  amendment as violations the spec expects none of).
- Integration (`make it`): `TestIntegrationChatHost`,
  `backend/features/terminals/integration.test.ts` (`hidden terminals`).
- `web/src/__tests__`: `chat*.test.ts(x)`, `conversation*.test.ts(x)`,
  `viewStatus.test.tsx`, `notifyViews.test.ts`, `attention.test.tsx`.
