# 02 · Multi-machine transport

## Context

The user's machines are reached over ssh with their own `~/.ssh/config`
(aliases, ProxyJump, agent forwarding). Machines are shared multi-user hosts
(lab workstations, GPU servers, robots) running Linux or macOS on amd64 or
arm64, sometimes with old userlands, sometimes without internet access. The
core needs many concurrent channels per machine: herdr API calls and event
streams, the pane surface of the shown tab, file reads, uploads, a
code-server proxy and a reverse channel for the VS Code extension.

## Goals / non-goals

Goals: reuse the user's ssh setup unchanged; no listening ports on machines;
no runtime dependencies on machines (no Node, Python or specific glibc);
bounded ssh session count; the same code path for the local machine.

Non-goals: managing ssh keys or herdr installations; Windows machines.

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
- **State machine** (`internal/machines`): connecting → ready ↔ degraded,
  auth_required, error, disabled; reconnect backoff 0.5 s doubling to 120 s;
  auth failures retry every 30 s or immediately after the UI's
  authentication terminal closes. *Degraded* means the agent is connected
  but two snapshot fetches in a row failed; it turns *ready* with the next
  fetch that works (every 5 s). The UI's **Retry**, offered in every state
  but *ready* to writable browsers, ends a backoff wait, and replaces the
  session of a machine that is connected but not *ready* (degraded) with a
  new one, whose agent finds herdr afresh, unless that session started less
  than 5 s ago; it is audited as `machine.retry`. Read-only browsers cannot
  retry (`denied.retry`): a new session ends every browser's surfaces,
  uploads and VS Code on the machine. After the authentication terminal the
  core only ends the backoff wait.
- **herdr API requests over the agent.** herdr drops an API connection whose
  request has not arrived 5 s after it accepted it. The core sends the
  request right behind the stream's header (`Session.OpenWith`) instead of
  after the agent's reply, so the request does not wait for a round trip
  through the reply direction, where pane surfaces and program windows may
  be queued on a slow link.
- **Instances.** `--instance NAME` makes agents use `~/.herdr-ide-NAME` for
  sockets, code-server process and settings, so two cores (daily and
  development) can share machines safely. Agent builds and code-server
  releases are shared between instances.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ssh -L`/`-R` unix-socket forwarding over a ControlMaster | Each pane stream would be an ssh exec session (MaxSessions limit); depends on sshd allowing stream-local forwarding; stale remote sockets need cleanup. |
| herdr's own `remote-api-bridge` per request | One ssh exec plus one remote process per call; does not cover terminals, files or code-server. |
| Helper written in Node or Python | Not present on every machine; glibc and version constraints. |
| Go `x/crypto/ssh` client instead of OpenSSH | Would not honour the user's ssh config (ProxyJump, Match blocks, agents, certificates). |
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
- **Slow or congested link** → yamux's keepalive tolerates 30 s, while
  herdr wants each API request within 5 s of accepting the connection;
  sending the request with the stream header keeps snapshots working, so
  the machine does not turn *degraded* only because replies queue behind
  surfaces and program windows.
- **herdr does not answer while the agent is connected** → *degraded* with
  the error; fetches retry every 5 s and **Retry** reconnects.
- **Retries in a row** (two clicks, a script) → a session younger than 5 s
  is kept, so retries cannot keep a machine disconnected.
- **Unsupported platform** → no embedded agent for the `uname` pair; the
  machine shows the error.
- **Hijacked control directory** → refused: `/tmp/herdr-ide-<uid>/s` must be
  a real directory owned by the user with no group/other access
  ([08](08-web-access-and-security.md)).

## Testing

`internal/agent/agent_test.go` (agent over the in-process transport, file
ops, exec, dial restrictions), `internal/transport/*_test.go` (ssh error
classification, arch normalization, quoting, control directory checks, a
request sent with the header reaches the agent before its reply, the
lost-session hook runs only when the session ends by itself, the control
master is stopped (`-O stop`) only while ssh stays up),
`internal/machines/machines_test.go` (Retry replaces the session of a
degraded machine, not one younger than 5 s),
`internal/server/server_test.go` (a read-only browser's retry is refused
and audited), `internal/herdr/client_test.go` (requests sent with the
dial),
`make it` for herdr streams. Verified manually against eight Ubuntu x86_64
hosts and an arm64 Ubuntu VM.
