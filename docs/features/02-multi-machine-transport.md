# 02 · Multi-machine transport

## Context

The user's machines are reached over ssh with their own `~/.ssh/config`
(aliases, ProxyJump, agent forwarding). They are shared multi-user hosts
(lab workstations, GPU servers, robots) running Linux or macOS on amd64 or
arm64, sometimes with old userlands or without internet access.

The core needs many concurrent channels per machine: the terminal core's API
and streams ([21](21-terminal-core.md)), agent detection, files, uploads,
program windows, the code-server proxy and the VS Code extension's bridge.
The core runs on Linux and macOS and, in the desktop app
([16](16-desktop-packaging.md)), on Windows, whose OpenSSH has no
ControlMaster.

## Goals / non-goals

Goals:

- reuse the user's ssh setup unchanged;
- no listening ports on machines;
- no runtime dependencies on machines (no Node, Python or specific glibc);
- a bounded number of ssh sessions;
- the same code path for the local machine.

Non-goals: managing ssh keys; Windows machines; a local machine on a
Windows core host; the interactive ssh login from a core on Windows.

## Design

### Agent

The agent is served by each machine's node, the command `node` of the one
binary (`cmd/veldr`, [39](39-nodes.md)). The
core carries it for machines as the same program built with the tag
`machine`: a static Go binary (`CGO_ENABLED=0`) for linux/darwin ×
amd64/arm64 without the server, the UI and the embedded payloads, embedded
gzipped in the core (`internal/embedded`). Its version is its content hash,
so a changed build is always re-uploaded and core and agent never disagree
on the protocol.

The agent is `//go:build unix` (unix sockets with peer checks, process
groups, code-server and Xvfb are POSIX). What both ends need, such as the
yamux configuration (`agentproto.YamuxConfig`), lives in
`internal/agentproto` so the core builds without the agent.

### Connect

`internal/transport/ssh.go` (`DialSSH`):

1. probe `uname -s`, `uname -m` and `$HOME` through `/bin/sh -c` (works with
   any login shell);
2. if `~/.veldr/agent/<hash>/veldr` is missing, upload it with
   `cat >` to a temporary name and rename it atomically; builds unused for
   14 days are removed in the same step;
3. `exec` it with `node dial --instance NAME` and speak yamux over the ssh
   session's stdin/stdout: `node dial` pipes them to the socket of the
   machine's node, which it starts when none answers (or one that takes
   over from an older build's, [39](39-nodes.md)), and
   passes on the session's `SSH_CONNECTION`.

