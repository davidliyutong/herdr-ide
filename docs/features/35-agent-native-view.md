# 35 · Coding agents' sessions and transcripts

## Context

Claude Code and Codex run as programs in the machines' terminals
([21](21-terminal-core.md)). The page knew which agent runs in a terminal
and what it does ([25](25-agent-detection.md)), but not which conversation
it is in, so after a restart it could only continue the directory's latest
one ([33](33-workspace-restore.md)).

Both agents write every session to a transcript of JSON lines on the
machine, under an id that is a UUID. What they do, measured on macOS with
Claude Code 2.1.330 and Codex CLI 0.170.0:

- Claude Code writes `<claude dir>/sessions/<pid>.json` (`pid`,
  `sessionId`, `cwd`, `startedAt` in ms, `procStart`, `status`, …) as soon
  as its interface is up, rewrites it at once with the new id on `/clear`,
  and removes it when it exits; a `<pid>.<hex>.key` lies beside it.
  `claude --session-id <uuid>` takes that id. The transcript,
  `<claude dir>/projects/<directory>/<id>.jsonl` (the directory with every
  character but an ASCII letter or digit replaced by `-`), is made at the
  first prompt. An assistant's response is a line per content block, the
  lines sharing `message.id` and its `usage`; most lines are the program's
  own state (attachments of up to 140 KB a line, request shapes, file
  snapshots) and no conversation. A message the user sends while the
  agent works is recorded, once the running turn takes it up, as an
  `attachment` line (`attachment.type` `queued_command`, `commandMode`
  `prompt`, `origin.kind` `human`, `prompt` a string or text and image
  blocks) after a `queue-operation` line `remove`, and no user line is
  written for it; a message still queued when the turn ends becomes an
  ordinary user line of the next turn (seen in transcripts of 2.1.30x to
  2.1.330, structure only). A Claude Code started with
  `CLAUDE_CODE_CHILD_SESSION` in its environment (which a terminal core
  started from inside a Claude Code session passed on) writes neither file.
- Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl`
  at the first prompt, not before, and does not keep it open. Its first
  line is `session_meta` (`id`, `cwd`, `timestamp`, the model's
  instructions: tens of KB). Each item of a turn is recorded once it
  completed (`event_msg` of type `item_completed`), and again in the
  model's wire form (`response_item`); older versions have no items.
- Both report their state through OSC 7501 (`idle`, `working`, `blocked`,
  `done`, with a `msg` such as `approve Write: /path`).

## Goals / non-goals

Goals: the session each agent terminal runs, found on the machine without
changing the agents' configuration; a terminal brought back in its
agent's own session after its terminal core started again, once the
machine confirmed it ([33](33-workspace-restore.md)); the session's usage
for the status bar ([29](29-ai-usage.md)); another kind of agent added by a
row of a registry and, for its conversations, a parser that reads a
session's transcript on its machine into events shaped as the Agent
Client Protocol's; a conversation view that knows its events only through
an interface (`ChatSource`), which the chat panes draw
([37](37-agent-chats.md)).

Non-goals: changing the agents' configuration (hooks); transcripts kept
compressed; subagents' conversations; sessions of agents other than
Claude Code and Codex. Running agents headless and their chats are
[37](37-agent-chats.md).

## Design

### Agent kinds (`internal/agentkinds`)

The registry of the coding agents the terminals recognize: for each kind
its `ID` (the detector's manifest id, [25](25-agent-detection.md)), `Title`,
`UsageProvider` (the AI usage plugin's provider, [29](29-ai-usage.md)),
`Start` (the argv that starts it), `NewSession` (appended to `Start` to
start it with a session id the caller chose), `ContinueLatest` (the command
that continues the directory's latest conversation), `ResumeByID` (the
command that resumes a session by its id), `Transcript` (the parser of
its transcripts, or none) and `Chat` (how the chat host runs it headless:
its adapter, the command and environment the adapter starts it with, and
for ACP the `_meta` of a new session; [37](37-agent-chats.md)). It is data
only and builds for every system the core runs on.

| Kind | Start | New session | Continue latest | Resume by id | Transcript | Chat |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | `--session-id {id}` | `claude --continue` | `claude --resume {id}` | `claude` | `claude` |
| `codex` | `codex` | – | `codex resume --last` | `codex resume {id}` | `codex` | `codex` |
| `kimi`, `grok` | its id | – | – | – | – | `acp` |
| `gemini`, `opencode`, `cursor`, `copilot`, `qwen`, `amp` | its id | – | – | – | – | – |
| the other 12 the detector knows | – | – | – | – | – | – |

`scripts/registry` writes the kinds into `design/generated/registry.json`
(key `agents`; `make tokens`), which the page reads
(`web/src/conversation/kinds.ts`): the palette's agents to start
(`startArgv`), the commands a restore types (`resumeCommand`), the AI
usage provider of a session and whether a kind's conversations can be
read (`hasNativeView`: it has a transcript parser) and the adapter of its
chats (`chatAdapter`; the command, environment and session metadata stay
on the machine's side, never in the registry's JSON). `uisettings.Agents`, the list of silent
agents, is made from it. A placeholder is replaced only by a lower-case
UUID (`ValidSessionID`, `isSessionId`); any other value makes no command.

Adding a kind: a row in `kinds`, the detector's manifest of the same id
(`TestKindsMatchManifestsAndSettings` holds the kinds, the manifests and
`uisettings.Agents` to the same ids, and the providers to the AI usage
plugin's), then `make tokens`. For its sessions and conversations also: a parser in
`internal/agent/transcript` (`formats`), how `internal/agent/sessions`
finds its sessions and transcripts, `ResumeByID` and `ContinueLatest`
(the test requires them of a kind with a transcript) and the vectors of
its lines in `design/testdata/transcript/`. For chats with it: a `Chat`
spec whose adapter is one of `agentkinds.Adapters` (`TestChatKinds`).

### Finding a session (`internal/agent/sessions`)

`Resolver.Resolve(kind, Proc{PID, Argv, Cwd})`, for the foreground program
of a terminal as the terminal core reports it, answers the session's id and
how it was found (a source word). The candidates are the program and its
descendants in its process group, breadth first, at most 3 generations and
32 processes (a wrapper script, npm's node launcher above the native
binary).

Claude Code, in this order:

1. **`argv`**: `--session-id <id>` (or `=<id>`), else `--resume <id>` or
   `-r <id>` unless `--fork-session` makes a new one; arguments after `--`
   are no options.
2. **`pid`**: Claude Code's record of the program's process, else of a
   descendant's, `<config dir>/sessions/<pid>.json`. The configuration
   directories are the process's own `CLAUDE_CONFIG_DIR` where its
   environment can be read (Linux) and the directory passes the trust
   check, else the agent's user's (`$CLAUDE_CONFIG_DIR`, `~/.claude`,
   `~/.config/claude`). A record is believed when its directory no other
   user and no group may write (on Linux the user's own primary group may:
   user private groups; on macOS every user's primary group is `staff`,
   so none may), it is a
   regular file of the user's of at most 64 KiB opened without following a
   link at its name, its `pid` is the process's, its `sessionId` is a
   lower-case UUID and, when the process's start time is known, its
   `startedAt` is a number within 60 s of it (a reused pid has an old
   record). The `.key` file is never opened. A record that names another
   session than the command line wins: `/clear` started one.
3. **`guess`**: when no other terminal runs Claude Code in the directory
   and the process is no child session (`CLAUDE_CODE_CHILD_SESSION` in its
   environment, Linux): the newest transcript of the directory's projects
   directories written since the process started (2 s of slack), that no
   running process's record names (at most 256 records read), whose first
   conversation line records the directory (at most 8 transcripts read, 4
   MiB or 256 lines of each). A directory name longer than 200 characters
   is cut there by Claude Code and followed by a hash, so every projects
   directory with that start is looked in.

Codex, in this order:

1. **`argv`**: `resume <id>`, also after `exec`.
2. **`fd`** (Linux): a candidate's open file (`/proc/<pid>/fd`) that is a
   `rollout-*-<id>.jsonl` inside the sessions directory of one of its homes
   (its own `CODEX_HOME` when it passes the same check as Claude Code's
   directories, `$CODEX_HOME`, `~/.codex`). Codex 0.170.0 holds no rollout
   open.
3. **`start`** and **`guess`**: when no other terminal runs Codex in the
   directory, the rollouts of the dated directories from the day before
   the process started to the day after now (at most 9 days back, and the
   3 days around the start), written since the start, whose first line is
   a `session_meta` of the directory made since the start (at most 256
   first lines read, 1 MiB each, kept by path): the only one is `start`,
   the most recently written of several a `guess`.

`Stamp` is a cheap fingerprint of what `Resolve` reads: the mtime and size
of Claude Code's record and its `sessions` directory (and of the projects
directories while nothing or only a guess is known), the newest rollout's
name and the count in each dated directory of Codex's (and the newest
one's mtime while the answer is a guess). The caller polls it with a few
stats and resolves again when it changed.

`Locate(kind, id)` finds a session's transcript. The id must be a
lower-case UUID before it reaches a path (`ErrBadID`). Claude Code's are
`projects/*/<id>.jsonl` of the agent's user's configuration directories;
Codex's are `rollout-*-<id>.jsonl` in `sessions` (its dated directories)
and `archived_sessions` of `$CODEX_HOME` and `~/.codex`, looked for first
in today's directory and the day a time-ordered id (UUID version 7) names,
and then, when not found, by walking at most 5000 dated directories. The
file must resolve through links to a regular file of the user's with one
name (a hard link to a file elsewhere has two) still inside the kind's
root; the newest of several wins; a `.jsonl.zst` of the session is
`ErrCompressed`. A Claude Code session's subagents' transcripts
(`<id>/subagents/*.jsonl`, at most 256) are checked the same way.
`OpenLocated` opens the file so that no link anywhere on its path is
followed (`openat2` with `RESOLVE_NO_SYMLINKS` on Linux 5.6 and later,
`O_NOFOLLOW_ANY` on macOS 11 and later, else one component at a time with
`O_NOFOLLOW`), without blocking, and checks the descriptor: a regular file
of the user's with one link, the device and inode `Locate` saw. A file
replaced since is located again once. An id without a transcript is
searched for at most once a second: for Claude Code every projects
directory; for Codex the dated directories of the days around today and
around the day a time-ordered id names, and every dated directory (up to
5000) at most once in 3 s. The resolver's maps hold at most 1024 entries each.

### The detector's part

When the agents plugin is on (`plugins.agents.enabled`), the core opens
the detect stream ([25](25-agent-detection.md)) with `Header.Sessions`;
without it the agent reads no session file. For each terminal whose agent
has a transcript parser, a goroutine with the agent's lifetime asks
`Resolve` once the 3 s startup grace is over. While nothing is found it
asks again after 1, 2, 4 and 8 s, then at every status change, every 30 s
and whenever `Stamp`, checked every 2 s (Claude Code) or 5 s (Codex),
changed. Once a session is found it checks `Stamp` at the same pace and
resolves again when the stamp, the foreground pid or its command line
changed; the same process keeps the session it had when a new `Resolve`
finds none. One `Resolve` runs at a time per stream,
within 10 s. A new session is a line of its own carrying the current
status, every line carries the last session found, and the line that clears
an agent clears it (`internal/agent/agentdetect_session.go`).

The core takes a session only as a lower-case UUID with a known source
(`checkSession`) and keeps it in the terminal record as `agent_session` and
`agent_session_source` ([22](22-terminal-protocol.md)), which a record
lacks while no session is known. The `agent` event always carries both,
`null` when unknown, so a page that merges the event into its record
loses a session that ended: another agent in the terminal, the agent
gone, or the plugin switched off. A line that changes only the session is
no news: no `/ws` message, sound or notification, and the status stays
the core's.

### The terminal leaf

A terminal's leaf in the layout document ([22](22-terminal-protocol.md))
may hold `session` (a lower-case UUID: the session the agent runs) and
`before` (the address of the terminal this one took the place of). A
value of another type or shape is dropped when the document is read, and
so is `render`, which earlier versions wrote (`"native"`: the pane showed
the agent's conversation over its terminal), whatever its value.
`setTerminalFields` changes only `session` and `before`, of every leaf of
the address, and never writes `render`. The restore remembers `session`
and writes `before` ([33](33-workspace-restore.md)); the terminal history
adopts a snapshot by `before` ([36](36-terminal-history.md)).

### Transcripts (`internal/agent/transcript`)

The parser reads a session's conversation on its machine. The chat
host's Claude Code adapter reads with it: a session imported into a chat
and what a handed-off session did in a terminal (`EachClaude`), and the
tool results of a live chat (`ClaudeFrame`, the same mapping;
[37](37-agent-chats.md)). No route sends a transcript's pages to the
page.
`Tail(kind, file, ref, limits)` reads one page of a transcript into events
shaped as the Agent Client Protocol's (ACP v1) `session/update`
notifications (`internal/agentproto/transcript.go`): `{seq, t, at}` and,
by `t`, `update` (the update member of `session/update`), `user` (the
prompt's ACP content blocks), `turn` (`state` `start`, `end` or `error`
with a `stopReason`) or `notice` (`method` `_<slug>/<name>`: `compacted`,
`command`, `error`, `model`, `skipped`, with `params`). The product's own
marks are under `_meta.<slug>` (`truncated`, `image`, `model`, `phase`,
`exitCode`, `interrupted`, `lines`). Each event is made from its line
alone, so the machine keeps nothing between reads.

- **Cursors.** An event's `seq` is its line's offset times 256 plus its
  index in the line (`agentproto.Seq`; exact in JavaScript for files below
  32 TiB, which a browser holding one compares and sends back and never
  takes apart). A reader's first read is a read back from the end (`from`
  0, `back`): the page ending with the last complete line, whose `next` is
  where forward reads go on; a back read before `first` gives earlier
  pages until `more` is false. A line still being written is not read
  until it ends.
- **Starting over.** A forward cursor that is no line's start any more
  (the file was replaced or truncated) is answered as a first read, and
  `file`, a digest of the file's device, inode and first line (never its
  path), tells a reader that it changed.
- **A page** has `kind`, `session`, `file`, `first`, `next`, `events`,
  `more`, `unknown` (lines read that made no event, whose content is not
  sent), `title` (the session's title the lines read give: the user's
  `custom-title` before Claude Code's `ai-title` or `summary`) and `code`
  (`not_found`, `compressed`, `bad_request`) when nothing was read.

Claude Code's lines:

| Line | Events |
| --- | --- |
| `user` with a text prompt (not `isMeta`, not a compaction's summary) | `turn` start, `user` |
| `attachment` `queued_command` of `commandMode` `prompt` whose `origin.kind` is `human`, or without an `origin` (a client of the SDK protocol's message; not `isMeta`, not a subagent's): a message sent while the agent worked | `user` without a `turn` start (it joins the running turn); a command's text makes its notice, as in a `user` line |
| any other `attachment` (other agents' messages, task notifications, the environment, skill listings) | nothing, not counted |
| `user` with `<command-name>`, `<local-command-stdout>`, `<bash-input>` and the like; `system` `local_command` | notice `command` (`name`, `args`, `output`) |
| `[Request interrupted by user…` | `turn` end, `cancelled` |
| `user` with `tool_result` blocks | `tool_call_update` (`failed` for `is_error`, with the exit code Claude Code words); its `toolUseResult` gives an edit's diff (old and new text, or each of `edits`), a write's new text over the original, a read's location and line count, a command's stdout and stderr |
| `assistant` `text`, `thinking`, `redacted_thinking`, `image` | `agent_message_chunk` (`_meta` model), `agent_thought_chunk` (Claude Code keeps the thinking's text empty), a placeholder block |
| `assistant` `tool_use` | `tool_call`: `Edit`, `MultiEdit`, `Write`, `NotebookEdit` edit; `Bash` and the shell tools execute; `Read` read; `Grep`, `Glob`, `LS` search; `WebFetch`, `WebSearch` fetch; `Task`, `Agent` think; `ExitPlanMode` switch_mode; others (MCP tools) other; `TodoWrite` a `plan` |
| `message.usage` | `usage_update` (`used`: input and cache tokens; no `size`, the transcript has no context window), once per `message.id` in a page |
| `system` `turn_duration`, `compact_boundary` | `turn` end; notice `compacted` (`trigger`, `preTokens`) |
| `assistant` whose response stopped (`end_turn`, `max_tokens`, `refusal`…), its last block not a thought: the turn's end in a session of the SDK protocol, whose transcript has no `turn_duration` lines | `turn` end with the stop reason |
| an API error (`isApiErrorMessage`, model `<synthetic>`) | notice `error` |
| `ai-title`, `summary`, `custom-title` | the reply's `title` |
| a subagent's line (`isSidechain`), any other type (the program's own state) | nothing, not counted |
| not a JSON object with a type, a message of another shape | counted in `unknown` |

Codex's lines, in the form a rollout's lines tell (an `item_completed` or
a `task_started` with `turn_attribution` is the newer form, `user_message`
and the other older `event_msg` messages the older; the nearest telling
line before the page within 1 MiB or 2000 lines decides, else the first in
the page):

| Line | Events |
| --- | --- |
| `event_msg` `task_started`, `task_complete`, `turn_aborted` | `turn` start; end; end `cancelled` |
| `event_msg` `token_count` | `usage_update` (`used`: the last request's input tokens, `size`: the model's context window) |
| `item_completed`: `UserMessage`, `AgentMessage`, `Reasoning` | `user`; `agent_message_chunk` (`_meta` phase); `agent_thought_chunk` of the summary |
| `item_completed`: `CommandExecution`, `FileChange`/`PatchApply`, `McpToolCall`, `WebSearch`, `TodoList`, `ImageView` | `tool_call` execute with its output and exit code; edit with an ACP v2 diff (`changes`, `patch`); other; fetch; `plan`; read |
| older form: `event_msg` `user_message` (without the injected `<environment_context>`), `response_item` `message`, `reasoning`, `function_call` and `custom_tool_call` (shell, `apply_patch`, `update_plan`, `view_image`, others), their outputs, `local_shell_call`, `web_search_call` | as the items |
| newer form: `response_item` | nothing (the items again) |
| `turn_context` with another model; `compacted` | notice `model`; notice `compacted` |

Bounds: a page takes at most `limits.Bytes` (1 MiB) of events and at least
one; an event's text at most 256 KiB, a tool call's output 32 KiB (its
start and its end), a tool call's input 256 items a list, 16 levels and
the text bound per string, a tool call's title 1 KiB and the session's
512 bytes; cut
text is marked `truncated`, and an event too large for the page is a
notice `skipped` in its place. A line makes at most 256 events (an index
takes the low 8 bits of `seq`) from at most 1024 content blocks and 32768
decoded JSON values; one longer than 8 MiB is skipped with a notice
`skipped` and the read goes on after it. A read reads at most 64 MiB of the
file, the look back included, and ends with its context.

### The agents plugin

Its switch, `plugins.agents.enabled` (on by default), turns finding the
sessions on the machines on and off (the detector's part, above). On the
page (`web/src/plugins/agents`) it adds one button to terminals' headers,
**Continue in Chat** (`ContinueInChat.tsx`): for a terminal whose agent
ran a session of a kind with chats and quit, while the leaf remembers the
agent and its session and no agent runs there, it opens that session as a
chat with the chat plugin on ([37](37-agent-chats.md)).

Core (`internal/plugins/agents`), a machine's route:
`GET /api/m/{id}/p/agents/resolve?kind=&session=&cwd=`: `{ok}` when the
agent kept the session's transcript and it records the directory `cwd`,
else `{ok: false, code}` (`not_found`, `other_cwd`, `compressed`,
`bad_request`); within 15 s, at most 8 at once per machine (`429 busy`),
since each may search the machine's session directories for an id it
does not know. It checks everything a request names (a kind with a
transcript parser, a lower-case UUID, an absolute directory of at most
4096 bytes of UTF-8 without NUL; `400 bad_request`) before asking the
machine, which checks it again; the machine's answer is decoded into the
reply's type, so nothing else reaches the page. It only reads: a
read-only core answers it, and it is not audited, as the file explorer's
reads are not. With the plugin off it answers `404 plugin_disabled`.

Machine (`internal/agent/plugin/agents`): `resolve` reads only what the
transcript says of itself (Claude Code's first conversation line, Codex's
`session_meta`) and compares its directory with the one asked about,
which it never opens. Replies carry codes, never an error's text, which
would name a path. Any other action, the `tail` of earlier versions
included, is `bad_params`.

### The conversation view (`web/src/conversation`)

`model.ts` reduces events to items: the user's prompts, the agent's
messages and thoughts, tool calls, the plan and notices, with the
context's usage and the session's title. Rules: an event whose `seq` is
not above the highest taken was taken already and is passed over; chunks
of a message join by their `messageId`, else with the item before when it
is the same kind; the same prompt again in the same turn, right after
itself, is one; a tool call is an item by its `toolCallId`, an update's
present members replace the item's, an update may come before its call,
and a call does not take a settled status back; a turn has one plan, which
a later `plan` replaces where it first came; `usage_update` keeps a size
it knew; a turn that ends for `cancelled`, `max_tokens`,
`max_turn_requests` or `refusal`, or fails, adds a notice; `reset` starts
over; a page of earlier events goes before the items, the overlap passed
over and its last message continued by the later page's chunks. Events
and updates of kinds the view does not show are counted, and the list
says how many. Only the item an event changes is drawn again. Events come
from a machine and are not trusted to have the shapes declared: the
reducer checks the type of every member it keeps, a member is read as
text only when it is a string (`asText`), and malformed events and blocks
are passed over or counted among the entries not shown.

`Conversation.tsx` draws the last 300 items; **Show Earlier Messages**
draws 300 more, then asks a source that has them for an earlier page. The list keeps
to its end while the user is there (24 px of slack) and keeps the user's
place when items come before; **Jump to Latest** shows while scrolled
away. Prompts show as typed (long ones folded), the agent's messages as
Markdown (`web/src/markdown`: tables, formulas typeset by KaTeX, code
highlighted), a thought as one line that opens, a tool call as a row that
opens on its command line, exit code and output (escape sequences
dropped, carriage returns applied), its diff (by lines' longest common
subsequence up to 2000 lines a side, or a patch's lines), what it read,
searched or fetched, or its input; the plan as a checklist, notices as
separators, the context in use as a meter when its size is known. In the
agent's messages a paragraph that is only one formula written between
`$$` and `$$` on one line, as both agents write display formulas, is
shown as display math (centered, display style), as a formula block
would be (`displayMath`); a formula within a line of text stays inline,
and fenced code blocks and code spans are left as written. A closed tool
call's row counts the lines a text diff adds and removes only when that
takes at most 100 000 pairs of lines compared; the diff itself is
compared when the call is opened. What is read out to screen readers is
the agent's last message, at most 2000 characters taken from its first
4000.

The view and its reducer know only `ChatSource`
(`web/src/conversation/source.ts`): `subscribe` (the events the source
has, then each new one: an `info` with the chat as the host states it
after each attach, `reattach` before a replay after the connection came
back, `reset` when they no longer hold), `loadEarlier` (optional), `send`
(with the page's id of the message), `cancel`, `respond` (a permission),
`answer` (a question), `setConfig`, `cancelQueued`, `compact`,
`suggestFiles`, `trust` and `untrust`; each command rejects with a code.
The chat host's events add permissions, questions and their answers,
queued messages, the chat's state and what it states, live increments of
items being written and subagents' items under their call: the reducer
replaces what came live for an item with its stored event (or a stored
notice under the item), drops items that only came live when it attaches
again, keeps them as they are once their turn ended without one, and keys
tool calls apart from the host's items (`tool:<id>`). The chat panes draw the view with the cards and the
composer (with custom-styled popover selectors for model, effort and
mode that position upward near the bottom of the viewport and support
keyboard navigation, [37](37-agent-chats.md)); the tests also drive it
with sources of their own.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A new kind of layout leaf for an agent's terminal instead of fields on the terminal leaf | Everything that knows terminal leaves (status dots, where a notification leads, Send to Agent, closing, kept panes, replacement after a core restart) would need a second path, and older clients would show an unknown node without a pane. With fields the pane stays a terminal everywhere. |
| Hooks in the agents' configuration | Writes into the user's configuration of each agent, shared with every other way they run it; the process, the agent's record of it and its transcript tell the session without that. |
| Parsing transcripts away from their machine (in the core or the page) | Whole files, mostly the program's own state (lines of 100 KB and more), would cross the connection; the machine parses them where they are and makes pages of events within bounds. |
| A path in the browser's request | A path is anything; a kind and a UUID name only a session's transcript inside the kind's own root. |
| Remembering a guessed session in the layout, or resuming by id without the machine's confirmation | A guess may be another terminal's, and the layout is written by every client of the machine ([33](33-workspace-restore.md)). |

## Failure modes

- **No session yet** (Codex before its first prompt; Claude Code before
  its record is read) → the record has no `agent_session`; a restore then
  continues the directory's latest conversation. Codex's session is found
  once its rollout appears: at the status change of its first turn, or at
  the next check of the stamp.
- **No transcript yet** (before the first prompt) → `resolve` answers
  `not_found`, and a restore continues the directory's latest
  conversation.
- **A child session** (Claude Code that inherited
  `CLAUDE_CODE_CHILD_SESSION`) → no record, no transcript, no session. The
  agent drops the agents' session markers from what its terminals inherit
  ([21](21-terminal-core.md)), so a terminal of the terminal core gets
  none.
- **On macOS** a process's environment and open files are not read, so a
  Claude Code whose own `CLAUDE_CONFIG_DIR` differs from the agent's is
  not found there, and the `fd` source does not exist. A transcript under
  a configuration directory that only the agent's process names (Linux)
  is found by `Resolve` but not by `Locate`: `resolve` says `not_found`.
- **A guess** → taken only while no other terminal runs that kind in the
  directory; never remembered in the layout nor shown as the session's
  usage ([29](29-ai-usage.md)). Another program of the user's working in
  the same directory can still be guessed.
- **A transcript format changes** → lines the parser does not know make no
  event and are counted (`unknown`); new kinds of lines of the programs'
  own state are skipped without a count.
- **A compressed transcript** → `compressed`.
- **A transcript hard-linked by a backup tool** (`cp -al`, rsnapshot) →
  the file has two names and is not taken: `not_found`.
- **The plugin is turned off** → its route answers `plugin_disabled`, the
  detect stream is opened again without sessions (records lose
  `agent_session`, and the `agent` events say so to open pages, so they
  lose it too); the leaves keep `session`. The agents are detected again
  without notifying again of a block or a turn's end the pages were told
  of ([25](25-agent-detection.md)).
- **A layout written by an earlier version** → its leaves' `render` is
  dropped as the document is read, and the panes show their terminals.

## Security

What leaves a machine, and when: while the plugin is on, the session id
(a lower-case UUID) and its source word for each agent terminal through the
detect stream; for a `resolve`, whether the session ran in the directory
asked about, as a code. No transcript's conversation is sent. A browser
names a session only by a kind and a UUID, checked on the core and again
on the machine; the transcript is found inside the kind's root, resolved
and still inside it, opened through no link as a regular file of the
user's with one name and the identity it was found with, and parsed as
hostile within the bounds above. The route is a read, allowed on a
read-only core and not audited. See the rows on coding agents' sessions
and on agent detection in [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agentkinds/agentkinds_test.go`: the kinds against the
  detector's manifests, `uisettings.Agents` and the usage providers; the
  commands the UI had before; only a UUID substituted; copies; the chat
  specs and their JSON (`TestChatKinds`, `TestKindJSON`).
  `scripts/registry/main_test.go` (`TestAgents`): the kinds in the
  generated registry.
- `internal/agent/sessions`: Claude Code's command line, records (trusted
  and refused, `startedAt`, an own configuration directory, the `.key`
  never opened), wrappers, the guess, the escaped names, `/proc`
  (`claude_test.go`); Codex's command line, the rollouts of a directory
  since the start, stamps, open files, dated directories, `session_meta`,
  names (`codex_test.go`); `Locate`: bad ids, Claude Code's and Codex's
  files, misses, compressed files (`locate_test.go`); opening through no
  link after a swap, a replaced file, hard links, other owners, subagents,
  the walk (`open_test.go`); the process table (`proc_test.go`). These
  and `internal/agent/transcript`'s ran on Linux x86_64 too, and the
  sessions package's in a Linux container both with `openat2` allowed and
  with it denied by seccomp (the walk one component at a time).
- `internal/agent/agentdetect_session_test.go`: the schedule, a process
  change, peers, the kinds that have sessions, a stream without
  `sessions` reading no session file, concurrency.
  `internal/server/term_session_test.go`: the record's and the event's
  session, a session-only change without a `/ws` message, `checkSession`,
  the header following the plugin's switch, a session found through a real
  agent and lost when the plugin is turned off; a session that ends
  leaving the events (null) and the record when another agent takes the
  terminal, when the agent leaves and another starts, and when the plugin
  is switched off (`TestTermAgentSessionEnds`); the agents detected again
  after a switch without a second notification
  (`TestTermRedetected`, `TestTermSwitchNotifiesOnce`). `TestIntegrationDetect`
  (`make it`) checks that a stand-in program named `claude` has none; it
  passed against the pinned herdr-core 0.1.21 for linux/arm64 in an
  isolated Linux container (Debian, an unprivileged user, no network).
- `internal/agent/transcript`: the shared vectors (`vectors_test.go`,
  also read from every line and in pages), cursors from every `seq`, a
  partial last line, a cut inside a line, reset cursors, file identity,
  `Changed`, long lines, truncation, events too large, 256 events a line,
  invalid UTF-8, usage once per message, Codex's form at a page's start,
  the reply's size, the last page (`transcript_test.go`); memory per line,
  replaced usage let go, the 64 MiB budget, walking past a long line, a
  cancelled read, oversize events (`bounds_test.go`); `FuzzTail`,
  `FuzzLineMemory`.
- `design/testdata/transcript/`: `claude-2.1.330-tools.json`,
  `codex-0.170.0-exec.json` and `claude-headless.json` (real transcripts,
  sanitized; the last of a session driven through the SDK protocol:
  turns without `turn_duration` lines, queued messages without an
  origin), `claude-session-events.json`, `claude-tools-errors.json`,
  `claude-unknown.json`, `claude-queued-prompts.json` (messages sent while
  the agent worked, in the shape measured on real transcripts),
  `codex-items.json`, `codex-legacy-apply-patch.json`
  (hand-written in the programs' shapes); the Go tests and
  `web/src/__tests__/transcriptVectors.test.ts` run every one.
  `design/testdata/layout/agent-leaves.json`: the leaf's fields.
- `internal/plugins/agents`: the route, validation, the reply checked,
  the request ending with its HTTP request
  (`TestResolveEndsWithItsRequest`), its limit (`TestResolveBusy`), and
  the whole path with the machine side (`agents_unix_test.go`).
  `internal/agent/plugin/agents/agents_test.go`: unknown actions,
  `resolve`, the shared resolver.
  `internal/agentproto/transcript_test.go`: the events' JSON, cursors,
  pages, `Seq`.
- `web/src/__tests__`: `agents.test.ts` (the plugin is its switch and
  one header button), `chatImport.test.tsx` (**Continue in Chat**),
  `agentLeaves.test.ts` (the leaf's fields, `render` dropped),
  `conversation.test.ts` and `conversationMemo.test.tsx` (the reducer and
  what is drawn again), `conversationView.test.tsx` (messages, display
  math from one-line `$$` paragraphs with code left as written, what is
  read out, tool calls, a patch's lines outside hunks, a long text diff
  compared only when opened, composer, drafts per source, list, events of
  shapes no parser makes), `agentKinds.test.tsx` (the palette's agents).
- Run on real programs (macOS, Claude Code 2.1.330, Codex CLI 0.170.0,
  herdr-core 0.1.21): the record and its rewrite on `/clear`,
  `--session-id`, the transcripts made at the first prompt, no files of a
  child session; Codex's rollout made at the first prompt and not held
  open. The two real vectors are transcripts of these runs.
