# Architecture

```
browser (React, WebGL)      ──WebSocket + HTTP──▶  core (Go, `herdr-ide`)
macOS application                                    ├─ machines: registry + connection state machine
                                                     ├─ server: event channel, terminal streams, files, code-server proxy, bridge hub
                                                     ├─ gui: virtual displays per machine, window list, frame routing
                                                     └─ one ssh session per machine ──yamux──▶ agent (`herdr-ide-agent`)
                                                                                                 ├─ herdr-core in a session of its own (raw pipe to its API socket)
                                                                                                 ├─ agent detection in its terminals
                                                                                                 ├─ files (stat/list/range read/upload/zip)
                                                                                                 ├─ code-server (unix socket only)
                                                                                                 ├─ Xvfb + window manager (programs' windows)
                                                                                                 └─ bridge.sock ◀── VS Code bridge extension
```

| Directory | Role |
| --- | --- |
| `cmd/herdr-ide` | Core entry point: flags, `serve`, `fetch-assets`, `version`. |
| `cmd/herdr-ide-agent` | Agent entry point (`serve` over stdio). |
| `internal/brand` | Product names; the only place they are defined in Go. |
| `internal/agentproto` | Stream protocol shared by core and agent. |
| `internal/agent` | Agent: the terminal core, agent detection, files, code-server supervision, virtual displays, bridge listener, housekeeping. |
| `internal/agent/detect` | Which coding agent a terminal's foreground process is and its state from the screen, by herdr's method and manifests (embedded, Apache-2.0), with the state machine for debouncing and done ([25](features/25-agent-detection.md)). |
| `internal/transport` | yamux sessions: in-process for the local machine, ssh stdio for others; agent upload. |
| `internal/machines` | The core's machines (`Registry`: SSH machines in `machines[-<instance>].json`, the SSH machines herdr saved imported once when that file does not exist), added, removed, renamed, enabled and disabled at runtime; the connection state machine. |
| `internal/hc` | Client of herdr-core's API (protocol generation 1): JSON-RPC calls, attached terminals as raw byte streams with credit, event subscriptions. |
| `internal/hcdist` | herdr-core release embedded for machines: version, upstream archive names and SHA-256 digests ([21](features/21-terminal-core.md)). |
| `internal/checksum` | SHA-256 of files, shared by the code-server downloads. |
| `internal/codeserver` | code-server provisioning (artifacts, checksums, install modes, start/stop). |
| `internal/settings` | The settings system: typed definitions registered by packages, flags, the hand-editable settings file (watched, migrated), layered values per machine ([13](features/13-settings-and-appearance.md)). |
| `internal/keybindings` | Commands, default keys per platform, the user's keybindings file, the bindings in effect and their conflicts; the key syntax shared with the clients. |
| `internal/uisettings` | The user interfaces' settings (appearance, layout, terminal, colors, notifications); `tokens.go` is generated from the design tokens. |
| `internal/registry` | What the core registers: the setting modules and the commands (used by the core and `scripts/registry`). |
| `internal/userfile` | Atomic writes and change detection of the hand-editable files. |
| `internal/gui` | Virtual displays on machines, their windows, frames and input between agents and browser windows. |
| `internal/server` | HTTP/WS front: guards, the event channel, terminal streams, files, proxy, bridge, audit. |
| `internal/embedded` | Build artifacts compiled into the core (agents, herdr-core, the video encoder, bridge VSIX). |
| `web` | Browser UI (Vite, React, zustand): the terminals of the machines' terminal cores (`src/term`: the client of `/api/v1/term` and the layout document; `src/state/terms.ts`: the machines' terminals and layouts; `src/vt`: Ghostty's terminal library as WebAssembly with its renderer and input encoders, also for the PTY dialogs, [26](features/26-web-terminals.md)); `math.html` renders a formula for the macOS application's preview ([19](features/19-formulas-in-panes.md)); `web/embed.go` embeds `web/dist`. |
| `macos` | macOS application (Swift package): `TermKit`, the clients of `/api/v1/term` and of the event channel `/ws`, of the file endpoints (uploads, downloads) and the settings API, with the terminal, layout (workspaces, tabs, splits), settings, keybindings, transfers, agents' attention, formula and core-process models; `App`, the AppKit window drawing terminals with Ghostty's renderer, with the browser UI's features over the same endpoints ([23](features/23-macos-application.md)). |
| `desktop` | Electron main process and electron-builder config; macOS `.app`/DMG wrapping the embedded core. |
| `extensions/herdr-ide-bridge` | VS Code extension installed into code-server. |
| `design` | Design tokens (`tokens.json`): colors in light and dark, metrics, font sizes and terminal palettes; `scripts/tokens` generates `macos/Sources/App/Tokens.swift`, `web/src/tokens.css` and the terminal colors' setting defaults (`internal/uisettings/tokens.go`) from them. `generated/registry.json` (`scripts/registry`): setting defaults, commands, default bindings per platform and the translation keys each UI needs. `testdata/layout`: the layout document's test vectors (directional focus and pane drops included), run by the TypeScript and Swift clients ([22](features/22-terminal-protocol.md)); `testdata/keys`: the key syntax's vectors, run by Go, TypeScript and Swift; `testdata/math`: the formulas found in terminal text, run by TypeScript and Swift ([19](features/19-formulas-in-panes.md)). |

