# 22 · Terminal protocol for clients

## Context

A client that emulates terminals itself (the browser UI) needs each
terminal's raw output, several viewers per terminal, and input it encodes
itself. herdr-core provides that per machine ([21](21-terminal-core.md)),
but its API is reachable only through the machine's agent, and it can also
run commands and read files, which clients must not get.

## Goals / non-goals

Goals: one connection from a client to the core for every machine's
terminals; herdr-core's records and events passed on unchanged, so clients
follow its API as it grows; backpressure from the drawing client to the
program; the core's guards and read-only mode.

Non-goals: emulating terminals in the core; a layout model in the core
(clients share theirs as a herdr-core document, below); replacing `/ws`.

## Design

**Endpoint** (`backend/features/terminals/client.ts`, `messages.ts`).
`GET /api/v1/term` is a WebSocket behind the usual request guards. Text
frames are JSON; binary frames are `[stream u32 LE][kind u8][payload]`
with herdr-core's kinds (0 data, 3 resize, 6 automatic input). The
message table is in
[architecture](../architecture.md#terminal-clients--core-protocol-apiv1term).

**Backends** (`backend.ts`). `sub {m}` subscribes to machine `m`; the
first subscriber starts the machine's backend:

1. Ask the agent for the terminal core's status. Upload this build's
   executable if it differs, start the core if none answers, restart it
   (programs adopted) if it runs another build. A read-only core does none
   of this.
2. Dial the core through the agent (`hc-api`), subscribe to all events and
   keep the terminal records.
3. Send subscribers `backend {state: ready}`, a `snapshot`, then every
   `event`. Snapshot and events go under one lock, so a later subscriber
   loses or duplicates nothing. Records pass through with fields the core
   does not know.
4. Add detected coding agents to the records as `agent` and
   `agent_status` ([25](25-agent-detection.md)) and, while the agents
   plugin is on, the session the agent runs as `agent_session` with
   `agent_session_source` (how the machine found it;
   [35](35-agent-native-view.md)), with an `agent` event at each change.
   The event carries all four members, null when unknown, so a client
   merging it drops a session that ended. A `focus` on a terminal whose
   turn is `done` marks it seen (`idle`).

A failing backend reports `backend {state: error, code}` and retries with
backoff from 1 s to 16 s, or at once when its machine connects. 10 s after
its last subscriber leaves (`termIdle`) it closes its connection; the core
and programs keep running. The state is also on `/ws` as the machine's
`hc {state, code, version}`.

**Lifecycle from the UI.** `POST /api/m/{id}/hc/{start|stop|restart}`
([02](02-multi-machine-transport.md)). After a stop the backend reports
`stopped` instead of starting another core until the user starts it or a
backend starts anew.

**Calls.** `call` passes an allowlisted method to the machine's core:

- reading: `terminal.list`, `terminal.get`, `terminal.read`, `doc.get`,
  `templates.list`;
- writing (refused in read-only mode): `terminal.run`, `terminal.kill`,
  `terminal.rm`, `terminal.keep`, `terminal.label`, `terminal.interrupt`,
  `doc.set`.

Anything else, and any call with the parameter `on` (herdr-core's remote
machine routing), is refused and audited as `denied.term`. `terminal.run`,
`kill`, `rm`, `interrupt` and `keep` are audited; `terminal.run` with its
argv, cwd and the variable names (not values) of its `env`. The core adds
to `terminal.run`'s `env` the virtual display's variables
([14](14-gui-windows.md)) and, on ssh machines, `SSH_CONNECTION`/
`SSH_CLIENT` ([21](21-terminal-core.md)). A read-only client's
`terminal.read` reaches herdr-core without `lines` (`readScreenOnly`):
with history lines herdr-core scrolls a program on the alternate screen,
which every viewer would see.

**Terminals kept from clients.** Two kinds of terminals are in no
snapshot, event or `terminal.list` result:

- **hidden terminals**, the product's own helpers (the chat host,
  [37](37-agent-chats.md)), recognized by their reserved name and label
  together (`agentproto.Hidden`; a label alone hides nothing, since any
  program can set one); their agents are not detected, and a stream of a
  terminal that becomes hidden is closed;
