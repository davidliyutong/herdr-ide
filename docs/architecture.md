# Architecture

```
browser (React, canvas)     ──WebSocket + HTTP──▶  core (Go, `herdr-ide`)
                                                     ├─ machines: registry + connection state machine
                                                     ├─ server: WS hub, session owner + pane surfaces, files, code-server proxy, bridge hub
                                                     ├─ gui: virtual displays per machine, window list, frame routing
                                                     └─ one ssh session per machine ──yamux──▶ agent (`herdr-ide-agent`)
                                                                                                 ├─ herdr API socket (raw pipe)
                                                                                                 ├─ herdr client socket (raw pipe, endpoint protocol)
                                                                                                 ├─ files (stat/list/range read/upload)
                                                                                                 ├─ code-server (unix socket only)
                                                                                                 ├─ Xvfb + window manager (programs' windows)
                                                                                                 └─ bridge.sock ◀── VS Code bridge extension
```

| Directory | Role |
| --- | --- |
| `cmd/herdr-ide` | Core entry point: flags, `serve`, `herdr` (runs the bundled herdr), `fetch-assets`. |
| `cmd/herdr-ide-agent` | Agent entry point (`serve` over stdio). |
| `internal/brand` | Product names; the only place they are defined in Go. |
| `internal/agentproto` | Stream protocol shared by core and agent. |
| `internal/agent` | Agent: herdr, terminals, files, code-server supervision, bridge listener, housekeeping. |
| `internal/transport` | yamux sessions: in-process for the local machine, ssh stdio for others; agent upload. |
| `internal/machines` | Machine registry (herdr's saved machines, enabled or disabled over it from the UI), state machine, herdr snapshots and subscriptions. |
| `internal/herdr` | herdr public socket API client; `endpoint`: client of herdr's endpoint protocol (generation 1). |
| `internal/herdrdist` | herdr release bundled in archives: version, upstream asset names and SHA-256 digests. |
| `internal/checksum` | SHA-256 of files, shared by code-server and herdr downloads. |
| `internal/codeserver` | code-server provisioning (artifacts, checksums, install modes, start/stop). |
| `internal/settings` | Core settings changeable from the UI: definitions, flags, settings file. |
| `internal/gui` | Virtual displays on machines, their windows, frames and input between agents and browser windows. |
| `internal/server` | HTTP/WS front: guards, session ownership and pane surfaces, files, proxy, bridge, audit. |
| `internal/embedded` | Build artifacts compiled into the core (agents, bridge VSIX). |
| `web` | Browser UI (Vite, React, zustand; panes on a canvas, xterm.js for the PTY dialogs); `web/embed.go` embeds `web/dist`. |
| `desktop` | Electron main process and electron-builder config; macOS `.app`/DMG wrapping the embedded core. |
| `extensions/herdr-ide-bridge` | VS Code extension installed into code-server. |

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
shortcuts (`cmd+t`/`cmd+w`/`cmd+,`/`cmd+n`/`cmd+j`): the shell intercepts them in
`before-input-event`, reading their keys from the core settings
`desktop-*-key`, leaves them to VS Code while one of its frames has focus
(except showing or hiding the VS Code panel), and the page runs the action; the
settings dialog records keys through the same bridge
([04](features/04-layout-and-keyboard.md)), the page reports its theme
setting, which the native title bar follows, and it asks the bridge where a
file or folder dropped from Finder is on disk, to create a workspace there
or paste its path into a pane of the local machine; folders dropped on the
Dock icon reach the page through the same bridge, also when the drop
launched the app. Same-origin popups become equally restricted native
windows; HTTP(S) links outside the core open in the default browser. Packaging
and lifecycle details are in [16](features/16-desktop-packaging.md).

## herdr facts the design relies on

Release archives contain the core with the matching native herdr beside it,
plus licenses. herdr is not embedded in agents. Every agent finds an installed
herdr the same way; the local agent falls back to the bundled one when none is
installed. herdr keeps its usual configuration, state and sockets. See
[feature 15](features/15-bundled-herdr.md).

Verified against herdr 0.9.5 (protocol 22):

- The public socket (`~/.config/herdr/herdr.sock`, mode 0600, no other auth)
  takes **one request per connection**, newline-delimited JSON
  `{id, method, params}`, and the request must arrive within 5 s.
- `events.subscribe` turns a connection into an event stream. A lagging
  subscriber gets `events_lost` and is closed; resubscribe and refetch
  `session.snapshot`. Agent status needs per-pane subscriptions. There is no
  pane output event.
- `herdr-client.sock` (beside the API socket, mode 0600) speaks the client
  endpoint protocol; generation 1 is kept for clients of any herdr build
  (0.9.5 and newer). Frames are a u32 little-endian length and a bincode 2
  value; the client says hello (generation, codecs, surface size), herdr
  welcomes it and sends a JSON snapshot, then complete surfaces and patches
  of the connection's focused tab, rendered by herdr at the client's size
  with borders and split lines. Keys, text, pastes and mouse events are
  sent per pane and encoded by herdr for the pane's modes. The client that
  interacted last is the foreground client: it receives OSC 52, bells and
  titles, and its reported colors answer OSC 10/11/4 and `CSI ?996n` for
  every pane. With a single client its size resizes every tab; a client
  connecting to a session without a workspace makes herdr create one. See
  [18](features/18-endpoint-surfaces.md).
- herdr 0.9.5 encodes no bytes for a Backspace key event without Ctrl; its
  own client sends the DEL byte as text, and so does the browser.
- Panes report their scroll position (`scroll`: `offset_from_bottom`,
  `max_offset_from_bottom`, `viewport_rows`) in `pane.get` and the snapshot.
  `pane.scroll` sets an absolute offset (clamped) and replies with the pane;
  the position is shared by every client of the pane, a scrolled-back view
  stays on its lines while output arrives, and stream input returns it to
  the bottom. `pane.selection.read` returns the text between two cells in
  absolute rows (row 0 is the oldest line kept), both included.

## Core ↔ agent protocol (`internal/agentproto`)

One yamux session per machine over the ssh session's stdio (an in-process
socketpair for the local machine, so both paths run the same code). Every
stream starts with a JSON header line from the opener and a JSON reply line;
after a successful reply it carries op-specific bytes.

