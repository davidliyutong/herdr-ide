# 10 · Remote resource lifecycle

## Context

herdr-ide starts processes and writes files on shared machines that it does
not otherwise manage. Several cores may connect to the same machine, agents
can be killed abruptly, browsers keep hidden iframes open, and code-server
holds hundreds of megabytes per instance. Left alone, this exhausts memory
and disk on machines the user shares with others.

## Goals / non-goals

Goals: every process has an owner and an end; every file has a retention
rule; nothing depends on the core shutting down cleanly; two cores never
destroy each other's state.

Non-goals: CPU or memory quotas; managing processes started by herdr panes.

## Design

**Processes**

| Process | Owner | Ends when |
| --- | --- | --- |
| agent | its ssh session | stdin closes, or yamux keepalive (15 s interval, 30 s timeout) fails |
| `herdr terminal session` | the agent's stream | the pane stops being displayed (stdin closed → herdr releases control), or the agent exits (process group killed) |
| code-server | the agent recorded in `run/cs.pid` | idle for `--code-server-idle` (default 20 min, counted by the core's proxy: no WebSocket open), the owning agent exits, the user presses stop, or 1 h without connections (code-server's own `--idle-timeout-seconds`) |
| VS Code extension host | code-server | 5 min after its window disconnects (`--reconnection-grace-time`) |
| curl / wget (machine downloads) | the agent's `download` request | the download finishes, fails, or runs 20 min |
| ssh ControlMaster | OpenSSH | 10 min unused (`ControlPersist`) |

- **Ownership** (`internal/agent/codeserver.go`): `cs.pid` holds the process
  id and the owning agent's pid. An agent stops only the process it owns on
  exit, adopts a running process whose owner died, and a new agent stops any
  orphan whose owner is gone at startup.
- **Hidden panels**: the UI unmounts a VS Code iframe hidden for 10 min,
  closing its WebSocket so the idle timer can run
  (`web/src/components/Dock.tsx`).

**Files**

| Path | Retention |
| --- | --- |
| `uploads/` | 7 days (pruned at agent start) |
| `cs-data/logs/` | 7 days |
| `agent/<build>/` | removed after 14 days unused; running agents touch their directory |
| `code-server/<version>/` | removed after 14 days unused; touched on start |
| `code-server/.download-*`, `.install-*` | removed when the download or install ends; left by a killed agent, removed with unused versions after 14 days |
| download cache (core host) | kept; legacy caches after renames are removed |
| settings file (core host) | one file per instance, replaced on change |

Directories are per instance except `agent/` and `code-server/`, which are
shared and therefore never deleted while recently used.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Delete other versions immediately | Two cores with different builds or code-server versions would delete each other's files on every connect. |
| One code-server per browser window | Multiplies memory use. |
| Keep code-server until the agent exits | Agents live as long as the core is connected, often days. |
| Rely on the core's clean shutdown | Cores crash, laptops sleep, networks drop. |

## Failure modes

- **Agent killed with SIGKILL** → its code-server survives until the next
  agent reaps it or its own 1 h idle timeout.
- **Core stopped** → remote agents end with their ssh sessions; the local
  agent runs inside the core, so the core waits (up to 15 s) for it to stop
  the code-server it started before exiting.
- **A code-server nobody tracks answers on the socket** (pid file lost, data
  directory moved under it) → replaced when VS Code is next opened
  ([05](05-vscode-panel.md)).
- **Two cores, same instance** → one code-server; either core's idle stop
  affects both, and the other restarts it on its next request.

## Testing

`internal/agent/lifecycle_test.go` (orphan reaping, owner-only stop on exit,
upload pruning, legacy directory migration),
`internal/server/server_test.go` (idle detection with open connections and
grace for untracked machines). Stop and pid-file cleanup were verified on a
live instance.
