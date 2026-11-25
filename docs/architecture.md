# Architecture

```
browser (React, wasm + WebGL)  ──WebSocket + HTTP──▶  core (TypeScript on Bun, `veldr`; in the desktop app, its utility process)
desktop app (Electron shell) ──MessagePorts, no TCP──▶  ├─ kernel: guards, event channel, machines (registry + connection state machine)
                                                        ├─ settings, keybindings (files on the core host)
                                                        ├─ features: terminals, files, VS Code proxy and bridge hub, program windows, plugins
                                                        └─ one ssh session per machine ──yamux──▶ agent (Go machine build or TypeScript machine side, served by `veldr node`)
                                                                                                    ├─ herdr-core in a session of its own (raw pipe to its API socket)
                                                                                                    ├─ agent detection in its terminals, with the agents' sessions
                                                                                                    ├─ files (stat/list/range read/upload/zip)
                                                                                                    ├─ code-server (unix socket only)
                                                                                                    ├─ Xvfb or Xwayland + window manager (programs' windows)
                                                                                                    ├─ plugins' machine sides (op plugin)
                                                                                                    ├─ chat.sock ◀── chat host (`veldr chat-host`, a hidden terminal of herdr-core) ──▶ coding agents headless
                                                                                                    ├─ bridge.sock ◀── VS Code bridge extension
                                                                                                    └─ vault.sock ◀── the vault's MCP server (`<slug>-mcp`) ◀──stdio── coding agents' CLIs
```

