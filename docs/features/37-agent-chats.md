# 37 · Agent chats

## Context

Coding agents run in the machines' terminals ([21](21-terminal-core.md)),
where the page knows which agent runs and what it does
([25](25-agent-detection.md)) and which session it is in
([35](35-agent-native-view.md)). An earlier version drew the agent's
conversation over its terminal (kept on the branch `wip/agent-terminal`):
the user's messages were pasted into the program, what it did was read
back from its transcript a turn late, its permission prompts and
questions could only be answered in the terminal under the view, and text
came whole, not as the agent wrote it. Reading a program's screen and
files cannot do better.

The agents have protocols of their own for running headless, which
editors and Orca use: Claude Code the Agent SDK's (stream-json messages
and control requests on standard input and output), Codex its app-server
(JSON-RPC on stdio), and Kimi Code and Grok the Agent Client Protocol
(ACP). Through them a client starts and resumes sessions, streams text,
answers permissions, questions and plan approvals, sets the model, the
effort and the permission mode, compacts, sends images and reads usage
and limits. A chat is such a session, run by a process of the product's
own on the machine and drawn by the page.

Constraints: an agent runs on the machine where its files are, as the
user, with the user's sign-in; nothing listens on TCP there; whatever the
product starts on a machine has an owner and an end, and whatever it
writes a bound ([10](10-remote-resource-lifecycle.md)); a session must
survive the page, the core, ssh and the agent going away; the Claude
protocol has no published specification and the Codex app-server is
marked experimental, so both are pinned to the versions recorded.

## Goals / non-goals

Goals: chats with Claude Code, Codex, Kimi Code and Grok in panes of the
layout, on any machine; streaming text and thoughts; permissions,
questions and plans answered in cards; the model, the effort and the
permission mode chosen per chat, full access only where the machine's
settings allow it; compacting, images, files named with `@`, messages
sent while the agent works; usage, context and limits; subagents' work
under the call that started it; the same notifications, dots and
attention list as agents in terminals ([07](07-agent-native-workflow.md));
a session started in a terminal opened as a chat, and a chat's session
continued in a terminal; chats that outlive the page, the core and the
terminal core, within bounds the user sets per machine.

Non-goals: agents that need a terminal (their own interface); OpenCode
(below); editing the agents' configuration; keeping a pending permission
across a restart of the chat host (the turn ends instead); subagents'
own conversations as chats.

## Design

```
page (chat pane) ──WebSocket──▶ core (plugin chat) ──yamux──▶ agent (plugin chat, action open)
  one per page                   relay, read-only, audit,        │ a stream per connection
                                 watch → /ws and notifications   ▼
                                                             run/chat.sock
                                                             chat host (`chat-host`, a hidden terminal
                                                             of the instance's terminal core)
                                                             ├─ journal: chat-<host>.db
                                                             └─ adapters: claude │ codex │ acp
                                                                  └─ one agent process per live chat
```

### Agent kinds with chats

A kind of the registry (`internal/agentkinds`) has a chat when its row has
a `Chat` spec: the adapter (`claude`, `codex`, `acp`), the command the
adapter adds its own arguments to, the environment it adds, and for ACP
the `_meta` of `session/new`. Only the adapter's name leaves the machine's
side (the registry's JSON for the page); the command is the machine's to
run, looked up in the PATH of the user's login shell.

| Kind | Adapter | Command |
| --- | --- | --- |
| `claude` | `claude` | `claude` and the SDK's arguments |
| `codex` | `codex` | `codex app-server --listen stdio://` |
| `kimi` | `acp` | `kimi acp` |
| `grok` | `acp` | `grok agent --no-leader stdio`, sessions made with `{"yoloMode": false}` |

OpenCode has no chat: `opencode acp` also listens on a TCP port of the
machine without authentication (a password makes it answer 401 but it
still listens), which no user of the machine should get.

### The chat host (`internal/chathost`)

`herdr-ide chat-host --base <data dir> --run <run dir>` (the machine
build has it, `cmd/herdr-ide/chathost_unix.go`; Linux and macOS, so a
core on Windows has chats on its SSH machines only) is the
long-lived process of an instance on a machine that runs the agents and
keeps their conversations. It serves `chat.sock` (0600) in the instance's
run directory (0700), which it takes under a lock of that directory; a
socket nobody answers on is replaced, and one another host answers on
makes it exit with status 1. It opens its journal, removes other hosts'
(below) and serves the protocol of `internal/chatproto`.

It runs as a hidden terminal of the instance's terminal core (below), so
the terminal core, not the agent, is its parent: ssh, the agent and the
core may go and come while it runs. It ends:

- when it had no agent process and no connection for 60 s;
- when it is told to make way for a host of a newer build
  (`shutdown`, refused while a chat works, waits or starts);
- on a signal of the terminal core's stop (SIGHUP, then SIGTERM, then
  SIGKILL, half a second apart): at the first, every agent's process group
  gets SIGTERM and the adapters end their agents; what is left gets
  SIGKILL at the next signal or 300 ms later;
- a host that has not ended 30 s after it began to stop (`StopGrace`)
  kills its agents' process groups and exits with status 1.

The chats stay in the journal, and their agents resume their sessions at
the next prompt.

