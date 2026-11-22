# 22 · Terminal protocol for clients

## Context

A client that emulates terminals itself (the browser UI, which keeps each
terminal's state in its own emulator and draws it with the GPU) needs each
terminal's raw output, several viewers of one terminal, and input bytes it
encodes itself, rather than a cell grid rendered for it. herdr-core provides that per machine
([21](21-terminal-core.md)), but its API is only reachable through the
machine's agent, and it also runs commands and reads files.

## Goals / non-goals

Goals: one connection from a client to the core for the terminals of every
machine; herdr-core's records and events passed on unchanged, so clients
follow its API as it grows; backpressure from the drawing client to the
program's terminal; the core's guards and read-only mode.

Non-goals: emulating terminals in the core; a layout model in the core
(clients share theirs as a document of herdr-core, see Layout document);
replacing `/ws`, which carries machines, files, program windows, agent
states and settings.

## Design

**Endpoint** (`internal/server/term_client.go`). `GET /api/v1/term` is a
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
   `idle`, `done`, `unknown`), and, while the agents plugin is on, the
   session the agent runs as `agent_session` (a lower-case UUID) with
   `agent_session_source` (how the machine found it: `argv`, `pid`, `fd`,
   `start`, `hook`, `guess`; [35](35-agent-native-view.md)), absent from
   the record while none is known. Subscribers get
   `event {type: "agent", terminal, data: {agent, agent_status, agent_session, agent_session_source}}`
   at every change and again after an event that replaced the record; a
   change of the session alone is such an event too. Every member is
   there: `agent` and `agent_status` are null when the agent left, the
   session's two null when it is not known, so a client that merges the
   event into its record loses a session that ended (another agent in the
   terminal, the agent gone, the agents plugin switched off). A `focus {s, focused: true}` on a
   stream of a terminal whose turn ended (`done`) marks it seen: `idle`.

A backend that fails reports `backend {state: error, code}`
(`machine_offline`, `not_bundled`, `not_running`, `install_failed`,
`start_failed`, `connect_failed`, `disconnected`, `stopped`) and tries
again after 1 s, doubling to 16 s, or at once when its machine connects. 10 s after its
last subscriber left it closes its connection (`termIdle`), and with it
the streams it kept for terminals' sizes (below); the terminal core and its
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
them. On an ssh machine it also gets `SSH_CONNECTION` and `SSH_CLIENT`
([21](21-terminal-core.md)) where the client gave none. Reading
methods: `terminal.list`, `terminal.get`, `terminal.read`, `doc.get`,
`templates.list`. Writing methods: `terminal.run`, `terminal.kill`,
`terminal.rm`, `terminal.keep`, `terminal.label`, `terminal.interrupt`,
`doc.set`. A call with the parameter `on` is refused. Refused calls are
audited as `denied.term` (method, machine; `param: on` for a call refused
for `on`); `terminal.run` (with its `argv`, `cwd` and the names, not the
values, of the variables the client gave in `env` as `client_env`, and of
those the core added as `env`), `terminal.kill`, `terminal.rm`,
`terminal.interrupt` and `terminal.keep` are audited with their terminal.
An `env` that is not an object of strings is refused (`usage`). A
read-only client's `terminal.read` reaches herdr-core without its `lines`
(the member removed in any letter case and of any type,
`readScreenOnly`), so it reads the screen only: to put history lines above
the screen of a program on the alternate screen, herdr-core scrolls the
program with mouse-wheel input, which every viewer sees.

**Streams.** `attach` opens a herdr-core attach stream and answers
`attached` with a stream number of the client's connection; the reply is
queued before the stream's first frame. Output arrives as binary frames:
the first paint, then the program's bytes. The client sends `ack {s, n}`
for the bytes it has drawn, which the core returns to herdr-core as credit:
a terminal has at most 256 KiB on its way to a client, and a client that
falls 4 MiB behind gets a new paint from herdr-core instead of the
backlog. The core returns at most the output it sent on that stream and
has not had credit for yet, so an `ack` beyond it is cut to it.
Input is a binary frame of kind 0, or kind 6 for the answers the
client's terminal produces by itself. `resize`, `focus` and `facts` go to
herdr-core as they are; the viewer that was active last, among those not
observing, sets the terminal's size and its display, and a terminal
without such a viewer gets herdr-core's headless size (200x120 unless the
user's herdr-core configuration says otherwise,
[21](21-terminal-core.md)). herdr-core answers programs' color
queries (OSC 10/11, `CSI ? 996 n`), device attributes and size reports
itself and keeps those queries from the viewers, from the display facts
of the viewer active last (colors and cell size), else from its defaults
(a dark background). So the page sends its theme's colors and its cell
size as `display` with every attach that is not observing, a `facts`
message when they change (a theme or font change, which also tells
programs that asked for mode 2031), and the colors as `display` with
`terminal.run`, for the queries a program makes before a pane attaches. An observing attach (asked for, or any attach of a
read-only core) gets the terminal's grid as kind 3 frames before the
output drawn for it, and sends nothing: no display facts with the attach
or later, no input, size or focus; its focus does not mark a finished
turn seen either. A connection reads messages of at most 16 MiB.
`closed` ends a stream with
herdr-core's reason, or `disconnected` when the backend's connection went.

