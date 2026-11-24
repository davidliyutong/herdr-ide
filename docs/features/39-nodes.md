# 39 · Nodes: one program on every machine

## Context

A machine's work lives on the machine: its terminals in a terminal core
([21](21-terminal-core.md)), its layout in that core's documents
([22](22-terminal-protocol.md)), its chats in a chat host
([37](37-agent-chats.md)). What reaches them was tied to one core: an
agent per core and ssh session, the local machine's agent inside the core's
process, and the machine's directories named after the core's instance, so
the desktop app (`desktop`) and a server's core (the default instance)
reaching the same machine saw different terminals.

Constraints: terminals and chats must outlive every program that shows
them; the agent runs on Linux and macOS only, herdr-core has no Windows
build; nothing listens on TCP on machines; ssh is the only way in;
herdr-core is another project, reached through its protocol
(AGENTS.md rule 7).

## Goals / non-goals

Goals:

- every machine runs one program, `herdr-ide`, in two roles: a **node**,
  the machine's service that listens on a local socket only, and a **UI**,
  which serves the web UI and is a client of nodes;
- a UI reaches its own machine's node exactly as it reaches another's,
  through the node's socket, locally or over ssh;
- several UIs attach to one node at once and see the same terminals,
  workspaces and chats, as tmux clients share a server;
- a node is upgraded without interrupting the panes of the UIs attached
  to it.

Non-goals: a node on Windows (no herdr-core); sharing a UI's settings,
keybindings, machines or vault between UIs; UIs reaching each other;
a node reachable without ssh.

## Design

### Roles

`herdr-ide` has these commands on Linux and macOS:

| Command | Role |
| --- | --- |
| `node` | The machine's service: what the agent did, for any number of clients, detached from them. |
| `node dial` | Pipes its standard input and output to the node's socket, starting the node first when none answers. Run by ssh. |
| `chat-host` | The chat host, run by the node. |
| `serve` | The UI: HTTP and WebSocket front, plugins' core sides, the files of the UI's host. Also on Windows. |

A machine needs only what it runs: the UI's host the full build, other
machines the machine build (tag `machine`: no `serve`, no web UI, no
payloads), which the UI uploads as before ([02](02-multi-machine-transport.md)).
A machine that has the full build of the same version runs it instead.

### The node

- **Socket.** `<data>/run/node.sock`, 0600 in the 0700 run directory; a
  connection whose peer is another uid (`SO_PEERCRED`, `getpeereid`) is
  closed. Nothing else is listened on.
- **Sessions.** Each connection is one yamux session speaking
  `internal/agentproto` as the agent did. `hello` carries the client's
  build and protocol range; the node answers with its own and the
  features they share, or `incompatible`.
- **One per namespace.** `run/node.lock` is held while a node serves; a
  second node started for the namespace exits unless it is taking over
  (below).
- **Lifetime.** `node dial` (ssh) or the UI (its own machine) starts the
  node when none answers. The node ends when it has had no client and no
  process of its own (code-server, display, encoder) for
  `node.idleMinutes`, on `node stop`, or when a newer node took over.
  Terminals and chats do not depend on it.
- **Detached services.** The node, herdr-core's server and the chat host
  each run as a service of their own: a transient systemd user unit,
  a launchd job, else a new session (`setsid`). None is a child that ends
  with another: systemd ends a unit's processes with its main process and
  launchd a job's with the job, so the node would otherwise take the
  terminals with it. A node finds running services by their sockets.

### The terminal core

herdr-core stays its own executable, pinned by `internal/hcdist` and
installed by a UI into `<data>/hc/herdr-core` only with its digest, as
before ([21](21-terminal-core.md)). The node starts, restarts and stops it
(op `hc`) and never links it, so a panic or an upgrade of the node does
not end terminals, holders keep programs across the terminal core's own
restart, and on macOS terminals keep the privacy grants of that executable
([16](16-desktop-packaging.md)).

### The UI

- **Its own machine.** It connects to `node.sock`, starting the node from
  its own executable when none answers. There is no in-process agent.
- **Other machines.** `ssh … -- <agent> node dial`: the session is the
  node's, over ssh's standard input and output as before, with the
  ControlMaster of [02](02-multi-machine-transport.md).
- **Several UIs.** What concerns the machine runs once, in the node; what
  concerns a UI's pages stays in the UI:

| Concern | Where |
| --- | --- |
| Terminals, layout documents, chats | Machine: terminal core and chat host. |
| code-server | Node: one process for every client; a UI's idle timeout releases it (`release`), which stops it only while no other client has a connection to it; it ends with the node. |
| Terminal history captures, AI usage limits | Node: a capture or a fetch of one UI answers the others' for a while (10 s, a minute), so the UIs' schedules do the work about once between them. |
| Program windows | Node: one capture and encoder per window, frames sent to every client that attached it. |
| Settings, keybindings, machines, vault, port forwards | UI's host, per UI instance. |
| Read-only mode | UI: enforced on its own pages and requests. |

### Requests from the machine

