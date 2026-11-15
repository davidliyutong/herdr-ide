# Architecture

```
browser (React, wasm + WebGL)  ──WebSocket + HTTP──▶  core (Go, `herdr-ide`)
desktop app (Electron shell)                            ├─ machines: registry + connection state machine
                                                        ├─ settings, keybindings (files on the core host)
                                                        ├─ server: event channel, terminal protocol, files, code-server proxy, bridge hub
                                                        ├─ gui: virtual displays per machine, window list, frame routing
                                                        └─ one ssh session per machine ──yamux──▶ agent (`herdr-ide-agent`)
                                                                                                    ├─ herdr-core in a session of its own (raw pipe to its API socket)
                                                                                                    ├─ agent detection in its terminals
                                                                                                    ├─ files (stat/list/range read/upload/zip)
                                                                                                    ├─ code-server (unix socket only)
                                                                                                    ├─ Xvfb + window manager (programs' windows)
                                                                                                    ├─ plugins' machine sides (op plugin)
                                                                                                    ├─ bridge.sock ◀── VS Code bridge extension
                                                                                                    └─ vault.sock ◀── the vault's MCP server (`<slug>-mcp`) ◀──stdio── coding agents' CLIs
```

The local machine's agent runs inside the core (an in-process socket pair
instead of ssh), so both paths run the same code. The agent is built for
Linux and macOS only: a core on Windows (the desktop app's) has no local
machine, lists it with the code `local_unsupported`, and reaches SSH
machines only ([02](features/02-multi-machine-transport.md)).

| Directory | Role |
| --- | --- |
| `cmd/herdr-ide` | Core entry point: flags, `serve`, `fetch-assets`, `mcp` (the vault's MCP server, also run by the name `<slug>-mcp`), `version`; the local machine's in-process agent (`local_unix.go`; `local_windows.go` dials none). Builds for Linux, macOS and Windows. |
| `cmd/herdr-ide-agent` | Agent entry point (`serve` over stdio; `mcp`, the vault's MCP server, also run by the name `<slug>-mcp`); Linux and macOS only (`//go:build unix`). |
| `internal/brand` | Product names; the only place they are defined in Go. |
| `internal/agentproto` | Stream protocol shared by core and agent, and the yamux configuration of both ends (`yamux.go`). |
| `internal/agent` | Agent: the terminal core, agent detection, files, code-server supervision, virtual displays, the bridge and vault listeners and the MCP link, housekeeping. Every file is `//go:build unix` (unix sockets with peer checks, process groups, Xvfb), so code the core runs on Windows does not import it. |
| `internal/agent/detect` | Which coding agent a terminal's foreground process is and its state from the screen, by herdr's method and manifests (embedded, Apache-2.0), with the state machine for debouncing and done ([25](features/25-agent-detection.md)). |
| `internal/transport` | yamux sessions: in-process for the local machine (`local.go`, unix), ssh stdio for others; agent upload; the ssh control directory (`sys_unix.go`: private, under `/tmp`; `sys_windows.go`: none, since Win32-OpenSSH has no ControlMaster, and ssh started without a console window). |
| `internal/sshconfig` | The Host aliases of the core host's OpenSSH configuration (`~/.ssh/config` and its includes) with their HostName and User, read with bounds for the Add Machine dialog ([02](features/02-multi-machine-transport.md)). |
| `internal/machines` | The core's machines (`Registry`: SSH machines in `machines[-<instance>].json`, the SSH machines herdr saved imported once when that file does not exist; entries and fields it does not use are written back as they were), added, removed, renamed, enabled and disabled at runtime; the connection state machine; the ssh target rule (`ValidTarget`; a stored machine whose target fails is listed with `invalid_target` and never dialed); the local machine of a core on Windows, listed with `local_unsupported` and never dialed (`LocalSupported`). |
| `internal/hc` | Client of herdr-core's API (protocol generation 1): JSON-RPC calls, attached terminals as raw byte streams with credit, event subscriptions. |
| `internal/hcdist` | herdr-core release embedded for machines: version, upstream archive names and SHA-256 digests ([21](features/21-terminal-core.md)). |
| `internal/checksum` | SHA-256 of files, shared by the code-server downloads. |
| `internal/codeserver` | code-server provisioning (artifacts, checksums, install modes, start/stop). |
| `internal/settings` | The settings system: typed definitions registered by packages, flags, the hand-editable settings file (watched, migrated), layered values per machine ([13](features/13-settings-and-appearance.md)). |
| `internal/keybindings` | Commands, default keys per platform, the user's keybindings file, the bindings in effect and their conflicts; the key syntax shared with the clients. |
| `internal/uisettings` | The user interfaces' settings (appearance, layout, terminal, colors, notifications); `tokens.go` is generated from the design tokens. |
| `internal/registry` | What the core registers: the setting modules and the commands (used by the core and `scripts/registry`). |
| `internal/userfile` | Atomic writes and change detection of the hand-editable files; the configuration directory made private on Linux and macOS (`private_unix.go`; on Windows its access control list keeps it the user's). |
| `internal/plugin` | The core's side of plugins: their routes below `/api/p/<id>` and `/api/m/{id}/p/<id>` (guarded and audited as the core's own), `/ws` messages, switches (`plugins.<id>.enabled`) and the calls to their machine sides ([27](features/27-plugins.md)). |
| `internal/agent/plugin` | The machine side of plugins: handlers of the agent's `plugin` op, registered per plugin. |
| `internal/vault` | The variable vault's store on the core host: values encrypted one by one (AES-256-GCM, the name as additional data) in `vault[-<instance>].json`, the master key in the system keychain or from a passphrase (Argon2id) ([30](features/30-variable-vault.md)). Builds for Windows too. |
| `internal/plugins/vault` | The vault plugin's core side: its routes, the MCP servers' requests (op `vault`, a `plugin.Streamer`), approvals and the access log. |
| `internal/vaultmcp` | The vault's MCP server (the `mcp` command of the core and the agent): JSON-RPC over stdio, the tools `list_variables`, `get_variable`, `run_with_env`. |
| `internal/gui` | Virtual displays on machines, their windows, frames and input between agents and browser windows. |
| `internal/jpegstrip` | JPEG encoding of a window capture in independent row groups, encoded in parallel (from Go's `image/jpeg`, BSD). |
| `internal/server` | HTTP/WS front: guards, the event channel, terminal streams, files, proxy, bridge, audit. |
| `internal/embedded` | Build artifacts compiled into the core (agents, herdr-core, the video encoder, bridge VSIX). |
| `web` | Browser UI (Vite, React, zustand): the plugins' web sides (`src/plugins`, the right sidebar `src/components/RightBar.tsx`, [27](features/27-plugins.md)); the terminals of the machines' terminal cores (`src/term`: the client of `/api/v1/term` and the layout document, whose panes are terminals, VS Code and previews; `src/state/terms.ts`: the machines' terminals and layouts; `src/vt`: Ghostty's terminal library as WebAssembly with its renderer and input encoders, also for the PTY dialogs, [26](features/26-web-terminals.md)); VS Code panes' iframes in a layer over the panes (`src/codeFrames.ts`, `src/components/CodeLayer.tsx`, [05](features/05-vscode-panes.md)); `web/embed.go` embeds `web/dist`. |
| `desktop` | Electron shell for macOS, Windows and Linux (`src`: the owned core process, what differs per system (`platform.ts`), the client of its settings and keybindings, the application menu, the main window's preload and policy) and electron-builder config: macOS DMG and zip, Windows NSIS setup, Linux AppImage and deb, each wrapping the core built for its system. |
| `extensions/herdr-ide-bridge` | VS Code extension installed into code-server. |
| `scripts` | Build, packaging and check scripts (`build.sh`, which also builds a Windows core; `package.sh`, archives for Linux and macOS; `desktop.sh`, the desktop app of each system; `icons.sh`; `check.sh`, which vets for Linux, macOS and Windows too), the pinned downloads (`fetch-hc`, `fetch-ghostty-vt.sh` for the web UI's emulator, `build-ffmpeg.sh` for the video encoder) and the generators (`tokens`, `registry`). |
| `design` | Design tokens (`tokens.json`): colors in light and dark, metrics, font sizes and terminal palettes; `scripts/tokens` generates `web/src/tokens.css` and the terminal colors' setting defaults (`internal/uisettings/tokens.go`) from them. `generated/registry.json` (`scripts/registry`): setting defaults, commands, default bindings per platform and the translation keys the web UI needs for them. `testdata/layout`: the layout document's test vectors (directional focus, pane drops and VS Code and preview panes included), run by the web UI's tests ([22](features/22-terminal-protocol.md)); `testdata/keys`: the key syntax's vectors, run by the web UI's tests (`parse.json` by Go's too); `testdata/math`: the formulas found in terminal text, run by the web UI's tests ([19](features/19-formulas-in-panes.md)); `testdata/machines`: the ssh target rule's vectors, run by Go and the web UI's tests. |

## Desktop launcher

The optional Electron shell (`desktop/src/main.ts`) runs on macOS, Windows
and Linux (`desktop/src/platform.ts` holds what differs). It spawns the
bundled core from its resources (`bin/herdr-ide`, `bin/herdr-ide.exe` on
Windows) with `--parent-stdio`, loopback port 7781 and instance `desktop`.
The core writes one `{ "event": "ready", "url": "…" }` line to stdout after
binding its listener; stderr carries logs. The shell loads only that owned
core's URL. Closing the parent stdin pipe cancels the core's context, and
it is how the shell stops the core on every system (no signal is sent;
Windows has none a process can clean up after), also when Electron
crashes; a core that has not exited after 20 seconds is killed. On macOS
the app and its core keep running in the Dock when the main window closes;
on Windows and Linux closing it quits.

The shell is a client of its core (`desktop/src/follow.ts`): it holds its
own `/ws` connection, reads `GET /api/settings` and `GET /api/keybindings`
when it opens and applies the `settings` and `keybindings` messages after
every change. The theme setting becomes the native title bar's and
controls', the language the menu's, the zoom (`window.zoom`) its
windows'. The application menu
(`desktop/src/menu.ts`: on macOS the application's, Shell, Edit, View and
Window; on Windows and Linux File, Shell, Edit, View, Window and Help)
holds the keybindings' commands for terminals, splits, workspaces, tabs,
find, the palette, the sidebar, Open in VS Code, maximizing a pane, the window's
zoom and focus, named as the
commands are everywhere; each command item shows the first single-stroke
key its command has and is disabled while the page says its command
cannot run, and the menu is rebuilt when the keybindings or the language
change.

The renderer reuses the browser UI with no Node APIs, sandboxing and context
isolation. The page matches every key it sees itself (`web/src/keymap.ts`),
with the desktop platform's bindings (`mac`, or `pc` on Windows and Linux),
and cancels the keys it runs. On macOS the menu acts only on keys the page
left (a text field, VS Code or another window has the keyboard), so a key
runs once; while a VS Code pane has the keyboard its commands act on that
pane; on Windows and Linux it registers no key and every key goes to the
page ([04](features/04-layout-and-keyboard.md)). A VS Code pane gives the
page the key of `pane.close` before VS Code sees it
([05](features/05-vscode-panes.md)). The main window's
preload exposes only `desktopShell`: the commands of menu items chosen,
which commands' items to disable (from the page), where a file or folder
dropped from the file manager is on disk (to create a workspace there or
paste its path into a pane of the local machine), and the folders opened
with the app (dropped on the Dock icon on macOS, named
on the command line by a file manager's Open With on Linux), also when they
launched it, and on macOS three requests for Full Disk Access without
arguments (System Settings at that list, the local terminal core's
executable in Finder, quitting and reopening the app), for which the shell
opens one fixed URL, a path it works out itself and its own bundle.
Same-origin popups become equally restricted native windows;
HTTP(S) links outside the core open in the default browser. Packaging and
lifecycle details are in [16](features/16-desktop-packaging.md).

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
| `hc` | core → agent | actions `status`, `install` (after a first reply the gzip-compressed herdr-core executable, chunked, checked against `Digest`), `start`, `restart` (the core's successor adopts the programs; both with `Digest`, the executable this build carries, which the agent hashes the installed file against before running it) and `stop` (the terminal core of the agent's instance); each ends with a reply with `HC` (the installed executable's digest, whether a core answers, its version, session and socket); failures carry `Code`: `not_installed`, `bad_digest`, `start_failed`, `stop_failed` |
| `hc-api` | core → agent | raw pipe to the terminal core's socket (herdr-core's API, `internal/hc`); starts nothing |
| `detect` | core → agent | after the reply, `DetectEvent` lines `{terminal, agent, status}` (status `working`, `blocked`, `idle`, `done`, `unknown`; `{terminal}` when the agent left) from the agent, which follows the terminal core's terminals until the core closes the stream ([25](features/25-agent-detection.md)); starts and writes nothing |
| `privacy` | core → agent | – (reply has `Privacy`: whether macOS's Full Disk Access lets the agent's process (`files`; on the local machine the core's) and the terminal core (`terminals`, a probe it runs with `machine.exec`) open a folder only it opens, each `granted`, `denied` or `unknown`, and the terminal core's executable); starts no terminal core, reads no file |
| `plugin` | core → agent | `Action` of `Plugin` with `Params` (the plugin's JSON); the reply's `Plugin` is its result, or JSON lines follow until either side closes the stream; failures carry `Code` (`unknown_plugin`, `bad_params`, the plugin's own) ([27](features/27-plugins.md)) |
| `bridge` | agent → core | JSON lines between the VS Code extension and the core |
| `vault` | agent → core | one `VaultRequest` line `{tool: list\|get\|env, names, client, terminal, cwd}` from the vault's MCP server, relayed from `vault.sock`, and one `VaultResponse` line `{ok, code, error, variables, values}`; the core decides from the machine the stream came from; refused with `Code` `plugin_disabled` while the plugin is off ([30](features/30-variable-vault.md)) |
| `gui` | core → agent | actions `status`, `install` (fetch Xvfb in user space), `start`, `keep` (start the display keeper, which holds the display while the instance's terminal core runs), `shells` (which of the pids in `Args` were started with the display) (reply `GUI`); `video` and `video-install` (`Digest`: the video encoder's SHA-256; the second streams the gzip-compressed encoder, chunked) reply whether it is installed and the stream kinds it makes here (`GUI.Video`, `GUI.VideoEncoders`); `attach`: messages `[kind u8][len u32][payload]`, JSON events (`window`, `gone`, `layer`, `layer_gone`, `cursor`, `stats`, `video` (a window's stream starts, or ends without a codec)) and frames (`GUIFrameHeader` + JPEG/PNG, or a video frame of the whole window, `Enc` 3, 4 for key frames) from the agent, JSON commands (`watch`, `ack`, `refresh`, `codecs` (the stream kinds all viewers decode, also sent with `watch` and `refresh`), `keyframe`, input, `close`) from the core |

yamux streams cannot be half-closed, so uploads use `ChunkWriter` framing
(`[u32 length][data]…[0]`). Core and agent always come from the same build:
the agent is uploaded by content hash, so the protocol needs no version
negotiation. Keep it that way when adding ops (add fields, don't reuse them).

## Event channel (`/ws`)

Every client holds one: the browser UI and the desktop app (its page and
its shell, which follows the settings and keybindings). Text frames are JSON with a `t` field; terminals have their
own protocol (`/api/v1/term`, below). A client plays no notification sounds
(`agent {sound}`) before it reports `active`.

| Client → core | Core → client |
| --- | --- |
| `retry {m}` (ends the wait before a disconnected machine's next connection attempt; refused for read-only clients), `ping {rid}` | `pong {rid}`, `machines {list}`, `machine {state}`, `agent {m, data}` (status change), `bridge.send {m, text, file, line, end_line, folders, window}` (text for an agent, with the file and lines it came from; `folders` and `window` are the sending VS Code window's, absent while unknown: the page whose VS Code pane shows that window picks a terminal of the pane's workspace), `bridge.download {m, paths, window}` (files chosen in VS Code's explorer; the page showing that window, else the page with the focus, downloads them), `bridge.focus {m, window, folders}` (a VS Code window got the keyboard: the page whose pane has it learns the pane's window and names it in its commands, `POST /api/m/{id}/bridge`) |
| `download.watch {ids}` (downloads the page started with `dl=<id>`: before starting one and after reconnecting), `download.cancel {id}` | `download {id, state, sent, total, name, error}` to the page following the id: progress and how it ended (`unknown` for an id the core has not seen or no longer knows), for the downloads panel |
| `theme {kind: dark\|light}` (VS Code follows it) | `gui {state: {m, phase, gpu, windows}}` (program windows per machine) |
| – | `plugin {plugin, m, data}`: a plugin's message for machine `m` (`""` for the core's), handed to the plugin's web side while it is on ([27](features/27-plugins.md)); the vault's: `{type: request, request: {id, m, tool, names, client, terminal, cwd, created, expires}}` (an approval to ask), `{type: resolved, id, answer}` (answered or expired: every page closes it), `{type: changed}` (load the variables and the log again) ([30](features/30-variable-vault.md)) |
| – | `settings {values, problems}` and `keybindings {user, effective, conflicts, problems}` after every change, through the API or the files ([13](features/13-settings-and-appearance.md)) |
| `active {idle}` (ms since the user last used the page) | `agent {…, sound}`: `sound` is true only for the most recently used page, which plays the notification sound; a terminal core's terminal sends `data {terminal, agent, display_agent, agent_status, title}` ([25](features/25-agent-detection.md)) |

HTTP endpoints besides files (`GET /api/m/{id}/file`, `GET /api/m/{id}/list`,
and `GET /api/m/{id}/download?path=…[&dl=<id>]`: one file as an attachment,
anything else as a zip from `fs.archive`; `download.cancel` over `/ws`
breaks a followed download off), uploads and the code-server proxy:
`GET /api/config` (with `ssh_login`: whether the core offers the
interactive ssh login, false on Windows), `GET /api/machines` (every
machine's state: the record, `status`, `code` for a machine never
connected (`invalid_target`, `local_unsupported`), the agent's `info`,
`hc {state, code, version}` while the core has a connection to the
machine's terminal core), `GET /api/gui`
(the program windows of every machine, as the `gui` messages of `/ws`),
`GET`/`PUT`/`DELETE /api/settings` (definitions, values, problems; one
value set or removed) and `GET`/`PUT /api/keybindings` (commands, defaults,
the user's rules, the bindings in effect and conflicts per platform; the
rules replaced), see [13](features/13-settings-and-appearance.md).
Machines ([02](features/02-multi-machine-transport.md)):
`POST /api/machines` (`{"target", "label"}`: adds and stores an SSH
machine; `201` with its state, `409 machine_exists`),
`GET /api/ssh/hosts` (the Host aliases of the core host's ssh
configuration that are no machine yet, with their `hostname` and `user`,
for the Add Machine dialog; refused read-only),
`PUT /api/machines/order` (`{"order": [ids]}`, each machine once),
`PUT /api/m/{id}/label` (`{"label": "…"}`; `409 label_taken`),
`PUT /api/m/{id}/enabled` (`{"enabled": bool}`) and `DELETE /api/m/{id}`
change the core's machines file and the running machine; the WebSocket
`GET /api/m/{id}/auth` is the interactive ssh login of an *auth_required*
machine (`501 ssh_login_unsupported` on a core without ssh control
sockets, Windows). `GET /api/m/{id}/hc` and `POST /api/m/{id}/hc/{start|stop|restart}`
report, start, stop and restart its terminal core; `GET /api/m/{id}/privacy`
reports macOS's Full Disk Access for the machine's processes (op
`privacy`, [16](features/16-desktop-packaging.md)). When machines come or
go the core sends every browser a new `machines {list}`; a renamed machine
arrives as its `machine {state}`. A program window is shown by
the app at `GET /m/{id}/gui/{win}`, streamed over the WebSocket
`/m/{id}/gui/{win}/ws` (JSON events and binary frames out, JSON commands in;
`?video=avc1,vp8` names the video streams the browser decodes)
and closed through `POST /m/{id}/gui/{win}/close`;
`POST /api/m/{id}/gui/enable` (`{"terminals": [...]}`, empty or absent
for all of them) gives open terminals of the machine's terminal core the
display, see [14](features/14-gui-windows.md). `PUT /api/settings` takes an
optional `machine` for settings that can differ per machine. Plugins' routes
are below `/api/p/<plugin>/` and `/api/m/{id}/p/<plugin>/` (each plugin's
document lists them); they answer `404 plugin_disabled` while the plugin is
off ([27](features/27-plugins.md)).

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
| `attach {rid, m, terminal, cols, rows, history, observe, display}` (an observer's `display` is not passed on) | `attached {rid, s, terminal, cols, rows, observe, automatic}`, later `closed {s, reason, exit_code, signal}` |
| `ack {s, n}` (output bytes drawn; at most the bytes sent and not yet acknowledged are credited), `resize {s, cols, rows}`, `focus {s, focused}` (focused also marks a terminal's ended turn seen; an observer's is dropped), `facts {s, display}`, `detach {s}` | – |
| binary kind 0 (input bytes), kind 6 (the client terminal's automatic answers) | binary kind 0 (output bytes: a first paint, then the program's output), kind 3 (`cols u16 LE, rows u16 LE`: an observed terminal's new grid) |
| `ping {rid}` | `pong {rid}` |

Terminal labels the UI sets with `terminal.label`: `name` (a pane's name)
and `closing` (the time, in ms since the epoch, when a terminal whose pane
was closed ends unless Undo Close brings it back; empty when brought back,
[04](features/04-layout-and-keyboard.md)).

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
typed against it (missing keys fail the build, a test checks placeholders);
the desktop app's menu and dialogs use the same strings. The settings' and
commands' labels are the keys `design/generated/registry.json` lists, and
the web UI's tests fail when one is missing. The VS Code extension uses
`package.nls*.json` and `l10n/`. Code comments, logs and protocol messages
are English ([12](features/12-internationalization.md)).
