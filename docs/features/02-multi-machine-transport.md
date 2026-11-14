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
- **Enabling and disabling.** Machines come from herdr's saved machines
  with herdr's enabled flag. The sidebar's machine menu (and the **Enable**
  button of a disabled machine) changes it for herdr-ide only:
  `PUT /api/m/{id}/enabled` saves the choice in the core's
  `machines[-<instance>].json` (beside its settings file; entries of
  machines not configured at the moment are kept) and applies it at once,
  so herdr's catalog is never written. Disabling ends the session (the
  agent exits and stops the code-server it started; panes keep running in
  herdr), drops the machine's snapshot and shows it as *disabled*; enabling
  connects it. Disabling a connected machine asks first; for a *ready* SSH
  machine the dialog also offers, checked by default, to stop its herdr
  server before the session ends
  ([17](17-local-herdr-management.md)). Read-only browsers cannot do
  either. The sidebar folds disabled machines, so their Enable
  button shows only when the user opens one; disabling a machine folds it
  and enabling it unfolds it.
- **Adding, removing, renaming and reloading.** Machines are herdr's saved
  machines, so they are added, removed and renamed with herdr's own
  commands, run with the local machine's herdr on the core host; the core
  only reads herdr's catalog and follows it (`syncCatalog`: machines it no
  longer has are removed, changed labels and enabled flags applied, new
  ones added when wanted). A catalog that cannot be read changes nothing.
  **Add machine…** (right-click the sidebar's free space or any machine)
  asks for an SSH target, a label and the herdr session there (both
  optional), then runs `herdr machine add [--label=L] [--remote-session=S]
  TARGET` in a terminal (WebSocket `GET /api/machines/add`, like the update
  terminal of [17](17-local-herdr-management.md)): herdr connects with the
  user's ssh configuration, lets the user pick a running session, offers to
  install or update herdr there, starts its server and saves the machine,
  asking in the terminal for anything it needs (a password, a host key,
  approval). When the command ends, the core follows the catalog and adds
  the machines that appeared since the terminal opened: they join the
  running manager (`Manager.Add`, with an earlier enabled choice for the id
  applied), connect, and reach every browser as a new machine list; the
  socket closes with `added <id>` or `none`, which the dialog reports. Only
  new ids are added, so machines left out by `--machine` or `--local-only`
  stay out; `--remote-session` applies to new machines too. Closing the
  window ends herdr's command; whatever herdr saved by then is still added.
  **Remove machine…**, offered for herdr's saved machines (not `--ssh`
  targets or the local machine), asks first and then runs
  `herdr machine remove ID` (`DELETE /api/m/{id}`, 30 s). Once the catalog
  no longer has the id (also when herdr reports it as already gone), the
  core ends the machine's session as disabling does (`Manager.Remove`,
  waiting up to 15 s), forgets its enabled choice and sends the new list;
  browsers that showed it move to another machine and close its VS Code
  panel. herdr's removal only forgets the profile: the machine's herdr
  server and panes keep running.
  **Rename machine** (same menu, herdr's saved machines only) edits the
  label in the machine's header; Enter runs `herdr machine rename ID
  --label LABEL` (`PUT /api/m/{id}/label`, `{"label": "…"}`, trimmed, 30 s).
  A label another saved machine has is refused first (`label_taken`):
  herdr's rename does not check it, but `herdr --machine` selects by label.
  The new label counts once the catalog has it (`Manager.Update`); the
  machine keeps its session.
  The sidebar's **Reload** button (and **Reload machines from herdr** in
  the sidebar's menus) follows changes made with herdr's own commands or
  TUI while the core runs (`POST /api/machines/refresh`): saved machines
  that `--machine` and `--local-only` take are added, removed ones dropped,
  renamed ones relabelled, and herdr's enabled flag applied to machines the
  user did not enable or disable here; a toast counts the changes. The core
  does not watch the catalog: reloading is on request. herdr's own clients
  pick up changes made here from the catalog. Read-only browsers can do
  none of this (`403`); everything is audited (`machine.add`,
  `machine.added`, `machine.remove`, `machine.rename`, `machine.refresh`
  when something changed).
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
  the error; fetches retry every 5 s and **Retry** reconnects. Retry starts
  no herdr server: when none runs (after the machine rebooted), the status
  block's **Start herdr** or the menu's **Restart herdr…** starts it
  ([17](17-local-herdr-management.md)). When the agent finds no herdr
  executable there (removed, moved, a reinstalled system), the status
  block says so and offers **Install herdr** instead.
- **Retries in a row** (two clicks, a script) → a session younger than 5 s
  is kept, so retries cannot keep a machine disconnected.
- **Adding fails** (unknown host, authentication, the user declines an
  install, the window closes early) → herdr saves nothing and says why in the
  terminal; the dialog shows that nothing was saved.
- **Removing or renaming fails** (herdr refuses, no herdr on the core
  host) → the machine stays as it was, and the toast shows herdr's output
  (`herdr`) or that the local herdr is unavailable (`no_local_herdr`, also
  for adding: the local machine's agent reports the herdr to use).
- **herdr's catalog cannot be read** (being rewritten, damaged) → reloading,
  adding, removing and renaming report `catalog` and change no machine;
  in particular the machines are not taken for removed.
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
degraded machine, not one younger than 5 s; the enabled overrides are saved
and applied; disabling at runtime ends the session and forgets the snapshot,
enabling connects again; machines added at runtime connect, removed ones
end their session, publish nothing more and lose their enabled choice, the
local machine cannot be removed; a reload applies herdr's label and
enabled flag, not over the user's choice),
`internal/server/server_test.go` (a read-only browser's retry is refused
and audited; enabling and disabling is refused read-only, checked, audited
and saved), `internal/server/machines_test.go` (with a fake herdr: targets
that read as options, odd labels and sessions are refused, as are read-only
browsers, the local machine and `--ssh` machines; herdr's arguments; a
machine herdr saved is added and named in the close reason, also outside
the selection; a removal or rename herdr refuses keeps the machine as it
was; a label another machine has is refused; a reload adds only selected
machines, drops removed ones, applies labels and enabled flags, keeps the
local and `--ssh` machines, and changes nothing with a damaged catalog;
audit events), `cmd/herdr-ide/main_test.go` (a reload selects as
`--local-only` and `--machine` do), `web/src/__tests__/menus.test.ts` (the machine menu asks before
disabling and before removing, offers renaming and removal only for herdr's
saved machines, the sidebar's free space offers adding and reloading; the
toasts of renaming and reloading), `web/src/__tests__/sidebarMachines.test.ts`
(the reload button, absent read-only; renaming in the machine's header),
`web/src/__tests__/addMachine.test.ts` (the form's checks and query, a
removed machine takes its VS Code panel and focus along), `internal/herdr/client_test.go` (requests sent with the
dial),
`make it` for herdr streams. Verified manually against eight Ubuntu x86_64
hosts and an arm64 Ubuntu VM.
