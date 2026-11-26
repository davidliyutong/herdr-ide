# 40 · Homes several hosts share

## Context

A machine's state is in the user's home (`~/.veldr[-<instance>]`, [02](02-multi-machine-transport.md)). On clusters the home is often one NFS export that every node mounts, so several machines of the UI write the same directory. What a process of one host keeps there must not be read or replaced by another host's:

- a unix socket or a lock is the host's: another host cannot connect to the socket, and NFS may share a lock across hosts (one host's node would think another host's serves it) or not (two nodes take one socket path);
- a pid file names a process of the host that wrote it; another host would signal an unrelated process of the same number;
- an executable replaced on NFS while another host runs it ends that process (the other host has no open reference to keep the old file); hosts of other architectures need other executables;
- SQLite's write-ahead log needs every connection of a database on one host;
- herdr-core keeps a session's state in `~/.local/state/herdr-core/<session>`, so two hosts' cores of one session would write one state.

## Goals / non-goals

Goals: any number of hosts use one home at once without seeing each other's sockets, locks, processes, executables or terminal cores; every process of a namespace on a host finds the same directories, whatever its environment or the host's name; a host's files left behind on a shared home are bounded.

Non-goals: sharing a namespace's terminals or code-server between hosts (each host is its own machine in the UI); network filesystems' own failures.

## Design

`backend/shared/host/hostdirs.ts` lays out a namespace's directories on a host; `backend/shared/host/hostid.ts` names the host.

**Host names.** `hostid.key` is the host's whole name, sanitized, and 8 hex digits of a hash of its machine id (`/etc/machine-id`, macOS's platform UUID), so two hosts of one name never share a key. `hostid.id` is the hash alone (the name without an id): it stays when macOS renames the host with the network, and names what a host must find again.

**Three kinds of files.**

| Kind | Where | What |
| --- | --- | --- |
| Runtime, host-local, private | `/run/user/<uid>/<data dir name without its dot>-<hash>` when the system has that directory (the user's, 0700; tmpfs per host); else `<data>/run-<hostid.id>` | sockets (node, terminal core and its holders, code-server, vault, bridge, chat host), locks, `cs.pid`, the display's state and X authority |
| Persistent, this host's | `<data>/hosts/<hostid.key>/` | the terminal core's executable, code-server's user data and extensions, logs of node, code-server and displays; in `~/.veldr/hosts/<hostid.key>/xvfb/`, Xvfb packages for the host's instances |
| Shared | `<data>/` and `~/.veldr/` | databases named per host ([38](38-sqlite-state.md)), agent builds by content hash, code-server per version, system and architecture, uploads with unique names, the vault's MCP command |

The runtime directory's name carries a hash of the data directory's real path, so another home (a test's `HOME`) never meets it. `/run/user/<uid>` is looked for itself, not through `XDG_RUNTIME_DIR`, which processes not started by a login lack; it must be the user's and private, or the data directory's is used. If those paths would exceed the Unix socket address limit, the instance uses a short, private 0700 directory directly below `/tmp` keyed by the user, host and data directory. A lingering user keeps `/run/user/<uid>` as long as the terminal core's service runs.

**The terminal core's session** is `veldr[-<instance>]-<hostid.id>`: herdr-core's state directory and service are per host.

**The vault's MCP command** (`<data>/bin/veldr-mcp`, named by agents' configurations, which a shared home shares) is a shell script that runs the link of the host's `uname -s` and `uname -m` beside it, each link pointing at that platform's agent build.

**Retention.** The agent touches its host's directory and its build at start and every 24 h. Another host's directory unused for 30 days loses its files except the terminal core's executable, which a terminal core that ran without any agent since may still run from; it goes whole after 180 days.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Detecting network filesystems (`statfs`) and separating only there | A probe that fails or changes would move a running terminal core's socket; one layout for every host has nothing to detect. |
| `/tmp/<slug>-<uid>` as the runtime directory | `systemd-tmpfiles` and macOS's periodic cleanup remove old files there, a lock among them, which would let two nodes run. |
| `XDG_RUNTIME_DIR` | Not set for every process that needs the directory (services, ssh commands without PAM); the same path is taken from its fixed place. |
| Setting `XDG_STATE_HOME` for herdr-core | Its programs would inherit it. |
| Content-addressed terminal core executables shared by hosts | Which host still runs one is not known on the others; per host costs a few MB each. |
| The host's name in runtime paths | macOS changes it with the network; the terminal core's socket would be lost while it runs. |

## Failure modes

- **The machine id changes** (a cloned VM given a new one): the host gets new directories and session; its old terminal core runs on unseen until stopped, and its files go by retention.
- **Two hosts with one machine id and name** (clones): they share everything as one host would; give the clone a new id (`systemd-machine-id-setup`).
- **A machine used by a build before this layout**: that build's terminal core (session `veldr[-<instance>]`, socket `<data>/run/hc.sock`) and its terminals run on unseen until stopped (`HC_SESSION=… HC_SOCKET=… <data>/hc/herdr-core server stop`); its files in `<data>` (`run/`, `hc/`, `cs-data/`, `cs-ext/`, logs) stay until removed by hand, and VS Code starts with new user data.
- **`/run/user/<uid>` removed while programs run** (a user who does not linger logs out; systemd stops the user's services with it): the next node starts afresh.

## Security

The runtime directory is the user's and 0700, created or checked to be so, never a link; inside `/run/user/<uid>` it shares that directory's protection. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/shared/host/hostdirs.test.ts`: the runtime directory (in `/run/user` or the data directory, homes apart, links resolved), making the directories.
- `backend/shared/host/hostid.test.ts`: the host's key and id, its machine id.
- `backend/machine/housekeeping.test.ts`, `vault.test.ts`, `agent.test.ts`: other hosts' directories pruned, the MCP link replaced, the terminal core's session and socket.
