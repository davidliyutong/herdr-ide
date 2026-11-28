# 22 · Terminal protocol for clients

## Context

A client that emulates terminals itself (the browser UI) needs each terminal's raw output, several viewers per terminal, and input it encodes itself. herdr-core provides that per machine ([21](21-terminal-core.md)), but only through the machine's agent, and it can also run commands and read files, which clients must not get.

## Goals / non-goals

Goals: one connection from a client to the hub for every machine's terminals; herdr-core's records and events passed on unchanged, so clients follow its API as it grows; backpressure from the drawing client to the program; the hub's guards and read-only mode.

Non-goals: emulating terminals in the hub; a layout model in the hub; replacing `/ws`.

## Design

**Endpoint** (`backend/features/terminals/client.ts`): `GET /api/v1/term`, a WebSocket behind the usual guards; messages in [architecture](../architecture.md#terminal-clients--hub-protocol-apiv1term).

**Backends** (`backend.ts`, `lifecycle.ts`), one per machine, started by the first `sub {m}`: bring up the terminal core ([21](21-terminal-core.md); a read-only hub starts nothing), subscribe to its events, and send subscribers a `snapshot`, then every `event`, under one lock, so a later subscriber loses or duplicates nothing. Records pass through unchanged, plus detected agents ([25](25-agent-detection.md)). 10 s after the last subscriber leaves, the backend disconnects; programs keep running.

**Calls** pass an allowlisted method (`allowlist.ts`):

- reading: `terminal.list`, `terminal.get`, `terminal.read`, `doc.get`, `templates.list`;
- writing (refused in read-only mode): `terminal.run`, `terminal.kill`, `terminal.rm`, `terminal.keep`, `terminal.label`, `terminal.interrupt`, `doc.set`.

Anything else, and any call with herdr-core's machine-routing parameter `on`, is refused and audited as `denied.term`. The hub adds the virtual display's ([14](14-gui-windows.md)) and the ssh session's variables to `terminal.run`'s `env`; vault variables never go there, since herdr-core persists it ([30](30-variable-vault.md)). A read-only client's `terminal.read` reaches herdr-core without `lines` (`readScreenOnly`), since with history lines herdr-core scrolls a program on the alternate screen, which every viewer would see.

**Terminals kept from clients**: the product's hidden terminals (the chat host, [37](37-agent-chats.md); by reserved name and label together, since any program can set a label) and other machines' terminals of the core. No snapshot, event or list holds them; a call or attach naming one is answered `not_found` and audited as `denied.term`.

**Streams.** The client sends `ack {s, n}` for bytes it has drawn; the hub forwards it as herdr-core credit, capped at what it sent, so a client that stops drawing stops the program. Observers (requested, or every attach of a read-only hub) send nothing. Pending attaches and calls per client are bounded (`busy`).

**The last viewer's stream** (`backend.ts`). herdr-core sets a terminal's size only through streams; without a viewer it jumps to the headless size, and full-screen programs lay out twice. So the hub keeps the last size-setting stream of a live terminal attached but unread (*parked*, returning no credit, owned by no client) until another size-setting viewer attaches, the terminal ends or the backend disconnects. Why not another way: [26](26-web-terminals.md#alternatives-considered).

**Layout document.** Clients arrange a machine's terminals in herdr-core's document `layout` (`web/src/term/layout.ts`). Written with `doc.set` and the version last read, it is the same in every client of the machine; unknown fields and node kinds are kept and written back, so a newer client's additions survive an older client's edit, and a version 1 document reads as one workspace. Version 2:

- `{"version": 2, "workspaces": […], "selected"}`; a workspace has an `id`, a `name`, the `cwd` new terminals start in, `tabs` and its `selected` tab; a tab a `root` node and its `focused` pane;
- a node is a split `{"split": "horizontal" | "vertical", "ratio", "children": [a, b]}` or a leaf: `{"terminal": address}` (with what restoring its agent needs, [33](33-workspace-restore.md)), `{"code": {"id", "folder"}}`, `{"preview": {"id", "path"}}` or a plugin's `{"view": {"id", "plugin", "kind", …}}`; a view keeps its `id` wherever it moves.

The contract is `spec/vectors/layout/*.json`, run by the web tests.

## Alternatives considered

| Option | Why not |
| --- | --- |
| New message types on `/ws` | Busy terminal output would delay machine, settings and agent messages in the shared queue. |
| Passing herdr-core's protocol through | Clients could call `machine.exec`, `file.*` and `server.stop`. |
| Acknowledging herdr-core on read | A slow client's backlog would queue in the hub. |
| One backend connection per client | Each would count as a viewer; one per machine keeps event order identical for all clients. |
| Starting terminal cores when machines connect | Machines nobody uses terminals on would get a long-lived process. |

## Failure modes

- **Machine offline / agent session lost** → `machine_offline` or `disconnected`; streams close; the backend returns with a new snapshot and the UI reattaches ([26](26-web-terminals.md)).
- **Client stops reading** → its send buffer overflows and the connection closes.
- **No subscriber for 10 s** → terminals take the headless size; the next attach resizes once.

## Security

Clients get only the allowlisted methods, never herdr-core's exec, file or server methods, and never hidden or other machines' terminals; read-only mode refuses writes, reads screens without history and makes every attach an observer. See the terminal clients row in [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/terminals/*.test.ts`: a scripted core behind a simulated agent (`testing.ts`): calls and audit, credit, read-only, hidden terminals, `the last viewer`; `integration.test.ts` (`make it`) against a real herdr-core.
- `web/src/__tests__/term.test.ts` (the client and every layout vector), `terms.test.ts`.
