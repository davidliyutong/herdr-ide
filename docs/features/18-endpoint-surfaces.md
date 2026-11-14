# 18 · Pane surfaces through herdr's endpoint

## Context

herdr's own client-rendered shell talks to the herdr server through the
client "endpoint" protocol on `herdr-client.sock`. herdr keeps generation 1
of that protocol available for clients of any build ("must remain available
indefinitely unless retired for a security reason"; variant order and the
core codecs are frozen, extensions arrive as optional named controls). Over
it herdr renders the selected tab into one cell grid at the client's size,
reports per-pane geometry and modes, accepts semantic input that it encodes
for each pane, and answers programs' color queries with the colors the
client reports.

Facts the design relies on (herdr 0.9.5, `src/protocol/wire.rs`,
`endpoint.rs`, `surface_delta.rs`, `surface_scroll.rs`,
`src/server/headless.rs`, `client_views.rs`):

- Messages are bincode 2 values (standard configuration: little endian,
  variable-length integers; enums as a variant index then their fields) after
  a u32 little-endian length; 2 MiB for the handshake, 32 MiB later.
- The client sends `EndpointControl{endpoint.hello.v1}` with JSON: generation
  1, the four core codecs, the surface size in cells and the cell size in
  pixels, and optional encodings. herdr answers `endpoint.welcome.v1` (or an
  error code), then `shell.snapshot.v1` (JSON with `boot_id` and the focused
  workspace, tab and pane), then complete surfaces (`PaneSurface`) and
  patches (`PaneSurfacePatch`, applied only to the revision before).
- One connection shows one tab: the connection's focused tab, chosen with
  endpoint requests (`tab.focus`, `pane.focus`; one in flight at a time). A
  focus change through the public API moves every client.
- herdr draws borders, gaps, split lines and scrollbars into the grid. Each
  pane has an outer `rect`, an `inner_rect` for its terminal, scroll
  metrics, and whether its program reports the mouse or shows the alternate
  screen; mouse cells are relative to `inner_rect`.
- The client that interacted last is the foreground client. Only it
  receives OSC 52 clipboard writes, bells and window titles, and its colors
  answer OSC 10/11/4 and `CSI ?996n`.
- When a client connects to a session without a workspace herdr creates
  one. With a single client its size resizes every tab of the session.

## Goals / non-goals

Goals: one connection per shown machine instead of one process per pane;
herdr's own key, mouse, focus, clipboard and color behavior; one browser
using the session at a time, with an explicit takeover.

Non-goals: several people sharing one core (herdr's rule applies: the last
interaction wins); using herdr's TUI next to the browser (herdr-ide becomes
the foreground client); kitty graphics and popups.

## Design

**Agent** (`internal/agent/agent.go`, `herdr.go`). Op `herdr-client` dials
the session's client socket and pipes bytes, like `herdr-api`. The path
follows herdr's `client_socket_path`: `sessions/<name>/herdr-client.sock`
for a named session; otherwise `HERDR_SOCKET_PATH`'s stem plus
`-client.sock`, then `HERDR_CLIENT_SOCKET_PATH`, then `herdr-client.sock` in
herdr's config directory. The agent starts nothing; the connection ends with
the stream.

**Endpoint client** (`internal/herdr/endpoint`). A hand-written bincode
reader and writer for the generation 1 messages herdr-ide uses; every server
message is decoded completely (unused ones are dropped) so the stream stays
aligned, and trailing bytes are an error. Sequence lengths are checked
against the bytes left before allocating, grids against herdr's limits
(4096 per side, one million cells). `Grid` keeps the connection's surface:
complete surfaces replace it; patches, `endpoint.surface-delta.v1` (a
complete surface sent as changed cells) and `endpoint.surface-scroll.v1`
(row moves inside panes plus a patch) update it, each only from the
revision before; a mismatch ends the connection. `Conn` sends a health ping
after 5 s of silence and closes the connection after 15 s without anything
from herdr.

**Sessions and ownership** (`internal/server/surface.go`)

- One browser connection owns the core's session, like a KVM console. The
  first browser becomes owner; a later one is told `busy` and may take
  over, after which the previous owner is told `taken_over` and may take it
  back. A read-only browser cannot take over a writable one and becomes
  owner only while no writable browser is connected. When the owner leaves,
  another writable browser, else a read-only one, becomes owner.
- The owner sends `view {m, tab, pane, cols, rows, cw, ch}`. The core keeps
  one endpoint connection to machine `m` at that size (it sends
  `ClientShellResize` when the size changes) and closes the others. herdr
  answers each new grid size with a complete surface (about 90 KB at
  200×60), so one such resize is in flight at a time (`Conn.Resize`): the
  hello's size counts as one, the next is sent when herdr's complete
  surface of the asked size arrives, or after 2 s in case herdr answers
  with another size, and the sizes the owner wanted meanwhile collapse into
  the latest. A new cell size on the same grid is sent at once. When
  herdr's focused tab or pane differs from the view's, the core sends
  `pane.focus` (or `tab.focus`) as an endpoint request; it repeats this after
  every snapshot, so herdr follows the UI. For a read-only browser only the
  tab is followed: herdr's focused pane is where the session's input goes.
  The browser never sends endpoint requests itself.
