# 37 · Agent chats

## Context

In a terminal ([21](21-terminal-core.md)) the page knows which agent runs ([25](25-agent-detection.md)) and its session ([35](35-agent-native-view.md)), but cannot stream its text, answer its permissions or confirm a message before the turn ends. The agents' headless protocols can: Claude Code's Agent SDK (stream-json and control requests on stdio), Codex's app-server (JSON-RPC on stdio), and the Agent Client Protocol (ACP) of Antigravity (`agy`), Kimi Code and Grok. A chat is such a session, run by a process of the product's own on the machine and drawn by the page.

Constraints: an agent runs where its files are, as the user, with the user's sign-in; nothing listens on TCP on machines; whatever is started has an owner and an end, whatever is written a bound ([10](10-remote-resource-lifecycle.md)); a session survives the page, the hub, ssh and the agent going away; Claude Code's and Codex's protocols are unspecified or experimental, so both are pinned to recorded versions.

## Goals / non-goals

Goals: chats with these agents in panes on any machine, with what their protocols offer (streaming, permissions, questions, plans, model, effort and mode, a queue, compacting, fork, rewind, usage, background tasks) and full access only where the machine allows it; switching agents with the context; the attention and notifications of agents in terminals ([07](07-agent-native-workflow.md)); sessions moved between terminals and chats; chats that outlive page, hub and terminal core within bounds set per machine.

Non-goals: agents that need a terminal; OpenCode (`opencode acp` listens on an unauthenticated TCP port); editing the agents' configuration; keeping a pending permission across a host restart; subagents' conversations as chats.

## Design

```
page (chat pane) ──WebSocket──▶ hub (plugin chat) ───yamux──▶ agent (plugin chat, action open)
  one per page                   relay, read-only, audit,        │ a stream per connection
                                 watch → /ws and notifications   ▼
                                                             <run>/chat.sock
                                                             chat host (`chat-host`, a hidden terminal
                                                             of the instance's terminal core)
                                                             ├─ journal: chat-<host>.db
                                                             └─ adapters: claude │ codex │ acp
                                                                  └─ one agent process per live chat
```

