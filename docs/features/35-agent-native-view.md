# 35 · Coding agents' conversations in their panes

## Context

Claude Code and Codex run as programs in the machines' terminals
([21](21-terminal-core.md)). Their interfaces draw on the alternate screen:
a table or a formula an agent writes is characters in cells, a long
conversation scrolls inside the program, and a diff is colored text. The
page knew which agent runs in a terminal and what it does
([25](25-agent-detection.md)), but not which conversation it is in, so
after a restart it could only continue the directory's latest one
([33](33-workspace-restore.md)).

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
  `done`, with a `msg` such as `approve Write: /path`), and a dialog of
  theirs can be open while the state is not `blocked`. Text pasted into
  either interface and an Enter start a turn, several lines included.

## Goals / non-goals

Goals: the session each agent terminal runs, found on the machine without
changing the agents' configuration; a pane that shows the agent's
conversation natively (Markdown with tables, formulas and code, thoughts,
tool calls with their output and diffs, the plan, notices), and the CLI
again in one step, for every client of the machine; the agent still the
CLI in its terminal, attached under the view, which shows whenever the
agent waits for the user; a message box that types into the CLI; a tab
that starts an agent shown this way; another kind of agent added by a row
of a registry and, for its conversations, a parser; a view that knows its
events only through an interface (`AgentSource`).

Non-goals: replacing the CLI (permission dialogs, slash command menus,
model pickers stay its own: the terminal shows for them); text as the
agent generates it (the transcripts are written a block at a time);
changing the agents' configuration (hooks); images in the view (a
placeholder stands for each); subagents' conversations; transcripts kept
compressed; a native view of agents other than Claude Code and Codex.

## Design

### Agent kinds (`internal/agentkinds`)

