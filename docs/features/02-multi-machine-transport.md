# 02 · Multi-machine transport

## Context

The user's machines are reached over ssh with their own `~/.ssh/config` (aliases, ProxyJump, agent forwarding). They are shared multi-user hosts (lab workstations, GPU servers, robots) running Linux or macOS on amd64 or arm64, sometimes with old userlands or without internet access.

The hub needs many concurrent channels per machine: the terminal core's API and streams ([21](21-terminal-core.md)), agent detection, files, uploads, program windows, the code-server proxy and the VS Code extension's bridge. The hub runs on Linux and macOS and, in the desktop app ([16](16-desktop-packaging.md)), on Windows, whose OpenSSH has no ControlMaster.

## Goals / non-goals

Goals:

- reuse the user's ssh setup unchanged;
- no listening ports on machines;
- no runtime dependencies on machines (no Node, Python or specific glibc);
- a bounded number of ssh sessions;
- the same code path for the local machine.

Non-goals: managing ssh keys; Windows machines; a local machine on a Windows hub host; the interactive ssh login from a hub on Windows.

## Design

### Agent

The agent is served by each machine's node, the command `node` of the machine build ([39](39-nodes.md)): the hub's own executable of the machine's platform, the hub and the TypeScript machine side ([42](42-typescript-backend.md#the-machine-side)), for linux (glibc and musl) and darwin × amd64/arm64. The hub carries its own platform's; a machine gets its platform's from the hub's release, checked against the release's `SHA256SUMS`: it downloads the archive, else the hub uploads it (`backend/kernel/machines/transport/release.ts`). Its version is its executable's digest, so a changed build is always installed again and hub and agent never disagree on the protocol. Machines running an earlier release's node get this build and its node takes over ([39](39-nodes.md)).

The agent runs on Linux and macOS only (unix sockets with peer checks, process groups, code-server and Xvfb are POSIX). Hub and agent speak the protocol of `backend/shared/proto` (agentproto, and yamux with its window, keepalive and backlog, [42](42-typescript-backend.md)).

### Connect

`backend/kernel/machines/transport/ssh.ts` (`dialSSH`):

