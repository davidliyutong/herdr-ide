# 35 · Coding agents' sessions and transcripts

## Context

Claude Code and Codex run as programs in the machines' terminals ([21](21-terminal-core.md)). Agent detection ([25](25-agent-detection.md)) tells which agent runs and what it does, but not which conversation it is in, so a restore could only continue the directory's latest one ([33](33-workspace-restore.md)).

Both agents keep each session as a JSON-lines transcript on the machine, named by a UUID (measured with Claude Code 2.1.330 and Codex CLI 0.170.0):

- Claude Code writes a record `<config dir>/sessions/<pid>.json` (`pid`, `sessionId`, `cwd`, `startedAt`) while it runs, rewritten on `/clear`; `claude --session-id <uuid>` chooses the id. The transcript, `<config dir>/projects/<escaped directory>/<id>.jsonl`, appears at the first prompt; most of its lines are the program's own state, not conversation. A Claude Code started with `CLAUDE_CODE_CHILD_SESSION` in its environment writes neither file.
- Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` at the first prompt and does not keep it open; its first line is `session_meta` (`id`, `cwd`, `timestamp`). A subagent's thread (a review, a spawned agent; Codex 0.171.0) has a rollout of its own, whose `session_meta` names its session as `parent_thread_id` and `session_id` and whose `source` is `{"subagent": …}`.

## Goals / non-goals

Goals: find the session each agent terminal runs, without changing the agents' configuration; resume it after the terminal core started again once the machine confirms it ([33](33-workspace-restore.md)); show its usage in the status bar ([29](29-ai-usage.md)); add a kind of agent by a row of a registry; map Claude Code's transcripts on the machine to events shaped as the Agent Client Protocol's; a conversation view the chat panes draw ([37](37-agent-chats.md)).

Non-goals: hooks in the agents' configuration; compressed transcripts; sessions of agents other than Claude Code and Codex. Running agents headless is [37](37-agent-chats.md).

## Design

### Agent kinds (`backend/shared/agents/kinds.ts`)

The registry of the coding agents: per kind its `id` (the detector's manifest id), `title`, `usageProvider` ([29](29-ai-usage.md)), `start` (argv), `newSession` (arguments that set the session id), `continueLatest`, `resumeById`, `transcript` (the format of its transcripts, or none) and `chat` (how the chat host runs it, [37](37-agent-chats.md)). It is data only.

| Kind | Start | New session | Continue latest | Resume by id | Transcript | Chat |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | `--session-id {id}` | `claude --continue` | `claude --resume {id}` | `claude` | `claude` |
| `codex` | `codex` | – | `codex resume --last` | `codex resume {id}` | `codex` | `codex` |
| `kimi`, `grok` | its id | – | – | – | – | `acp` |
| `gemini`, `opencode`, `cursor`, `copilot`, `qwen`, `amp` | its id | – | – | – | – | – |
| the other kinds the detector knows | – | – | – | – | – | – |

`make tokens` writes the kinds into `spec/generated/registry.json` (key `agents`), which the page reads (`web/src/conversation/kinds.ts`): agents to start, the commands a restore types, the usage provider, whether a kind's transcripts are read, its chat adapter. Argv, environment and session metadata of chats stay on the machine, never in that JSON. A `{id}` placeholder is replaced only by a lower-case UUID; anything else makes no command. How to add a kind is in [AGENTS.md](../../AGENTS.md) (gotchas); `backend/shared/agents/kinds.test.ts` holds the pieces together.

### Finding a session (`backend/machine/agents`)

The `Resolver` (`backend/machine/agents/sessions.ts`) reads everything asynchronously, so the node's one thread never waits for the file system ([42](42-typescript-backend.md)).

`Resolver.resolve(kind, {pid, argv, cwd})` answers the session id of a terminal's foreground program and a source word. Candidates are the program and a bounded set of its descendants (wrappers, npm's launcher).

- **Claude Code**: `argv` (`--session-id`, or `--resume`/`-r` without `--fork-session`); else `pid`: its record in the process's own `CLAUDE_CONFIG_DIR` (Linux) or the user's configuration directories, believed only when the directory is not writable by others, the file is a small regular file of the user's opened without following links, its `pid` matches and its `startedAt` is within 60 s of the process's start (a reused pid has an old record); a record naming another session than the command line wins (`/clear`). Else `guess`: when no other terminal runs Claude Code in the directory, the newest transcript of the directory written since the process started that no running record names.
- **Codex**: `argv` (`resume <id>`); else `fd` (Linux): an open rollout (a subagent's stands for its session, and the session's own wins); else `start`/`guess`: when no other terminal runs Codex in the directory, the rollouts made since the process started whose `session_meta` records the directory, subagents' left out (one is `start`, the newest of several a `guess`).

A guess is never remembered in the layout nor shown as the session's usage. `Stamp` is a cheap fingerprint of what `Resolve` reads, polled to know when to resolve again.

`locate(kind, id)` finds a transcript inside the kind's root (Claude Code's `projects/*/`, Codex's dated `sessions` and `archived_sessions`) and its subagents' (Claude Code's `<session>/subagents/*.jsonl`; Codex's rollouts naming the session as their parent, in its rollout's directory and the dated ones from the session's start to now, at most 256 first lines read); the id must be a lower-case UUID before it reaches a path. `openLocated` opens it without following any link (`O_NOFOLLOW_ANY` on macOS, on Linux `O_NOFOLLOW` and the descriptor refused before any read when `/proc/self/fd` names another path) and checks it is a regular file of the user's with one link and the identity `locate` saw. Searches for unknown ids are rate-limited and the resolver's maps bounded.

### The detector's part

With the agents plugin on, the hub opens the detect stream ([25](25-agent-detection.md)) with `Header.Sessions`; without it the agent reads no session file. For each terminal whose agent's transcripts are read, a follower resolves after the startup grace, retries with back-off while nothing is found, and resolves again when the stamp, the foreground pid or its command line changes (`followSession` of `backend/features/agents/machine/detector.ts`).

The hub accepts only a lower-case UUID with a known source and keeps it in the terminal record as `agent_session` and `agent_session_source` ([22](22-terminal-protocol.md)). The `agent` event always carries both (`null` when unknown), so a page loses a session that ended. A change of the session alone sends no `/ws` message, sound or notification.

### The terminal leaf

A terminal leaf of the layout document ([22](22-terminal-protocol.md)) may hold `session` (the session the agent runs) and `before` (the address of the terminal this one replaced). Values of another shape are dropped when the document is read, and so is `render`, which earlier versions wrote. The restore remembers `session` and writes `before` ([33](33-workspace-restore.md)); terminal history adopts a snapshot by `before` ([36](36-terminal-history.md)).

### Claude Code's transcripts (`backend/shared/agents/transcript`)

The parser maps the lines of a Claude Code transcript, and the messages of its SDK protocol, which have their shapes, to events shaped as ACP v1 `session/update` notifications (`backend/shared/proto/agentproto/transcript.ts`): `update`, `user`, `turn` (`start`, `end`, `error` with a `stopReason`) and `notice` (`_<slug>/<name>`: `compacted`, `command`, `error`, `skipped`); the product's own marks are under `_meta.<slug>`. Each event is made from its line alone. `claudeFrame` maps one line, `eachClaude` a file's lines forward from an offset, for the chat host's Claude Code adapter: imported sessions, what a session did in a terminal, and a live chat's tool results ([37](37-agent-chats.md)). No route sends a transcript to the page.

The mapping, in short: prompts make `turn` start and `user`; messages sent while the agent works join the running turn; assistant text, thinking and tool calls make chunks and `tool_call` (edit, execute, read, search, fetch, think, a plan); tool results make `tool_call_update` with diffs and outputs; usage makes `usage_update`; turn ends, interruptions, compactions and API errors make `turn` ends and notices; titles come from `custom-title`, `ai-title` or `summary`; a response's usage is on each of its lines, and readers keep the last of a message. The program's own state lines make nothing; lines of unknown shape are counted in `unknown`. The shared vectors in `spec/vectors/transcript/` are the exact specification.

Transcripts are parsed as hostile input within bounds: 256 KiB of text an event (32 KiB of a tool's output), 256 events and 8 MiB a line (longer lines skipped with a notice); cut text is marked `truncated`.

### The agents plugin

`plugins.agents.enabled` (on by default) switches session finding on the machines. On the page (`web/src/plugins/agents`) it adds **Continue in Chat** to a terminal's header when the leaf remembers a session of a kind with chats whose agent has quit, opening it as a chat ([37](37-agent-chats.md)).

`GET /api/m/{id}/p/agents/resolve?kind=&session=&cwd=` (`backend/features/agents`, machine side `machine.ts` there) answers `{ok}` when the machine has the session's transcript and it records that directory, else a code (`not_found`, `other_cwd`, `compressed`, `bad_request`). It is validated on the hub and again on the machine, bounded (15 s, 8 at once per machine, `429 busy`), a read allowed on a read-only hub, and `404 plugin_disabled` with the plugin off. The machine reads only what the transcript says of itself and replies with codes, never paths.

### The conversation view (`web/src/conversation`)

`model.ts` reduces events to items (prompts, messages, thoughts, tool calls, the plan, notices, usage, title): duplicate `seq`s are skipped, chunks join by message, tool calls merge by `toolCallId`, earlier pages go before the items. Events come from a machine and are type-checked member by member; malformed ones are counted as not shown. `Conversation.tsx` draws the last 300 items (more on request), follows the end while the user is there, and renders messages as Markdown (`web/src/markdown`, KaTeX, highlighted code; a one-line `$$…$$` paragraph is display math), tool calls with their command, output and diff, the plan as a checklist and the context's use as a meter.

The view knows its events only through `ChatSource` (`web/src/conversation/source.ts`: `subscribe`, `loadEarlier`, `send`, `cancel`, `respond`, `answer`, `setConfig`, `cancelQueued`, `compact`, `suggestFiles`, `trust`, `untrust`). The chat panes implement it with the chat host's events, which add permissions, questions, queued messages and live increments that stored events replace ([37](37-agent-chats.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A new kind of layout leaf for an agent's terminal | Everything that knows terminal leaves would need a second path, and older clients would show an unknown node. Fields keep the pane a terminal. |
| Hooks in the agents' configuration | Writes into the user's configuration of each agent; the process, its record and its transcript tell the session without that. |
| Parsing transcripts in the hub or the page | Whole files, mostly program state, would cross the connection; the machine parses them in place within bounds. |
| A path in the browser's request | A kind and a UUID name only a transcript inside the kind's own root. |
| Resuming a guessed session, or without the machine's confirmation | A guess may be another terminal's, and every client of the machine writes the layout. |

## Failure modes

- **No session or transcript yet** (before the first prompt) → no `agent_session`, `resolve` says `not_found`; a restore continues the directory's latest conversation.
- **A child session** (`CLAUDE_CODE_CHILD_SESSION`) → no files, no session; the agent strips these markers from what its terminals inherit ([21](21-terminal-core.md)).
- **macOS** → a process's environment and open files are not read: a Claude Code with its own `CLAUDE_CONFIG_DIR` is not found, and there is no `fd` source.
- **A guess** → only while no other terminal runs that kind in the directory; another program of the user's there can still be guessed.
- **A changed transcript format** → unknown lines make no event and are counted.
- **Compressed or hard-linked transcripts** → `compressed`; `not_found`.
- **The plugin is turned off** → `plugin_disabled`; the detect stream reopens without sessions and pages lose `agent_session`; leaves keep `session`; no second notification for already-reported states ([25](25-agent-detection.md)).

## Security

While the plugin is on, a session id and its source word leave the machine per agent terminal; a `resolve` returns only a code. No conversation is sent. A session is named only by a kind and a UUID, checked on the hub and the machine; the transcript is found inside the kind's root, opened through no link with the identity it was found with, and parsed within bounds. See [SECURITY.md](../../SECURITY.md) (coding agents' sessions, agent detection).

## Testing

- `backend/shared/agents/kinds.test.ts` (kinds against manifests, settings and usage providers; UUID substitution; chat specs; `the generated registry`).
- `backend/machine/agents/sessions.test.ts`: command lines, records trusted and refused, guesses, stamps, `locate`, opening through no link, hard links, the process table; also run on Linux in a container.
- `backend/features/agents/machine/detector.test.ts` and `backend/features/terminals/sessions.test.ts`: schedule, sessions in records and events, sessions ending (`a session ends`), the plugin's switch (`detected again after a switch`, `a switch notifies once`).
- `backend/shared/agents/transcript`: the shared vectors (`transcript.test.ts`, which rewrites their expected events with `UPDATE_TESTDATA=1` after a deliberate change, also run by `web/src/__tests__/transcriptVectors.test.ts` against the conversation model), frames, bounds (`a line of many small values`, `walking past a long line`). Vectors in `spec/vectors/transcript/`: a real sanitized transcript (Claude Code 2.1.330), one of a session driven through the SDK protocol, and hand-written ones. `spec/vectors/layout/agent-leaves.json`: the leaf's fields.
- `backend/features/agents/agents.test.ts`, `backend/features/agents/machine.test.ts`: the route, validation, its limit (`busy`), the machine side (`resolve` through the wire).
- `web/src/__tests__`: `agents.test.ts`, `chatImport.test.tsx`, `agentLeaves.test.ts`, `conversation.test.ts`, `conversationMemo.test.tsx`, `conversationView.test.tsx`, `agentKinds.test.tsx`.