## Desktop launcher

The optional Electron shell (`desktop/src/main.ts`) spawns the bundled core
from `Contents/Resources/bin/` with `--parent-stdio`, loopback port 7781 and
instance `desktop`. The core writes one `{ "event": "ready", "url": "…" }`
line to stdout after binding its listener; stderr carries logs. The shell
loads only that owned core's URL. Closing the parent stdin pipe cancels the
core's context, including when Electron crashes. Normal quit sends SIGTERM
and waits up to 20 seconds before killing the owned core.

The renderer reuses the browser UI with no Node APIs, sandboxing and context
isolation. The main window's preload exposes only `desktopShell` for direct
shortcuts (single-stroke keybindings with cmd, ctrl or alt, such as `cmd+t`):
the shell intercepts them in `before-input-event`, reading them from
`/api/keybindings`, leaves them to VS Code while one of its frames has focus
(except bindings for everywhere, such as showing or hiding the VS Code
panel), and the page runs the command; the settings dialog records keys
through the same bridge
([04](features/04-layout-and-keyboard.md)), the page reports its theme
setting, which the native title bar follows, and it asks the bridge where a
file or folder dropped from Finder is on disk, to create a workspace there
or paste its path into a pane of the local machine; folders dropped on the
Dock icon reach the page through the same bridge, also when the drop
launched the app. Same-origin popups become equally restricted native
windows; HTTP(S) links outside the core open in the default browser. Packaging
and lifecycle details are in [16](features/16-desktop-packaging.md).

## Core ↔ agent protocol (`internal/agentproto`)

One yamux session per machine over the ssh session's stdio (an in-process
socketpair for the local machine, so both paths run the same code). Every
stream starts with a JSON header line from the opener and a JSON reply line;
after a successful reply it carries op-specific bytes.

