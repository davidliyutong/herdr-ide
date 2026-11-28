# 40 · Homes several hosts share

## Context

A machine's state is in the user's home (`~/.veldr[-<instance>]`, [02](02-multi-machine-transport.md)), on clusters often one NFS export every node mounts; yet sockets, locks, pid files, running executables, SQLite's write-ahead log and herdr-core's session state are one host's.

## Goals / non-goals

Goals: hosts share one home without seeing each other's sockets, locks, processes, executables or terminal cores; a namespace's processes on a host find the same directories whatever their environment or host name; what a host leaves is bounded. Non-goals: sharing terminals or code-server between hosts.

## Design

`backend/shared/host/hostid.ts` names the host: `hostid.key` is its sanitized full name with 8 hex digits of a hash of its machine id, so two hosts of one name never share a key; `hostid.id` hashes the machine id alone and survives macOS renaming the host with the network. `backend/shared/host/hostdirs.ts` lays out the directories:

- **Runtime, host-local, 0700**: sockets, locks, pid files, the display's files, in `/run/user/<uid>/<data dir name without its dot>-<hash of its real path>` when that directory is the user's and private (looked up itself, not through `XDG_RUNTIME_DIR`, which non-login processes lack), else `<data>/run-<hostid.id>`, or under `/tmp` when socket paths would be too long.
- **This host's**, `<data>/hosts/<hostid.key>/`: the terminal core's executable, code-server's user data and extensions, logs, Xvfb packages.
- **Shared**, `<data>/`: databases named per host ([38](38-sqlite-state.md)), agent builds by content hash, code-server per version and platform, uploads with unique names, and the vault's MCP command `<data>/bin/veldr-mcp`, a script running the link for the host's `uname -s`/`uname -m`.

The terminal core's session is `veldr[-<instance>]-<hostid.id>`, so herdr-core's state and service are per host. Retention (`backend/machine/housekeeping.ts`): the agent touches its host's directory and build daily; another host's directory unused for 30 days loses its files except the terminal core's executable (a core may still run from it), and goes whole after 180 days.

## Alternatives considered

- **Detecting network filesystems (`statfs`)**: a probe that changes would move a running core's socket.
- **`/tmp/<slug>-<uid>` as the runtime directory**: periodic cleanups remove a lock there, letting two nodes run.
- **The host's name in runtime paths**: macOS changes it with the network.

## Failure modes

- **The machine id changes** (a cloned VM given a new one) → new directories and session; the old core runs on unseen until stopped.
- **Clones with one machine id and name** → they act as one host; give the clone a new id (`systemd-machine-id-setup`).
- **`/run/user/<uid>` removed** (a non-lingering user logs out) → the next node starts afresh.

## Security

The runtime directory is the user's and 0700, created or checked to be so, never a link. See [SECURITY.md](../../SECURITY.md).

## Testing

`backend/shared/host/hostdirs.test.ts`, `hostid.test.ts`; `backend/machine/housekeeping.test.ts`, `vault.test.ts`, `agent.test.ts`.
