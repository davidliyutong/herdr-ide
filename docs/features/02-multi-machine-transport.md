# 02 · Multi-machine transport

## Context

Machines are shared Linux or macOS hosts (amd64, arm64), sometimes with old userlands or no internet, reached over ssh with the user's own `~/.ssh/config`. The hub needs many concurrent channels per machine (terminals, files, program windows, code-server, the VS Code bridge) and also runs on Windows ([16](16-desktop-packaging.md)), whose OpenSSH has no ControlMaster.

## Goals / non-goals

Goals: the user's ssh setup unchanged; no listening ports and no runtime dependencies on machines; a bounded number of ssh sessions; the same code path for the local machine.

Non-goals: managing ssh keys; Windows machines; a local machine or an interactive ssh login on a Windows hub.

## Design

### Agent and connection

Each machine runs its platform's machine build, the hub's own executable, whose `node` command serves the agent protocol ([39](39-nodes.md), [42](42-typescript-backend.md#the-machine-side)). A build's version is its executable's digest, so hub and agent never disagree on the protocol; a node of an earlier release is taken over.

`dialSSH` (`backend/kernel/machines/transport/ssh.ts`) probes `uname` and `$HOME` through `/bin/sh -c`, installs the build under `~/.veldr/agent/` unless present (the machine downloads its release archive, else the hub uploads it, `release.ts`; checked against the release's `SHA256SUMS` before it is renamed into place), then runs `node dial`, which pipes ssh's stdin/stdout to the machine's node. One yamux session per machine carries every stream ([architecture](../architecture.md#hub--agent-protocol-backendsharedprotoagentproto)), avoiding `MaxSessions` and stream-local forwarding. Every ssh command puts `--` before the target.

### ssh login

ssh runs with `BatchMode=yes`, keepalives and a ControlMaster in a private per-instance directory under `/tmp` (`controldir.ts`). An interactive login (password, 2FA, host key) done once in the UI's authentication terminal (`GET /api/m/{id}/auth`, `ssh -t` in a PTY on the hub host) is reused by the BatchMode connections. Windows has no ControlMaster, so a Windows hub offers no login terminal (`ssh_login: false`, `501 ssh_login_unsupported`) and needs keys in the ssh agent and accepted host keys.

### Local machine

`dialNode` (`backend/kernel/machines/transport/local.ts`) reaches the local node through its socket, starting it from the build the hub installs where an upload would put it. A Windows hub has no local agent (`LOCAL_SUPPORTED`): its local machine shows `local_unsupported`; WSL is added as an SSH machine. Paths on machines are POSIX (`node:path`'s `posix`).

### Machine states

`backend/kernel/machines/machine.ts`: *disabled*; *connecting*, with the deploy step (`probe`, `download`, `upload`, `install`, `start`) shown in the UI; *auth_required*; *error* with ssh's message and, when the build cannot be deployed, a `failure` code ([42](42-typescript-backend.md#the-machine-side)); *ready* once the agent answers `hello`. Failures retry with randomized exponential backoff; an ssh timeout waits for a manual **Retry**, except for a few minutes after the machine was ready (a rebooting host). Read-only browsers cannot retry, since an attempt may start an ssh login.

### Machines

The local machine, the stored SSH machines and this run's `--ssh` targets (`--local-only`, `--machine` select among them; `selectSpecs` in `backend/hosts/common/compose.ts`). They are stored in `machines[-<instance>].json` ([reference](../reference.md#files-and-directories), `backend/kernel/machines/registry.ts`): random ids (they appear in URLs and settings), written whole and atomically after every change, unknown fields kept, not re-read while the hub runs; a file that is not a machines file is left alone.

The UI adds (suggesting the hub host's ssh aliases with only their `HostName` and `User`, `sshconfig.ts`), orders, renames (unique labels), removes (nothing on the machine is touched), enables and disables machines, refused read-only and audited (`backend/features/machines/hub.ts`).

`validTarget` (`backend/kernel/machines/spec.ts`) accepts OpenSSH destinations and refuses a leading `-`, whitespace and control characters, shell metacharacters that a user's `ProxyCommand` or `Match exec` would expand, and more than 255 bytes; the web UI checks with the same vectors (`spec/vectors/machines/targets.json`). A refused stored target is shown in *error* and never dialed; `--ssh` with one stops the hub.

### Terminal core and instances

Connecting starts only the node. The first `/api/v1/term` subscription installs this build's herdr-core where it differs and starts it detached from the agent ([21](21-terminal-core.md), [22](22-terminal-protocol.md); `backend/features/terminals/lifecycle.ts`); a read-only hub installs and starts nothing. The machine's menu starts, restarts or stops it.

`--instance` gives a hub its own files and, unless `--node-instance` says otherwise, its own namespace on machines, so daily and development hubs share machines safely ([39](39-nodes.md#namespaces), [40](40-shared-homes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| ssh unix-socket forwarding | One ssh session per stream; needs stream-local forwarding. |
| One ssh exec per request | A remote process per call, no streaming. |
| A helper in Node or Python | Not on every machine. |
| An ssh library instead of OpenSSH | Would not honour the user's ssh config. |
| Starting the terminal core on connect | Unused machines would get a process outliving the hub. |

## Failure modes

- **Authentication needed**: *auth_required* with the authentication terminal (on Windows, instructions and **Retry**).
- **Network loss**: the yamux keepalive ends the session and the hub reconnects; a control master that died silently is stopped (`ssh -O stop`) so the next attempt does not hang.
- **Terminal core unreachable**: the machine stays *ready* with an `hc` error code; the hub retries and the menu offers start or restart.
- **Undeployable build**: *error* with its `failure` code, which the UI explains.
- **Hijacked control directory**: refused unless owned by the user with no group or other access ([08](08-web-access-and-security.md)).

## Testing

- `backend/kernel/machines/transport/` (`transport.test.ts`, `deploy.test.ts`, `release.test.ts`): ssh arguments, error classification, control directory, deployment over ssh and locally.
- `backend/kernel/machines/machines.test.ts`, `backend/features/machines/hub.test.ts`, `sshconfig.test.ts`: the machines file, targets from the shared vectors, the endpoints and their guards.
- `backend/machine/agent.test.ts`, `backend/features/terminals/terminals.test.ts`: the terminal core's lifecycle.
- `make e2e` (`e2e/tests/ssh.spec.ts`): an OpenSSH container added from the dialog, dropping and coming back, nothing of the instance left after it stops.