`vault` (the vault's MCP server) and `bridge` (the VS Code extension)
start on the node and need a UI:

- **Vault.** Values live on UI hosts, so a request goes to every attached
  UI. The first value a UI releases (allowed for the machine, or approved
  on one of its pages) answers it; a UI that lacks the variable, is
  locked or is denied answers no, and the request fails only when every UI
  did or `vault.approvalTimeout` passed. The other UIs' approval prompts
  are withdrawn. Each UI logs what it released ([30](30-variable-vault.md)).
- **Bridge.** A connection of the extension goes to the UI that last
  connected to code-server (it shows VS Code), else to the newest client.

### Namespaces

A node's namespace is the machine's data directory and terminal core
session: `~/.herdr-ide` and `herdr-ide` by default, for every UI,
desktop app and server alike. `--instance` names a separate namespace for
both roles, for development and tests (`dev`, `e2e-<random>`); a UI's
instance also names its own files on its host
([reference](../reference.md#files-and-directories)). A node finding the
former desktop namespace (`~/.herdr-ide-desktop`) imports its layout
documents and chat journal once and serves its terminal core beside its
own until that core has no terminal.

### Upgrades without interruption

A UI whose build is newer than the node's starts the new node, which takes
over:

1. The new node binds a temporary socket and renames it over `node.sock`
   (likewise `vault.sock` and `bridge.sock`); new connections reach it.
2. The old node sends every client a yamux GoAway and accepts no new
   stream; its streams keep running.
3. Clients open a session to the new node and move their long streams,
   the new one before the old one ends: terminal attaches (herdr-core
   takes several attaches of a terminal), chat subscriptions (resumed from
   the last event's sequence) and watches (a full state first). Proxied
   VS Code connections, uploads, git and other bounded requests finish on
   the old node.
4. Schedules and singletons pass by lock: the old node stops its
   captures and collections and releases its locks; code-server is adopted
   by its pid file; program windows' window manager runs in the display
   keeper (`gui-keep`), not in the node.
5. The old node exits when its last stream ends, at the latest after the
   longest bounded request (10 min).

A UI speaks its own protocol version and the one before, so it serves
both nodes during the move; an older UI attached to a newer node does the
same. The chat host and the terminal core keep their own rules: a chat
host makes way only while no chat works, the terminal core restarts only
when asked.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| The local machine's agent in the core's process (before) | The machine's service ended with one UI and could serve no other. |
| herdr-core linked into `herdr-ide`, run as `herdr-ide hc` | Saves one artifact at the cost of cgo in every Linux and macOS build, a build of another project's sources and its entry point, and terminals' macOS privacy grants moving to an executable that changes with every release. |
| herdr-core's library called in the node's process | A node panic or upgrade would end every terminal; holders and macOS responsibility need processes of their own. |
| `ssh -L` forwarding of the node's socket | Many servers disable stream-local forwarding; it cannot start a node. |
| The node as one systemd unit with `KillMode=process` | Takeover needs two nodes at once, and leftovers of a stopped unit are not services anyone owns. |
| Vault on the node | Values would leave the UI hosts where they were entered. |
| Vault requests to the UI that started the terminal | A terminal outlives the UI that started it. |
| Restart the node on upgrade and let clients reconnect | Every pane would blink and VS Code windows reload. |

## Failure modes

- **Node crash.** Clients see the session end and reconnect as after an
  ssh loss; terminals and chats keep running, the services it ran are
  adopted by the next node.
- **No node starts.** `node dial` reports why (missing build, lock held by
  a node that does not answer, mkdir failure); the UI shows it on the
  machine. A lock whose holder is gone is taken over.
- **Incompatible builds.** `hello` answers `incompatible`; the UI offers to
  upgrade the node, or tells an older UI to update.
- **Takeover interrupted.** If the new node dies before the old one exits,
  clients return to whichever node answers `node.sock`; the old node
  takes it back after its drain timeout if no node serves.
- **No user service manager** (containers, no linger). Services start in a
  new session and end with the user's login session where the system ends
  it; [deployment](../deployment.md#remote-resources) says how to enable
  lingering.

## Security

- The node's socket, like `hc.sock` and `chat.sock`, admits the user's own
  processes only: 0600 file, 0700 directory, peer uid checked.
- Nothing listens on TCP; ssh runs `node dial` with a fixed argument
  vector and `--` before the target.
- A UI enforces its read-only mode itself; a node serves any client of the
  user, as the terminal core does.
- Vault values are released by a UI only, each under its own rules and
  log; a UI cannot answer for another.

## Testing

- `internal/node`: socket mode and peer check, lock, version negotiation,
  GoAway and drain, takeover of sockets and schedules.
- `cmd/herdr-ide`: `node dial` starts one node for concurrent dials.
- Integration (`make it`): the terminal core started, restarted and
  stopped by a node, which a takeover leaves running.
- End to end: two UI processes on one node see each other's terminals,
  workspaces and chats; a vault request answered by the second UI; a node
  upgrade under a live terminal, chat and VS Code window, with nothing
  reloaded; SSH machines in Docker over `node dial`.