- **other machines' terminals** of the terminal core (`machine.add`,
  addresses like `box/t7`); each machine is reached through its own core.

A call or attach that names one (as `terminal`, `caller` or `parent`) is
answered `not_found`, as for a terminal that does not exist, and audited
as `denied.term` with the reason. Setting the hidden label or taking the
chat host's name is refused. `labels` must be an object of strings, so
the core forwards what it checked.

**Streams.** `attach` opens a herdr-core attach and answers `attached`
with a stream number; the reply is queued before the stream's first frame.
Output arrives as binary frames: the first paint, then the program's
bytes.

- **Credit.** The client sends `ack {s, n}` for bytes it has drawn; the
  core forwards it as herdr-core credit, capped at what it actually sent.
  So at most 256 KiB is in flight per terminal, and a client 4 MiB behind
  gets a repaint instead of the backlog.
- **Input** is kind 0, or kind 6 for answers the client's emulator
  produces itself. `resize`, `focus` and `facts` pass through.
- **Display facts.** herdr-core answers color queries (OSC 10/11, mode
  2031), device attributes and size reports itself, from the facts of the
  viewer active last. So the page sends its theme colors and cell size as
  `display` with each attach and `terminal.run`, and `facts` when they
  change.
- **Observers.** An observing attach (requested, or every attach of a
  read-only core) receives the grid size as kind 3 frames and sends
  nothing: no input, size, focus or facts, and its focus marks no turn
  seen.
- Messages are at most 16 MiB. `closed` ends a stream with herdr-core's
  reason, or `disconnected`.

**The last viewer's stream** (`joined`, `left`, `unpark` in
`backend.ts`; `release` in `client.ts`). herdr-core sets a terminal's
size only through streams. If the last viewer detached, the terminal
jumped to the headless size (200x120) and back at the next attach, so
full-screen programs (Claude Code, Codex) laid out twice, lost their
scroll position, and the next first paint showed the wrong layout.

So when a client lets go of the last size-setting stream of a live
terminal, the core keeps it attached but unread (`parked`):

- it tells herdr-core the viewer lost focus (if it had it) and stops
  forwarding output;
- herdr-core sends it at most its remaining credit, then drops the backlog
  for a repaint as for any slow viewer;
- it belongs to no client: no input, size, focus or credit reaches it;
- it closes once the next size-setting viewer has attached, when the
  terminal ends or is removed, or with the backend's connection (10 s
  after the last subscriber).