- Without an owner the connections stay open for 10 s (a page reload), then
  close.
- herdr's output reaches the owner only: `surf` (`open`, `error` with a
  code, `notice`), `surf.tab` (the tab herdr shows), `surf.meta` (pane
  geometry and modes, splits, OSC 8 link targets; sent when they change),
  binary surface messages, `clip` (OSC 52) and `bell`. A new owner receives
  the current surface at once.
- Input from the owner: `in {m, pane, ev}` (key, text, paste and mouse
  events, at most 256 per message), `focus`, and `host` (foreground,
  background, 16 palette colors and dark or light), which the core sends to
  herdr now and on every new connection.

**Binary surface messages** to the browser (little endian): kind (complete
or patch), generation, size, cursor, row moves, then spans of cells (symbol,
colors, modifiers, skip and link index). The core forwards herdr's own
changed spans; a complete surface is one span per row. WebSocket compression
shrinks the repeated cell fields.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `herdr terminal session` per pane (the previous design) | Drops keyboard and mouse modes, OSC 52, bell and graphics, cannot report colors, and needs one process per pane. |
| herdr's numbered private protocol | Tied to herdr's exact build (`PROTOCOL_VERSION`); generation 1 of the endpoint protocol is the interface herdr keeps stable for other builds. |
| One endpoint connection per pane | A connection shows a whole tab; several connections would each be a client resizing tabs and competing for the foreground. |
| Decoding bincode in the browser | The core already sits between agent and browser; decoding there keeps the browser protocol small, lets a new owner start from the core's grid, and keeps herdr's wire format out of the browser. |
| Several browsers sharing control (the previous arbiter) | herdr has one foreground client per server and sizes tabs to one client; several browsers of one user would resize panes back and forth. |

## Failure modes

- **herdr without endpoint generation 1** (older than 0.9.5) → the welcome
  is missing or refused; the UI shows `herdr_too_old` and the core retries
  every 15 s (after updating herdr, the next try connects).
- **Connection lost** (agent or herdr restart) → `surf error disconnected`,
  reconnect with backoff (1 s doubling to 16 s); when the machine's agent
  session comes (back), ready or degraded, a waiting connection tries again
  at once with the backoff reset (`wakeSurface`), so a machine back from a
  network loss or re-enabled shows its panes within seconds. The first
  surface is complete.
- **Revision mismatch or malformed message** → the connection is closed and
  reopened.
- **Endpoint request refused** (`tab.focus` of a closed tab) → a `notice`;
  the browser's next view retries.
- **Browser send queue overflow** → the core drops that WebSocket; the
  browser reconnects and the core resends a complete surface.
- **Window resized over a slow link** (a window drag, the layout settling
  while a machine connects) → the browser sends a view for every size it
  measures. Sent on to herdr one by one, each new size cost a complete
  surface, and they queued up on the link: at 150 KB/s with 100 ms latency
  a one-second drag from 200×60 left the grid at intermediate sizes for ten
  seconds after the window stopped, drawn at their own size (cut off or
  with an empty margin). With one resize in flight the grid reaches the
  final size about one surface after the drag ends.

## Security

The client socket is reachable only through the agent, as the API socket.
The browser cannot address herdr's endpoint directly: the core composes the
only endpoint requests (`tab.focus`, `pane.focus`) and encodes input events
from a closed set. A read-only browser sends no input, focus or colors,
never moves herdr's focused pane, and gets no clipboard writes; it still
selects the tab it shows and sets the tab size, as any herdr client does.
Pastes are filtered in the core as well as the browser, OSC 52 writes reach
the clipboard only after a click or, with the browser's automatic setting,
right after the user's input to a pane ([03](03-pane-rendering-and-input.md)),
and decoding is bounded per item type. See [SECURITY.md](../../SECURITY.md).

## Testing

`internal/herdr/endpoint` (bincode vectors from herdr's tests, herdr's
frozen `endpoint-*-v1.json` fixtures, a session recorded from herdr 0.9.5
whose patches and scroll controls must reproduce herdr's next complete
surface, delta and patch validation, bounds on hostile lengths, handshake
errors, chunked request replies, one resize in flight: sizes wanted
meanwhile collapse into the latest, an older surface does not end the wait,
a cell size alone is sent at once, the wait ends after its timeout);
`internal/server/surface_test.go`
(ownership: busy, takeover, read-only rules, handover; the binary encoding
shared with the web tests; a waiting connection is woken when its machine
connects); `TestIntegrationEndpoint`, `TestIntegrationKeyParity` and
`TestIntegrationResizeOverSlowLink` (a window drag over a delayed,
150 KB/s link reaches the final size after at most five grid sizes; every
size was sent before, 23 of them, and the final one came ten seconds after
the drag) (`make it`) against a real herdr through the agent.