**The last viewer's stream** (`termBackend.joined`, `left` and `unpark` in
`internal/server/term_backend.go`, `termClient.release` in
`term_client.go`). herdr-core's API sets a terminal's size nowhere but in
a stream, so a terminal whose last viewer detached got the headless size
at once and its pane's size again at the next attach: with a pane of
127x38 attached the terminal's record said 127x38, and 200x120 as soon as
the pane detached. A full-screen program (Claude Code, which draws on the
alternate screen and scrolls its transcript itself; Codex) was thus laid
out twice around every detach and attach. It lost its own scroll position
(Claude Code went to the end when the 120-row layout reached it), and the
first paint after the attach showed the 200x120 layout until the program
drew again. The core therefore keeps a terminal's last viewer attached:

- A backend counts, per terminal, its clients' streams that set the size
  (the ones not observing; `typing`), for the connection it has now.
- When a client lets go of such a stream, by `detach` or by leaving, and
  it is the terminal's last one on that connection and the terminal is
  live in the backend's records, the core does not close it. It tells
  herdr-core that the viewer's focus is gone when the client had reported
  it focused, so that the program is told, which herdr-core does not do
  by itself for a viewer that stays; it stops forwarding the stream's
  output; and it keeps the stream attached and unread (`parked`), a
  viewer of the size the terminal has.
- herdr-core sends an unread stream at most what is left of its 256 KiB
  of credit, which waits in the core's memory, queues up to 4 MiB behind
  that and then drops the backlog for a repaint, as for any viewer that
  falls behind.
- The kept stream is closed once the terminal's next viewer that sets the
  size has attached (after herdr-core answered the attach, so the
  terminal is not without a viewer in between), when the terminal is
  removed or finishes (`term_events.go`), and with the backend's
  connection. It belongs to no client: no input, size, focus, display
  fact or credit of a client reaches it.
- A stream that ends by itself (its program's end, the backend's
  connection), an observer's stream and every stream of a terminal but
  the last are closed as before.

