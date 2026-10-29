# 01 · herdr integration

## Context

herdr manages terminals, workspaces and AI coding agents on each machine and
already connects to saved SSH machines. The goal is a browser IDE that is an
orchestrator *of* herdr: it must understand herdr's model (workspaces, tabs,
split layouts, panes, agent states) and render panes natively, instead of
showing herdr's TUI inside a terminal.

Findings that shaped the design (herdr 0.9.5, protocol 22, read from its
Apache-2.0 sources and verified on real servers):

- The public socket API is newline-delimited JSON, **one request per
  connection**, 5 s to send the request, no authentication beyond the
  socket's 0600 mode. 128 methods cover workspaces, tabs, panes, layouts,
  agents, worktrees and plugins.
- `events.subscribe` turns a connection into an event stream; lagging
  subscribers receive `events_lost` and are closed. Agent status changes
  need one subscription entry per pane. There is no pane-output event, and
  `pane.read` returns revision 0, so output cannot be polled efficiently.
- `herdr terminal session control|observe <target>` is a documented
  JSON-lines CLI around herdr's private client protocol: herdr's own terminal
  emulator (libghostty-vt) re-renders the pane and emits ANSI frames (full
  first, then diffs). Control accepts input, resize, scroll and mouse events;
  one controller per pane; observers do not resize.
- That wrapper drops OSC 52 clipboard, bell, keyboard-protocol negotiation
  and Kitty graphics messages.

## Goals / non-goals

Goals: native multi-pane rendering; live workspace/tab/layout/agent state for
every machine; full interactivity; no coupling to herdr's private protocol
version.

Non-goals: replacing herdr's server, managing herdr installation on
machines, reimplementing its agent detection.

## Design

- **State.** Per machine, `internal/machines/machine.go` keeps a lifecycle
  subscription (workspace/tab/pane/layout events) and an agent-status
  subscription (one entry per pane, rebuilt when the pane set changes). Any
  event, plus a 5 s heartbeat, triggers a debounced refetch of
  `session.snapshot` and `layout.export` per tab. The state sent to browsers
  is the snapshot plus layouts, replaced as a whole; browsers do not apply
  event deltas. Agent status events are also forwarded as notifications.
- **Requests.** `internal/herdr/client.go` opens one connection per call
  (through the agent, see [02](02-multi-machine-transport.md)). Mutating
  calls trigger a refetch. Browser calls go through an allowlist
  ([08](08-web-access-and-security.md)).
- **Panes.** Each displayed pane is a `herdr terminal session` process on the
  pane's machine, started by the agent; frames are forwarded to the browser
  as binary WebSocket messages ([03](03-pane-rendering-and-arbitration.md)).
- **Discovery.** Machines come from herdr's saved catalog
  (`~/.local/state/herdr/client/endpoints.json`) plus `--ssh` targets; the
  remote herdr binary path is taken from herdr's ssh-metadata cache when
  available, else searched (`HERDR_BIN`, `PATH`, `~/.local/bin`, login shell).
  Socket paths follow herdr's rules (named sessions under
  `sessions/<name>/`, `XDG_CONFIG_HOME`, `HERDR_SOCKET_PATH`).
- **Sessions.** `--local-session` selects a named herdr session locally;
  remote machines use the session saved in their herdr profile.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Run the herdr TUI in one web terminal per machine | Not an orchestrator: the UI could not know which pane or machine is in focus, could not render panes natively, and the machine selection in herdr is global persisted state shared with the user's own TUI clients. |
| Poll `pane.read` ANSI snapshots per pane | No change signal (no output event, revision always 0), no cursor position, full redraws: high latency and flicker. |
| Implement herdr's private client protocol (bincode) | Gains clipboard, bell, keyboard protocol and graphics, but must match herdr's exact protocol version on every machine and breaks on each herdr upgrade. The CLI wrapper runs the server's own binary, so it always matches. |
| Cut panes out of the client-shell surface stream | Most stable private interface, but one tab per connection, herdr owns pane sizes, and cell grids must be decoded. |
| `herdr --machine X` per request | Two ssh processes and two remote herdr processes per call, and no event streams. |

## Failure modes

- **Lagging subscription** (`events_lost`) → resubscribe and refetch.
- **Pane closed between snapshot and subscribe** → the whole agent-status
  subscription is rejected; refetch and retry after 2 s.
- **herdr not running or not found** → agent reports `herdr_error`, the
  machine shows *degraded*; snapshots are retried.
- **Pane terminal gone** (e.g. its cwd was deleted) → the stream ends with
  herdr's reason, shown on the pane with a reconnect button.
- **herdr protocol change** → only the public API and the documented CLI
  stream are used; a breaking change there surfaces as request errors, not
  as corrupted rendering.

## Testing

`internal/herdr/client_test.go` (one request per connection, subscription,
`events_lost`) against a fake socket; `internal/agent/integration_test.go`
(`make it`) against a real herdr in an isolated session: workspace creation,
control stream, input, first frame full.
