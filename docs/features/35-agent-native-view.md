# 35 · Coding agents' sessions and transcripts

## Context

Agent detection ([25](25-agent-detection.md)) tells which agent runs in a terminal, not which conversation; without that a restore can only continue the directory's latest one ([33](33-workspace-restore.md)). Claude Code, Codex and Antigravity (`agy`) keep each session on disk, named by a UUID: Claude Code a record per running process (`<config dir>/sessions/<pid>.json`) and a transcript under `<config dir>/projects/`, Codex a rollout under `~/.codex/sessions/`, Antigravity a SQLite database per conversation.

## Goals / non-goals

Goals: find the session each agent terminal runs without changing the agents' configuration, to resume it once the machine confirms it ([33](33-workspace-restore.md)); a registry row per kind of agent; Claude Code's transcripts mapped on the machine to ACP-shaped events; a conversation view for the chat panes ([37](37-agent-chats.md)).

Non-goals: hooks in the agents' configuration; compressed transcripts.

## Design

### Agent kinds (`backend/shared/agents/kinds.ts`)

The registry of coding agents, data only: per kind how to start it, set a new session's id, continue the latest or resume by id, its transcript format, usage provider ([29](29-ai-usage.md)) and chat adapter ([37](37-agent-chats.md)). Claude Code, Codex and Antigravity have transcripts and resume by id; Kimi Code and Grok have chats; the rest are only started or detected. `make tokens` writes the kinds into `spec/generated/registry.json`, which the page reads (`web/src/conversation/kinds.ts`); a chat's argv, environment and session metadata stay on the machine. A `{id}` placeholder is replaced only by a lower-case UUID. Adding a kind: [AGENTS.md](../../AGENTS.md) (gotchas).

### Finding a session (`backend/machine/agents`)

The `Resolver` (`sessions.ts`, a `SessionDriver` per format in `driver.ts`) answers the session of a terminal's foreground program, or of a bounded set of its descendants, with a source word, reading everything asynchronously:

- `argv`: the command line names the session.
- `pid` (Claude Code): its record, believed only as a regular file of the user's, opened through no link in a directory others cannot write, whose pid and start time match the process.
- `fd` (Linux; Codex, Antigravity): the session file the process holds open.
- `start`, `guess`: while no other terminal runs that kind in the directory, the session made there since the process started, the newest of several a `guess`.

A `stamp`, a cheap fingerprint of what resolving reads, tells when to resolve again. `locate(kind, id)` finds a session's files inside the kind's root, the id a lower-case UUID before it reaches a path; `openLocated` opens them through no link, as regular files of the user's with one link and the identity `locate` saw.

### Sessions in records and leaves

With the agents plugin on (`plugins.agents.enabled`), the hub opens the detect stream ([25](25-agent-detection.md)) asking for sessions; otherwise no session file is read. The detector (`followSession`, `backend/features/agents/machine/detector.ts`) resolves each agent terminal's session again when the stamp, the foreground pid or its command line changes. The hub keeps only a lower-case UUID with a known source, as the terminal record's `agent_session` and `agent_session_source` ([22](22-terminal-protocol.md)).

A terminal leaf of the layout document may hold `session` (never a guess) and `before` (the terminal this one replaced): the restore remembers the one and writes the other ([33](33-workspace-restore.md)), terminal history adopts a snapshot by `before` ([36](36-terminal-history.md)), and a leaf whose quit agent has chats offers **Continue in Chat** (`web/src/plugins/agents`, [37](37-agent-chats.md)). `GET /api/m/{id}/p/agents/resolve` (`backend/features/agents`) confirms that the machine has a session's transcript for a directory, answering with codes, never paths.

### Claude Code's transcripts (`backend/shared/agents/transcript`)

The parser maps a Claude Code transcript's lines, and the SDK protocol's messages, which share their shapes, to events shaped as ACP v1 `session/update` notifications (`backend/shared/proto/agentproto/transcript.ts`), each from its line alone; the program's state lines make nothing and unknown ones are counted. The chat host's Claude Code adapter reads with it ([37](37-agent-chats.md)); `spec/vectors/transcript/` is the exact specification. Transcripts are parsed as hostile input within bounds, cut text marked `truncated`; no route sends a transcript to the page.

### The conversation view (`web/src/conversation`)

`model.ts` reduces events to items (prompts, messages, thoughts, tool calls, the plan, notices, usage), type-checking each event from the machine member by member; `Conversation.tsx` draws them through the sanitizing Markdown component (`web/src/markdown`). The view knows its events only through `ChatSource` (`source.ts`), which the chat panes implement ([37](37-agent-chats.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A new kind of layout leaf for an agent's terminal | Everything that knows terminal leaves would need a second path; fields keep the pane a terminal. |
| Hooks in the agents' configuration | Writes the user's configuration; the process, its record and its transcript tell the session without that. |
| Parsing transcripts in the hub or the page | Whole files, mostly program state, would cross the connection. |
| A path in the browser's request | A kind and a UUID name only a transcript inside the kind's own root. |
| Resuming a guessed or unconfirmed session | A guess may be another terminal's, and every client of the machine writes the layout. |

## Failure modes

- **No transcript yet** (before the first prompt) → no session; a restore continues the directory's latest conversation.
- **A child session** (`CLAUDE_CODE_CHILD_SESSION`) → no files; the agent strips the marker from what its terminals inherit ([21](21-terminal-core.md)).
- **macOS** → no environment or open files of a process are read: no `fd` source, and a Claude Code with its own `CLAUDE_CONFIG_DIR` is not found.
- **Compressed or hard-linked transcripts** → `compressed`, `not_found`.

## Security

While the plugin is on, a session id and its source word leave the machine per agent terminal, and a `resolve` returns only a code; no conversation is sent. A session is named only by a kind and a UUID, checked on the hub and the machine, and its transcript is opened inside the kind's root through no link and parsed within bounds. See [SECURITY.md](../../SECURITY.md) (coding agents' sessions, agent detection).

## Testing

- `backend/shared/agents/kinds.test.ts` (the registry against manifests, settings and the generated JSON); `backend/machine/agents/sessions.test.ts` (sources, refused records, guesses, `locate`), also on Linux in a container.
- `backend/features/agents/machine/detector.test.ts`, `backend/features/terminals/sessions.test.ts`, `backend/features/agents/*.test.ts`: sessions in records and events, the resolve route.
- `spec/vectors/transcript/`, run by `backend/shared/agents/transcript/transcript.test.ts` and `web/src/__tests__/transcriptVectors.test.ts`; `spec/vectors/layout/agent-leaves.json`; `web/src/__tests__/agent*.test.ts(x)`, `conversation*.test.ts(x)`.