One yamux session per machine carries every stream; each stream starts with
a JSON header and reply
([architecture](../architecture.md#core--agent-protocol-internalagentproto)).
This avoids sshd's `MaxSessions` and any dependence on
`AllowStreamLocalForwarding`. Every ssh command puts `--` before the target.

### ssh options and login

`SSHArgs` uses `BatchMode=yes`, keepalives (`ServerAliveInterval=15`,
`ServerAliveCountMax=4`) and a ControlMaster (`ControlPersist=600`) in a
private control directory `/tmp/veldr-<uid>/s`, one per instance
(`s-<instance>`, a hash for names over 16 characters).

The master exists so that an interactive login (password, 2FA, host key)
done once is reused by the BatchMode connections. The UI's authentication
terminal (`GET /api/m/{id}/auth`, WebSocket) runs `ssh -t` with
`BatchMode=no` and the same control path in a PTY on the core host; when it
closes, the machine tries again at once.

On Windows, Win32-OpenSSH cannot share connections, so the control directory
is empty (`sys_windows.go`): no `Control*` option is passed and every
connection authenticates by itself. A login typed in a terminal would hold
nothing for later connections, so the core offers none (`ssh_login: false`
in `GET /api/config`, `501 ssh_login_unsupported` from the auth endpoint),
and the UI explains how to set up key authentication instead. SSH machines
of a core on Windows therefore need a key the ssh agent holds (or one without
a passphrase) and an accepted host key.

### Local machine

`transport.DialNode` (`local.go`, unix) connects to the local machine's
node through its socket, starting it from the core's own executable when
none answers: identical protocol, no ssh. `transport.DialLocal` runs an
agent in the tests' process over a socketpair.

A core on Windows has no local agent (`cmd/veldr/local_windows.go`): its
local machine is listed in *error* with `local_unsupported` and never
dialed. WSL is not built in; a WSL distribution with an ssh server is added
as an SSH machine.

Paths on machines are POSIX, so the core handles them with Go's `path`, not
`filepath`, also on Windows.

### Machine states

`internal/machines/machine.go` runs one `Machine` per machine:

- *disabled* until enabled;
- *connecting* while it dials;
- *auth_required* when the dial needs a login (retried periodically);
- *error* on any other failure, with ssh's message (retried with
  exponential backoff);
- *ready* once its agent answers `hello`, whose reply carries the host's
  platform and directories.

A session that ends turns *error* and reconnects with the backoff reset.
The authentication terminal closing and **Retry** end a wait at once.
Read-only browsers cannot retry, since an attempt may start an ssh login.
Every state change goes to every `/ws` client.

### The machines file

`internal/machines/registry.go`. The machines are the local machine (always
first), the stored SSH machines and the `--ssh` targets of this run. They
are stored in `machines[-<instance>].json` beside the settings
([reference](../reference.md#files-and-directories)):

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

- Ids are random, never derived from the target, since they appear in URLs
  and per-machine settings.
- The file is read at start and written whole (atomically, 0600) after every
  change; a change that cannot be written is refused.
- Entries and fields this version does not understand are kept as written.
- A stored target the core refuses (below) is listed in *error* with
  `invalid_target` and never dialed; it can be renamed or removed.
- The file is not re-read while the core runs; edit it while it is stopped.

Without the file there are no stored machines yet; nothing is written
until the first change. A file that is not a machines file (no `version`
or `machines`) is an error: the core keeps its machines in memory and
leaves the file alone.

### Choosing machines for a run

`cmd/veldr` (`selectSpecs`):

- `--ssh TARGET` (repeatable) adds a machine for this run only, not stored;
- `--local-only` connects the local machine and the `--ssh` targets;
- `--machine NAME` (repeatable) connects only the machines named by id,
  label or target.

### Managing machines from the UI

- **Add machine…** (`POST /api/machines {target, label}`). The dialog
  suggests the Host aliases of the core host's ssh configuration that are
  not machines yet (`GET /api/ssh/hosts`, `internal/sshconfig`). The parser
  follows `Include` and keeps only concrete aliases with their `HostName`
  and `User`; no other option (keys, proxies, commands) leaves the core.
  Reading is bounded in file size, count and include depth. A machine that
  needs a login turns *auth_required* and the page opens the
  authentication terminal where the core offers one.
- **Ordering** by dragging or **Move Up/Down** (`PUT /api/machines/order`),
  stored as the file's `order`.
- **Rename** (`PUT /api/m/{id}/label`); labels are unique (`label_taken`)
  because `--machine` selects by label.
- **Remove** (`DELETE /api/m/{id}`) deletes the record and ends the session.
  Nothing on the machine is removed; its terminal core keeps running. The
  local machine cannot be removed.
- **Enable/disable** (`PUT /api/m/{id}/enabled`). Disabling ends the session
  (the agent exits and stops its code-server; programs keep running in the
  terminal core). For a ready machine the confirmation offers to stop its
  terminal core too.

All of these are refused for read-only browsers and audited
(`machine.add`, `machine.rename`, `machine.remove`, `machine.enable`,
`machine.disable`, `machine.order`).

### Target validation

`machines.ValidTarget` accepts what OpenSSH takes as a destination
(`[user@]host`, `ssh://[user@]host[:port]`, aliases, IPv6 literals with
zone ids, Unicode names) and refuses:

- a leading `-` (ssh would read an option);
- whitespace, control and format characters;
- shell metacharacters (``! " $ & ' ( ) * ; < > ? \ ` { | }``), which a
  user's `ProxyCommand` or `Match exec` would expand through `%h`, `%r` or
  `%n`;
- more than 255 bytes.

This follows OpenSSH's own check of command-line destinations (9.6 and
later) and adds a few characters ssh passes on. The web UI checks typed
targets with the same vectors (`design/testdata/machines/targets.json`).
A refused target answers `invalid_target`; `--ssh` with one stops the core.

### The terminal core of each machine

`internal/server/term_backend.go`, `internal/agent/hc.go`
([21](21-terminal-core.md)). Connecting a machine starts only its agent.
When the first client of `/api/v1/term` subscribes to a machine's terminals
([22](22-terminal-protocol.md)), the core:

1. asks the agent for the terminal core's status (op `hc`);
2. uploads this build's herdr-core (`internal/hcdist`) when the installed
   one differs; the agent checks the digest and swaps it into
   `~/.veldr[-<instance>]/hosts/<host>/hc/`, and a running core of
   another build is restarted, its successor adopting the programs;
3. starts a core if none runs (session
   `veldr[-<instance>]-<host id>`, detached from the agent so its
   programs outlive it);
4. connects (op `hc-api`) and subscribes to its events.

A read-only core installs and starts nothing. The connection closes shortly
after the last client leaves and is retried with backoff while it fails.
The machine's state carries `hc {state, code, version}`, and while the
connection lasts the agent reports coding agents in the terminals
([25](25-agent-detection.md)).

The machine's menu reports (`GET /api/m/{id}/hc`) and starts, restarts or
stops (`POST /api/m/{id}/hc/{start|stop|restart}`) the terminal core.
Stop ends every terminal and keeps the core stopped until started again or
subscribed to anew. Refused read-only, audited
([deployment](../deployment.md#remote-resources)).

### Instances

`--instance NAME` makes agents use `~/.veldr-NAME` (sockets, uploads,
the terminal core and its session `veldr-NAME-<host id>`, code-server's
data) and
the core its own settings, keybindings and machines files, so a daily and a
development core can share machines safely. Agent builds, code-server
releases, Xvfb packages and video encoders are shared between instances.
A home several hosts share keeps each host's sockets, executables and
terminal core apart ([40](40-shared-homes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ssh -L`/`-R` unix-socket forwarding over a ControlMaster | One ssh session per stream (`MaxSessions`); needs stream-local forwarding; stale remote sockets. |
| One ssh exec per request | One remote process per call, and no streaming of terminals, files or code-server. |
| Helper written in Node or Python | Not on every machine; glibc and version constraints. |
| Go `x/crypto/ssh` client instead of OpenSSH | Would not honour the user's ssh config (ProxyJump, Match, agents, certificates). |
| Ids derived from the target | Ids appear in URLs and settings; random ids keep the target out. |
| Starting the terminal core when a machine connects | Unused machines would get a process outliving the core; the first subscription starts it. |
| Node.js core (sharing TypeScript types with the UI) | Go cross-compiles to static binaries with no runtime on the host. |

## Failure modes

- **Authentication needed** → ssh's stderr classified as auth →
  *auth_required* with an authentication terminal (on Windows, instructions
  and **Retry**).
- **Network loss** → yamux keepalive ends the session on both sides; the
  agent exits and releases what it owns
  ([10](10-remote-resource-lifecycle.md)); the core reconnects. If ssh is
  still running shortly after yamux gave up, or a probe through the master
  times out, the control master died silently (network change, sleep): the
  core runs `ssh -O stop` so the next attempt opens a new master instead of
  hanging. A new password or 2FA login is then needed.
- **Terminal core unreachable** → the machine stays *ready*; its `hc` state
  is `error` with a code (`not_bundled`, `install_failed`, `start_failed`,
  `connect_failed`, `stopped`, …); the core retries and the menu offers
  start or restart.
- **Unreachable machine added** → stored, shown in *error* with ssh's
  message, retried with backoff.
- **Machines file damaged** → logged; the core runs with the local machine
  and `--ssh` targets, keeps changes in memory and leaves the file alone.
- **Refused stored target** → *error* with `invalid_target`, never dialed;
  rename, remove or fix the file while the core is stopped.
- **Writing the file fails** → the change is refused with `save`.
- **Unsupported platform** → no embedded agent for the `uname` pair; the
  machine shows the error.
- **Hijacked control directory** → refused unless it is a real directory
  owned by the user with no group/other access
  ([08](08-web-access-and-security.md)).

## Testing

- `internal/agent/agent_test.go`: the agent over the tests' in-process
  transport, file ops, dial restrictions.
- `internal/agent/node_test.go`: the node's socket, several clients, one
  node per build, idle end, stop, retiring when its executable is gone.
- `internal/transport/*_test.go`: error classification, arch normalization,
  quoting, the control directory checks, no `Control*` options without it,
  stopping the master only while ssh stays up.
- `internal/machines/machines_test.go`: no file, the file's round
  trip and errors, ordering, target validation from the shared vectors,
  refused targets never dialed, the local machine without an agent, adding,
  removing, renaming, enabling and disabling at runtime.
- `internal/server/machines_test.go`: the HTTP endpoints, read-only and
  audit, `ssh_login` without a control directory, the terminal core's
  endpoints' guards, the ssh aliases offered (`TestSSHHosts`).
- `internal/sshconfig/*_test.go`: the config parser and its bounds.
- `internal/server/term_test.go` (`TestHCLifecycle`, `TestTermWithoutCore`)
  and `internal/agent/hc_test.go` (`TestHCInstallStartAndPipe`): install,
  start, stop and restart of the terminal core.
- `cmd/veldr/main_test.go`: `--local-only` and `--machine`.
- Web: `menus.test.ts`, `sidebarMachines.test.ts`, `addMachine.test.ts`,
  `addMachineHosts.test.ts`, `codePanes.test.ts` in `web/src/__tests__`.
- Tests that need an agent skip on Windows (`dialAgent` in
  `internal/{machines,server}/agent_unix_test.go`); CI runs the Go tests on
  Linux, macOS and Windows.
- `make it` (`TestIntegrationHC`, `TestIntegrationTerm`) with the real
  herdr-core.
- `make e2e` (`e2e/tests/ssh.spec.ts`, with Docker): a container running
  OpenSSH added from the dialog, its terminal and files, the machine
  dropping and coming back with its terminal core, a chat there, and
  nothing of the instance left on it once the terminal core and the core
  stop.

Verified manually against eight Ubuntu x86_64 hosts and an arm64 Ubuntu VM.
