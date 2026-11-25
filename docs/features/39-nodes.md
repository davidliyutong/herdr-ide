# 39 · Nodes: one program on every machine

## Context

A machine's work lives on the machine: its terminals in a terminal core ([21](21-terminal-core.md)), its layout in that core's documents ([22](22-terminal-protocol.md)), its chats in a chat host ([37](37-agent-chats.md)). What reaches them was tied to one hub: an agent per hub and ssh session, the local machine's agent inside the hub's process, and the machine's directories named after the hub's instance, so the desktop app (`desktop`) and a server's hub (the default instance) reaching the same machine saw different terminals.

Constraints: terminals and chats must outlive every program that shows them; the agent runs on Linux and macOS only, herdr-core has no Windows build; nothing listens on TCP on machines; ssh is the only way in; herdr-core is another project, reached through its protocol (AGENTS.md rule 7).

## Goals / non-goals

Goals:

- every machine runs one program, `veldr`, in two roles: a **node**, the machine's service that listens on a local socket only, and a **UI**, which serves the web UI and is a client of nodes;
- a UI reaches its own machine's node exactly as it reaches another's, through the node's socket, locally or over ssh;
- several UIs attach to one node at once and see the same terminals, workspaces and chats, as tmux clients share a server;
- a node is upgraded without interrupting the panes of the UIs attached to it.

Non-goals: a node on Windows (no herdr-core); sharing a UI's settings, keybindings, machines or vault between UIs; UIs reaching each other; a node reachable without ssh.

## Design

### Roles

`veldr` has these commands on Linux and macOS:

| Command | Role |
| --- | --- |
| `node` | The machine's service: what the agent did, for any number of clients, detached from them. |
| `node dial` | Pipes its standard input and output to the node's socket, starting the node first when none answers. Run by ssh. |
| `chat-host` | The chat host, which the node starts as a hidden terminal of the instance's terminal core ([37](37-agent-chats.md)). |
| `serve` | The UI: HTTP and WebSocket front, plugins' hub sides, the files of the UI's host. Also on Windows. |

