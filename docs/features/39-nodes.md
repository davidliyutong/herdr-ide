# 39 · Nodes: one program on every machine

## Context

A machine's work lives on the machine: terminals in a terminal core ([21](21-terminal-core.md)), layouts in its documents ([22](22-terminal-protocol.md)), chats in a chat host ([37](37-agent-chats.md)). Several UIs (the desktop app, a server's hub, development hubs) reach the same machine. Nothing listens on TCP there, ssh is the only way in, and herdr-core has no Windows build.

## Goals / non-goals

Goals: one program in two roles, a **node** (the machine's service, on a local socket) and a **UI** (serves the web UI, a client of nodes); a UI reaches its own machine's node as it reaches another's; several UIs share a node's terminals, workspaces and chats, as tmux clients share a server; upgrades never interrupt panes.

Non-goals: a node on Windows; sharing settings, machines or vault between UIs; a node reachable without ssh.

## Design

### Roles

One executable, the hub's, is also its platform's machine build ([42](42-typescript-backend.md#the-machine-side)): `serve` and `desktop` are UIs; `node` is the node; `node dial`, run by ssh, pipes stdin/stdout to the node's socket, starting the node when none answers; `chat-host` runs as a hidden terminal of the terminal core. Code: `backend/machine/node.ts`, `backend/hosts/machine/cli.ts`.

### The node

- **Socket**: `node.sock`, 0600 in the namespace's 0700 runtime directory ([40](40-shared-homes.md)); a peer of another uid is closed. A connection's first line (`agentproto.NodeHello`) names the client's wish (`serve`, `stop`, `takeover`), hub and build; `serve` then carries one yamux session of the agent protocol.
- **One per namespace and host** (`node.lock`), started in a session of its own when none answers (log `<data>/hosts/<host>/node.log`), ending shortly after its last client, on `node stop` or once taken over.
- **Terminals do not depend on it**: herdr-core runs as a service of its own, which the node starts and stops (op `hc`) but never links, so a node crash or upgrade ends no terminal and macOS privacy grants stay with herdr-core's executable ([16](16-desktop-packaging.md#full-disk-access-macos)).

### Several UIs

What concerns the machine runs once, in the node: one code-server (a UI's idle release stops it only while no other client uses it), history captures and AI usage fetches shared between the UIs' schedules, one window manager with one client in control ([14](14-gui-windows.md)). Settings, machines, vault and port forwards stay on each UI's host, and each UI enforces its own read-only mode. A vault request from the machine goes to every attached UI, and the first value one releases answers it ([30](30-variable-vault.md)); a VS Code bridge connection goes to the UI that last opened code-server.

### Namespaces

A node's namespace is the data directory and terminal core session (`~/.veldr`, `veldr-<host id>` by default). A hub's `--instance` also names its namespace on machines unless `--node-instance` says otherwise, keeping `dev` and `e2e-<random>` hubs apart from the user's. The desktop app is instance `desktop` in the default namespace, sharing terminals with a server's hubs; a `desktop` namespace left by earlier desktop builds is not touched, its terminal core running until stopped.

### Upgrades without interruption

A client compares builds (`newer` of agentproto). A node of its build or newer serves it, since the protocol only grows (AGENTS.md rule 7). An older node is taken over: the client starts `node --takeover`, the old node gives up socket, lock and code-server, tells its hubs to move (op `node.drain`) and ends once they left or the longest bounded request passed. A moved hub's streams reopen on the new session as after any lost stream, while the machine stays ready. Nodes of earlier releases are taken over the same way.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| The local agent in the hub's process | The machine's service would end with one UI. |
| herdr-core inside the node | A node crash or upgrade would end every terminal. |
| `ssh -L` forwarding of the node's socket | Often disabled; cannot start a node. |
| systemd or launchd units for the node | Takeover needs two nodes at once. |
| Vault values on the node | Values would leave the UI hosts where they were entered. |
| Restarting the node on upgrade | Every machine would show disconnected. |

## Failure modes

- **Node crash**: clients reconnect; terminals and chats keep running; the next node adopts or reaps its code-server.
- **No node starts**: the client points at `node.log`; a stale lock is taken.
- **Takeover fails**: the client uses whichever node serves, or the next client starts one.
- **Login session ended by the system** (`KillUserProcesses`): the node ends, the terminal core and chat host do not.

## Security

The node's socket admits only the user's processes (0600, 0700 directory, peer uid); nothing listens on TCP; ssh runs `node dial` with a fixed argument vector. Read-only mode and vault releases are each UI's own.

## Testing

`backend/machine/node.test.ts`, `vault.test.ts`; `backend/shared/proto/agentproto/agentproto.test.ts`; `e2e/tests/nodes.spec.ts` (two hubs sharing a node, a takeover while a terminal works on).