1. probe `uname -s`, `uname -m` and `$HOME` through `/bin/sh -c` (works with any login shell);
2. if `~/.veldr/agent/<hash>/veldr` is missing, install it: the machine downloads its platform's archive, else the hub uploads it, written to a temporary name and renamed atomically once its SHA-256 is the release's ([42](42-typescript-backend.md#the-machine-side)); builds unused for 14 days are removed in the same step;
3. `exec` it with `node dial --instance NAME` and speak yamux over the ssh session's stdin/stdout: `node dial` pipes them to the socket of the machine's node, which it starts when none answers (or one that takes over from an older build's, [39](39-nodes.md)), and passes on the session's `SSH_CONNECTION`.

One yamux session per machine carries every stream; each stream starts with a JSON header and reply ([architecture](../architecture.md#hub--agent-protocol-backendsharedprotoagentproto)). This avoids sshd's `MaxSessions` and any dependence on `AllowStreamLocalForwarding`. Every ssh command puts `--` before the target.

Concurrent deployments share manifest verification and in-flight archive loads. Each caller can stop waiting for the manifest independently, and verified archives are reused from the disk cache after the load completes. Failed dials and short-lived sessions retry with increasing, randomized delays.

### ssh options and login

`sshArgs` uses `BatchMode=yes`, keepalives (`ServerAliveInterval=15`, `ServerAliveCountMax=4`) and a ControlMaster (`ControlPersist=600`) in a private control directory `/tmp/veldr-<uid>/s`, one per instance (`s-<instance>`, a hash for names over 16 characters; `controldir.ts`).

The master exists so that an interactive login (password, 2FA, host key) done once is reused by the BatchMode connections. The UI's authentication terminal (`GET /api/m/{id}/auth`, WebSocket) runs `ssh -t` with `BatchMode=no` and the same control path in a PTY on the hub host; when it closes, the machine tries again at once.

On Windows, Win32-OpenSSH cannot share connections, so the control directory is empty (`controlDir`): no `Control*` option is passed and every connection authenticates by itself. A login typed in a terminal would hold nothing for later connections, so the hub offers none (`ssh_login: false` in `GET /api/config`, `501 ssh_login_unsupported` from the auth endpoint), and the UI explains how to set up key authentication instead. SSH machines of a hub on Windows therefore need a key the ssh agent holds (or one without a passphrase) and an accepted host key.

### Local machine

`dialNode` (`transport/local.ts`, Linux and macOS) connects to the local machine's node through its socket, starting it when none answers from this platform's machine build, which the hub installs where an upload would put it (`~/.veldr/agent/<hash>/veldr`): identical protocol, no ssh. The hub's tests use an agent in memory (`backend/kernel/testing.ts`, `backend/machine/testing.ts`).

A hub on Windows has no local agent (`LOCAL_SUPPORTED` in `transport/local.ts`): its local machine is listed in *error* with `local_unsupported` and never dialed. WSL is not built in; a WSL distribution with an ssh server is added as an SSH machine.

Paths on machines are POSIX, so the hub handles them with `node:path`'s `posix`, also on Windows.

### Machine states

`backend/kernel/machines/machine.ts` runs one `Machine` per machine:

- *disabled* until enabled;
- *connecting* while it dials, with `deploy`, what the dial is doing: `probe`, `download` (the machine fetches its build), `upload` (`sent` of `total` bytes ssh has read from the hub), `install` (the machine checks and unpacks the upload), `start` (its node); a new step is published at once, an upload's bytes at most every 250 ms (`DEPLOY_PUBLISH_MS`), and the field is gone once the machine leaves *connecting*. The sidebar and the machine's settings show the step and a bar, filled by an upload, moving otherwise;
- *auth_required* when the dial needs a login (retried periodically);
- *error* on any other failure, with ssh's message (retried with exponential backoff, except ssh timeouts, which wait for a manual **Retry**);
- *ready* once its agent answers `hello`, whose reply carries the host's platform and directories.

A session that ends turns *error* and reconnects, with the backoff reset after a stable session. The authentication terminal closing and **Retry** end a wait at once; ssh timeouts do not auto-retry and wait for **Retry** (with a quick **Disable** button beside it in the sidebar). Read-only browsers cannot retry, since an attempt may start an ssh login. Every state change goes to every `/ws` client. Browser event, terminal, chat and GUI channels retry with jittered backoff and reset their delay after a connection stays open for 30 s. The browser's event channel keeps at most 256 messages or 256 Ki UTF-16 code units while disconnected, dropping the oldest messages when it reaches either bound.

### The machines file

`backend/kernel/machines/registry.ts`. The machines are the local machine (always first), the stored SSH machines and the `--ssh` targets of this run. They are stored in `machines[-<instance>].json` beside the settings ([reference](../reference.md#files-and-directories)):

```json
{
  "version": 1,
  "machines": [
    { "id": "3f9c0a1b2c3d4e5f", "label": "gpu", "kind": "ssh", "target": "gpu-host", "enabled": true },
    { "id": "local", "label": "", "kind": "local", "enabled": false }
  ]
}
```

Key rules:

- Ids are random, never derived from the target, since they appear in URLs and per-machine settings.
- The file is read at start and written whole (atomically, 0600) after every change; a change that cannot be written is refused.
- Entries and fields this version does not understand are kept as written.
- A stored target the hub refuses (below) is listed in *error* with `invalid_target` and never dialed; it can be renamed or removed.
- The file is not re-read while the hub runs; edit it while it is stopped.

Without the file there are no stored machines yet; nothing is written until the first change. A file that is not a machines file (no `version` or `machines`) is an error: the hub keeps its machines in memory and leaves the file alone.

### Choosing machines for a run

`backend/hosts/bun/serve.ts` (`selectSpecs`):

- `--ssh TARGET` (repeatable) adds a machine for this run only, not stored;
- `--local-only` connects the local machine and the `--ssh` targets;
- `--machine NAME` (repeatable) connects only the machines named by id, label or target.

### Managing machines from the UI

- **Add Machine…** (`POST /api/machines {target, label}`). The dialog suggests the Host aliases of the hub host's ssh configuration that are not machines yet (`GET /api/ssh/hosts`, `backend/features/machines/sshconfig.ts`). The parser follows `Include` and keeps only concrete aliases with their `HostName` and `User`; no other option (keys, proxies, commands) leaves the hub. Reading is bounded in file size, count and include depth. A machine that needs a login turns *auth_required* and the page opens the authentication terminal where the hub offers one.
- **Ordering** by dragging or **Move Up/Down** (`PUT /api/machines/order`), stored as the file's `order`.
- **Rename** (`PUT /api/m/{id}/label`); labels are unique (`label_taken`) because `--machine` selects by label.
- **Remove** (`DELETE /api/m/{id}`) deletes the record and ends the session. Nothing on the machine is removed; its terminal core keeps running. The local machine cannot be removed.
- **Enable/disable** (`PUT /api/m/{id}/enabled`). Disabling ends the session (the agent exits and stops its code-server; programs keep running in the terminal core). For a ready machine the confirmation offers to stop its terminal core too; already-offline machines disable directly without confirmation.

All of these are refused for read-only browsers and audited (`machine.add`, `machine.rename`, `machine.remove`, `machine.enable`, `machine.disable`, `machine.order`).

### Target validation

`validTarget` (`backend/kernel/machines/spec.ts`) accepts what OpenSSH takes as a destination (`[user@]host`, `ssh://[user@]host[:port]`, aliases, IPv6 literals with zone ids, Unicode names) and refuses:

- a leading `-` (ssh would read an option);
- whitespace, control and format characters;
- shell metacharacters (``! " $ & ' ( ) * ; < > ? \ ` { | }``), which a user's `ProxyCommand` or `Match exec` would expand through `%h`, `%r` or `%n`;
- more than 255 bytes.

This follows OpenSSH's own check of command-line destinations (9.6 and later) and adds a few characters ssh passes on. The web UI checks typed targets with the same vectors (`spec/vectors/machines/targets.json`). A refused target answers `invalid_target`; `--ssh` with one stops the hub.

### The terminal core of each machine

`backend/features/terminals/backend.ts` and `lifecycle.ts`, `backend/machine/hc.ts` ([21](21-terminal-core.md)). Connecting a machine starts only its agent. When the first client of `/api/v1/term` subscribes to a machine's terminals ([22](22-terminal-protocol.md)), the hub:

1. asks the agent for the terminal core's status (op `hc`);
2. installs this build's herdr-core (`backend/scripts/hcdist.ts`) when the installed one differs, from the copy the node's executable carries (`hc`'s `install-embedded`); the agent checks the digest and swaps it into `~/.veldr[-<instance>]/hosts/<host>/hc/`, and a running terminal core of another build is restarted, its successor adopting the programs;
3. starts a terminal core if none runs (session `veldr[-<instance>]-<host id>`, detached from the agent so its programs outlive it);
4. connects (op `hc-api`) and subscribes to its events.

A read-only hub installs and starts nothing. The connection closes shortly after the last client leaves and is retried with backoff while it fails. The machine's state carries `hc {state, code, version}`, and while the connection lasts the agent reports coding agents in the terminals ([25](25-agent-detection.md)).

The machine's menu reports (`GET /api/m/{id}/hc`) and starts, restarts or stops (`POST /api/m/{id}/hc/{start|stop|restart}`) the terminal core. Stop ends every terminal and keeps the terminal core stopped until started again or subscribed to anew. Refused read-only, audited ([deployment](../deployment.md#remote-resources)).

### Instances

`--instance NAME` makes agents use `~/.veldr-NAME` (sockets, uploads, the terminal core and its session `veldr-NAME-<host id>`, code-server's data) and the hub its own settings, keybindings and machines files, so a daily and a development hub can share machines safely. Agent builds, code-server releases, Xvfb packages and video encoders are shared between instances. A home several hosts share keeps each host's sockets, executables and terminal core apart ([40](40-shared-homes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ssh -L`/`-R` unix-socket forwarding over a ControlMaster | One ssh session per stream (`MaxSessions`); needs stream-local forwarding; stale remote sockets. |
| One ssh exec per request | One remote process per call, and no streaming of terminals, files or code-server. |
| Helper written in Node or Python | Not on every machine; glibc and version constraints. |
| An ssh library (Node's `ssh2`, Go's `x/crypto/ssh`) instead of OpenSSH | Would not honour the user's ssh config (ProxyJump, Match, agents, certificates). |
| Ids derived from the target | Ids appear in URLs and settings; random ids keep the target out. |
| Starting the terminal core when a machine connects | Unused machines would get a process outliving the hub; the first subscription starts it. |
| A hub in Go | The hub is TypeScript, one Bun executable per platform ([42](42-typescript-backend.md)): one language with the UI and the desktop shell, and the SDKs the coding agents publish. |

## Failure modes

- **Authentication needed** → ssh's stderr classified as auth → *auth_required* with an authentication terminal (on Windows, instructions and **Retry**).
- **Network loss** → yamux keepalive ends the session on both sides; the agent exits and releases what it owns ([10](10-remote-resource-lifecycle.md)); the hub reconnects. If ssh is still running shortly after yamux gave up, or a probe through the master times out, the control master died silently (network change, sleep): the hub runs `ssh -O stop` so the next attempt opens a new master instead of hanging. A new password or 2FA login is then needed.
- **Terminal core unreachable** → the machine stays *ready*; its `hc` state is `error` with a code (`not_bundled`, `install_failed`, `start_failed`, `connect_failed`, `stopped`, …); the hub retries and the menu offers start or restart.
- **Unreachable machine added** → stored, shown in *error* with ssh's message; ssh timeouts wait for manual **Retry** (with quick **Disable** beside it), while other errors retry with backoff.
- **Machines file damaged** → logged; the hub runs with the local machine and `--ssh` targets, keeps changes in memory and leaves the file alone.
- **Refused stored target** → *error* with `invalid_target`, never dialed; rename, remove or fix the file while the hub is stopped.
- **Writing the file fails** → the change is refused with `save`.
- **Unsupported platform** → no embedded agent for the `uname` pair; the machine shows the error. A machine its build cannot be deployed to carries the failure's code as `failure` beside the error (`platform_unsupported`, `cpu_unsupported`, `libs_missing`, `build_unavailable`: [42](42-typescript-backend.md)), which the UI explains; it is dialed again with backoff.
- **Hijacked control directory** → refused unless it is a real directory owned by the user with no group/other access ([08](08-web-access-and-security.md)).

## Testing

- `backend/machine/agent.test.ts`, `fsops.test.ts`: the agent over the tests' in-process transport, file ops, dial restrictions.
- `backend/machine/node.test.ts`: the node's socket, several clients, one node per build, idle end, stop, retiring when its executable is gone.
- `backend/kernel/machines/transport/transport.test.ts`: error classification, arch normalization, quoting, the target after `--`, the control directory checks, no `Control*` options without it, stopping the master only while ssh stays up.
- `backend/kernel/machines/transport/deploy.test.ts`: the machine build over ssh (download, upload, bounds, failures) and the local node started from the hub's own executable.
- `backend/kernel/payloads.test.ts`: the release the build records, the machine build of each platform from it.
- `backend/kernel/machines/machines.test.ts`: no file, the file's round trip and errors, ordering, target validation from the shared vectors, refused targets never dialed, the local machine without an agent, adding, removing, enabling and disabling at runtime.
- `backend/features/machines/hub.test.ts`: the HTTP endpoints (adding, renaming, ordering, removing, enabling), read-only and audit, `ssh_login` without a control directory, the ssh aliases offered (`ssh hosts`).
- `backend/features/machines/sshconfig.test.ts`: the config parser and its bounds.
- `backend/features/terminals/terminals.test.ts` (`installs and starts the build’s terminal core`, `the terminal core’s lifecycle from the UI`, `without a terminal core`, `routes that change state are guarded`) and `backend/machine/agent.test.ts`: install, start, stop and restart of the terminal core, its endpoints' guards.
- Web: `menus.test.ts`, `sidebarMachines.test.ts`, `addMachine.test.ts`, `addMachineHosts.test.ts`, `codePanes.test.ts` in `web/src/__tests__`.
- CI runs the hub's tests on Linux and macOS.
- `make it` (`backend/machine/integration.test.ts`, `backend/features/terminals/integration.test.ts`) with the real herdr-core.
- `make e2e` (`e2e/tests/ssh.spec.ts`, with Docker): a container running OpenSSH added from the dialog, its terminal and files, the machine dropping and coming back with its terminal core, a chat there, and nothing of the instance left on it once the terminal core and the hub stop.

Verified manually against eight Ubuntu x86_64 hosts and an arm64 Ubuntu VM.
