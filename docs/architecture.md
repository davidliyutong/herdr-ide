# Architecture

```
browser (React + xterm.js)  ──WebSocket + HTTP──▶  core (Go, `herdr-ide`)
                                                     ├─ machines: registry + connection state machine
                                                     ├─ server: WS hub, pane arbiter, files, code-server proxy, bridge hub
                                                     └─ one ssh session per machine ──yamux──▶ agent (`herdr-ide-agent`)
                                                                                                 ├─ herdr API socket (raw pipe)
                                                                                                 ├─ `herdr terminal session` processes
                                                                                                 ├─ files (stat/list/range read/upload)
                                                                                                 ├─ code-server (unix socket only)
                                                                                                 └─ bridge.sock ◀── VS Code bridge extension
```

| Directory | Role |
| --- | --- |
| `cmd/herdr-ide` | Core entry point: flags, `serve`, `fetch-assets`. |
| `cmd/herdr-ide-agent` | Agent entry point (`serve` over stdio). |
| `internal/brand` | Product names; the only place they are defined in Go. |
| `internal/agentproto` | Stream protocol shared by core and agent. |
| `internal/agent` | Agent: herdr, terminals, files, code-server supervision, bridge listener, housekeeping. |
| `internal/transport` | yamux sessions: in-process for the local machine, ssh stdio for others; agent upload. |
| `internal/machines` | Machine registry (herdr's saved machines), state machine, herdr snapshots and subscriptions. |
| `internal/herdr` | herdr public socket API client. |
| `internal/codeserver` | code-server provisioning (artifacts, checksums, install modes, start/stop). |
| `internal/settings` | Core settings changeable from the UI: definitions, flags, settings file. |
| `internal/server` | HTTP/WS front: guards, arbiter, files, proxy, bridge, audit. |
| `internal/embedded` | Build artifacts compiled into the core (agents, bridge VSIX). |
| `web` | Browser UI (Vite, React, zustand, xterm.js); `web/embed.go` embeds `web/dist`. |
| `extensions/herdr-ide-bridge` | VS Code extension installed into code-server. |

## herdr facts the design relies on

Verified against herdr 0.9.5 (protocol 22):

- The public socket (`~/.config/herdr/herdr.sock`, mode 0600, no other auth)
  takes **one request per connection**, newline-delimited JSON
  `{id, method, params}`, and the request must arrive within 5 s.
- `events.subscribe` turns a connection into an event stream. A lagging
  subscriber gets `events_lost` and is closed; resubscribe and refetch
  `session.snapshot`. Agent status needs per-pane subscriptions. There is no
  pane output event.
- `herdr terminal session control|observe <pane> --cols N --rows N` is a
  documented JSON-lines stream of `terminal.frame` records (base64 ANSI,
  full or delta, re-rendered by herdr's terminal emulator; the first frame is
  full). Control accepts `terminal.input|resize|scroll|mouse|release`, resizes
  the PTY and allows one controller per pane; observers do not resize.
- That stream drops OSC 52, bell, keyboard-protocol negotiation and Kitty
  graphics. A native client of herdr's private protocol could keep them but
  would be tied to its exact protocol version.

## Core ↔ agent protocol (`internal/agentproto`)

One yamux session per machine over the ssh session's stdio (an in-process
socketpair for the local machine, so both paths run the same code). Every
stream starts with a JSON header line from the opener and a JSON reply line;
after a successful reply it carries op-specific bytes.

| Op | Direction | Payload after the reply |
| --- | --- | --- |
| `hello` | core → agent | – (reply has host info, herdr binary, data dirs) |
| `herdr-api` | core → agent | raw pipe to the herdr socket |
| `term` | core → agent | JSON lines of `herdr terminal session` |
| `fs.stat`, `fs.list` | core → agent | – |
| `fs.read` | core → agent | `Length` bytes from `Offset` |
| `fs.write` | core → agent | chunked upload, then a second reply |
| `exec` | core → agent | – (buffered output in the reply) |
| `dial-unix` | core → agent | raw pipe to a socket in the agent's run directory |
| `code-server` | core → agent | actions `status`, `install` (chunked tarball), `download` (the machine fetches `URL`, checked against `Digest`), `start`, `stop`, `install-ext`, `uninstall-ext`, `marker`; `Bin` selects an installed code-server |
| `bridge` | agent → core | JSON lines between the VS Code extension and the core |

yamux streams cannot be half-closed, so uploads use `ChunkWriter` framing
(`[u32 length][data]…[0]`). Core and agent always come from the same build:
the agent is uploaded by content hash, so the protocol needs no version
negotiation. Keep it that way when adding ops (add fields, don't reuse them).

## Browser ↔ core protocol (`/ws`)

Text frames are JSON with a `t` field; binary frames are terminal output
`[sid u32][flags u8][cols u16][rows u16][ANSI bytes]` (flags bit 0 = full).

| Browser → core | Core → browser |
| --- | --- |
| `attach {sid, m, pane, cols, rows, mode: auto\|observe, takeover}` | `machines {list}`, `machine {state}` |
| `detach`, `claim`, `resize`, `in`, `inb`, `scroll`, `mouse` | `term {sid, ev: open\|closed\|error\|notice, mode, cols, rows, code}` |
| `api {rid, m, method, params}` (allowlisted herdr calls) | `api.res {rid, result\|error}` |
| `retry {m}`, `ping` | `agent {m, data}` (status change), `bridge.send {m, text}` |
| `theme {kind: dark\|light}` (VS Code follows it) | |

HTTP endpoints besides files, uploads and the code-server proxy:
`GET /api/config`, `GET /api/keymap`, `GET /api/machines`, and
`GET`/`PUT /api/settings` (core settings with their definitions, see
[13](features/13-settings-and-appearance.md)).

User-facing text is never produced by the server: it sends codes (phases,
notices) that the UI translates.

## Pane arbitration (`internal/server/arbiter.go`)

Within one core, the most recently active browser controls a pane (its size
becomes the PTY size); every other viewer gets its own observe stream at the
controller's size, scaled to fit. Typing or clicking claims control. When the
controller leaves, control passes to the most recently active remaining
viewer. A takeover by something outside the core turns the viewer into an
observer with a notice. Each stream switch opens a fresh stream, which starts
with a full frame.

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