| Op | Direction | Payload after the reply |
| --- | --- | --- |
| `hello` | core → agent | – (reply has host info, herdr binary, data dirs) |
| `herdr-api` | core → agent | raw pipe to the herdr socket; the core sends the request line right after the header, without waiting for the reply (herdr wants it within 5 s) |
| `herdr-client` | core → agent | raw pipe to herdr's client socket (endpoint protocol) |
| `fs.stat`, `fs.list` | core → agent | – |
| `fs.read` | core → agent | `Length` bytes from `Offset` |
| `fs.write` | core → agent | chunked upload, then a second reply; `unique` keeps existing files (`-1`, `-2`… names) |
| `exec` | core → agent | – (buffered output in the reply) |
| `dial-unix` | core → agent | raw pipe to a socket in the agent's run directory |
| `code-server` | core → agent | actions `status`, `install` (chunked tarball), `download` (the machine fetches `URL`, checked against `Digest`), `start`, `stop`, `install-ext`, `uninstall-ext`, `marker`; `Bin` selects an installed code-server |
| `herdr` | core → agent | – (an empty reply at once, then a second reply with `Herdr` when the action is done); actions `status`, `start`, `stop` (the server of `Session`), `check` (herdr's newest release), `update` (only the application's managed copy) |
| `bridge` | agent → core | JSON lines between the VS Code extension and the core |
| `gui` | core → agent | actions `status`, `install` (fetch Xvfb in user space), `start`, `keep` (start the display keeper for `Session`'s herdr server), `shells` (which of the pids in `Args` were started with the display) (reply `GUI`); `video` and `video-install` (`Digest`: the video encoder's SHA-256; the second streams the gzip-compressed encoder, chunked) reply whether it is installed and the stream kinds it makes here (`GUI.Video`, `GUI.VideoEncoders`); `attach`: messages `[kind u8][len u32][payload]`, JSON events (`window`, `gone`, `layer`, `layer_gone`, `cursor`, `stats`, `video` (a window's stream starts, or ends without a codec)) and frames (`GUIFrameHeader` + JPEG/PNG, or a video frame of the whole window, `Enc` 3, 4 for key frames) from the agent, JSON commands (`watch`, `ack`, `refresh`, `codecs` (the stream kinds all viewers decode, also sent with `watch` and `refresh`), `keyframe`, input, `close`) from the core |

yamux streams cannot be half-closed, so uploads use `ChunkWriter` framing
(`[u32 length][data]…[0]`). Core and agent always come from the same build:
the agent is uploaded by content hash, so the protocol needs no version
negotiation. Keep it that way when adding ops (add fields, don't reuse them).

## Browser ↔ core protocol (`/ws`)

Text frames are JSON with a `t` field; binary frames are pane surface updates
(complete or patch: generation, size, cursor, row moves, spans of cells; see
`web/src/surface/protocol.ts`).

| Browser → core | Core → browser |
| --- | --- |
| `view {m, tab, pane, cols, rows, cw, ch}`, `takeover` | `session {state: owner\|busy\|taken_over}` |
| `in {m, pane, ev}` (key, text, paste, mouse events), `focus {m, focused}`, `host {host}` (terminal colors) | `surf {m, gen, ev: open\|error\|notice, code}`, `surf.tab`, `surf.meta` (panes, splits, links), `clip` (OSC 52), `bell` |
| `api {rid, m, method, params}` (allowlisted herdr calls) | `api.res {rid, result\|error}` |
| `retry {m}`, `ping` | `machines {list}`, `machine {state}`, `agent {m, data}` (status change), `bridge.send {m, text}` |
| `theme {kind: dark\|light}` (VS Code follows it) | `gui {state: {m, phase, gpu, windows}}` (program windows per machine) |
| `active {idle}` (ms since the user last used the page) | `agent {…, sound}`: `sound` is true only for the most recently used page, which plays the notification sound |

HTTP endpoints besides files, uploads and the code-server proxy:
`GET /api/config`, `GET /api/keymap`, `GET /api/machines`, and
`GET`/`PUT /api/settings` (core settings with their definitions, see
[13](features/13-settings-and-appearance.md)), and `PUT /api/m/{id}/enabled`
(`{"enabled": bool}`: enables or disables a machine, see
[02](features/02-multi-machine-transport.md)). A program window is shown by
the app at `GET /m/{id}/gui/{win}`, streamed over the WebSocket
`/m/{id}/gui/{win}/ws` (JSON events and binary frames out, JSON commands in;
`?video=avc1,vp8` names the video streams the browser decodes)
and closed through `POST /m/{id}/gui/{win}/close`;
`POST /api/m/{id}/gui/enable` gives open panes the display, see
[14](features/14-gui-windows.md). `PUT /api/settings` takes an optional
`machine` for settings that can differ per machine. `GET /api/m/{id}/herdr`
and `POST /api/m/{id}/herdr/{start|stop|check|update}` manage the local
machine's herdr; the WebSocket `GET /api/m/{id}/herdr/remote` runs the local
herdr's `herdr --remote` for an SSH machine in a PTY, see
[17](features/17-local-herdr-management.md).

User-facing text is never produced by the server: it sends codes (phases,
notices) that the UI translates.

## Session ownership and surfaces (`internal/server/surface.go`)

One browser connection owns the core's session, like a KVM console: it
chooses the shown machine, tab and size, and only its input reaches herdr.
Another browser is told the session is busy and may take it over; the
previous owner is then told it was taken over. A read-only browser never
takes over a writable one. The core keeps one endpoint connection to the
shown machine's herdr, decodes its surfaces into a grid and forwards changed
spans; when the owner changes, the new owner gets the current surface. See
[18](features/18-endpoint-surfaces.md).

## code-server lifecycle

`codeserver.Manager.Ensure` (core): depending on the `code-server-install`
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