`serve` is the hub's executable (TypeScript, `backend/hosts/bun`), which is the machine build of its platform too and runs `node`, `node dial` and `chat-host` itself ([42](42-typescript-backend.md#the-machine-side)); the UI installs it on its own machine, and other machines download their platform's from the release or get it uploaded ([02](02-multi-machine-transport.md)). `backend/machine/node.ts` is the node, `backend/hosts/machine/cli.ts` its commands (`chathost.ts` the chat host's). A node of this build takes over from any older build's node on the same socket and protocol (below).

### The node

- **Socket.** `node.sock`, 0600 in the namespace's runtime directory on the host (0700, [40](40-shared-homes.md)); a connection whose peer is another uid (`SO_PEERCRED`, `getpeereid`) is closed. Nothing else is listened on.
- **Hello.** A connection's first line (`agentproto.NodeHello`) says what the client wants (`serve`, `stop`, `takeover`), names its hub (a random id per hub process, the same across its reconnects) and its build: a digest of its executable, its version and when the executable was written. The node answers with its own build; with `serve` the connection then carries one yamux session speaking the agent protocol (`backend/shared/proto/agentproto`) as the agent did.
- **One per namespace and host.** `node.lock` in the runtime directory is held while a node serves; a second node started for the namespace exits unless it takes over (below).
- **Lifetime.** `node dial` (ssh) or the UI (its own machine) starts the node when none answers, in a session of its own (`setsid`), its output in `<data>/hosts/<host>/node.log`. It ends 15 s after its last client left, on `node stop` (with `--terminal-core` the instance's terminal core on the host is stopped too), or once it was taken over and its clients moved. One whose executable is removed (a development build, an uninstalled app) takes no new client. Terminals and chats do not depend on it: herdr-core runs as a service of its own (`herdr-core server start`), and the chat host as one of its terminals.

### The terminal core

herdr-core stays its own executable, pinned by `backend/scripts/hcdist.ts` and installed by a UI into `<data>/hosts/<host>/hc/herdr-core` only with its digest, as before ([21](21-terminal-core.md)). The node starts, restarts and stops it (op `hc`) and never links it, so a panic or an upgrade of the node does not end terminals, holders keep programs across the terminal core's own restart, and on macOS terminals keep the privacy grants of that executable ([16](16-desktop-packaging.md)).

### The UI

- **Its own machine.** It connects to `node.sock`, starting the node from the machine build it installed for its platform when none answers (`backend/kernel/machines/transport/local.ts`). There is no in-process agent.
- **Other machines.** `ssh … -- <agent> node dial`: the session is the node's, over ssh's standard input and output as before, with the ControlMaster of [02](02-multi-machine-transport.md).
- **Several UIs.** What concerns the machine runs once, in the node; what concerns a UI's pages stays in the UI:

| Concern | Where |
| --- | --- |
| Terminals, layout documents, chats | Machine: terminal core and chat host. |
| code-server | Node: one process for every client; a UI's idle timeout releases it (`release`), which stops it only while no other client has a connection to it; it ends with the node. |
| Terminal history captures, AI usage limits | Node: a capture or a fetch of one UI answers the others' for a while (10 s, a minute), so the UIs' schedules do the work about once between them. |
| Program windows | Node: one window manager, one capture and encoder per window, every window sent to every client; one client controls them (input, focus, closing), the others view and may take control at once ([14](14-gui-windows.md)). |
| Settings, keybindings, machines, vault, port forwards | UI's host, per UI instance. |
| Read-only mode | UI: enforced on its own pages and requests. |

### Requests from the machine

`vault` (the vault's MCP server) and `bridge` (the VS Code extension) start on the node and need a UI:

- **Vault.** Values live on UI hosts, so a request goes to every attached UI. The first value a UI releases (allowed for the machine, or approved on one of its pages) answers it; a UI that lacks the variable, is locked or is denied answers no, and the request fails only when every UI did or `vault.approvalTimeout` passed. The other UIs' approval prompts are withdrawn. Each UI logs what it released ([30](30-variable-vault.md)).
- **Bridge.** A connection of the extension goes to the UI that last connected to code-server (it shows VS Code), else to the newest client.

### Namespaces

A node's namespace is the machine's data directory and terminal core session: `~/.veldr` and `veldr-<host id>` by default ([40](40-shared-homes.md)). A hub's `--instance` names its own files on its host ([reference](../reference.md#files-and-directories)) and, unless `--node-instance` says otherwise, the namespace on machines too, which keeps development and test hubs (`dev`, `e2e-<random>`) apart from the user's. The desktop app runs `--instance desktop --node-instance=`: its own settings and vault, and the default namespace on every machine, which it shares with a server's hubs. Earlier desktop builds used the namespace `desktop`; it is left as it was, its terminal core running until stopped ([deployment](../deployment.md#desktop-app)).

### Upgrades without interruption

The client that reaches a node compares builds (`newer` of agentproto: by version when both builds have a release version, else by when their executables were written):

- the node's build or a newer one: the client uses the node; the protocol only grows (AGENTS.md rule 7), so a newer node serves an older hub;
- an older node: the client starts `node --takeover` from its own executable and connects to that.

The node taking over asks the running one to give way (`takeover`), which closes its listener, gives up the lock and hands its code-server over (the pid file names the new node), then takes lock and socket. The old node tells each of its sessions' hubs to move (op `node.drain`, agent to hub), serves them meanwhile, and ends once they left, at the latest after 10 minutes, the longest bounded request.

A hub told to move connects again, which reaches the new node, and makes that session the machine's while the machine stays ready; the old session ends 2 s later. What used it opens its streams again on the new session as after any lost stream, without the machine being shown as disconnected: terminal attaches (herdr-core takes a terminal's attach again with its screen), chat subscriptions (resumed from the journal) and watches (a full state first); program windows attach to the new node's window manager once the old one ended with its last client. The chat host and the terminal core keep their own rules: a chat host makes way only while no chat works, the terminal core restarts only when asked.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| The local machine's agent in the hub's process (before) | The machine's service ended with one UI and could serve no other. |
| herdr-core linked into `veldr`, run as `veldr hc` | Saves one artifact at the cost of cgo in every Linux and macOS build, a build of another project's sources and its entry point, and terminals' macOS privacy grants moving to an executable that changes with every release. |
| herdr-core's library called in the node's process | A node panic or upgrade would end every terminal; holders and macOS responsibility need processes of their own. |
| `ssh -L` forwarding of the node's socket | Many servers disable stream-local forwarding; it cannot start a node. |
| The node as one systemd unit with `KillMode=process` | Takeover needs two nodes at once, and leftovers of a stopped unit are not services anyone owns. |
| Vault on the node | Values would leave the UI hosts where they were entered. |
| Vault requests to the UI that started the terminal | A terminal outlives the UI that started it. |
| Restart the node on upgrade and let clients reconnect | Every machine would be shown disconnected and every pane reconnect. |
| Moving each stream to the new node before its old one ends | Every user of a session would have to know two; the streams resume on their own once theirs ends, while the machine stays ready. |
| A node per build (the first step of this design) | Two nodes of one namespace contend for its sockets, code-server and display's window manager. |
| Systemd or launchd services for the node and the chat host | The node holds nothing that must outlive it, and the chat host already runs as a terminal of the terminal core, which is such a service. |

## Failure modes

- **Node crash.** Clients see the session end and reconnect as after an ssh loss; terminals and chats keep running, the code-server it ran is adopted or reaped by the next node.
- **No node starts.** The client reports why (`no node answers on …; see <data>/hosts/<host>/node.log`); the machine shows it. A lock whose holder is gone is taken.
- **The running node does not give way.** A node taking over waits 5 s for the lock and exits; the client uses the node that serves.
- **Takeover interrupted.** A new node that dies leaves no node on the socket; the next client starts one. The old node ends with its clients.
- **A hub that knows no drain notice** (a build before it). It keeps its session until the old node ends after 10 minutes, then reconnects.
- **The user's login session ends.** Where the system ends the session's processes (systemd's `KillUserProcesses`), the node ends with it; the terminal core and the chat host do not.

## Security

- The node's socket, like `hc.sock` and `chat.sock`, admits the user's own processes only: 0600 file, 0700 directory, peer uid checked.
- Nothing listens on TCP; ssh runs `node dial` with a fixed argument vector and `--` before the target.
- A UI enforces its read-only mode itself; a node serves any client of the user, as the terminal core does.
- Vault values are released by a UI only, each under its own rules and log; a UI cannot answer for another.

## Testing

- `backend/machine/node.test.ts`: the socket's mode, several clients, one node per namespace, idle end and stop, retiring when the executable is gone, takeover with its drain notice, the order of builds (`backend/shared/proto/agentproto/agentproto.test.ts` too).
- `backend/machine/vault.test.ts`, `backend/features/vscode/machine.test.ts`, `backend/features/gui/machine.test.ts`: vault requests asked of every hub, code-server kept for another hub, bridge connections, a program window viewer that falls behind, two hubs on one window manager.
- End to end (`e2e/tests/nodes.spec.ts`, `gui.spec.ts`): two hubs of one instance share the local node; a newer build takes the node over while the other hub stays ready and its page's terminal works on; two hubs show an SSH machine's program window, one in control.
