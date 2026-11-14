# 22 · Terminal protocol for clients

## Context

The browser UI draws panes from the cell grid herdr renders for one
foreground client ([18](18-endpoint-surfaces.md)). A client that emulates
terminals itself (a native application drawing with the GPU, a browser
renderer with its own terminal state) needs the opposite: each terminal's
raw output, several viewers of one terminal, and input bytes it encodes
itself. herdr-core provides that per machine
([21](21-terminal-core.md)), but its API is only reachable through the
machine's agent, and it also runs commands and reads files.

## Goals / non-goals

Goals: one connection from a client to the core for the terminals of every
machine; herdr-core's records and events passed on unchanged, so clients
follow its API as it grows; backpressure from the drawing client to the
program's terminal; the core's guards and read-only mode.

Non-goals: emulating terminals in the core; a layout model in the core
(clients keep theirs in herdr-core's documents, `doc.get` and `doc.set`);
replacing `/ws`, which still carries machines, files and the browser UI's
panes.

## Design

**Endpoint** (`internal/server/term.go`). `GET /api/v1/term` is a
WebSocket behind the guards of every request. Text frames are JSON
messages, binary frames `[stream u32 LE][kind u8][payload]` with
herdr-core's kind numbers (0 data, 3 resize, 6 automatic input). The
message table is in
[architecture](../architecture.md#terminal-clients--core-protocol-apiv1term).

**Backends.** `sub {m}` subscribes the client to machine `m`. The first
subscriber starts the machine's backend:

1. The core asks the agent for the terminal core's status. When the
   machine's executable differs from the one this build carries
   (`embedded.HC`), the core uploads it; when no terminal core answers, the
   agent starts one; when one runs from another build, the agent restarts
   it and the successor adopts the programs. A read-only core does none of
   this and uses a terminal core that already runs.
2. The core dials the terminal core through the agent (`hc-api`),
   subscribes to all its events and keeps its terminal records by address,
   applying each event as herdr-core's API describes.
3. Subscribers get `backend {state: ready}` and a `snapshot`, then every
   `event`. A later subscriber gets the snapshot with the events so far
   applied; snapshot and events are sent under one lock, so none is lost
   or applied twice. Records and event data are passed on as herdr-core
   sent them, with fields the core does not know.

A backend that fails reports `backend {state: error, code}`
(`machine_offline`, `not_bundled`, `not_running`, `install_failed`,
`start_failed`, `connect_failed`, `disconnected`) and tries again after
1 s, doubling to 16 s, or at once when its machine connects. 10 s after its
last subscriber left it closes its connection; the terminal core and its
programs keep running.

**Calls.** `call` passes an allowlisted herdr-core method to the machine's
terminal core and answers with its result or its error kind. Reading
methods: `terminal.list`, `terminal.get`, `terminal.read`, `doc.get`,
`templates.list`. Writing methods: `terminal.run`, `terminal.kill`,
`terminal.rm`, `terminal.keep`, `terminal.label`, `terminal.interrupt`,
`doc.set`. A call with the parameter `on` is refused.

**Streams.** `attach` opens a herdr-core attach stream and answers
`attached` with a stream number of the client's connection; the reply is
queued before the stream's first frame. Output arrives as binary frames:
the first paint, then the program's bytes. The client sends `ack {s, n}`
for the bytes it has drawn, which the core returns to herdr-core as credit:
a terminal has at most 256 KiB on its way to a client, and a client that
falls 4 MiB behind gets a new paint from herdr-core instead of the
backlog. Input is a binary frame of kind 0, or kind 6 for the answers the
client's terminal produces by itself. `resize`, `focus` and `facts` go to
herdr-core as they are; the viewer that was active last sets the
terminal's size. An observing attach (asked for, or any attach of a
read-only core) gets the terminal's grid as kind 3 frames before the
output drawn for it, and sends nothing. `closed` ends a stream with
herdr-core's reason, or `disconnected` when the backend's connection went.

**Clients.** Two implementations follow the protocol and share the layout
document ([23](23-macos-application.md)): `macos/Sources/TermKit` (Swift),
used by the macOS application, and `web/src/term` (TypeScript):
`connection.ts` (the WebSocket, reconnecting and subscribing again, calls
as promises, streams with their handlers registered before their first
frame), `store.ts` (terminal records from snapshots and events) and
`layout.ts` (the tabs and splits of the layout document as immutable
values). The browser UI's panes do not use it; they come from herdr
([18](18-endpoint-surfaces.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| New message types on `/ws` | Its binary frames are pane surfaces without a stream number, its clients share one session owner, and WebSocket compression there would spend CPU on terminal bytes that are already paced by credit. |
| Passing herdr-core's framed protocol through to clients | Clients could call `machine.exec`, `file.*` and `server.stop`, and would need one connection per machine. |
| Acknowledging herdr-core as soon as the core has read a frame | A slow client's backlog would queue in the core; with the client's own acknowledgements a full send queue means a client that stopped reading. |
| A snapshot fetched with `terminal.list` for each new subscriber | Without a sequence number in it, events between the list and the subscription would be lost or applied twice. |
| One backend connection per client | herdr-core would count each as a viewer and subscriber; one connection per machine keeps event order identical for every client. |
| Starting terminal cores when machines connect | A machine nobody uses terminals on would get a process that outlives the core. |

## Failure modes

- **Machine offline or agent session lost** → the backend reports
  `machine_offline` or `disconnected`, open streams close with
  `disconnected`, and the backend returns when the machine does.
- **Build without herdr-core** (a plain `go build`) on a machine without a
  terminal core → `not_bundled`.
- **Client stops reading** → its send queue (8192 messages) fills and the
  core closes the connection; its streams detach.
- **Client disconnects** → its streams detach and its subscriptions end;
  programs keep running.
- **Call to a machine the client did not subscribe to, or whose backend is
  not ready** → `unavailable`.
- **Unknown or refused method** → `refused`, audited as `denied.term`.

## Security

See the row for terminal clients in [SECURITY.md](../../SECURITY.md).

## Testing

`internal/server/term_test.go`, with a scripted terminal core on the
machine's socket behind a real agent: backend states and the snapshot with
unknown fields kept, events forwarded and applied for a later subscriber,
allowed and refused calls with their audit entries, a stream's reply before
its first frame, input, automatic input, credit, size, focus and display
facts reaching the terminal core, detaching, a program's end, the terminal
core going away and coming back, read-only (writing calls refused, attaches
observe, input dropped, nothing installed), and a machine without a
terminal core. `web/src/__tests__/term.test.ts` covers the TypeScript client against a
scripted socket (frames, names, the store's events, layouts and the
document the macOS application writes, subscribing, calls, a stream's
reply before its frames, input, credit, reconnecting), and
`macos/Tests/TermKitTests` the Swift one. `TestIntegrationTerm` (`make it`, `HC_TEST_BIN`) runs the
whole path against a real herdr-core: install and start through the agent,
a shell started, typed into and read by one client, found and watched by a
second, and killed.
