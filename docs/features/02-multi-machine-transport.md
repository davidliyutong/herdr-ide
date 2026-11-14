# 02 · Multi-machine transport

## Context

The user's machines are reached over ssh with their own `~/.ssh/config`
(aliases, ProxyJump, agent forwarding). Machines are shared multi-user hosts
(lab workstations, GPU servers, robots) running Linux or macOS on amd64 or
arm64, sometimes with old userlands, sometimes without internet access. The
core needs many concurrent channels per machine: the terminal core's API
and terminal streams ([21](21-terminal-core.md)), agent detection, file
reads, uploads, program windows, a code-server proxy and a reverse channel
for the VS Code extension.

## Goals / non-goals

Goals: reuse the user's ssh setup unchanged; no listening ports on machines;
no runtime dependencies on machines (no Node, Python or specific glibc);
bounded ssh session count; the same code path for the local machine.

Non-goals: managing ssh keys; Windows machines.

## Design

- **Agent.** `cmd/herdr-ide-agent` is a static Go binary (`CGO_ENABLED=0`)
  built for linux/darwin × amd64/arm64 and embedded gzipped in the core
  (`internal/embedded`). Its version is the content hash, so a changed build
  is always re-uploaded and core and agent can never disagree on the
  protocol.
- **Connect** (`internal/transport/ssh.go`):
  1. probe `uname -s`, `uname -m`, `$HOME` through `/bin/sh -c` (works with
     any login shell);
  2. if `~/.herdr-ide/agent/<hash>/herdr-ide-agent` is missing, upload it with
     `cat >` to a temporary name and rename atomically;
  3. `exec` it with `serve --instance NAME` and speak yamux over the ssh
     session's stdin/stdout.
- **ssh options.** BatchMode, ServerAlive keepalives, `ControlMaster=auto`
  with `ControlPersist=600` in a private control directory. The master exists
  so that an interactive login (password, 2FA, host-key prompt) done once in
  the UI's authentication terminal is reused by the BatchMode connections.
- **Local machine.** `transport.DialLocal` runs the same agent in-process over
  a socketpair: identical protocol, no ssh.