An attach of the size the terminal has resizes nothing, and its first
paint is exact; a viewer of another size resizes the terminal once. The
streams are kept by the backend's connection, which closes 10 s after its
last subscriber: with no client subscribed to the machine at all, its
terminals still get the headless size. Why the size is not kept another
way is in [26](26-web-terminals.md#alternatives-considered).

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
            "children": [{ "terminal": "t1" }, { "code": { "id": "q2m8x0vb", "folder": "/srv/api" } }]
          },
          "focused": "t1"
        }
      ],
      "selected": 0
    }
  ],
  "selected": 0
}
```

- A workspace has an `id` (eight random lowercase letters and digits from
  the client that created it, unique in the document), a `name` (the
  user's; empty for none), the `cwd` new terminals start in (empty for
  none), its `tabs` and its `selected` tab. A workspace without a name is
  shown with the last component of its `cwd`: `~` for the home directory or
  none, `/` for the root (`workspaceTitle`); `Workspace` and `工作区`, the
  names earlier clients gave the workspaces they made, count as none. The top-level `selected` is the selected workspace.
- A tab has a `root` node and the `focused` pane, and a `name` only
  when the user named it.
- A node is a leaf or a split
  `{"split": "horizontal" | "vertical", "ratio", "children": [first, second]}`;
  `horizontal` places the children side by side, and `ratio`, the first
  child's share, is clamped to 0.1–0.9. A leaf is a pane, of one of these
  kinds, named by its key in `focused` and the operations:
  - a terminal `{"terminal": address}`, named by its address. Its leaf
    may also hold what brings a coding agent back after the terminal core
    started again ([33](33-workspace-restore.md)): `agent` (the id of an
    agent running in it that can continue a conversation, `claude` or
    `codex`) with `pid` (the pid of the terminal's program then), or
    `resume` (the id of the agent the terminal lost with its program,
    until a client typed that agent's resume command into it). The ids
    select a kind of the agent kind registry (`internal/agentkinds`,
    [35](35-agent-native-view.md)), whose commands the client types; a
    client that does not restore keeps the fields as it keeps unknown
    ones. Three more fields have values the web UI checks
    (`terminalFields`, `setTerminalFields` in `web/src/term/layout.ts`):
    `render` (`"native"`: the pane shows the agent's conversation instead
    of the terminal, [35](35-agent-native-view.md)), `session` (the
    agent's session, a lower-case UUID) and `before` (the address of the
    terminal this one took the place of: 1–64 letters, digits, `_` and
    `-`, starting with a letter or digit). Read from a document, a value of
    another type or shape is left out of the leaf and its other fields
    are kept; a change sets only these three of every leaf of the address
    (a malformed document may have two), removes one whose value is null
    or not one it may hold, and never writes through a prototype;
  - VS Code `{"code": {"id", "folder"}}` for a folder of the machine
    (`""`: the one code-server opens), named `code:<id>`
    ([05](05-vscode-panes.md));
  - a preview `{"preview": {"id", "path"}}` of a file or directory of the
    machine, named `preview:<id>` ([06](06-quick-look-and-files.md)).

  A view's `id` is eight random lowercase letters and digits from the
  client that opened it; the same view keeps it wherever it moves, so every
  client finds it again (VS Code's window, the preview's file). A `code`
  without an `id` and a `preview` without an `id` or a `path` are nodes of
  an unknown kind.
- A document with `tabs` instead of `workspaces` (version 1) reads as one
  workspace with the id `default`, an empty name and directory, and those
  tabs. Workspaces without an id or with a repeated one and tabs without a
  root are left out, fields of the wrong type read as empty (a view's
  missing `folder` too), a focus outside its tab moves to the tab's first
  pane, and selections are clamped.
- Fields a client does not know, at every level (inside `code` and
  `preview` too), and nodes of a kind it does not know are kept and written
  back: a newer client's additions survive an older client's change. Such
  a node holds no panes and stays where it is; a client that knows
  terminals only keeps VS Code views and previews this way, so its tab of
  them alone stays as well. Clients write version 2.
- Operations, with the same results in every client: workspaces are
  created (at the end, selected), renamed, closed (the selection moves to
  the next one, else the one before; closing the last one leaves a
  document with no workspace, which is valid), moved and selected; a pane opens in
  a new tab of a workspace, or is focused where it already is; tabs are
  named (an empty name removes the name), closed, moved and selected; a
  pane is split, the new pane after it (or before) and focused, its tab
  selected; a closed pane's sibling takes its parent's place and, if it
  had it, the focus, a tab left without panes goes and its workspace stays;
  pruning closes the terminals that no longer live and keeps the other
  panes; a ratio is set by the path to its split; two panes swap, also
  across tabs and workspaces; a pane moves beside another one, before or
  after it, or into a new tab of a workspace; a preview shows another
  path. Closing a workspace or tab ends no program; the client ends them.
- `design/testdata/layout/*.json` holds the contract as vectors: an input
  document, operations, whether they change the layout, and the expected
  document, with the workspaces' names as shown for a home directory
  (`titles`) where they matter. The web UI's tests run every vector.

**Client.** `web/src/term` (TypeScript) follows the protocol and the
layout document for the browser UI and the desktop app
([26](26-web-terminals.md)):
`protocol.ts` (the messages, frames and records),
`connection.ts` (the WebSocket, reconnecting and subscribing again, calls
as promises, streams with their handlers registered before their first
frame), `store.ts` (terminal records from snapshots and events) and
`layout.ts` (the layout document's workspaces, tabs and splits as immutable
values and the operations on them); `web/src/state/terms.ts` follows the
machines the user turned to, reads their layout documents before editing
them and writes one change at a time with the version last read. It gives
a machine whose document was never written (`doc.get` answers no value) a
first workspace without a name; a document without workspaces stays so
until a pane is opened, which makes one
([04](04-layout-and-keyboard.md)). It starts terminals with
`terminal.run`'s `keep: true`, so that herdr-core gives them a new shell
when it starts again without their programs, and replaces those that
ended with the core in the layout (`web/src/restore.ts`,
[33](33-workspace-restore.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| New message types on `/ws` | Its JSON messages share one send queue and WebSocket compression: terminal output would be compressed although credit already paces it, would need stream numbers there too, and a busy terminal would delay the machine, settings and agent messages every client (the desktop shell included) follows. |
| Passing herdr-core's framed protocol through to clients | Clients could call `machine.exec`, `file.*` and `server.stop`, and would need one connection per machine. |
| Acknowledging herdr-core as soon as the core has read a frame | A slow client's backlog would queue in the core; with the client's own acknowledgements a full send queue means a client that stopped reading. |
| A snapshot fetched with `terminal.list` for each new subscriber | Without a sequence number in it, events between the list and the subscription would be lost or applied twice. |
| One backend connection per client | herdr-core would count each as a viewer and subscriber; one connection per machine keeps event order identical for every client. |
| Starting terminal cores when machines connect | A machine nobody uses terminals on would get a process that outlives the core. |

## Failure modes

- **Machine offline or agent session lost** → the backend reports
  `machine_offline` or `disconnected`, open streams close with
  `disconnected`, the kept ones go with the connection (the terminals
  have the headless size meanwhile), and the backend returns when the
  machine does, with a new snapshot, at which the web UI attaches its
  panes again ([26](26-web-terminals.md)).
- **Build without herdr-core** (a plain `go build`) on a machine without a
  terminal core → `not_bundled`.
- **Client stops reading** → its send queue (8192 messages) fills and the
  core closes the connection; its streams are let go as for a client that
  disconnects.
- **Client disconnects** → the core lets go of its streams and its
  subscriptions end; programs keep running. The last stream that set a
  live terminal's size stays attached at the terminal core, the others
  are closed.
- **No client is subscribed to a machine for 10 s** (every page closed,
  the core stopped or started again) → the backend's connection closes
  with the streams it kept, and the machine's terminals get herdr-core's
  headless size; the next pane that attaches resizes its terminal once,
  and a full-screen program lays itself out again.
- **A client attaches with another size than the kept stream's** (another
  window size, another font) → the terminal is resized once, as between
  two viewers.
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
allowed and refused calls with their audit entries (a call with `on`,
`terminal.interrupt`, `terminal.keep`, `terminal.run`'s `cwd` and the
names of its variables), the display's
variables in `terminal.run`, detected agents in records and events and
seen by focus, typing into a terminal's shell, a stream's reply before
its first frame, input, automatic input, credit, size, focus and display
facts reaching the terminal core, credit cut to the output sent,
detaching (the last viewer's focus told gone and its stream kept at the
terminal core until the terminal's next viewer attached), a program's end,
the terminal core going away and coming back, read-only (writing calls refused, attaches
observe without display facts, input, size, focus and facts dropped, a
finished turn not seen, nothing installed), a machine without a
terminal core, and `TestTermKeepsTheLastViewer` (of two viewers and an
observer the ones that leave first closed, the last viewer's stream kept,
an observer not taking its place, the next viewer ending it).
`term_readlines_test.go`: a read-only client's `terminal.read` reaching
the terminal core without `lines` in any spelling or type
(`TestTermReadOnlyReadsTheScreenOnly`), a writing client's with them;
`term_session_test.go`: the session in records and agent events, present
in a record only while known and null in an event when not
(`TestTermAgentSessionEnds`; [35](35-agent-native-view.md)). `web/src/__tests__/term.test.ts` covers the TypeScript client against a
scripted socket (frames, names, the store's events, every layout vector,
subscribing, calls, a stream's reply before its frames, input, credit,
reconnecting), `terms.test.ts` the browser UI's model (the layout read
after the terminals, one write at a time with another client's newer
version taken, ended programs' panes closed, terminals asked for before
the machine was ready, `keep: true` in `terminal.run`), `restore.test.ts`
terminals that ended with the core replaced in the layout and the leaf's
`agent`, `pid` and `resume` ([33](33-workspace-restore.md)),
`agentLeaves.test.ts` and `design/testdata/layout/agent-leaves.json` the
leaf's `render`, `session` and `before`. `TestIntegrationTerm` (`make it`, `HC_TEST_BIN`) runs the
whole path against a real herdr-core: install and start through the agent,
a shell started, typed into and read by one client, found and watched by a
second, and killed; `TestIntegrationDetect` an agent's states
([25](25-agent-detection.md)); `TestIntegrationTermShells` typing into a
shell as enabling program windows does, without changing its size. The
three passed against the pinned herdr-core 0.1.21 for linux/arm64 in an
isolated Linux container (Debian, an unprivileged user, no network).