Each machine's agent sessions are served by its node (`veldr node`), a
process of its own listening on a socket in the instance's runtime
directory on that host (`internal/hostdirs`; a home several hosts share
keeps each host's sockets, locks and executables apart,
[40](features/40-shared-homes.md)):
the core reaches the local machine's node through that socket, a remote
machine's over ssh with `node dial`, so both paths run the same code
([39](features/39-nodes.md)). The agent builds for
Linux and macOS only. A core on Windows (the desktop app's) lists its local
machine with the code `local_unsupported` and reaches SSH machines only
([02](features/02-multi-machine-transport.md)).

## Code map

The core is TypeScript under `backend/` (its
[README](../backend/README.md) has the layers and their rules), built with
Bun into one executable per platform; machines run the Go program
`cmd/veldr` (the machine build), which the core embeds and uploads, or, in
the TypeScript build (`backend/scripts/build.ts --machine ts`), that same
executable, which is the core and the TypeScript machine side
(`backend/machine`, `backend/hosts/machine`, the features' `machine.ts`)
of its platform: machines download their platform's from the core's
release, checked against its `SHA256SUMS`, or the core uploads it
([42](features/42-typescript-backend.md)).

| Directory | Role |
| --- | --- |
| `backend/shared` | What the core and the machine side share: wire protocols (`proto/`: agentproto, yamux, herdr-core's, the chat host's), libraries (`lib/`: brand names, logging, Go-compatible times and strings), SQLite state (`store/`), the host's directories, ids, loopback and file rules (`host/`), the coding agents' kinds and Claude Code's transcripts mapped to ACP-shaped events (`agents/`, `agents/transcript/`, [35](features/35-agent-native-view.md)). |
| `backend/kernel` | The core's machinery: HTTP routing and guards (`http/`: Host/Origin, proxy secret, CSP), `Fail` codes and audit, channels and the pages on `/ws`, machines and their connections (`machines/`: the registry `machines[-<instance>].json`, the connection state machine, the ssh target rule, the transports to the local node and over ssh, the machine builds they install, `transport/builds.ts`, and the TypeScript build's release, its `SHA256SUMS` and archives, `transport/release.ts`), settings and keybindings (`config/`: typed settings, the hand-editable files, the registry written to `spec/generated/registry.json` and `docs/reference.md`, [13](features/13-settings-and-appearance.md)), typed agent actions, the payloads it carries for machines (`payloads.ts`). |
| `backend/machine` | The TypeScript machine side's machinery (Bun, Linux and macOS): the node and its clients (`node.ts`, `dial.ts`), the agent its sessions share and the core's ops (`agent.ts`, `fsops.ts`, `hcop.ts`), the dispatch of the `plugin` op, and of the ops a feature serves itself (`detect`, `code-server`), to the features' machine sides (`dispatch.ts`, `feature.ts`: `defineMachine`, and what they see of the sessions: their pipes per socket, streams towards their cores), the terminal core (`hc.ts`), hidden terminals, housekeeping, the vault's socket, the coding agents' sessions and their files, which several features read (`agents/`, [35](features/35-agent-native-view.md)), system calls through `bun:ffi` (`sys/`). |
| `backend/features/<id>` | Everything the product does, one directory per feature: its typed protocol (`protocol.ts`), its core side (`core.ts`: routes, channels, services, settings), its machine side in TypeScript (`machine.ts` and `machine/`, for files, git, search, monitor, browser, history, usage, agents: detection, [25](features/25-agent-detection.md), and vscode: code-server and the bridge's socket) and, while machines run the Go build, the tests of the wire it shares with it ([27](features/27-plugins.md)): `machines`, `terminals` ([22](features/22-terminal-protocol.md)), `files` ([28](features/28-file-explorer.md)), `git` ([31](features/31-git.md)), `search` ([41](features/41-project-search.md)), `monitor` ([34](features/34-system-monitor.md)), `browser` ([32](features/32-browser-and-ports.md)), `agents` ([33](features/33-workspace-restore.md)), `history` ([36](features/36-terminal-history.md)), `chat` ([37](features/37-agent-chats.md)), `usage` ([29](features/29-ai-usage.md)), `vault` ([30](features/30-variable-vault.md)), `gui` ([14](features/14-gui-windows.md)), `vscode` ([05](features/05-vscode-panes.md), [09](features/09-air-gapped-installs.md)). |
| `backend/hosts/bun` | The command line (`main.ts`: `serve`, `fetch-assets`, `version`, `node`: run here in the TypeScript build, passed on to the Go machine build otherwise) and `serve` on `Bun.serve` (`serve.ts`), the payloads embedded in the executable (`payloads.ts`). |
| `backend/hosts/common` | What both hosts compose (`compose.ts`): the features, settings and keybindings, the machines, the host's routes. |
| `backend/hosts/machine` | The TypeScript machine side's commands (`cli.ts`: `node`, `node dial`, `node stop`, with the Go build's flags), which the command line runs, and the features its node serves (`features.ts`). |
| `backend/hosts/electron` | The core in the desktop app's utility process (`main.ts`, `serve.ts`, `start.ts`), its bridge to the main process over MessagePorts (`bridge.ts`), node-pty's terminals (`pty.ts`). |
| `backend/scripts` | The executable's build (`build.ts`, `--machine go\|ts`: the core that embeds the Go machine builds, or the TypeScript build), the reference check (`reference.ts`), the npm packages' notices. |
| `cmd/veldr` | The machine build: `node` (`node`, `node dial`, `node stop`), `gui-keep`, `gui-wl`, `chat-host`, `mcp` and `version` (`machine_unix.go`, `node_unix.go`, `chathost_unix.go`). |
| `internal/brand` | Product names; the only place they are defined in Go. |
| `internal/hostid` | The host's key (name and a hash of its machine id) and id (the hash alone), for files and sessions kept per host ([40](features/40-shared-homes.md)). |
| `internal/hostdirs` | A namespace's directories on a host: the data directory, the host's own directory in it, the host-local runtime directory. |
| `internal/agentproto` | Stream protocol shared by core and agent; yamux configuration; types both sides need (transcript events, history snapshots); `Hidden`, the rule that hides the product's own terminals by reserved name and label together. |
| `internal/agentkinds` | Registry of coding agent kinds: commands to start, continue and resume, transcript format, chat adapter; the same as the core's (`backend/shared/agents`, [35](features/35-agent-native-view.md)). |
| `internal/agent` | The agent: terminal core, detection, files, code-server, displays, bridge and vault sockets, housekeeping. `//go:build unix`. `agenttest` serves one in a test's process. |
| `internal/agent/detect` | Which coding agent runs in a terminal and its state ([25](features/25-agent-detection.md)); its manifests and the cases in `testdata/` are read by the TypeScript machine side too. |
| `internal/agent/sessions`, `internal/agent/transcript` | The session an agent's process runs; Claude Code's transcript lines mapped to ACP-shaped events for the chat host ([35](features/35-agent-native-view.md)). |
| `internal/agent/plugin`, `internal/agent/plugin/*` | Machine side of the features: handlers of the `plugin` op (files, git, monitor, search, browser, agents, history, chat, usage); a panic fails the action, not the agent. |
| `internal/chatproto` | The chat host's protocol on its unix socket ([37](features/37-agent-chats.md)). |
| `internal/chathost` | The chat host: lifetime, chats and their agents, the journal and its bounds. Unix only. |
| `internal/chatadapter`, `…/{claude,codex,acp}`, `internal/acp` | The adapters to the agents' protocols: Claude Code's Agent SDK, Codex's app-server, the Agent Client Protocol (Kimi Code, Grok). |
| `internal/store` | Private SQLite databases with versioned schemas ([38](features/38-sqlite-state.md)). |
| `internal/hc` | Client of herdr-core's API: JSON-RPC, attached byte streams with credit, events. |
| `internal/hcdist` | Pinned herdr-core release: version, archive names, SHA-256 ([21](features/21-terminal-core.md)); `scripts/fetch-hc` fetches it for the build. |
| `internal/checksum` | SHA-256 of files. |
| `internal/vaultmcp` | The vault's MCP server (`mcp` command): `list_variables`, `get_variable`, `run_with_env`. |
| `internal/usage` | AI subscription usage and log cost on one machine, run by the agent ([29](features/29-ai-usage.md)); its price table is `spec/pricing/pricing.json`, which the TypeScript side reads too. |
| `internal/jpegstrip` | Parallel JPEG encoding of window captures in row groups. |
| `web` | Browser UI (Vite, React, zustand). Terminals: `src/term` (protocol client, layout), `src/vt` (emulator, [26](features/26-web-terminals.md)); restores: `src/restore.ts`; conversation view: `src/conversation`; plugins: `src/plugins`. The core embeds `web/dist`. |
| `desktop` | Electron shell and electron-builder configuration ([16](features/16-desktop-packaging.md)). |
| `extensions/veldr-bridge` | VS Code extension installed into code-server. |
| `scripts` | Build (`build.sh`: payloads staged in `dist/payload`, the core of each platform), packaging, checks, pinned downloads and the design tokens' generator (`tokens`). |
| `spec` | Design tokens (`tokens.json`, [24](features/24-design-tokens.md)), `generated/registry.json`, the pinned Codex app-server schema, and shared test vectors and recordings (`vectors/`) run by Go, core and web tests. |
| `e2e` | End-to-end tests (`make e2e`): Playwright specs against the real core, each on an isolated instance (`harness`; `E2E_MACHINE=ts` runs them against the TypeScript build), `machines`, old kernels and C libraries in KVM and containers with payloads run in each (`payloads/machine-node`: the TypeScript machine side), `fakeacp`, a scripted offline ACP agent installed as `kimi`, `xclient`, an X program that reports its input for the program window tests, and `sshd`, the image of the SSH machines the tests run in Docker (with Xvfb). |

## Desktop app

The Electron shell (`desktop/src/main.ts`) runs the core in a utility
process (`backend/hosts/electron`, bundled as `desktop/dist/core.mjs`),
instance `desktop` and the default namespace on machines
([39](features/39-nodes.md)), and listens on nothing
([42](features/42-typescript-backend.md)):

- The core starts with a message on its parent port: the instance, the
  payloads' directories (the app's resources) and the verify key, which
  signs the user's system prompt answers (Touch ID, Windows Hello) for
  the vault and never leaves the shell's main process otherwise
  ([30](features/30-variable-vault.md)).