| Op | Direction | Payload after the reply |
| --- | --- | --- |
| `hello` | core → agent | – (reply has host info and data dirs); the machine is ready once it answers |
| `fs.stat`, `fs.list` | core → agent | – |
| `fs.read` | core → agent | `Length` bytes from `Offset` |
| `fs.write` | core → agent | chunked upload, then a second reply; `unique` keeps existing files (`-1`, `-2`… names) |
| `fs.archive` | core → agent | a zip of `Paths` (each at the root under its name, directories recursively), streamed until the agent closes the stream; with `Chunked` as `ChunkWriter` chunks ended by the empty chunk once the archive is complete |
| `dial-unix` | core → agent | raw pipe to a socket in the agent's run directory |
| `code-server` | core → agent | actions `status`, `install` (chunked tarball), `download` (the machine fetches `URL`, checked against `Digest`), `start`, `stop`, `install-ext`, `uninstall-ext` (their output in `Exec`), `marker`; `Bin` selects an installed code-server |
| `hc` | core → agent | actions `status`, `install` (after a first reply the gzip-compressed herdr-core executable, chunked, checked against `Digest`), `start`, `restart` (the core's successor adopts the programs) and `stop` (the terminal core of the agent's instance); each ends with a reply with `HC` (the installed executable's digest, whether a core answers, its version, session and socket); failures carry `Code`: `not_installed`, `bad_digest`, `start_failed`, `stop_failed` |
| `hc-api` | core → agent | raw pipe to the terminal core's socket (herdr-core's API, `internal/hc`); starts nothing |
| `detect` | core → agent | after the reply, `DetectEvent` lines `{terminal, agent, status}` (status `working`, `blocked`, `idle`, `done`, `unknown`; `{terminal}` when the agent left) from the agent, which follows the terminal core's terminals until the core closes the stream ([25](features/25-agent-detection.md)); starts and writes nothing |
| `bridge` | agent → core | JSON lines between the VS Code extension and the core |
| `gui` | core → agent | actions `status`, `install` (fetch Xvfb in user space), `start`, `keep` (start the display keeper, which holds the display while the instance's terminal core runs), `shells` (which of the pids in `Args` were started with the display) (reply `GUI`); `video` and `video-install` (`Digest`: the video encoder's SHA-256; the second streams the gzip-compressed encoder, chunked) reply whether it is installed and the stream kinds it makes here (`GUI.Video`, `GUI.VideoEncoders`); `attach`: messages `[kind u8][len u32][payload]`, JSON events (`window`, `gone`, `layer`, `layer_gone`, `cursor`, `stats`, `video` (a window's stream starts, or ends without a codec)) and frames (`GUIFrameHeader` + JPEG/PNG, or a video frame of the whole window, `Enc` 3, 4 for key frames) from the agent, JSON commands (`watch`, `ack`, `refresh`, `codecs` (the stream kinds all viewers decode, also sent with `watch` and `refresh`), `keyframe`, input, `close`) from the core |

yamux streams cannot be half-closed, so uploads use `ChunkWriter` framing
(`[u32 length][data]…[0]`). Core and agent always come from the same build:
the agent is uploaded by content hash, so the protocol needs no version
negotiation. Keep it that way when adding ops (add fields, don't reuse them).

## Event channel (`/ws`)

Every client holds one: the browser UI, the desktop app and the macOS
application. Text frames are JSON with a `t` field; terminals have their
own protocol (`/api/v1/term`, below). A client plays no notification sounds
(`agent {sound}`) before it reports `active`.

| Client → core | Core → client |
| --- | --- |
| `retry {m}` (ends the wait before a disconnected machine's next connection attempt; refused for read-only clients), `ping` | `machines {list}`, `machine {state}`, `agent {m, data}` (status change), `bridge.send {m, text, folders}` (the sending VS Code window's folders: the page picks the workspace whose panel shows it), `bridge.download {m, paths}` (files chosen in VS Code's explorer; the page with the focus downloads them) |
| `download.watch {ids}` (downloads the page started with `dl=<id>`: before starting one and after reconnecting), `download.cancel {id}` | `download {id, state, sent, total, name, error}` to the page following the id: progress and how it ended (`unknown` for an id the core has not seen or no longer knows), for the downloads panel |
| `theme {kind: dark\|light}` (VS Code follows it) | `gui {state: {m, phase, gpu, windows}}` (program windows per machine) |
| – | `settings {values, problems}` and `keybindings {user, effective, conflicts, problems}` after every change, through the API or the files ([13](features/13-settings-and-appearance.md)) |
| `active {idle}` (ms since the user last used the page) | `agent {…, sound}`: `sound` is true only for the most recently used page, which plays the notification sound; a terminal core's terminal sends `data {terminal, agent, display_agent, agent_status, title}` ([25](features/25-agent-detection.md)) |

HTTP endpoints besides files (`GET /api/m/{id}/file`, `GET /api/m/{id}/list`,
and `GET /api/m/{id}/download?path=…[&dl=<id>]`: one file as an attachment,
anything else as a zip from `fs.archive`; `download.cancel` over `/ws`
breaks a followed download off), uploads and the code-server proxy:
`GET /api/config`, `GET /api/machines` (every machine's state: the record,
`status`, the agent's `info`, `hc {state, code, version}` while the core
has a connection to the machine's terminal core), `GET /api/gui`
(the program windows of every machine, as the `gui` messages of `/ws`),
`GET`/`PUT`/`DELETE /api/settings` (definitions, values, problems; one
value set or removed) and `GET`/`PUT /api/keybindings` (commands, defaults,
the user's rules, the bindings in effect and conflicts per platform; the
rules replaced), see [13](features/13-settings-and-appearance.md).
Machines ([02](features/02-multi-machine-transport.md)):
`POST /api/machines` (`{"target", "label"}`: adds and stores an SSH
machine; `201` with its state, `409 machine_exists`),
`PUT /api/m/{id}/label` (`{"label": "…"}`; `409 label_taken`),
`PUT /api/m/{id}/enabled` (`{"enabled": bool}`) and `DELETE /api/m/{id}`
change the core's machines file and the running machine; the WebSocket
`GET /api/m/{id}/auth` is the interactive ssh login of an *auth_required*
machine. `GET /api/m/{id}/hc` and `POST /api/m/{id}/hc/{start|stop|restart}`
report, start, stop and restart its terminal core. When machines come or
go the core sends every browser a new `machines {list}`; a renamed machine
arrives as its `machine {state}`. A program window is shown by
the app at `GET /m/{id}/gui/{win}`, streamed over the WebSocket
`/m/{id}/gui/{win}/ws` (JSON events and binary frames out, JSON commands in;
`?video=avc1,vp8` names the video streams the browser decodes)
and closed through `POST /m/{id}/gui/{win}/close`;
`POST /api/m/{id}/gui/enable` (`{"terminals": [...]}`, empty or absent
for all of them) gives open terminals of the machine's terminal core the
display, see [14](features/14-gui-windows.md). `PUT /api/settings` takes an
optional `machine` for settings that can differ per machine.

## Terminal clients ↔ core protocol (`/api/v1/term`)

Clients that draw terminals themselves use the WebSocket `/api/v1/term`,
behind the same guards as `/ws`. It reaches the terminal core of each
machine (herdr-core in the agent's own session,
[21](features/21-terminal-core.md)); the protocol and its reasoning are in
[22](features/22-terminal-protocol.md). Text frames are JSON with a `t`
field; binary frames are `[stream u32 LE][kind u8][payload]`.

| Client → core | Core → client |
| --- | --- |
| `sub {m}`, `unsub {m}` (a machine's terminals) | `backend {m, state: starting\|ready\|error, code, version}` (also in the machine's state on `/ws` as `hc`), `snapshot {m, terminals}` (herdr-core's terminal records, with the detected `agent` and `agent_status`), `event {m, type, terminal, data}` (herdr-core's events, and `agent` with `{agent, agent_status}`) |
| `call {rid, m, method, params}` (allowlisted herdr-core methods) | `res {rid, result}` or `res {rid, error: {kind, message}}` |
| `attach {rid, m, terminal, cols, rows, history, observe, display}` | `attached {rid, s, terminal, cols, rows, observe, automatic}`, later `closed {s, reason, exit_code, signal}` |
| `ack {s, n}` (output bytes drawn), `resize {s, cols, rows}`, `focus {s, focused}` (focused also marks a terminal's ended turn seen), `facts {s, display}`, `detach {s}` | – |
| binary kind 0 (input bytes), kind 6 (the client terminal's automatic answers) | binary kind 0 (output bytes: a first paint, then the program's output), kind 3 (`cols u16 LE, rows u16 LE`: an observed terminal's new grid) |
| `ping {rid}` | `pong {rid}` |

User-facing text is never produced by the server: it sends codes (phases,
notices) that the UI translates.

## code-server lifecycle

`codeserver.Manager.Ensure` (core): depending on the `codeServer.install`
setting, use an installed code-server, have the machine download the release
(verified against the core's digest), or resolve it for the machine's
platform (seed → cache → download, SHA-256 verified) → upload and unpack;
the first two fall back to the last → install the bridge and the default
extensions (VSIXs, also from the core) → start (a running code-server is
reused only if it serves the workbench; otherwise it is replaced). The agent records the process in `run/cs.pid` with its own pid as
owner; it stops its own process on exit, reaps processes whose owner died,
and stops on request. The core stops code-server after `--code-server-idle`
without WebSocket connections through its proxy. See
[deployment](deployment.md#remote-resources).

## Names, renames and migration

All runtime identifiers derive from `internal/brand` (Go),
`web/src/brand.ts` and `extensions/herdr-ide-bridge/src/brand.ts`;
`internal/brand/brand_test.go` keeps the three in sync and
`scripts/check.sh` rejects new hardcoded occurrences. `scripts/rename.sh NEW`
renames the project (files, directories, module path) and appends the old
names to the `Legacy*` lists, from which:

- the agent moves `~/.<old>` to `~/.<new>` on each machine,
- the core removes the old download cache,
- the web UI moves `localStorage` keys,
- code-server uninstalls the old bridge extension.

## Internationalization

The web UI uses `web/src/i18n`: `en.ts` defines every key, other locales are
typed against it (missing keys fail the build, a test checks placeholders).
The VS Code extension uses `package.nls*.json` and `l10n/`. Code comments,
logs and protocol messages are English.