- **Multiplexing.** One yamux session per machine; streams start with a JSON
  header and reply ([architecture](../architecture.md#core--agent-protocol-internalagentproto)).
  This avoids sshd's `MaxSessions` (default 10) and any dependence on
  `AllowStreamLocalForwarding`.
- **State machine** (`internal/machines`): connecting → ready,
  auth_required, error, disabled; reconnect backoff 0.5 s doubling to 120 s;
  auth failures retry every 30 s or immediately after the UI's
  authentication terminal closes. A machine is *ready* as soon as its agent
  answers `hello`. The UI's **Retry**, offered to
  writable browsers in every state but *ready* and *disabled*, ends the
  backoff wait; read-only browsers cannot retry (`denied.retry`), since an
  attempt may start an ssh login.
- **The terminal core's state.** While the core has a connection to a
  machine's terminal core ([22](22-terminal-protocol.md)), the machine's
  state carries it as `hc {state, code, version}` (`starting`, `ready` or
  `error` with the backend's code), so every `/ws` client sees whether
  terminals work there. While that connection lasts the agent also tells
  which coding agents run in the terminals and what they do
  ([25](25-agent-detection.md)).
- **Machines.** The core keeps its own list of machines in
  `machines[-<instance>].json` beside its settings file
  ([reference](../reference.md#files-and-directories)): one record per SSH
  machine (`id`, `label`, `kind: "ssh"`, `target`, `enabled`), and one of
  the local machine (its `enabled` flag) once it was enabled or disabled.
  Every change is written at once (atomically, 0600). The first time a core
  of an instance starts without the file, it imports the SSH machines saved
  by herdr, the terminal multiplexer an earlier version drew its panes from
  (`~/.local/state/herdr/client/endpoints.json`), with their labels and
  enabled flags, and the choices an earlier version kept in the same file;
  after that herdr's catalog is never read. Machines given with `--ssh`
  are not stored: changes to them last until the core stops. `--local-only`
  and `--machine` choose which stored machines a run connects to; the file
  keeps the others.
- **Adding.** **Add machine…** (right-click the sidebar's free space or any
  machine) asks for an SSH target and an optional label (the target names
  it otherwise): `POST /api/machines {target, label}`. The target is an ssh
  destination without spaces or control characters that does not start
  with `-`, at most 255 bytes, and the label at most 64 characters without
  control characters; a target or id the core has already is refused
  (`machine_exists`). The core gives the machine a random id, stores it,
  sends every browser the new machine list and connects it with the user's
  ssh configuration. A machine that needs an interactive login (a password,
  a key's passphrase, a host key to confirm) turns *auth_required*, and the
  page that added it opens the authentication terminal for it.
- **Renaming, removing, enabling and disabling.** The machine's menu renames
  an SSH machine in its header (`PUT /api/m/{id}/label`, `{"label": "…"}`,
  trimmed; a label another machine has, running or stored, is refused with
  `label_taken`, since `--machine` selects by label; the local machine keeps
  its host's name). **Remove machine…** asks first (`DELETE /api/m/{id}`):
  the record goes, the machine's session ends as disabling does (waiting up
  to 15 s), and browsers that showed it move to another machine and close
  its VS Code panel; nothing on the machine is removed, its terminal core
  and terminals keep running. The local machine cannot be
  removed. `PUT /api/m/{id}/enabled` (`{"enabled": bool}`) enables or
  disables a machine: stored and applied at once. Disabling ends the
  session (the agent exits and stops the code-server it started; programs
  keep running in the terminal core) and shows it as *disabled*; enabling
  connects it. Disabling a
  connected machine asks first. The
  sidebar folds disabled machines, so their Enable button shows only when
  the user opens one; disabling a machine folds it and enabling it unfolds
  it. Read-only browsers can do none of this (`403`); everything is
  audited (`machine.add`, `machine.rename`, `machine.remove`,
  `machine.enable`, `machine.disable`, with the error when it failed).
- **The terminal core from the UI.** `GET /api/m/{id}/hc` reports a
  machine's terminal core (the installed executable's digest, whether one
  answers, its version, session and socket), and
  `POST /api/m/{id}/hc/{start|stop|restart}` runs the agent's `hc` op from
  the machine's menu (the browser UI's sidebar, the macOS application);
  restart and stop ask first: start installs this build's
  executable when the machine has another and starts a core; restart has
  the core's successor adopt the programs; stop ends every terminal there
  after the user confirmed it and keeps the core stopped (the terminal
  backend reports `stopped` instead of starting another) until it is
  started again or a client subscribes to the machine anew. Refused
  read-only, audited as `hc.start`, `hc.stop`, `hc.restart`
  ([deployment](../deployment.md#remote-resources)).
- **Instances.** `--instance NAME` makes agents use `~/.herdr-ide-NAME` for
  sockets, code-server process and settings, so two cores (daily and
  development) can share machines safely. Agent builds and code-server
  releases are shared between instances.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ssh -L`/`-R` unix-socket forwarding over a ControlMaster | Each pane stream would be an ssh exec session (MaxSessions limit); depends on sshd allowing stream-local forwarding; stale remote sockets need cleanup. |
| One ssh exec per request | One ssh exec plus one remote process per call (sshd's `MaxSessions`), and no way to stream terminals, files or code-server. |
| Helper written in Node or Python | Not present on every machine; glibc and version constraints. |
| Go `x/crypto/ssh` client instead of OpenSSH | Would not honour the user's ssh config (ProxyJump, Match blocks, agents, certificates). |
| Reading herdr's catalog at every start | The core's list would change with another program's; one import keeps the user's machines without depending on it afterwards. |
| Node.js core (sharing TypeScript types with the UI) | A Go core and agent cross-compile to static binaries for every platform with no runtime on the host; the UI types are generated separately. |

## Failure modes

- **Authentication needed** → stderr classified as auth (`Permission
  denied`, host key prompts) → *auth_required*, with an authentication
  terminal in the UI.
- **Network loss** → yamux keepalive (15 s, 30 s write timeout) ends the
  session on both sides; the agent exits and releases what it owns
  ([10](10-remote-resource-lifecycle.md)); the core reconnects with backoff.
  If the session's ssh is still running 2 s after yamux gave up, the
  control master's connection died silently (the network changed, the
  computer slept): the core tells that master to take no new sessions
  (`ssh -O stop`, which removes its socket), and also when a connection
  probe through it times out, so the next attempt opens a new master
  instead of hanging on the old one until its ServerAlive checks give up a
  minute later. Sessions still open through the old master, including
  other instances' (the control directory is per user, not per instance),
  keep running until they end or its checks end them. A password or 2FA
  login is needed for the new master, as for any new connection.
- **The terminal core does not answer** → the machine stays *ready*; its
  `hc` state shows the backend's code, and the machine's menu offers to
  start or restart the terminal core ([21](21-terminal-core.md)).
- **Adding a machine that cannot be reached** (unknown host, refused
  connection) → it is stored and shows *error* with ssh's message, retried
  with the backoff; remove it or fix the ssh configuration. One that needs
  a login shows *auth_required* and the authentication terminal.
- **The machines file cannot be read** (damaged JSON) → the core logs it,
  runs with the local machine and the `--ssh` targets, keeps changes in
  memory and leaves the file alone; **herdr's catalog cannot be read at
  the first start** → nothing is imported and no file is written, so the
  next start imports again.
- **Writing the file fails** (disk full, read-only directory) → the change
  is refused with `save` and the machine stays as it was.
- **Unsupported platform** → no embedded agent for the `uname` pair; the
  machine shows the error.
- **Hijacked control directory** → refused: `/tmp/herdr-ide-<uid>/s` must be
  a real directory owned by the user with no group/other access
  ([08](08-web-access-and-security.md)).

## Testing

`internal/agent/agent_test.go` (agent over the in-process transport, file
ops, dial restrictions), `internal/transport/*_test.go` (ssh error
classification, arch normalization, quoting, control directory checks, the
lost-session hook runs only when the session ends by itself, the control
master is stopped (`-O stop`) only while ssh stays up),
`internal/machines/machines_test.go` (herdr's catalog imported once, also
when empty, never again; the earlier file's enabled choices migrated, the
local machine's included; records written 0600 and read back; a damaged
file reported and left alone; an unreadable catalog imports and writes
nothing; the order of the local, stored and `--ssh` machines; a machine is
ready once its agent answers and logs nothing; disabling at runtime ends
the session, enabling connects again, both stored; machines added at runtime
are stored and connect, a known id or target is refused, removed ones end
their session, lose their record and publish nothing more, the local
machine cannot be removed; renaming stores the label for stored machines,
keeps it for `--ssh` ones, refuses a label another machine has and the
local machine), `internal/server/machines_test.go` (adding, renaming,
removing and enabling over HTTP: odd targets and labels refused, a known
target refused, read-only browsers refused, the file and the audit log;
the terminal core's endpoints refused read-only, for unknown actions and
for machines without an agent), `internal/server/term_test.go`
(`TestHCLifecycle`: status, a stopped core kept stopped while a client is
subscribed, started and restarted again, the machine's `hc` state, audit
entries), `cmd/herdr-ide/main_test.go` (`--local-only` and `--machine`),
`web/src/__tests__/menus.test.ts` (the machine menu asks before disabling
and before removing, offers renaming and removal for SSH machines, the
sidebar's free space offers adding; adding opens the authentication
terminal once the new machine needs a login; starting, restarting and
stopping the terminal core, one action at a time),
`web/src/__tests__/sidebarMachines.test.ts` (renaming in the machine's
header, a machine's terminals followed when shown, starting a terminal
core that failed), `web/src/__tests__/addMachine.test.ts` (the form's
checks, a removed machine takes its VS Code panel along),
`macos/Tests/TermKitTests` (the machine state's `hc`), `make it` for the
terminal core's streams. Verified manually against eight Ubuntu x86_64 hosts and
an arm64 Ubuntu VM.