- The app's windows load `https://<slug>.localhost/`, which their session
  intercepts: each request goes to the core over a MessagePort
  (`backend/hosts/electron/bridge.ts`), its body and the response's in
  chunks with credit both ways. WebSockets are channels, MessagePorts the
  main process makes for a frame of that origin (`desktopChannels`; the
  web UI's `openChannel`, VS Code's frames' WebSocket). Requests in process
  are the desktop client's; their Origin is the one Electron reports for
  the frame or worker that made them (`initiatorOrigin`), so the core's
  guard refuses a page of another origin in the app's session.
- A crashed core is started again with the windows kept (at most 3 times
  a minute); quitting asks it to stop, and kills it after 20 s.

The shell is a client of its core, reached directly: it follows settings
and keybindings over `/ws` for the title bar theme, menu language, zoom
and the menu's keys. The renderer is the web UI, sandboxed, with no Node
APIs; its preload exposes `desktopShell` to the main window's page and
`desktopChannels` to each frame of the app's origin. On macOS the menu acts only on keys the page did not
handle; on Windows and Linux every key goes to the page
([04](features/04-layout-and-keyboard.md)). Packaging, menus and the
preload's surface are in [16](features/16-desktop-packaging.md).

## Core ↔ agent protocol (`internal/agentproto`)

One yamux session per machine over ssh stdio and `node dial`, or the
local node's socket; the connection's first line, before yamux, is a
`NodeHello` (`serve` with the ssh session's `SSH_CONNECTION`, or `stop`). Every stream starts with a JSON header line from the opener and a
JSON reply line; after a successful reply it carries op-specific bytes.

| Op | Direction | Purpose |
| --- | --- | --- |
| `hello` | core → agent | Host info, data directories, the ssh session's `SSH_CONNECTION`; the machine is ready once it answers. |
| `fs.stat`, `fs.list` | core → agent | Metadata and listings; large listings follow the reply as `entries_length` bytes of JSON. |
| `fs.read` | core → agent | `Length` bytes from `Offset`. |
| `fs.write` | core → agent | Chunked upload, then a second reply; `unique` keeps existing files. |
| `fs.archive` | core → agent | A zip of `Paths`, streamed. |
| `dial-unix` | core → agent | Raw pipe to a socket in the agent's run directory. |
| `code-server` | core → agent | `status`, `install` (with the `digest` the core verified the release by, which the TypeScript machine side checks before unpacking it), `download` (checked against the core's `digest`), `start`, `stop`, `release` (stops it unless another core's session has a connection to it), `install-ext`, `marker`. |
| `hc` | core → agent | Terminal core `status`, `install` (digest-checked), `install-embedded` (the herdr-core the machine build carries, whose digest `status` reports as `embedded`: the TypeScript build's, which the core holds to the digest its build recorded), `start`, `restart`, `stop` of the agent's instance. |
| `hc-api` | core → agent | Raw pipe to the terminal core's API socket; starts nothing. |
| `detect` | core → agent | Stream of `DetectEvent {terminal, agent, status}` lines, with the agent's `session` when asked ([25](features/25-agent-detection.md)). |
| `privacy` | core → agent | macOS Full Disk Access of the agent and the terminal core. |
| `plugin` | core → agent | A plugin's `Action` with `Params`; a result or JSON lines follow ([27](features/27-plugins.md)). |
| `bridge` | agent → core | JSON lines between the VS Code extension (`bridge.sock`) and the core. |
| `node.drain` | agent → core | The node was taken over by a newer build's: the core connects again and moves the machine to that session ([39](features/39-nodes.md)). |
| `vault` | agent → core | One request from the vault's MCP server (`vault.sock`) with the caller's process chain from peer credentials, one response; asked of every core the node serves ([30](features/30-variable-vault.md)). |
| `gui` | core → agent | Displays: `status`, `install`, `start`, `pick`, `keep`, `shells`, `video`, `video-install`, and `attach` for framed window events, frames and input; every core of the node attaches to one window manager, which takes input from the one in control ([14](features/14-gui-windows.md)). |

Rules:

- Headers and replies are bounded to 1 MiB. Payloads over 32 KiB
  (`MaxInline`) follow the line with a length field, at most 64 MiB.
- The core waits for a reply until the request's deadline, else 60 s
  (`transport.ReplyTimeout`). A plugin stream stays bound to the caller's
  context after the reply.
- yamux streams cannot be half-closed, so uploads use `ChunkWriter` framing
  (`[u32 length][data]…[0]`).
- Core and agent come from the same build (the agent is uploaded by content
  hash), so there is no version negotiation. Extend by adding fields and
  ops; never reuse them.
- The Go machine build and the TypeScript machine side speak the same wire:
  a node of either serves any core, and takes over from the other. The
  TypeScript side answers the ops and plugins of the features it does not
  serve yet (`gui`; chat) as an unknown plugin (`unknown_plugin`).

## Event channel (`/ws`)

Every client (browser page, desktop page, desktop shell) holds one. Text
frames are JSON with a `t` field. Terminals have their own protocol
(below).

| Client → core | Core → client |
| --- | --- |
| `ping {rid}` | `pong {rid}` |
| `retry {m}`: reconnect a machine now (not for read-only clients) | `machines {list}`, `machine {state}` |
| `active {idle}`: when the user last used the page | `agent {m, data, sound}`: a terminal's agent status, or a chat that became blocked or done; `sound` only for the most recently used page |
| `theme {kind}`: VS Code follows it | `gui {state}`: program windows per machine |
| `download.watch {ids}`, `download.cancel {id}` | `download {id, state, sent, total, name, error}` |
| – | `bridge.send`, `bridge.download`, `bridge.focus`, `bridge.close`, `bridge.leave`: VS Code bridge events for the page showing that window ([05](features/05-vscode-panes.md)) |
| – | `settings {values, problems}`, `keybindings {user, effective, conflicts, problems}` after every change ([13](features/13-settings-and-appearance.md)) |
| – | `plugin {plugin, m, data}`: a plugin's message, e.g. the vault's approvals or the chats' states ([27](features/27-plugins.md)) |

HTTP endpoints are listed in
[reference.md](reference.md#http-and-websocket-endpoints). Plugins' routes
are below `/api/p/<plugin>/` and `/api/m/{id}/p/<plugin>/` and answer
`404 plugin_disabled` while the plugin is off.

The server never produces user-facing text: it sends codes that the UI
translates.

## Terminal clients ↔ core protocol (`/api/v1/term`)

Clients that draw terminals themselves use the WebSocket `/api/v1/term`,
behind the same guards as `/ws`. It reaches each machine's terminal core
([21](features/21-terminal-core.md)); the protocol and its reasoning are in
[22](features/22-terminal-protocol.md). Text frames are JSON with a `t`
field; binary frames are `[stream u32 LE][kind u8][payload]`.

| Client → core | Core → client |
| --- | --- |
| `sub {m}`, `unsub {m}` | `backend {m, state, code, version}`, `snapshot {m, terminals}`, `event {m, type, terminal, data}` (with detected agents and sessions) |
| `call {rid, m, method, params}` (allowlisted methods) | `res {rid, result}` or `res {rid, error}` |
| `attach {rid, m, terminal, cols, rows, history, observe, display}` | `attached {rid, s, …}`, later `closed {s, reason, exit_code, signal}` |
| `ack {s, n}`, `resize`, `focus`, `facts`, `detach {s}` | – |
| binary kind 0 (input), kind 6 (automatic answers) | binary kind 0 (output), kind 3 (an observed terminal's new grid) |
| `ping {rid}` | `pong {rid}` |

`ack` returns stream credit for bytes drawn. When the last client that set
a live terminal's size leaves, the core keeps that attachment open so the
terminal keeps its size instead of herdr-core's headless one.

Terminal labels: the UI sets `name` and `closing` (Undo Close,
[04](features/04-layout-and-keyboard.md)); the core sets `seen` for an
acknowledged `done` turn ([25](features/25-agent-detection.md)).

The product's own terminals (the chat host, `agentproto.Hidden`) and other
machines' terminals are in no snapshot, event or list; a call or attach
naming one is answered as for a missing terminal and audited as
`denied.term`.

## Chats (`internal/chatproto`, `backend/features/chat`)

A machine's chat host runs coding agents headless and keeps their
conversations ([37](features/37-agent-chats.md)). The path from a page:

1. **Page ↔ core**: one WebSocket per page, `GET /api/p/chat/ws`, JSON
   frames: `attach`, `detach` and `command` from the page; `attached`,
   `event`, `detached` and `ack` from the core, with bounded subscriptions
   and queues (`wire.go`, `ws.go`, mirrored by
   `web/src/plugins/chat/protocol.ts`). Routes below `/api/m/{id}/p/chat/`
   manage chats ([reference](reference.md#http-and-websocket-endpoints)).
2. **Core ↔ agent**: each subscription, request and watch is a `plugin`
   stream (`chat`, action `open`) that then carries the host's socket. The
   machine side starts the host as a hidden terminal of the instance's
   terminal core when none serves, and asks a host of an older build to
   make way.
3. **Core ↔ chat host**: `chatproto` JSON lines on `chat.sock` in the runtime
   directory: a
   hello, one request and its response, then for `attach` the chat's stored
   and live events and for `watch` the chats' states.
4. **Chat host ↔ agent**: one process per live chat, through its adapter
   on the agent's standard input and output: Claude Code's stream-json,
   Codex's app-server JSON-RPC, or ACP.

## code-server lifecycle

`CodeServers.ensure` (core, `backend/features/vscode/provision.ts`), by
the `codeServer.install` setting:

1. Use an installed code-server, have the machine download the release
   (checked against the core's digest), or upload one the core resolved
   (seed → cache → download, SHA-256 verified; the TypeScript machine side
   checks the upload against the same digest before unpacking it). The
   first two fall back to the last.
2. Install the bridge and default extensions.
3. Start, reusing a running code-server only if it serves the workbench.

The node owns the process (`cs.pid` in the runtime directory) for every core it serves, stops it
on exit, hands it to a node that takes over and reaps orphans. A core releases it after `--code-server-idle`
without proxied WebSockets, which stops it unless another core has a
connection to it, and stops it when VS Code is switched off for every kind
of client
([05](features/05-vscode-panes.md),
[deployment](deployment.md#remote-resources)).

## Names and renames

Runtime identifiers derive from `internal/brand`, `web/src/brand.ts` and
`extensions/veldr-bridge/src/brand.ts`, kept in sync by
`internal/brand/brand_test.go`; `scripts/check.sh` rejects hardcoded names.
`scripts/rename.sh NEW` renames the project; the renamed version starts with
namespaces of its own ([11](features/11-naming-and-renames.md)).

## Internationalization

`web/src/i18n/en.ts` defines every key; other locales are typed against it,
so a missing key fails the build. Plugins keep messages in
`web/src/plugins/<id>/i18n`. The desktop menu uses the same strings. The VS
Code extension uses `package.nls*.json` and `l10n/`. Comments, logs and
protocol messages are English ([12](features/12-internationalization.md)).