A kind of `backend/shared/agents/kinds.ts` has a chat when its row has a `chat` spec (`ChatSpec`: adapter, command, added environment, ACP's `session/new` `_meta`); only the adapter's name reaches the page.

| Kind | Adapter | Command |
| --- | --- | --- |
| `claude` | `claude` | `claude` and the SDK's arguments |
| `codex` | `codex` | `codex app-server --listen stdio://` |
| `agy` | `acp` | `agy acp --stdio` |
| `kimi` | `acp` | `kimi acp` |
| `grok` | `acp` | `grok agent --no-leader stdio`, sessions made with `{"yoloMode": false}` |

### The chat host

The `chat-host` command (`backend/hosts/machine/chathost.ts`, the host in `backend/features/chat/machine/host`; Linux and macOS) runs the agents and keeps their conversations; its process model is in [42](42-typescript-backend.md#the-chat-host), its limits in [deployment](../deployment.md#remote-resources). It serves `chat.sock` (0600) in the runtime directory (0700, [40](40-shared-homes.md)) under a lock, and runs as a hidden terminal of the instance's terminal core, so ssh, the agent and the hub may come and go. It ends when idle, when a newer build asks it to make way (refused while a chat is busy), or with the terminal core; chats stay in the journal and resume their sessions at the next prompt. Its socket, protocol and journal stay compatible across releases, so a newer build's host takes over an earlier one's chats. The terminal core reads no shell startup files, so agents get the environment of the user's interactive login shell (`host/env.ts`), where their programs are on the `PATH`.

The machine side's action `open` (`backend/features/chat/machine.ts`) joins a stream of the hub's to the host's socket, having the terminal core run a host when none serves. A host of an older build is asked to make way when idle; a newer one, or one of the same commit, is used while it speaks this protocol, so two hubs of different builds do not keep replacing each other. The hub's watch never starts or replaces a host.

A helper's terminal is hidden when it has both the reserved name and the label (`hidden`, `backend/shared/proto/agentproto/hidden.ts`); a label alone, which any program can set, hides nothing, and clients may take neither. Everything that walks the terminal core's terminals uses that rule: the terminal protocol ([22](22-terminal-protocol.md)), agent detection ([25](25-agent-detection.md)) and terminal history ([36](36-terminal-history.md)).

### Chats

A chat is one agent session in one directory. Its state is `starting`, `idle`, `working`, `waiting`, `sleeping` (no agent process), `failed` (with the agent's stderr tail, kept in memory only) or `closed`; its status is the terminals' `working`, `blocked`, `done`, `idle`.

- **Agent process.** Idle for `chat.idleStopMinutes`, or the idlest beyond `chat.maxLive`, it ends and the chat sleeps; the next prompt resumes the session. Deleting a chat leaves the agent's session files.
- **Prompts.** ACP content blocks: text, images, and links to `@` files and workspace files (picked, or file explorer rows dropped on the composer). During a turn a prompt is queued, withdrawable or promoted; a steer goes into the running turn where the agent can, an interrupt ends the turn and keeps the queue. A resend under the prompt's `clientId` takes effect once.
- **Permissions, questions and plans.** The adapter asks the host, which stores the request as an event; the first answer of any client wins; secret answers are masked everywhere but to the agent. Allowing for the session writes no setting. In plan mode the plan is a permission approved into `default` or `acceptEdits`.
- **Modes and full access.** `default`, `acceptEdits`, `plan`, `full`; a new chat starts in `chat.permissionMode.<kind>`, else `chat.permissionMode`. Full access needs `chat.allowFullAccess` (per machine, off by default): adapters mark the mode values that grant it (for ACP every mode not known to ask), and the host refuses them (`not_allowed`), sets back an agent that switches itself, and refuses them until the hub has sent the machine's settings.
- **Trusted folders.** An agent loads a project's own settings (hooks, MCP servers) only in a folder it trusts itself (Claude Code's `~/.claude.json`, read only) or the user trusted through the host; elsewhere it starts without them and the chat offers **Trust This Folder**. The host refuses `/`, the home and its ancestors, and folders others may change (`unsafe_folder`), and pins each trusted folder's device and inode.
- **Models.** Model and effort are set through the protocol, never by a slash command that saves them. `chat.visibleModels.<kind>` filters the picker; a new chat starts on `chat.model.<kind>` (empty: the agent's default; `@last`: the last chosen), else on the first shown model the agent offers (`chatproto.startModels`), so a hidden or withdrawn model never reaches the agent or fails a start.
- **Compacting and usage.** `compact` maps to each protocol's compaction; context fill and session cost come from its usage messages, subscription limits from AI usage ([29](29-ai-usage.md)).
- **Fork, rewind, export.** `fork` forks the session natively (Claude Code at a message, Codex at a turn, ACP whole sessions where advertised), else seeds a new chat with the context after a warning. `rewind` needs native rollback (Claude Code, Codex) and truncates the journal atomically. `export` gives a bounded Markdown digest or the raw JSON.
- **Switching agents** (`host/handoff.ts`). A new chat of another kind starts with context selected deterministically from the journal, not summarized by a model, within `chat.handoffMaxKB`: a short conversation whole, of a long one the latest prompt, the original request, recent turns, key command results, modified files and the plan, each turn attributed to its agent; thoughts, permission state, subagent internals and images are left out. Codex takes it into its thread (`thread/inject_items`), the others with the next prompt, never stored as the user's text.
- **Background tasks and subagents.** Subagent events carry `parent`, the tool call that started them; their permissions are the chat's. Adapters publish live tasks as `Chat.tasks` (in memory only), which the page lists with stop buttons. Claude Code's task events are edges in a bounded queue that drops some when full, so the Claude adapter ends a task by its level too: a background task when `background_tasks_changed` no longer lists it, a foreground one when the tool call it blocked returns its result (one moved to the background meanwhile is listed again by that level).

### The protocol and the journal

`backend/shared/proto/chatproto`: JSON lines on the socket, the host's hello, then one request per connection (`Op`), except `attach` and `watch`, which stay open; an attached connection sends commands (`CommandOp`), each answered by `ack`. Agents are named by kind, never by command; errors are codes the page translates.

A **stored** event has a sequence number and stays in the journal. A **live** event is an increment of an item being streamed: unnumbered, sent only to attached connections, never stored. When the item completes, one stored event with its whole state replaces the increments, so a client that reattaches from its last sequence number gets partial items whole. Agents' stderr rides only on live events.

The journal is the host's SQLite database `chat-<host>.db` ([38](38-sqlite-state.md)); a chat's events reach its clients only once stored. Its bounds are settings per machine (`chat.maxChatMB`, `chat.maxTotalMB`, `chat.maxChats`, `chat.retentionDays`): a chat over its bytes loses its oldest events, past the others closed chats go, archived and oldest first, and a new chat with nothing left to remove is refused (`too_many`). An event the journal refuses fails the chat, so a log never has a gap.

### Adapters (`backend/features/chat/machine/{claude,codex,acp}`)

The host owns chats, logs, clients, bounds and process decisions; an adapter owns one agent process per session and turns its protocol into events, by the rules in `machine/adapter.ts`'s header: argv and environment as the host gives them, never a client's; requests it does not serve answered "method not found"; the user's configuration never written; the agent in its own process group, ended gracefully before any SIGKILL; output never held up; full-access values marked; a session another process runs neither resumed nor imported (`in_terminal`). The host gets its adapters by name (`chatAdapters`, `backend/hosts/machine/features.ts`), each `meta` declaring what it supports.

- **Claude Code** (`claude/`): Anthropic's Agent SDK running the user's own `claude`, fetched by machines on use, never shipped ([42](42-typescript-backend.md#claude-code)). Full access is a start option (`allowDangerouslySkipPermissions`), so switching to it restarts the program on the same session. Messages are mapped by `backend/shared/agents/transcript` ([35](35-agent-native-view.md)).
- **Codex** (`codex/`): one `codex app-server` per live chat, written against types generated from the pinned schema (`spec/codex-app-server`). A thread started writable records its directory in `~/.codex/config.toml`, so threads start read-only and each turn carries the mode as policy:

  | Mode | Approval policy | Sandbox | Collaboration mode |
  | --- | --- | --- | --- |
  | `default` | `untrusted` | `workspaceWrite` of the directory | default |
  | `acceptEdits` | `on-request` | `workspaceWrite` of the directory | default |
  | `plan` | `on-request` | `readOnly` | `plan` |
  | `full` | `never` | `dangerFullAccess` | default |

  `default` is `untrusted` because under `on-request` the model refuses to write instead of asking. Approvals never map to the amendments Codex saves. Close closes stdin before SIGTERM: Codex killed outright leaves its shell snapshots.

- **ACP** (`acp/`, on `@agentclientprotocol/sdk`): the client offers no file system or terminal capability, so every request but a permission is "method not found". Per-kind hooks are in `acp/extensions.ts`: Grok's permission mode is enforced by the client, without touching its configuration; Antigravity's subagents are followed from their transcripts by `SafeFileTailer` (`backend/machine/agents/tailer.ts`: only the user's regular files inside the agent's directories, through no link, in bounded reads). An ACP agent cannot tell that a terminal runs a session.

### The hub and the page

The hub's plugin (`backend/features/chat`) has routes below `/api/m/{id}/p/chat/` and `/api/p/chat/` ([reference](../reference.md#agent-chats)). A GET never starts a host; a read-only hub starts nothing, refuses `GET agents` and session lists (both may run the agents' programs), and omits agents' stderr. Every change is audited, never with a prompt's text or an answer. One WebSocket per page (`page.ts`, `web/src/plugins/chat/protocol.ts`) carries all its chats, as browsers allow six HTTP/1.1 connections per origin; each subscription is its own connection to the host, and one that falls behind is dropped and reattached without stalling the others. While a machine's host is in use the hub watches it (`watch.ts`), sends the chats' states to pages and publishes an agent event when a chat becomes blocked or done.

The page (`web/src/plugins/chat`, `web/src/conversation`):

- A chat pane is a layout leaf `{view: {plugin: chat, kind: chat, chat, agent}}` drawn by the conversation view ([35](35-agent-native-view.md)); its composer queues on Enter while a turn runs and steers or interrupts on `Cmd/Ctrl+Enter`.
- New chats come from the new-tab menu, the command `chat.new` and the Chats panel, in the focused pane's directory. They offer the providers enabled in Settings › Agent Chats (`chat.providers.<kind>`) that the machine says it can start (`agents`, `state.ts` `offeredKinds`), every enabled one while that is unknown; making a workspace asks (`POST agents?refresh=1`, starting the host), and so does a chat refused or failed with `not_found`.
- The Chats panel lists the machine's chats by urgency and the agents' earlier sessions of the directory.
- The list holds at its end while the user is there (`Conversation.tsx` `holdsEnd`): any move up leaves it, also a few pixels of a slow swipe (a wheel or swipe up leaves it before the scroll event, so output that comes meanwhile does not pull it back); coming back within 24 px of the end holds it again. It draws the last 300 items (more on **Show Earlier Messages**); while the user reads away from the end, the item first shown then stays drawn and the window grows as items come, so the reader is not pushed to its top; back at the end it holds the newest 300 again.
- The background tasks tray (`BackgroundTasksBar.tsx`) lists the chat's running tasks with stop buttons. A stop that fails says why, dismissible, and offers **Remove from List**, which drops that task from this page's list (the agent keeps it if it still runs); a task the agent lists no more leaves it by itself.
- Chats count in the attention inbox, badge and notifications as terminal agents do, also without an open pane (`status.ts`, [27](27-plugins.md)).

### Sessions between terminals and chats

Opening one of an agent's earlier sessions makes a chat that resumes it with its conversation imported first; a terminal whose agent quit offers **Continue in Chat** ([33](33-workspace-restore.md)). **Continue in Terminal** (kinds whose command resumes a session by id: Claude Code, Codex, Antigravity; no turn running) ends the chat's agent and opens a terminal tab that resumes the session; when the chat is used again, the host first imports what the session did in the terminal. Two processes never write one session: the page refuses a session a terminal's agent runs, the host one another process runs (`in_terminal`).

## Alternatives considered

| Option | Why not |
| --- | --- |
| The conversation drawn over the agent's terminal | Input pasted into a program, confirmation a turn late, permissions only in the terminal, no streaming. |
| ACP for every agent | Claude Code and Codex speak it only through third-party adapters, without their permissions, plans, questions, effort and usage. |
| The Agent SDK in Node as a sidecar | A Node runtime per machine; the machine side runs on Bun, which loads the SDK itself. |
| The host as a child of the agent | It would die with every ssh drop and hub restart. |
| A socket or port the hub reaches directly | Nothing listens on TCP on machines; the agent's stream suffices. |
| JSONL files per chat | Bounds and eviction would need their own crash-safe rewriting; SQLite gives transactions. |
| Storing live increments | Every token in the log; a reattach gets the whole item instead. |

## Failure modes

- **No terminal core** → `no_terminal_core`; **host not up in time** → `start_failed`; **a host speaking another protocol** → `upgrading` until idle, and the page offers a restart.
- **Agent not installed or not signed in** → `not_found` (then not offered on that machine) or `auth_required`.
- **Claude Code's SDK unavailable on the machine** → `sdk_unavailable`.
- **The agent exits or breaks protocol** → the chat fails with its stderr tail; the next prompt starts it again.
- **The page falls behind or loses the connection** → reattach from the last sequence number.
- **The terminal core stops** → host and agents end; the next host's chats sleep, their running turns ended in an error.

## Security

Chats run agents as the user, as terminals do, through a long-lived product process reached only through the run directory (0700, socket 0600) and the agent's stream. Pages reach it only through the hub's guarded routes and WebSocket; their inputs are checked on the hub and again by the host. What runs is the registry's command; no command line, path or variable comes from a client. Full access is off unless the machine allows it; project settings load only in trusted folders no one else can change. Secret answers and stderr are never stored; stderr reaches writable clients only. See the agent-chat rows in [SECURITY.md](../../SECURITY.md).

## Testing

- Protocol: `backend/shared/proto/chatproto/chatproto.test.ts`.
- Host: `backend/features/chat/machine/host/*.test.ts`, `backend/features/chat/machine.test.ts` (the open action), `backend/hosts/machine/chathost.test.ts`.
- Adapters: `backend/features/chat/machine/{acp,codex,claude}/*.test.ts`, replaying `spec/vectors/chat` through fake agents against golden files (`testdata/golden`); Codex's messages validated against its schema; the SDK's way to machines (`sdkstore.test.ts`, `backend/features/chat/sdkprovision.test.ts`).
- Hub: `backend/features/chat/*.test.ts`. Hidden terminals: `backend/features/terminals/hidden.test.ts`, `backend/machine/hidden.test.ts`, `make it`'s `hidden terminals`. Tailing: `backend/machine/agents/tailer.test.ts`.
- End to end: `tests/chat.spec.ts` (fake ACP agent), `tests/chat-codex.spec.ts` (a fake app-server that flags a writable thread, a turn without its policy or an approval with an amendment).
- Web: `web/src/__tests__/chat*.test.ts(x)`, `conversation*.test.ts(x)`, `attention.test.tsx`.