The registry of the coding agents the terminals recognize: for each kind
its `ID` (the detector's manifest id, [25](25-agent-detection.md)), `Title`,
`UsageProvider` (the AI usage plugin's provider, [29](29-ai-usage.md)),
`Start` (the argv that starts it), `NewSession` (appended to `Start` to
start it with a session id the caller chose), `ContinueLatest` (the command
that continues the directory's latest conversation), `ResumeByID` (the
command that resumes a session by its id) and `Transcript` (the parser of
its transcripts, or none). It is data only and builds for every system the
core runs on.

| Kind | Start | New session | Continue latest | Resume by id | Transcript |
| --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | `--session-id {id}` | `claude --continue` | `claude --resume {id}` | `claude` |
| `codex` | `codex` | – | `codex resume --last` | `codex resume {id}` | `codex` |
| `gemini`, `opencode`, `kimi`, `grok`, `cursor`, `copilot`, `qwen`, `amp` | its id | – | – | – | – |
| the other 12 the detector knows | – | – | – | – | – |

`scripts/registry` writes the kinds into `design/generated/registry.json`
(key `agents`; `make tokens`), which the page reads
(`web/src/conversation/kinds.ts`): the palette's agents to start, the
commands a restore types (`resumeCommand`), the new agent tab
(`startArgv`), the AI usage provider of a session and whether a kind has a
native view (`hasNativeView`). `uisettings.Agents`, the list of silent
agents, is made from it. A placeholder is replaced only by a lower-case
UUID (`ValidSessionID`, `isSessionId`); any other value makes no command.

Adding a kind: a row in `kinds`, the detector's manifest of the same id
(`TestKindsMatchManifestsAndSettings` holds the kinds, the manifests and
`uisettings.Agents` to the same ids, and the providers to the AI usage
plugin's), then `make tokens`. For a native view also: a parser in
`internal/agent/transcript` (`formats`), how `internal/agent/sessions`
finds its sessions and transcripts, `ResumeByID` and `ContinueLatest`
(the test requires them of a kind with a transcript), the vectors of its
lines in `design/testdata/transcript/`, and the new-tab item's message
`agents.newTab.<id>` in `web/src/plugins/agents/i18n/`.

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
may hold `render: "native"` (shown as the agent's conversation; absent:
the terminal), `session` (a lower-case UUID: the session the agent runs)
and `before` (the address of the terminal this one took the place of). A
value of another type or shape is dropped when the document is read, and
`setTerminalFields` changes only these three, of every leaf of the address.
The switch writes `render`; a new agent tab writes `render` and, for Claude
Code, `session`; the restore remembers `session` and writes `before`
([33](33-workspace-restore.md)).

### Transcripts (`internal/agent/transcript`)

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
  32 TiB, which the page compares and sends back and never takes apart).
  A view's first read is a read back from the end (`from` 0, `back`): the
  page ending with the last complete line, whose `next` is where forward
  reads go on; a back read before `first` gives earlier pages until `more`
  is false. A line still being written is not read until it ends.
- **Starting over.** A forward cursor that is no line's start any more
  (the file was replaced or truncated) is answered as a first read, and
  `file`, a digest of the file's device, inode and first line (never its
  path), tells a reader that it changed.
- **The reply** has `kind`, `session`, `file`, `first`, `next`, `events`,
  `more`, `unknown` (lines read that made no event, whose content is not
  sent), `title` (the session's title the lines read give: the user's
  `custom-title` before Claude Code's `ai-title` or `summary`) and `code`
  (`not_found`, `compressed`, `bad_request`) when nothing was read.

Claude Code's lines:

| Line | Events |
| --- | --- |
| `user` with a text prompt (not `isMeta`, not a compaction's summary) | `turn` start, `user` |
| `attachment` `queued_command` of `commandMode` `prompt` whose `origin.kind` is `human` (not `isMeta`, not a subagent's): a message sent while the agent worked | `user` without a `turn` start (it joins the running turn); a command's text makes its notice, as in a `user` line |
| any other `attachment` (other agents' messages, task notifications, the environment, skill listings) | nothing, not counted |
| `user` with `<command-name>`, `<local-command-stdout>`, `<bash-input>` and the like; `system` `local_command` | notice `command` (`name`, `args`, `output`) |
| `[Request interrupted by user…` | `turn` end, `cancelled` |
| `user` with `tool_result` blocks | `tool_call_update` (`failed` for `is_error`, with the exit code Claude Code words); its `toolUseResult` gives an edit's diff (old and new text, or each of `edits`), a write's new text over the original, a read's location and line count, a command's stdout and stderr |
| `assistant` `text`, `thinking`, `redacted_thinking`, `image` | `agent_message_chunk` (`_meta` model), `agent_thought_chunk` (Claude Code keeps the thinking's text empty), a placeholder block |
| `assistant` `tool_use` | `tool_call`: `Edit`, `MultiEdit`, `Write`, `NotebookEdit` edit; `Bash` and the shell tools execute; `Read` read; `Grep`, `Glob`, `LS` search; `WebFetch`, `WebSearch` fetch; `Task`, `Agent` think; `ExitPlanMode` switch_mode; others (MCP tools) other; `TodoWrite` a `plan` |
| `message.usage` | `usage_update` (`used`: input and cache tokens; no `size`, the transcript has no context window), once per `message.id` in a page |
| `system` `turn_duration`, `compact_boundary` | `turn` end; notice `compacted` (`trigger`, `preTokens`) |
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

Core (`internal/plugins/agents`), both routes a machine's:

- `GET /api/m/{id}/p/agents/tail?s=<kind>~<session>~<from>[~b]&…&wait=<ms>`:
  a page of each of 1 to 8 transcripts (`~b` reads the page before the
  cursor), waiting up to `wait` (0 to 15000) for one of them to have
  something new. At most 6 requests wait on a machine at once, and at
  most 2 of one client (the address it connects from, without the port;
  `X-Forwarded-For` is the client's own word and is not believed, so
  behind a proxy every client is the proxy): a request over either limit
  is read at once (`wait` 0) and, when it has nothing new, held by the
  core for at most 1 s (and not longer than its own wait) before it is
  answered, using nothing of the machine meanwhile. More than 16 requests
  of a machine at once, waiting or not, answer `429 busy`. The machine is
  asked within the wait and 30 s; a reply whose pages are not the ones
  asked for is `502 bad_reply`.
- `GET /api/m/{id}/p/agents/resolve?kind=&session=&cwd=`: `{ok}` when the
  agent kept the session's transcript and it records the directory `cwd`,
  else `{ok: false, code}` (`not_found`, `other_cwd`, `compressed`,
  `bad_request`); within 15 s, at most 8 at once per machine (`429 busy`),
  since each may search the machine's session directories for an id it
  does not know.

Both check everything a request names (a kind with a transcript parser, a
lower-case UUID, a decimal cursor, an absolute directory of at most 4096
bytes of UTF-8 without NUL; `400 bad_request`) before asking the machine,
which checks it again; the machine's answer is decoded into the reply's
types, so nothing else reaches the page. They only read: a read-only core
answers them, and they are not audited, as the file explorer's reads are
not. With the plugin off they answer `404 plugin_disabled`.

Machine (`internal/agent/plugin/agents`): `tail` opens each transcript
with `OpenLocated` and reads it with `Tail`, the refs sharing a reply of 4
MiB (each at most 1 MiB, `4 MiB / n`). At most 2 transcript reads run at
once in the agent; the others wait their turn until their request ends.
When nothing of any ref is new and the request waits, the plugin stats
each watched transcript every 250 ms (and reads its last line when it
grew), looks for those not found once a second, holds no file open in
between, reads every ref again on a change, and ends with the core's
request (the page closed or moved on). A read again that brought no event
(lines were appended that make none) is where the wait goes on from, so
such lines are read once, not at every look. `resolve` reads only what the
transcript says of itself (Claude Code's first conversation line, Codex's
`session_meta`) and compares its directory with the one asked about,
which it never opens. Replies carry codes, never an error's text, which
would name a path.

Page (`web/src/plugins/agents`):

- **Reading** (`transcript.ts`). A feed per session a surface shows, read
  by one poller per machine: one request in flight for every session the
  page shows on that machine (at most 8 a request, the next ones in turn
  when more are shown), the next as soon as one is answered. A session's
  first read asks for no wait and is a back read; later reads go forward
  from `next` and wait 15 s on the machine. A read is given up when the
  sessions shown change, and counts as failed 10 s after its wait; after
  a failure the next waits 1 s, doubling to 30 s, and what was shown
  stays (marked stale); a machine whose terminals come again, or the page
  shown again, ends that wait and reads at once. A session without a
  first page 5 s after it is shown, after a first read that failed, or
  after three first reads in a row that found the machine busy, has
  none to show (the strip below), and its reads go on. No read starts
  while the page is hidden or no surface shows a session. A forward read
  answered from another transcript file (the machine's `file` changed) is
  not taken: the feed starts over and reads that file's last page; a
  back read of another file starts the feed over with it. A feed keeps at
  most 20 000 events, and 8 feeds no surface shows are kept for a pane
  shown again.
- **What the pane shows** (`view.ts`, `Surface.tsx`). The session shown is
  the record's `agent_session`, else the leaf's `session`. With the leaf's
  `render: "native"` and an agent with a native view, the surface over the
  terminal is: a strip over the terminal's top while there is nothing to
  show (no session found yet, no transcript yet, a compressed one, no
  first page that could be read: "The conversation cannot be read right
  now; trying again", also on a read-only page; or the agent waiting for
  an answer before its first page came), with **Terminal View** (not on a
  read-only page), the terminal staying visible and usable; the whole
  pane with a spinner until the first page is read; the conversation
  over the whole pane; or, while the agent's status is `blocked`, the
  conversation over the upper part of the pane (38 %, at least 7rem) with
  a line naming what the agent waits for (the record's status `msg`) and
  **Show Terminal**, the terminal shown below at its size. `covers` says
  the same at render time from the leaf, the record and the feed's state,
  so a pane shown again is covered from its first frame; while the agent
  waits it says nothing, and the surface covers the upper part as it
  draws it.
- **Where the question is** (`waitingView`). While the agent waits, the
  surface reads the terminal's screen (its rows as text) and the rows its
  upper part would cover. When all the terminal shows is under that part
  and nothing below it (Codex draws its first dialogs at the top of a
  cleared screen), or the screen cannot be read, the terminal is shown
  whole, the conversation kept in its place unseen, with a strip saying
  what the agent waits for, over the terminal's blank bottom (over its top
  when the screen cannot be read) and **Show Conversation**, which brings
  the upper part back until the agent stops waiting (its **Show Terminal**
  then goes back to the terminal shown whole). A CLI draws its dialog a
  moment after its status, so the screen is read again every 250 ms until
  the answer held for 3 s, and anew when what the agent waits for
  changes; a user writing a message keeps the upper part. Neither way
  changes the terminal's size.
- **The keyboard** (`Surface.tsx`) follows what the surface draws, in the
  pane that has the focus and only while nothing else on the page has it
  (a field, a dialog, another pane, the terminal itself): the composer
  (the list on a read-only page) when the conversation is drawn over the
  terminal, the spinner's box before it; the terminal when the strip is
  shown over it (a new agent tab before its first prompt, so the user can
  type it) or when the agent begins to wait for an answer. When the agent
  begins to wait while the user is writing a message (text in the
  composer, or a key pressed in it within 1.5 s, `WRITING_MS`), the short
  view keeps the composer and the keyboard in it, and only the line says
  what the agent waits for; Enter sends nothing while the agent waits, so
  the user's next Enter does not answer the agent's question. The
  terminal takes the keyboard when the user clicks it, or with **Show
  Terminal**, which shows the terminal alone. Each of the strip, the
  spinner and the conversation is an element of its own, so the keyboard
  never stays on one drawn for another.
- **The switch.** A button in the header of a terminal that runs an agent
  with a native view (`ViewToggle.tsx`; it stays in narrow headers and in
  panes without the focus) and the command `agents.toggleView` (the
  focused terminal; no default key, every candidate being taken by a
  terminal or a program in it) write the leaf's `render`, so every client
  of the machine follows. A read-only page shows the button disabled and
  follows the layout.
- **A new agent tab.** The new-tab menu has **Agent: Claude Code** and
  **Agent: Codex**; `agents.newTab` (no default key) starts the first kind
  in the workspace shown. The agent is the terminal's program
  (`terminal.run` with its `Start`), in a new tab whose leaf has
  `render: "native"` from the write that places it; Claude Code is started
  with `--session-id` and a new UUID, which the leaf remembers, so its
  session is known before any file exists. Codex's is found after its
  first prompt.
- **The message box** (`TranscriptSource.send`). The text is pasted into
  the terminal (bracketed when the program asked for it), and Enter is
  typed 250 ms later: Codex takes an Enter right after a burst of text as
  a new line. Before the paste, and again before the Enter, the page
  checks that it is not read-only, that the terminal is on the page and
  still runs the session's agent (its record is live and names the
  feed's kind), and that the agent does not wait for an answer. A check
  that fails before the paste refuses the message (`read_only`,
  `detached`, `blocked`); one that fails before the Enter leaves the
  pasted text in the agent's input without pressing Enter (`pasted`): an
  Enter then would answer a permission dialog with its default, or run
  the text in a shell. The box says why, and for `pasted` asks the user to
  check the terminal; the text stays in the box. A message counts as sent
  once, within 10 s, the transcript has it after the send as the user's
  prompt: the same text, or a prompt containing it, runs of white space
  compared as one space; a prompt longer than the transcript keeps of an
  event's text (256 KiB) by its first 4096 characters. A message that
  starts with `/` or `!` (a command of the agent's interface or of its
  shell) counts as sent also by the first command notice after it, which
  confirms the oldest such message waiting, without comparing its name.
  Otherwise the box says it has not shown in the conversation and offers
  **Show Terminal**, since a dialog of the agent's may have taken the
  text. **Stop** (while the agent works) types Escape, the key both agents
  stop a turn with.
- **Find** (`find.open`) on a terminal its conversation covers shows the
  terminal first (the leaf's `render` removed), then opens find in it; a
  read-only page cannot, and the command is disabled there.

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
says how many with **Show Terminal**. Only the item an event changes is
drawn again. Events come from a machine and are not trusted to have the
shapes declared: the reducer checks the type of every member it keeps, a
member is read as text only when it is a string (`asText`), and malformed
events and blocks are passed over or counted among the entries not shown.

`Conversation.tsx` draws the last 300 items; **Show Earlier Messages**
draws 300 more, then asks the source for an earlier page. The list keeps
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
4000. The box below takes Enter to send, Shift+Enter or Alt+Enter for a
new line, nothing while an input method composes; it is greyed while a
message is on its way, sends nothing while the agent is blocked, and is
not there on a read-only page, in the upper part shown while the agent
waits (unless the user was writing, above), or for a source that takes
no input. Text typed in it and not sent is a draft of the session's view
in that terminal (one source per feed and terminal, `sourceOf`), kept in
the page's memory: it stays when the terminal is shown instead, when
another tab is shown and when the agent disappears for a moment, and is
gone once sent; another session (after `/clear`) starts with an empty
box.

### The source (`AgentSource`)

The view and its reducer know only `AgentSource`
(`web/src/conversation/source.ts`): `capabilities` (`input`: `terminal`,
`direct` or `none`; `permissions`; `streaming`), `subscribe` (the events
the source has, then each new one; `reset` when they no longer hold),
`loadEarlier`, `send`, `cancel` and `respond`. Its one implementation is
`TranscriptSource` (`web/src/plugins/agents/transcript.ts`): input
`terminal` (`none` on a read-only page), no permissions, no streaming.

### Surfaces over web terminals

The page draws a plugin's surface in a layer over a terminal's pane, below
its header, which takes none of the terminal's room
([27](27-plugins.md): `terminalSurfaces`, `headerActions`). A surface that
covers all of the terminal makes it covered
([26](26-web-terminals.md)): attached, measured and resized with its pane,
its output taken and acknowledged, nothing drawn, no bell, no keyboard and
no Tab stop. Text pasted or typed into the pane (Send to Agent, the message
box) still reaches the terminal (`paneHandle`, `withPane`), while focusing
the pane focuses the surface that registered with `useSurfaceFocus`
(`withView`). A terminal covered while it has the keyboard hands it to the
surface. Panes kept hidden draw no surface.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Embedding a third-party terminal renderer for agents (Tern) | A closed beta, a terminal application of its own that cannot be embedded in a page, and neither agent speaks its protocol; the page has Markdown, highlighting and KaTeX already. |
| A new kind of layout leaf for an agent instead of fields on the terminal leaf | Everything that knows terminal leaves (status dots, where a notification leads, Send to Agent, closing, kept panes, replacement after a core restart) would need a second path, and older clients would show an unknown node without a pane. With fields the pane stays a terminal everywhere and older clients show the CLI. |
| Rendering the view instead of the terminal (unmounting it) | The terminal is the pane's second child, which keeps its stream and emulator alive; a layer beside it leaves the terminal attached at its size, so the CLI is there at once. |
| Shrinking the terminal when the agent waits | A resize makes Claude Code lay itself out again and lose its scroll position ([22](22-terminal-protocol.md)); the surface shrinks and the terminal keeps its size. |
| A stream or a long poll per pane | Browsers open 6 HTTP/1.1 connections per origin: a page with several agent panes would hold them all and starve its other requests. One request per machine carries every session shown. |
| Hooks in the agents' configuration | Writes into the user's configuration of each agent, shared with every other way they run it; the process, the agent's record of it and its transcript tell the session without that. |
| Headless modes (`claude -p --output-format stream-json`, Codex's app server) | The agent would no longer be the CLI the user knows, with its dialogs, commands and keys, and the terminal would show nothing; the transcript is what the CLI writes anyway. |
| Parsing transcripts in the page | The page would fetch whole files, mostly the program's own state (lines of 100 KB and more), over the connection; the machine sends a page of events. |
| A path in the browser's request | A path is anything; a kind and a UUID name only a session's transcript inside the kind's own root. |
| `terminal.interrupt` (Ctrl+C) to stop a turn | Both agents stop a turn with Escape, and Ctrl+C at an idle prompt may quit them. |
| Enter with the paste | Codex tells a paste from typing by its pace and takes an Enter right after it as a new line. |
| Taking a session the message box sent as sent | A dialog of the agent's can be open while its status is not `blocked`, and takes the text; only the prompt in the transcript says it reached the agent. |
| Pressing Enter after the pause without looking again | The agent may have begun to wait for an answer meanwhile, and an Enter gives its dialog the default answer; or it left the terminal, and the shell runs the text as a command. |
| One number of waiting reads per machine, shared by every page | One client, a read-only one included, could hold every place with its long polls, and the conversations of the other pages would never load. A client has 2 of the 6, and a request over a limit is still read at once. || Remembering a guessed session in the layout, or resuming by id without the machine's confirmation | A guess may be another terminal's, and the layout is written by every client of the machine ([33](33-workspace-restore.md)). |

## Failure modes

- **No session yet** (Codex before its first prompt; Claude Code before
  its record is read) → the strip over the terminal says so; the
  terminal stays usable. Codex's session is found once its rollout
  appears: at the status change of its first turn, or at the next check of
  the stamp.
- **No transcript yet** (before the first prompt) → `not_found`: the
  strip; a waiting read looks for it once a second.
- **A child session** (Claude Code that inherited
  `CLAUDE_CODE_CHILD_SESSION`) → no record, no transcript, no session. The
  agent drops the agents' session markers from what its terminals inherit
  ([21](21-terminal-core.md)), so a terminal of the terminal core gets
  none.
- **On macOS** a process's environment and open files are not read, so a
  Claude Code whose own `CLAUDE_CONFIG_DIR` differs from the agent's is
  not found there, and the `fd` source does not exist. A transcript under
  a configuration directory that only the agent's process names (Linux)
  is found by `Resolve` but not by `Locate`: the view says `not_found`.
- **A guess** → taken only while no other terminal runs that kind in the
  directory; shown in the view, never remembered in the layout nor shown
  as the session's usage ([29](29-ai-usage.md)). Another program of the
  user's working in the same directory can still be guessed.
- **A transcript format changes** → lines the parser does not know make no
  event: counted (`unknown` on the machine, the reducer's own count on the
  page, which the list says), and the CLI is one click away. New kinds of
  lines of the programs' own state are skipped without a count.
- **A compressed transcript** → `compressed`: the strip.
- **A transcript hard-linked by a backup tool** (`cp -al`, rsnapshot) →
  the file has two names and is not taken: `not_found`, the strip.
- **A message not confirmed** in 10 s → the box says it has not shown in
  the conversation and offers the terminal; the text stays in the box. A
  message sent while the agent works shows, and counts as sent, once the
  running turn takes it up (Claude Code records it then); a turn that
  takes it up later than 10 s after the send leaves it unconfirmed.
- **Commands without a notice** → the parser makes no command notice of
  Codex's lines: a `/` command sent to Codex shows as not confirmed after
  10 s although it ran, with the same explanation. A
  command notice confirms the oldest command waiting, whatever its name.
- **The agent begins to wait, or leaves, during the 250 ms before Enter**
  → no Enter is typed; the pasted text may be in the agent's input, and
  the box says to check the terminal.
- **A dialog open while the status is not blocked** → the view stays over
  the terminal; the message box's text may go to the dialog (and is then
  not confirmed); the switch shows the CLI.
- **Text appears a block at a time**, when the agent wrote it to its
  transcript, not as it is generated; the status is live.
- **The transcript's file changes** (`/clear`, a replaced file) → a new
  session or a new `file`: the feed starts over from the new file's last
  page.
- **The machine does not answer** → reads back off up to 30 s, the view
  says it may not be current, and keeps what it shows; without a first
  page, the strip says the conversation cannot be read now, the terminal
  shows, and the reads go on.
- **More pages than a machine's waiting reads** (6 per machine, 2 per
  client) → a page over a limit reads about once a second instead of
  waiting on the machine; more than 16 reads of a machine at once →
  `429 busy`, read again after the back-off.
- **The plugin is turned off** → its routes answer `plugin_disabled`, the
  detect stream is opened again without sessions (records lose
  `agent_session`, and the `agent` events say so to open pages, so they
  lose it too), and panes show their terminals; the leaves keep `render`.
  The agents are detected again without notifying again of a block or a
  turn's end the pages were told of ([25](25-agent-detection.md)).

## Security

What leaves a machine, and when: while the plugin is on, the session id
(a lower-case UUID) and its source word for each agent terminal through the
detect stream, and, for a pane that shows a conversation, the
conversation's events, tool input and output included, cut to their bounds;
images never. A browser names a transcript only by a kind and a UUID,
checked on the core and again on the machine; the file is found inside the
kind's root, resolved and still inside it, opened through no link as a
regular file of the user's with one name and the identity it was found
with, and parsed as hostile within the bounds above. The routes are reads,
allowed on a read-only core and not audited. The message box and the stop
button type into the terminal only what the user could type, and never on
a read-only page. See the rows on coding agents' sessions and transcripts
and on agent detection in [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agentkinds/agentkinds_test.go`: the kinds against the
  detector's manifests, `uisettings.Agents` and the usage providers; the
  commands the UI had before; only a UUID substituted; copies.
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
- `design/testdata/transcript/`: `claude-2.1.330-tools.json` and
  `codex-0.170.0-exec.json` (real transcripts, sanitized),
  `claude-session-events.json`, `claude-tools-errors.json`,
  `claude-unknown.json`, `claude-queued-prompts.json` (messages sent while
  the agent worked, in the shape measured on real transcripts),
  `codex-items.json`, `codex-legacy-apply-patch.json`
  (hand-written in the programs' shapes); the Go tests and
  `web/src/__tests__/transcriptVectors.test.ts` run every one.
  `design/testdata/layout/agent-leaves.json`: the leaf's fields.
- `internal/plugins/agents`: routes, validation, the reply checked, the
  request ending with its HTTP request, the waiting limits per machine and
  per client with a request over them read at once and held at most 1 s,
  `busy` beyond 16 (`TestTailWaiting`), the client's address
  (`TestClientOf`), `resolve` and its limit (`TestResolveBusy`), and the
  whole path with the machine side (`agents_unix_test.go`).
  `internal/agent/plugin/agents/agents_test.go`: bad params, first and
  forward reads, codes, waits for an append and for a file to appear, the
  wait's limit and its end with the stream, the reply's bound, `resolve`,
  the shared resolver, reads taking turns (`TestReadsTakeTurns`), lines
  without events read once in a wait (`TestWaitReadsAnAppendOnce`).
  `internal/agentproto/transcript_test.go`: the events' JSON, `Seq`.
- `web/src/__tests__`: `agents.test.ts` (covers, the rows a box over the
  terminal covers and when a waiting agent's terminal is shown whole, the
  switch, the new agent tab, find), `agentsSurface.test.tsx` (the
  header's button, strip, loading, native, the upper part while blocked,
  a new session, a draft kept across the terminal shown instead and the
  pane drawn again, the keyboard handed over as what is drawn changes and
  left with a user writing a message; while the agent waits, the upper
  part when the question shows below it, the terminal whole with the strip
  over its blank bottom or, unread, over its top, the screen followed as
  the dialog is drawn and read again as what the agent waits for changes,
  the upper part kept for a user writing), `agentsFocus.test.tsx` (with
  the real `TerminalView`: the terminal's keyboard for a new agent tab
  without a transcript, the composer's when the conversation is first
  drawn, the terminal's when the agent begins to wait but not from a user
  writing, and when it is shown whole),
  `agentsGrid.test.tsx` (the terminal's grid unchanged while the view
  shrinks and covers it again), `agentsTranscript.test.ts` (one read per
  machine, first back then forward, earlier pages, a changed file, codes,
  giving up, hidden pages, back-off, reading at once when the page is
  shown or the machine is back, the terminal shown when the first page
  does not come, time-outs, cursors above 32 bits, the message box's
  paste, Enter, confirmation by the prompt, by a command's notice and by
  the start of a prompt too long to keep, no Enter when the agent began
  to wait, left or its pane went during the pause, refusals, Escape),
  `conversation.test.ts` and `conversationMemo.test.tsx` (the reducer and
  what is drawn again), `conversationView.test.tsx` (messages, display
  math from one-line `$$` paragraphs with code left as written, what is
  read out, tool calls, a patch's lines outside hunks, a long text diff
  compared only when opened, composer, drafts per source, list, events of
  shapes no parser makes), `agentKinds.test.tsx` (the palette's agents),
  `agentLeaves.test.ts`, `surfaces.test.ts`, `surfaceFocus.test.ts`,
  `termPane.test.ts` (covered terminals).
- Run on real programs (macOS, Claude Code 2.1.330, Codex CLI 0.170.0,
  herdr-core 0.1.21): the record and its rewrite on `/clear`,
  `--session-id`, the transcripts made at the first prompt, no files of a
  child session; Codex's rollout made at the first prompt and not held
  open; a pasted message and Enter starting a turn in both interfaces,
  several lines included; a dialog open while the status was `done`. The
  two real vectors are transcripts of these runs.
- Run in a browser against the `dev` instance on macOS, with Claude Code
  2.1.330 and Codex 0.170.0, before the confirmation of commands, the
  check before Enter, the keyboard's rules, the drafts kept across
  remounts, the strip for a conversation that cannot be read and display
  math took the form described above (the tests above cover those): a
  Claude Code started by hand in a shell was detected with its session,
  and the header's button showed its conversation (a table with formulas
  in its cells, a formula, a highlighted code block, tool rows: an edit
  with +1 −0, a read) with the session's cost and context in the status
  bar; the composer's message reached Claude Code and Codex through the
  terminal (the paste, Enter 250 ms later) and showed as the user's
  message; a permission dialog showed the terminal under the short view
  with what the agent waited for, and the conversation came back after
  the answer; `/clear` made the view follow the new session (a `/clear`
  notice); Codex had no session before its first prompt (the strip) and
  one after it, with a table and an inline formula drawn and its context
  as a percentage; the terminals of the `dev` core carried no session
  markers of the Claude Code session the core was started from.