Observers' streams and all but the last viewer are closed normally. Why
the size is not kept another way:
[26](26-web-terminals.md#alternatives-considered).

**Layout document.** Clients arrange a machine's terminals in herdr-core's
document `layout` on that machine: read with `doc.get`, written with
`doc.set` and the version last read (a `doc` event announces newer ones).
Every client of the machine shows the same arrangement. Version 2:

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

- A **workspace** has an `id` (eight random lowercase letters and digits,
  unique in the document), a `name` (empty: shown as the last component of
  `cwd`), the `cwd` new terminals start in, `tabs` and its `selected` tab.
- A **tab** has a `root` node, the `focused` pane, and an optional `name`.
- A **node** is a split
  `{"split": "horizontal" | "vertical", "ratio", "children": [a, b]}`
  (`horizontal` is side by side; `ratio` is clamped to 0.1–0.9) or a leaf:
  - a terminal `{"terminal": address}`, optionally with `agent` and `pid`
    or `resume` for restoring a coding agent
    ([33](33-workspace-restore.md)), whose ids select a kind of the agent
    kind registry (`backend/shared/agents/kinds.ts`); `session` (the agent's session
    UUID, [35](35-agent-native-view.md)) and `before` (the address of the
    terminal this one replaced), checked by `terminalFields` in
    `web/src/term/layout.ts`, which leaves out malformed values and the
    obsolete `render`;
  - VS Code `{"code": {"id", "folder"}}`, named `code:<id>`
    ([05](05-vscode-panes.md));
  - a preview `{"preview": {"id", "path"}}`, named `preview:<id>`
    ([06](06-quick-look-and-files.md)).

  A view keeps its `id` wherever it moves, so every client finds it again.
- **Compatibility.** A version 1 document (`tabs` at the top) reads as one
  workspace `default`. Invalid parts are dropped or clamped. Unknown fields
  and node kinds are kept and written back, so a newer client's additions
  survive an older client's edit. Clients write version 2.
- **Operations** (create, rename, close, move and select workspaces and
  tabs; split, close, swap and move panes; set ratios; prune ended
  terminals) give the same result in every client. Closing a workspace or
  tab ends no program; the client does. The contract is the vectors in
  `spec/vectors/layout/*.json`, run by the web tests.

**Client.** `web/src/term`: `protocol.ts` (messages and frames),
`connection.ts` (WebSocket, resubscribing, calls as promises, stream
handlers registered before the first frame), `store.ts` (records from
snapshots and events), `layout.ts` (the layout as immutable values and
operations). `web/src/state/terms.ts` reads a machine's layout before
editing and writes one change at a time with the version last read. It
starts terminals with `keep: true` and replaces those that ended with the
core ([33](33-workspace-restore.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| New message types on `/ws` | Shares one send queue and compression with machine, settings and agent messages; busy terminal output would delay them and be compressed needlessly. |
| Passing herdr-core's protocol through | Clients could call `machine.exec`, `file.*` and `server.stop`, and would need a connection per machine. |
| Acknowledging herdr-core on read | A slow client's backlog would queue in the core. |
| A `terminal.list` snapshot per subscriber | Without a sequence number, events between list and subscription would be lost or doubled. |
| One backend connection per client | Each would count as a viewer; one per machine keeps event order identical for all clients. |
| Starting terminal cores when machines connect | Machines nobody uses terminals on would get a long-lived process. |

## Failure modes

- **Machine offline / agent session lost** → `machine_offline` or
  `disconnected`; streams close; the backend returns with a new snapshot
  and the UI reattaches ([26](26-web-terminals.md)).
- **Build without herdr-core** on a machine without a core →
  `not_bundled`.
- **Client stops reading** → its send queue (8192 messages) fills and the
  connection closes; its streams are released as on disconnect.
- **No subscriber for 10 s** → the backend's connection and kept streams
  close; terminals take the headless size, and the next attach resizes
  once.
- **Call to an unsubscribed or not ready machine** → `unavailable`.
- **Unknown or refused method** → `refused`, audited as `denied.term`.
- **A hidden terminal or another machine's named** → `not_found`, audited
  as `denied.term` with the reason.

## Security

Clients get only the allowlisted methods above, never herdr-core's exec,
file or server methods, and never the product's hidden terminals or other
machines' terminals; read-only mode refuses writes, reads screens without
history and makes every attach an observer. See the terminal clients row in
[SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/terminals/terminals.test.ts`, with a scripted core
  behind a simulated agent (`testing.ts`): lifecycle, snapshots and
  events, allowed and refused calls with audit entries, credit capping,
  display facts, detected agents, read-only, and `the last viewer`;
  `hidden.test.ts` hidden and other machines' terminals (also before their
  label and after a `missed`); `units.test.ts` (`terminal.read`) a
  read-only `terminal.read`; `sessions.test.ts` the agent session in
  records and events.
- `web/src/__tests__/term.test.ts`: the TypeScript client against a
  scripted socket and every layout vector; `terms.test.ts` the UI's model;
  `restore.test.ts` restoring after a core restart; `agentLeaves.test.ts`
  with `spec/vectors/layout/agent-leaves.json` a leaf's `session` and
  `before`.
- `make it`: `backend/features/terminals/integration.test.ts` (`a shell,
  typed into and read, watched, killed`, `agent detection`, `shells`,
  `hidden terminals`) against a real herdr-core.