The agents' programs live where the user's shell startup files put them
(a version manager's directory, `~/.local/bin`), which the host, started
by the terminal core, does not read. So it asks an interactive login
shell for its environment (`$SHELL -l -i -c env`, without a terminal, in
a session of its own, 10 s, at most 1 MiB of output), keeps it 6 hours or
until a startup file of the system's or the user's shells changes, and
uses its own environment for 5 minutes when the shell does not answer.
An agent gets that environment without the variables of the host's
terminal (`HC_TERMINAL_*`), of ssh and of a coding agent's session (the
agent's `agentSessionVars`, [21](21-terminal-core.md)), with `PWD` its
chat's directory and its spec's variables added; `HC_SESSION`, `HC_SOCKET`
and `HC_SCOPE` stay, so that the terminal core's sweep after a crash finds
the agents.

What it logs goes to its terminal's output, which nobody reads, and to
`chat-host-<host>.log` in the data directory (0600), started again at
1 MiB with the one before kept as `chat-host.old-<host>.log`; other hosts'
log files nobody wrote for 30 days go when a host opens its own.

### Starting the host, and handover (`internal/agent/plugin/chat`)

The machine side of the plugin has one action, `open`: a connection to
the host's socket for the core, after which the stream carries the host's
bytes both ways, its hello first. Nothing listens on the machine for the
core: each connection is a stream the core opens.

When no host serves, the agent has the instance's terminal core run one
(`plugin.Env.RunHidden`): `terminal.run` of its own executable (the
core's for the local machine, whose agent runs in the core) with
`chat-host --base --run`, named `herdr-ide-chat-host`, labeled
`herdr-ide.hidden=chat-host`, without a parent and notifications, in the
user's home, removed from the terminal core's records when it exits, with
only the user's name, home, shell, `PATH`, locale, `TMPDIR` and `XDG_*`
variables of the agent's environment on top of the terminal core's. The terminal core gives a name to one live terminal at a time, so `runHidden`
checks `terminal.get` when `name_taken` occurs: if a matching helper holds
the name it waits for that host, and if a user's own terminal occupies
`herdr-ide-chat-host` (without the hidden label and arguments), it leaves
the user's terminal untouched and starts the chat host under a disambiguated
hidden fallback name (`herdr-ide-chat-host-1`..`-16`, all matched by
`agentproto.IsChatHostName`). The open waits
up to 15 s for a host to serve, asking the terminal core again after
0.5 s, doubling to 2 s (a host that ends still holds the name). A name
held while nothing serves for that long and 30 s more (as long as a host
takes to end) is a stuck host's: the terminal of that name (or fallback
helper name) is killed (`plugin.Env.KillHidden`) only when it carries both
the hidden label and matching arguments, and another is started. One start
at a time per agent.

A host of an older build than the agent's (by `git describe` versions) is
asked to make way, which it does when no chat works or waits; once its
process is gone a host of this build takes its place, and the chats
resume their sessions there. A host of a newer build, or of a build whose
age is not known (a development build), is used as it is while it speaks
this protocol: two cores of different builds that reach one machine do
not take turns replacing each other. A host that speaks another protocol
and does not make way fails the open with `upgrading` (503) until its
chats are idle. An open with `start: false` (the core's watch) never
starts a host nor asks one to make way: `not_running` when none serves.
Other failures: `no_terminal_core` (503: the host runs as a terminal of a
terminal core that does not run), `start_failed`.

### Hidden terminals

A terminal of the product's own helpers is hidden when it has both the
reserved name and the label (`agentproto.Hidden`): labels are free-form,
so a program that labels another terminal does not hide it, and clients
can take neither the name nor the label. Every part that walks the
terminal core's terminals decides by that one rule:

- the core's terminal protocol keeps it out of snapshots, events and
  `terminal.list` results, refuses a `terminal.run` or `terminal.label`
  that sets the label or takes the name (`refused`), and answers a call or
  an attach that names it, by address or by name, as for a terminal that
  does not exist; a target the core does not know yet is looked up first
  (`terminal.get`), and an attach is checked again on the record it
  answered. Refusals are audited as `denied.term` with `reason: hidden`
  ([22](22-terminal-protocol.md));
- agent detection on the machine does not watch it, so no detection event
  about it reaches the core ([25](25-agent-detection.md));
- terminal history does not capture it ([36](36-terminal-history.md)).

### Chats

A chat (`c` and 16 hexadecimal digits) is a conversation with one agent
session, in a directory (an absolute path that exists). Its state:
`starting`, `idle` (the agent runs, no turn does), `working`, `waiting` (a
permission or a question waits), `sleeping` (no agent process; the next
prompt resumes the session), `failed` (with the error and the end of what
the agent wrote to its standard error, at most 2 KiB, in memory only),
`closed`. Its status, which dots and notifications show, is the
vocabulary of agents in terminals: `working`, `blocked`, `done` (a turn
ended after the last sequence number the user saw), `idle`.

- **The agent process.** A chat's agent runs while it is used. One idle
  (no turn, nothing waiting, nothing queued) for `chat.idleStopMinutes`
  (30) is ended and its chat sleeps; one more than `chat.maxLive` (8)
  ends the one idle the longest (`too_many` when all work, wait or
  start). A prompt to a sleeping or closed chat starts the agent again
  with the session resumed (Claude Code `--resume`, Codex `thread/resume`
  with `excludeTurns`, ACP `session/resume`, else `session/load` with its
  replay dropped). A session that never had a turn may not have been
  kept by the agent: such a chat starts a new one instead. Close ends the
  agent and keeps the chat until the bounds remove it; delete forgets it
  and its log (the agent's own session files stay).
- **Prompts.** A prompt's content is ACP content blocks (text, images of at
  most 5 MiB each, `resource_link` for a file named with `@`), at most
  8 MiB in all. A prompt to an idle chat starts a turn and is stored as
  its `user` event with the page's id of the message (`clientId`). While a
  turn runs, the adapter queues it, or steers it into the running turn
  where the agent can (Claude Code takes it into the turn after a tool
  result, Codex `turn/steer`), and tells so with `queued` events
  (`queued`, `taken`, `cancelled`); Claude Code and ACP agents can
  withdraw a queued message. A prompt with the `clientId` of one of the
  chat's last 256 is one a page sent again without having its answer: it
  is answered OK and not sent again, and one still being taken gets that
  one's answer. Cancel ends the turn, what waits and the queue. A chat's
  first prompt names it (80 characters); the agent's title of the session
  (Claude Code's from its transcript, read at a turn's end and 5 s later;
  Codex's thread name; an ACP `session_info_update`) replaces that,
  unless the user renamed the chat.
- **Permissions and questions.** The adapter asks the host
  (`chatadapter.Sink`), which stores a `permission` (its kind: `tool`,
  `command`, `file`, `plan`, `mcp`, `other`; the tool call with its
  command, diff or input; the options) or a `question` (one or more, with
  options and their previews, several or one to choose, the user's own
  words where allowed, secret ones), and the chat waits. The first answer
  of any client wins and is stored as `permission_done` or
  `question_done` with who answered (`user`, `cancel`, `ended`); later
  ones get `not_found`. An answer to a secret question is masked in the
  log and on the connections (`••••••`); the agent alone gets it. At
  most 64 wait in a chat (more are answered cancelled), answers at most
  64 KiB. For Claude Code and Codex, which have no options of their own,
  the host offers `allow_once`, `allow_session` (calls like it for the
  rest of the session, writing no setting; for Claude Code only where it
  suggests rules for that) and `reject_once`; ACP
  agents' own options are offered, but those that allow or reject for
  good, which an agent may keep in its settings.
- **Plans.** In plan mode the agent's plan comes as a permission of kind
  `plan` whose options are `plan:<mode>` (approve and go on in that mode:
  `default` or `acceptEdits`) and `reject_once` (keep planning). Claude
  Code: `ExitPlanMode`, then `set_permission_mode`. Codex: the plan item of
  a turn in collaboration mode `plan`, approved before its turn ends; the
  next turn carries it out with "Implement the plan." in the mode chosen.
- **Modes and full access.** `default` asks before edits and commands,
  `acceptEdits` edits the working directory without asking, `plan` plans
  first, `full` asks for nothing. A new chat starts in
  `chat.permissionMode` (`default`); the user changes it per chat. Full
  access is allowed only by `chat.allowFullAccess`, off by default, per
  machine; each adapter marks the values of its mode option that may give
  full access (ACP agents: every mode not known to ask, Kimi Code's
  `auto` among them), and the host refuses a chat or a change that asks
  for one (`not_allowed`), starts the agent of a chat that had one in
  `default` (the notice `full_access_off`), and sets back an agent that
  switches itself to one (or ends it, when it has no other mode). A host
  starts with full access off, whatever it stored, until the core gives
  its process the machine's settings; turning the setting off restarts
  the agents running with it in `default`. A mode the agent changes to
  by itself (a plan's approval, an agent's own switch) is the chat's mode
  from then on.
- **Trusted folders.** An agent loads a project's own settings (its hooks,
  MCP servers, instructions) only in a folder it trusts itself (Claude
  Code: its trust dialog accepted for the folder or one above, as
  `~/.claude.json` records it, read only) or the user trusted through the
  host (`trust`); elsewhere the adapter starts it without them
  (`--setting-sources=user` for Claude Code) and stores the notice
  `untrusted_folder`, once until a start in a trusted folder. The notice
  offers **Trust This Folder**, and after that **Stop Trusting This
  Folder**. The host refuses to trust `/`, the home directory and the
  directories above it, a directory not the user's or that its group or
  others may write, and one below a directory others may write that has
  no sticky bit (`unsafe_folder`); it keeps the directory's device and
  inode and drops a trusted path that is another directory, or no longer
  safe, at the next start there; at most 1000 directories. `untrust` takes
  back the trust of a directory and of those above it; a running agent
  keeps what it loaded until its next start.
- **Model and effort.** The chat's options list the agent's models and the
  model's efforts; a value is set through the protocol, never by a slash
  command that saves it (Claude Code `set_model` and
  `apply_flag_settings {effortLevel}`, Codex with every turn, ACP
  `session/set_config_option`). Values set are kept and applied again
  when the agent starts again.
- **Compacting.** `compact`: Claude Code's `/compact`, Codex
  `thread/compact/start`; the notices `compacting` and `compacted`. ACP
  agents have no protocol for it (their own `/compact` works as a
  prompt).
- **Usage and limits.** The chat states its context in use and its size,
  the cost so far and the subscription's limit windows the agent reports
  (Claude Code: `result`, `get_context_usage`, `rate_limit_event`; Codex:
  `thread/tokenUsage/updated`, `account/rateLimits/updated`, at most every
  5 s and at a turn's end; ACP: `usage_update`, Grok's cost in its
  `_meta`).
- **Subagents.** Their events carry `parent`, the tool call that started
  them (Claude Code's `parent_tool_use_id`, Codex's child threads), and the
  view shows them under that call; their permissions are the chat's.

### The protocol (`internal/chatproto`, version 2)

JSON lines of at most 16 MiB on the socket. The host writes its hello
(`{host: {proto, version, pid}}`); the client sends one request, which
the host answers; every request but `attach` and `watch` ends the
connection then. Requests name agents by their kind, never by a command.

| Request | Answer |
| --- | --- |
| `agents {kinds}` | `{agents: [{kind, available, version?, reason?}]}` (`not_found`: not in the PATH; `unsupported`) |
| `chats` | Every chat, closed ones too, the latest first. |
| `new {kind, cwd, resume?, import?, options?}` | The chat, `starting`; what follows comes as events. |
| `attach {chat, from, noCatchUp?}` | The chat and `first`, the lowest sequence number kept; then the stored events after `from`, then every new one. |
| `close`, `delete {chat}` | – |
| `sessions {kind, cwd, cursor}` | A page of the sessions the agent kept for the directory, with the chat that has each. |
| `watch` | Every chat's state, then a line per change (a chat no more in `deleted`). |
| `seen {chat, seq}` | – (a turn that ended at or before `seq` is no longer `done`) |
| `configure {settings}` | – (the machine's settings, clamped) |
| `shutdown` | – (`busy` while a chat works, waits or starts) |
| `trust`, `untrust {cwd}` | – |
| `trusted` | `{trusted: [{cwd, at}]}` (all valid persisted trusted folders) |
| `host_status` | `{hostStatus: {proto, version, pid, terminalId?, startedAt, socket, base, conns, watchers, liveAgents, totalChats, totalBytes, ending, settings, sessions}}` |

An attached connection sends commands, each answered by an `ack` with
its id: `prompt`, `cancel`, `permission`, `answer`, `set_config`,
`cancel_queued`, `compact`, `rename`, `handoff`. At most 8 of a
connection may wait for the agent (30 s each).

Events: `update` (an ACP `session/update` with the item it belongs to),
`user`, `turn` (`start`, `end` with a stop reason, `error`),
`permission`, `permission_done`, `question`, `question_done`, `queued`,
`state`, `info` (the chat as it is now: its configuration options, slash
commands, usage, capabilities, the agent's version), `notice`
(`_herdr-ide/<name>`) and `ack`. A **stored** event has a sequence number
and stays in the log. A **live** event is an increment of an item being
streamed (text, a thought, a tool's input or output): it has no number,
goes only to the connections attached then, and is never stored; once
the item is complete, or changes otherwise, one stored event with its
whole state under the same item replaces what came live for it. A client
that attaches again gets the stored events after its `from` and drops
items it has only increments of. What an agent wrote to its standard
error rides only on live errors (a `state`, a `turn` or an `info`) and is
never stored.

Errors carry a code, which the page translates: `bad_request`,
`unknown_chat`, `too_many`, `busy`, `not_found`, `start_failed`,
`protocol`, `auth_required`, `unsupported`, `too_large`, `ended`,
`failed`, `in_terminal`, `handed_off`, `sleeping`, `not_allowed`,
`unsafe_folder`.

### The journal

`chat-<host>.db` in the instance's data directory, a SQLite database of
the host's own ([38](38-sqlite-state.md)): the chats (every member of a
chat but its status, the options its agent starts with again, the item a
later import starts after, its bytes), their stored events as the lines
clients get, the trusted folders and the settings. Bounds, from the
machine's settings:

| Bound | Setting | Default | Bounds |
| --- | --- | --- | --- |
| Bytes of a chat's events | `chat.maxChatMB` | 64 MB | 8–256 |
| Bytes of every chat's events | `chat.maxTotalMB` | 512 MB | 64–2048 |
| Chats kept | `chat.maxChats` | 500 | 50–2000 |
| Days a closed chat is kept | `chat.retentionDays` | 30 | 1–365 |
| A stored event | – | 1 MiB | – |

A chat over its bytes loses its oldest events down to seven eighths of
them. Past the others, closed chats go oldest first (closed longest ago);
when none is left and the bytes are still too many, the largest chat loses
its oldest events; a new chat past `chat.maxChats` with no closed chat to
remove is refused (`too_many`). The bounds are checked at the start,
after every 1 MiB of events, every hour and when the settings change. An
event longer than 1 MiB is cut: a tool call's long strings to their first
and last 16 KiB, anything else to a notice `skipped` under the same item
(a permission cut that way is cancelled). An event the journal does not
take fails the chat, so that its log has no gap; its next prompt starts
it again. A journal of a newer host is not used: the host does not
serve. Other hosts' journals of a shared home nobody opened for 30 days
are removed at the start.

### Adapters (`internal/chatadapter`)

The host owns chats, logs, clients, bounds and every decision about
processes; an adapter owns one agent process per session and turns its
protocol into events. The rules all three follow are the package's
comment: argv as given (its program an absolute path the host resolved),
the environment as given; every request of the agent it does not serve
answered "method not found" (an agent not answered waits); frames,
members and values it does not know passed over; answers to requests it
did not make ignored; the user's configuration never written; the agent
in a process group of its own, ended gracefully (input closed, SIGTERM to
the group, SIGKILL after a grace, then the group swept of what the agent
left); the agent's output never blocked by the host; increments live and
complete items stored; a prompt told once (the host stores the `user`
event of a prompt it believes starts a turn, `PromptParams.Recorded`, and
the adapter decides under its own lock); full-access values marked; the
agent's mode stated whenever it changes; a session another process runs
neither resumed nor imported.

- **Claude Code** (`internal/chatadapter/claude`). The protocol of the
  Agent SDK, implemented in Go after the TypeScript SDK 0.3.323's type
  definitions and the recordings of Claude Code 2.1.330: `claude
  --output-format stream-json --verbose --input-format stream-json
  --include-partial-messages --permission-prompt-tool stdio
  --setting-sources=…`, `--session-id=` or `--resume=`, `--model=`,
  `--permission-mode=` and, for full access only,
  `--allow-dangerously-skip-permissions` (switching to full access starts
  the program again with the session resumed: the notice `restarted`). Its
  environment adds `CLAUDE_CODE_ENTRYPOINT=herdr-ide` (the SDK's own entry
  points hide their sessions from the terminal's `/resume` list),
  `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` and the SDK's version, and drops
  `NODE_OPTIONS`. `can_use_tool` becomes a permission, `AskUserQuestion`
  a question and `ExitPlanMode` a plan; "allow for this session" sends
  only the suggestions' `addRules`, their destination rewritten to the
  session (a `setMode` suggestion would switch the mode); stream events
  are increments of an item (`<message>/<block>` or a tool call), each
  block's `assistant` frame its stored state, tool results mapped by
  `internal/agent/transcript` as an import maps them. Control requests
  wait 60 s for `initialize`, 30 s otherwise; Close waits 2 s, then
  SIGTERM, then SIGKILL 5 s later. A session Claude Code runs in a
  terminal (its record `<claude dir>/sessions/<pid>.json` of a running
  process, not one of the host's own) is `in_terminal`. Sessions and
  imports read the transcripts (`~/.claude/projects`), 50 a page, at most
  4096 a directory, the last 256 MiB of a transcript for an import.
- **Codex** (`internal/chatadapter/codex`). `codex app-server --listen
  stdio://`, protocol v2 with `experimentalApi`, one app-server per live
  chat; the part of its schema the adapter relies on is pinned in
  `design/codex-app-server/summary.json` (0.171.0, `TestSchemaPinned`). A
  thread started with sandbox `workspace-write` writes the directory into
  `~/.codex/config.toml` as trusted, so threads start and resume
  read-only, asking, and each turn carries the chat's mode as policies,
  which write nothing:

  | Mode | Approval policy | Sandbox | Collaboration mode |
  | --- | --- | --- | --- |
  | `default` | `untrusted` (asks before every change and command) | `workspaceWrite` of the directory | default |
  | `acceptEdits` | `on-request` | `workspaceWrite` of the directory | default |
  | `plan` | `on-request` | `readOnly` | `plan` |
  | `full` | `never` | `dangerFullAccess` | default |

  Under `on-request` with a read-only sandbox the model refuses to write
  instead of asking, which is why `default` is `untrusted`. Approvals map
  to accept, acceptForSession, decline and cancel, never to the command
  or network amendments Codex saves; elicitations and requests for more
  permissions are refused. Model and effort go with every turn (a thread
  takes no effort); images as data URLs (an item keeps only a local
  image's path). Codex does not stop a command of an interrupted turn:
  one still running 2 s after the interrupt has the app-server ended and
  started again on the thread (`restarted`). The app-server's refusal of a
  thread another Codex writes is `in_terminal`. Sessions (`thread/list`)
  and imports (`thread/turns/list`) use a live chat's app-server, else a
  short one of their own. Close closes its input, SIGTERM 2 s later,
  SIGKILL 5 s after that: a Codex killed outright leaves its shell
  snapshots (`~/.codex/shell_snapshots`) behind.
- **ACP** (`internal/chatadapter/acp`, on `internal/acp`): Kimi Code and
  Grok. The client states neither the file system nor the terminal
  capability. Modes are the agent's own, the host's mapped at the start
  (`default`, `acceptEdits`, `plan`, `full` to the agent's of that
  meaning where it has one). One turn per prompt: a prompt while a turn
  runs waits in the adapter (at most 16) and is sent when it ends. Sessions
  and imports run a short agent process (`session/list`; `session/load`,
  whose replay is the import, marked lossy: Kimi Code's leaves images out,
  merges a cancelled prompt with the next and numbers tool calls anew).
  The agent has 60 s to initialize and to make a session, 2 minutes to
  load one, 30 s for a call; Close waits 2 s, then SIGTERM, SIGKILL 3 s
  later. An ACP agent cannot tell that a terminal runs a session.

Start and session listings have 60 s; calls 30 s; an adapter has 10 s to
end its agent before the host kills the group. At most 4 listings run at
a time.

### The core's plugin (`internal/plugins/chat`)

**Routes** (below `/api/m/{id}/p/chat/`, [reference](../reference.md#http-and-websocket-endpoints)):
`GET agents`, `POST agents`, `GET chats`, `POST sessions`, `POST new`,
`POST close`, `DELETE chat`, `POST seen`, `POST handoff`, `POST trust`,
`POST untrust`, `GET trusted`, `POST trusted`, `POST host/stop`; and
`GET /api/p/chat/hosts`, `GET /api/p/chat/states`, `GET /api/p/chat/ws`. A GET
never starts the machine's host (`not_running`); a change does, except on
a read-only core, which starts nothing. `GET agents` and the sessions
listing may run the agents' programs, so the first is refused read-only
and the second is a POST. Every change is audited as `chat.<route>` with
the kind, the directory, the session, the import, the mode and the chat
it made or named. Before a request that may start an agent the core gives
the host the machine's settings unless that host process (by its version
and pid) took them already. A machine has at most 128 connections of the
core to its host, the last 8 for the watch and the configures
(`too_many`, 409).

**The page's WebSocket** (`wire.go`, `ws.go`; mirrored by
`web/src/plugins/chat/protocol.ts`). One per page, for every chat of
every machine (a browser opens at most six HTTP/1.1 connections to an
origin). A subscription (`attach {sub, m, chat, from}`) is a connection
of its own to the machine's host: `attached {chat, first}`, then `event`s,
until `detach` or `detached` (the machine left, the chat was deleted, the
plugin was turned off, `lost`: the host connection ended, attach again
from the last sequence number). At most 32 subscriptions, 16 of one
machine. Commands (`command {id, m, chat, cmd}`) go on a subscription of
that chat and get one `ack` each, also when the subscription ends first
(`lost`: it may have been carried out). A read-only core refuses every
command (`read_only`) and subscribes without the catch-up that may run an
agent. Flow control: what waits for a page is bounded (8192 messages,
32 MiB); its subscriptions' events share half of it, and a subscription
over its share is not read from its host until the page took enough, so
the host drops that connection when it falls 8192 events or 16 MiB behind
and the page attaches again, while its other chats go on; a page that
falls behind on the core's own messages is closed (1013). With the plugin
off, every subscription hears `plugin_disabled` and the socket closes.

**Watch, states and notifications** (`watch.go`). While a machine is
connected, the plugin is on and its host is in use (a chat with an agent,
a page's subscription, or a route used within the last 2 minutes), the
core watches the host without starting one: every chat's state, then
each change. It sends them to the pages as the plugin's `/ws` message
`{t: states, states, full, rev}` (numbered per machine; `GET
/api/p/chat/states` gives the last of every machine) and publishes an
agent event (`machines.Manager.PublishAgent`, with `chat` instead of a
terminal) when a chat becomes blocked or done, once per status and
sequence number; of the first states read only the blocked ones. a machine disconnects, its cached live states transition to `sleeping`/`idle`
(preserving `done` for unread turns) with `stale: true` on `ChatState` and
`StatesData`, cleared on reconnect. A watch
that fails is tried again after 5 s, doubling to 5 minutes, up to 6 times
before it waits for the next use. Settings changes configure the watched
hosts at once.

**Read-only and audit.** A read-only core leaves out the agents' standard
error, here and on the WebSocket. Commands that change what an agent may
do or where its session goes are audited when answered: `chat.permission`
(the request, the option or `cancelled`), `chat.answer` (the number of
answers, never their text), `chat.set_config` (the option and the
value), `chat.handoff`; a prompt's text never. Of a page's refusals of one
command, one record is written per 10 s, counting the others; values are
cut to 256 bytes.

### The page (`web/src/plugins/chat`, `web/src/conversation`)

- **The pane.** A chat is a pane of the layout, `{view: {plugin: chat,
  kind: chat, chat, agent, title?}}` (the chat id taken only in the host's
  form, the agent only when it is a kind with a chat), drawn by the
  conversation view from the chat's source (`source.ts`, the
  `ChatSource` of `conversation/source.ts`). Its header names the agent,
  the chat's title (renamed in place) and directory and its state; its
  menu has Rename, **Continue in Terminal**, Close and Delete. The view
  draws the last 300 items and streams increments at most once a frame.
  The agents' Markdown is shown with tables, code and formulas (KaTeX):
  besides `$…$` and `$$…$$`, a formula written between `\[` and `\]`
  (on one line or several) is shown as a display formula and one between
  `\(` and `\)` on one line inline, in messages, thoughts, plans, tool
  results and question previews (`conversation/format.ts`); code blocks,
  code spans, `\\[` and an unmatched `\[` stay as written, so a message
  still arriving swallows nothing. Files shown elsewhere keep Markdown's
  own escaped brackets. The cards answer the agent where it asked (number
  keys choose a permission's options); an answered card says "Your
  choice" only for an answer this page gave (kept in memory per chat, 200
  chats, until the page is loaded again) and "Answered" for any other.
  The composer sends on Enter (Shift+Enter or
  Alt+Enter: a new line), attaches up to 20 images by pasting, dropping or
  picking, names files of the chat's directory after `@` (the machine's
  listing, 50 at most), offers the agent's slash commands after `/`, the
  model, effort and mode selectors from the chat's options (values of
  full access shown unavailable where the machine does not allow them),
  the queued messages, a stop button (and Escape), and a line of cost,
  context and the tightest limit. Drafts are kept per chat (200 chats).
  Read-only, every control is disabled.
- **New chats.** The new-tab menu offers a chat with each kind that has
  one, and with those the machine's host can start once it told
  (`GET agents`, which starts no host, asked again after 5 minutes), as
  do the command `chat.new` (one kind directly, else a menu of them at
  the focused pane) and the Chats panel. A chat starts in the focused pane's directory, else the
  machine's home, in the mode of `chat.permissionMode`, in a new tab.
- **The Chats panel** of the right sidebar: the machine's chats, blocked
  ones first, then done, working and the rest, the latest first; each
  shows its chat, closes or deletes it. Below them the agents' earlier
  sessions of the focused pane's directory (below).
- **Statuses** (`status.ts`, the plugin's `viewStatus`,
  [27](27-plugins.md)): a chat pane is working, blocked, done or idle as
  its chat; the sidebar's dots, the tabs', the attention list, the badge
  and notifications count chat panes as they count agent terminals, and a
  notification of a chat leads to its pane
  ([07](07-agent-native-workflow.md)). Seeing a pane whose chat is done
  posts `seen` with its last sequence number, which ends done for every
  page; a failed post is tried again after 2 s, doubling, 8 times at
  most, and the chat's next done state asks again.
- **Usage in the status bar.** `chat.usage`: the cost, the context in use
  and the tightest limit of the chat in the focused pane
  ([29](29-ai-usage.md)).
- **The connection** (`connection.ts`) opens with the first subscription
  and closes a minute after the last; it connects again after 0.5 s,
  doubling to 8 s, and attaches every chat again from its last stored
  event. A command not answered in 60 s, or whose subscription was lost,
  is uncertain: the view shows the message pending and sending it again
  under its `clientId` does not send it twice. What the core sends is
  checked member by member.

### Importing a session, and continuing in a terminal

- **Import.** The Chats panel lists, for each kind the machine's host can
  start (a writable page starts the host to ask, `POST agents`), the
  sessions the agent kept for the directory (the panel's, else the
  focused pane's), newest first, a page at a time (**Show More**), at most
  1000 a kind; listing them may run the agent, so a read-only page lists
  none. A session that is already a chat's shows that chat: from the
  list, and from **Continue in Chat** below, the page looks for the chat
  of that kind and session among the chats it knows, and when the host
  still refuses a second chat on the session, among the machine's chats
  (`GET chats`), and opens it. Opening one makes a chat that resumes the session and
  brings its earlier conversation into the log first (`new` with `resume`
  and `import`; an ACP import begins with the notice `imported`). An
  import names the chat with the agent's own title of the session when
  it has one (Claude Code's custom title, else its generated one; Codex's
  thread name, read with `thread/list` for that thread; the title an ACP
  agent's `session/list` gives, reading at most 10 pages), unless the
  user renamed the chat; a catch-up changes no title. A
  terminal pane whose agent ran a session of a kind with chats and quit
  offers **Continue in Chat** in its header while the leaf remembers the
  agent (30 s after it quit,
  [33](33-workspace-restore.md)) and no agent runs in the terminal. Two
  processes never write one session: the page refuses a session a
  terminal's agent runs (its record's `agent_session`, or a leaf about to
  resume it) and names that terminal, and the host refuses one another
  process runs (`in_terminal`).
- **Handoff.** **Continue in Terminal** (while no turn runs, for an agent
  that resumes a session by its id: Claude Code, Codex) has the host end
  the chat's agent and mark the chat handed off (the notice `handed_off`),
  then opens a terminal tab in the chat's workspace and directory running
  the machine's shell, whose leaf asks for the agent to resume the
  session (`{session, resume: <kind>}`); once attached the page types the
  kind's command (`claude --resume <id>`, `codex resume <id>`) as a
  restore does ([33](33-workspace-restore.md)). The shell stays when the
  agent exits, and the pane can continue the session in a chat again. A
  terminal that runs the session, or is about to (`sessionTerminal`: a
  record's `agent_session`, or a leaf naming the session whose agent the
  machine has not reported yet), is shown instead of starting another;
  the handoff stays under way until the machine detects an agent there,
  the terminal ends, or 15 s pass.
- **Catch-up.** When a handed-off chat takes a prompt again, or is
  attached while no agent runs (at most every 10 s), the host first
  brings in what the session did in the terminal: the adapter's history
  after the last item it imported, never twice. What it brings counts as
  seen; a failure is an error notice, and the chat goes on.

### After the terminal core starts again

A stop of the terminal core ends the host and the agents with it. The
next use starts a host, which reads the journal: a chat whose agent ran
sleeps, its turn ended in an error and what waited cancelled. The panes
attach again by themselves; the next prompt resumes the session by its
id, its context and cost going on.

## Alternatives considered

| Option | Why not |
| --- | --- |
| The conversation drawn over the agent's terminal (feature 35's earlier version, branch `wip/agent-terminal`) | Input pasted into a program, confirmation a turn late from its transcript, permissions and questions only in the terminal under the view, no streaming. |
| ACP for every agent | Claude Code and Codex speak it only through adapters of other projects, without their own permissions, plans, questions, effort, usage and limits. |
| The Agent SDK in Node as a sidecar on each machine | A Node runtime and packages per machine (no internet there); the protocol is small enough to speak from Go, pinned to the SDK's types and recorded. |
| `character-ai/claude-agent-sdk-go` | A one-shot `claude --print` per query without control requests: no permissions, questions, plan approval, model or effort changes, interrupts or queued messages; some arguments named wrong for 2.1.330. |
| The host as a child of the agent | It would end with every ssh drop and core restart, and its agents with it; as a terminal of the terminal core it lives as the user's programs do, with their owner and end. |
| A socket or port of the host that the core reaches directly | Nothing listens on TCP on machines; the agent's stream to the run directory's socket is enough. |
| The journal as JSONL files per chat | Bounds, eviction, the trusted list and the chats' rows would need their own crash-safe rewriting; SQLite gives transactions, and one database per host is one file to prune ([38](38-sqlite-state.md)). |
| Live increments stored | Every token in the log; a reattach replays the item's whole state instead. |
| OpenCode through ACP | It listens on a TCP port without authentication. |

## Failure modes

- **No terminal core** → `no_terminal_core` (503); the panes say the
  machine's terminal core does not run.
- **The host does not come up within 15 s** → `start_failed`; a name held
  by a stuck host is freed and the host started again.
- **A host of another build serves** → used while it speaks this
  protocol; else `upgrading` (503) until its chats are idle.
- **The agent is not installed, or not signed in** → `not_found` in the
  agents list (no new-tab item); `auth_required` when it wants a sign-in
  (the page suggests running it once in a terminal).
- **The agent exits or breaks its protocol** → the chat fails with the
  end of its standard error; the next prompt starts it again.
- **A session Claude Code or Codex runs in a terminal** → `in_terminal`;
  an ACP agent's is not detected.
- **A resumed session the agent no longer has** → the start fails
  (`not_found`); a catch-up that finds nothing goes on as the log has it.
- **The page falls behind** → the subscription is lost and attached again
  from its last sequence number; live increments of unfinished items are
  dropped and come again whole.
- **A command's answer lost with the connection** → uncertain; a prompt
  sent again under its `clientId` is taken once.
- **The journal refuses a write** → the chat fails; its log has no gap.
- **A newer host's journal** → an older host does not serve.
- **Pending permissions when the host ends** → cancelled, the turn ended
  in an error.
- **Two cores of one instance** → one host serves both; each watches it
  and configures it, the last configure's settings apply.
- **A machine whose chats nobody uses** → the watch lets go after
  2 minutes, the agents stop after `chat.idleStopMinutes`, the host
  exits a minute later.

## Security

Chats run agents as the user on the machine, as their terminals do. What
is new: a process of the product's own that outlives the agent and runs
agents without a terminal. It is reached only through the instance's run
directory (0700, the socket 0600) and the agent's stream; a page reaches
it only through the core's guarded routes and WebSocket, which take
agent kinds, chat ids, clean absolute directories, session ids of a
fixed form and option values without control characters, checked on the
core and again by the host. What runs is the registry's command, looked
up on the machine; no command line, path to run or variable comes from a
client. Full access is off unless the machine's setting allows it, also
for a host that starts again; project settings load only in folders the
agent or the user trusted, and only folders that no one else may change.
Answers to secret questions and the agents' standard error are never
stored; the latter goes only to writable clients. The hidden terminal is
none of the clients' (above). Programs of the user in that terminal core
reach the host's terminal through its socket, as they reach every
terminal of it. The agents load the user's own hooks and MCP servers as
they do in a terminal. See the rows on agent chats in
[SECURITY.md](../../SECURITY.md).

## Testing

- `internal/chatproto`: the wire, statuses, ids, clamping, `ReadLine`.
  `internal/chatadapter`: registration and the rules' types.
- `internal/chathost`: requests and checks, the login shell's environment
  and PATH (`env_test.go`), turns, prompts recorded once and sent again
  (`TestPromptRecorded`, `TestPromptSentAgain`), permissions (first answer
  wins), questions and their ids, idle stop and resume, `maxLive`,
  handoff and catch-up (`TestHandoffAndCatchUp`, `TestCatchUpImportsOnce`),
  import, close and delete, watch, shutdown, recovery after a host ended,
  idle exit, a fresh session not resumed, trust and its refusals and
  re-checks, full access (off at start, revoked, taken by the agent),
  stderr never stored, a journal failure, a hard exit, the log file, a
  session in a terminal (`fx3_test.go`, `fixes_test.go`, `chat_test.go`,
  `host_test.go`); the journal's replay, slow subscribers, every bound
  and the cuts (`journal_test.go`); signals ending agents' groups and
  their children (`signal_test.go`).
- Adapters, against fake agent processes (the test binary playing the
  CLI) that replay the recordings of `design/testdata/chat/`
  (`claude/`, `codex/`, `acp/`; its README says what each shows and which
  version made it): `internal/chatadapter/claude` (`TestReplay`, history
  and sessions, the group swept after exit and close, trust, full access
  by restart, `in_terminal`, titles, the plan's mode, timeouts),
  `internal/chatadapter/codex` (a replay per recording, the policies per
  mode against the pinned schema `TestSchemaPinned`, server requests,
  close order, leftovers ended, `in_terminal`, sessions, history),
  `internal/chatadapter/acp` (Kimi Code and Grok sessions, resume and
  load, unknown requests, the queue, legacy modes, full-access marking),
  `internal/acp`.
- `internal/agent/plugin/chat`: the host started, a watch, opens together,
  the name taken, handover (an older host replaced, never a newer one,
  the old process waited for), a stuck host killed. `internal/agent`
  `hidden_test.go`: the hidden run and kill.
- `internal/plugins/chat`: routes, GETs that start no host, read-only
  redaction, errors, the handoff, the settings; the watch (states, done
  across a gap, a quiet host let go, configures); the WebSocket (relay,
  read-only, limits, flow control, audit bounds, the connection cap).
- `internal/server/term_hidden_test.go`: hidden terminals out of
  snapshots, events and lists, in the window before their label, after a
  `missed`, for read-only clients; other machines' terminals; labels that
  are not strings. `TestDetectSkipsHelperTerminals`,
  `TestHiddenTerminalsNotCaptured`.
- Integration (`make it`, an isolated herdr-core 0.1.21):
  `TestIntegrationChatHost` (the host started as a hidden terminal,
  serving, restarted after the terminal core restarted) and
  `TestIntegrationTermHidden`, passed in an isolated Linux container and
  on macOS.
- `web/src/__tests__`: `chat.test.ts`, `chatConnection.test.ts`,
  `chatPane.test.tsx`, `chatPlugin.test.tsx`, `chatHandoff.test.ts`,
  `chatImport.test.tsx`, `conversationChat.test.ts`,
  `conversationCards.test.tsx`, `conversationComposer.test.tsx`,
  `viewStatus.test.tsx`, `notifyViews.test.ts`, `attention.test.tsx`.
- Run in a browser against a development instance (Claude Code 2.1.330
  with `claude-haiku-5-5`, Codex 0.171.0, Kimi Code 2.7.2): the new-tab
  items of four kinds; a chat in the focused pane's directory; the
  untrusted-folder notice and its Trust button; the model, effort and
  mode selectors from the agent, full access shown unavailable; tables,
  display and inline math; thoughts; a permission allowed once and its
  command run; a question answered; streaming; a queued message taken; a
  done chat in the sidebar's agents, the tab's and workspace's dots and
  the title's badge while away, seen when back; a plan approved with
  accept edits and its file written without asking; cost, context and
  limits in the composer and the status bar; the terminal core stopped
  (the host and agents gone) and started (the chat sleeping, a prompt
  resuming its session with its context and cost); a handoff's terminal
  running `claude --resume <id>`; a Kimi Code turn.
