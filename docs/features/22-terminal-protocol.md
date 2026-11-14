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
(clients share theirs as a document of herdr-core, see Layout document);
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
4. The core asks the agent which coding agents run in the terminals
   ([25](25-agent-detection.md)) and adds them to the records as `agent`
   (`claude`, `codex`, …) and `agent_status` (`working`, `blocked`,
   `idle`, `done`, `unknown`), sending subscribers
   `event {type: "agent", terminal, data: {agent, agent_status}}` (both
   null when the agent left) at every change and again after an event
   that replaced the record. A `focus {s, focused: true}` on a stream of a
   terminal whose turn ended (`done`) marks it seen: `idle`.

A backend that fails reports `backend {state: error, code}`
(`machine_offline`, `not_bundled`, `not_running`, `install_failed`,
`start_failed`, `connect_failed`, `disconnected`, `stopped`) and tries
again after 1 s, doubling to 16 s, or at once when its machine connects. 10 s after its
last subscriber left it closes its connection; the terminal core and its
programs keep running. The backend's state is also part of its machine's
state on `/ws` (`hc {state, code, version}`), for clients that are not
subscribed, while the backend runs.

**Lifecycle from the UI.** `POST /api/m/{id}/hc/{start|stop|restart}`
([02](02-multi-machine-transport.md)) starts the terminal core as a first
subscription does (installing this build's executable when needed),
restarts it (with `restart`, also when it runs this build: the successor
adopts the programs), or stops it. After a stop the backend reports
`stopped` instead of starting another core, while clients stay
subscribed, until the core is started from the UI or a backend starts anew
(the first subscriber after the last one left).

**Calls.** `call` passes an allowlisted herdr-core method to the machine's
terminal core and answers with its result or its error kind. A
`terminal.run` on a remote machine whose virtual display is ready gets the
display's variables in its `env` ([14](14-gui-windows.md)); they replace
those of the client, whose other variables stay, and the audit entry names
them. Reading
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

**Layout document.** Clients arrange a machine's terminals in herdr-core's
document `layout` on that machine, read with `doc.get`, written with
`doc.set` and the version last read (a `doc` event announces a newer one),
so every client of the machine shows the same arrangement. Version 2:

```json
{
  "version": 2,
  "workspaces": [
    {
      "id": "k3v9x0qa",
      "name": "api",
      "cwd": "/srv/api",
      "tabs": [
        {
          "name": "build",
          "root": {
            "split": "horizontal",
            "ratio": 0.5,
            "children": [{ "terminal": "t1" }, { "terminal": "t2" }]
          },
          "focused": "t2"
        }
      ],
      "selected": 0
    }
  ],
  "selected": 0
}
```

- A workspace has an `id` (eight random lowercase letters and digits from
  the client that created it, unique in the document), a `name`, the `cwd`
  new terminals start in (empty for none), its `tabs` and its `selected`
  tab. The top-level `selected` is the selected workspace.
- A tab has a `root` node and the `focused` terminal, and a `name` only
  when the user named it.
- A node is a leaf `{"terminal": address}` or a split
  `{"split": "horizontal" | "vertical", "ratio", "children": [first, second]}`;
  `horizontal` places the children side by side, and `ratio`, the first
  child's share, is clamped to 0.1–0.9.
- A document with `tabs` instead of `workspaces` (version 1) reads as one
  workspace with the id `default`, an empty name and directory, and those
  tabs. Workspaces without an id or with a repeated one and tabs without a
  root are left out, fields of the wrong type read as empty, a focus outside
  its tab moves to the tab's first terminal, and selections are clamped.
- Fields a client does not know, at every level, and nodes of a kind it
  does not know are kept and written back: a newer client's additions
  survive an older client's change. Such a node holds no terminals and
  stays where it is. Clients write version 2.
- Operations, with the same results in every client: workspaces are
  created (at the end, selected), renamed, closed (the selection moves to
  the next one, else the one before), moved and selected; a terminal opens
  in a new tab of a workspace, or is focused where it already is; tabs are
  named (an empty name removes the name), closed, moved and selected; the
  focused terminal is split, the new terminal second and focused; a closed
  terminal's sibling takes its parent's place and, if it had it, the focus,
  a tab left without terminals goes and its workspace stays; pruning closes
  the terminals that no longer live; a ratio is set by the path to its
  split; two terminals' panes swap, also across tabs and workspaces; a pane
  moves beside another one, before or after it, or into a new tab of a
  workspace. Closing a workspace or tab ends no program; the client ends
  them.
- `design/testdata/layout/*.json` holds the contract as vectors: an input
  document, operations, whether they change the layout, and the expected
  document. Both clients run every vector.

**Clients.** Two implementations follow the protocol and the layout
document: `macos/Sources/TermKit` (Swift), used by the macOS application
([23](23-macos-application.md)), and `web/src/term` (TypeScript):
`connection.ts` (the WebSocket, reconnecting and subscribing again, calls
as promises, streams with their handlers registered before their first
frame), `store.ts` (terminal records from snapshots and events) and
`layout.ts` (the layout document's workspaces, tabs and splits as immutable
values and the operations on them). The browser UI's panes do not use it;
they come from herdr ([18](18-endpoint-surfaces.md)).

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
machine's socket behind a real agent: the lifecycle from the UI (a stopped
core kept stopped while subscribed, started and restarted, the machine's
`hc` state), backend states and the snapshot with
unknown fields kept, events forwarded and applied for a later subscriber,
allowed and refused calls with their audit entries, the display's
variables in `terminal.run`, detected agents in records and events and
seen by focus, typing into a terminal's shell, a stream's reply before
its first frame, input, automatic input, credit, size, focus and display
facts reaching the terminal core, detaching, a program's end, the terminal
core going away and coming back, read-only (writing calls refused, attaches
observe, input dropped, nothing installed), and a machine without a
terminal core. `web/src/__tests__/term.test.ts` covers the TypeScript client against a
scripted socket (frames, names, the store's events, every layout vector,
subscribing, calls, a stream's reply before its frames, input, credit,
reconnecting), and `macos/Tests/TermKitTests` the Swift one, with the same
layout vectors. `TestIntegrationTerm` (`make it`, `HC_TEST_BIN`) runs the
whole path against a real herdr-core: install and start through the agent,
a shell started, typed into and read by one client, found and watched by a
second, and killed; `TestIntegrationDetect` an agent's states
([25](25-agent-detection.md)); `TestIntegrationTermShells` typing into a
shell as enabling program windows does, without changing its size.
