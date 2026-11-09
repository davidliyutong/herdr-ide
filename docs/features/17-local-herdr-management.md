# 17 · Managing herdr from the UI

## Context

The release and the macOS app include herdr so that the core host needs no
separate installation ([15](15-bundled-herdr.md)). Desktop users in
particular may never use a terminal: without a way to start herdr's server,
check for a newer herdr and install it from the UI, the included herdr would
still need the command line. herdr itself starts its server from its TUI and
updates through `herdr update`.

SSH machines need the same for their server. herdr's server ends with its
host (it saves the session first), so after a machine reboots the agent
connects again but finds no server: the machine stays *degraded*, and
**Retry**, which only replaces the agent session
([02](02-multi-machine-transport.md)), cannot help. Starting it meant an ssh
terminal on that machine.

herdr can also disappear from an SSH machine: removed by accident, moved to
another install location, or gone with a reinstalled system. herdr's SSH
metadata then still names the old path, and a server started before keeps
running and answering (its executable stays open), but no server can be
started or restarted there until herdr is installed again.

## Goals / non-goals

Goals: start, stop and restart the herdr server of every machine, local or
SSH, from the UI; show which herdr is in use and the server's version;
check for and install
herdr updates for the copy the application provides, without stopping
running terminals where herdr supports it; update herdr on SSH machines,
or install it again where it went missing, exactly the way herdr does, with
the user answering herdr's own questions.

Non-goals: starting the server automatically (also not from **Retry**);
updating a local installation
of the user's (Homebrew, mise, `~/.local/bin`, …); installing or replacing
herdr on SSH machines with the application's own logic or without the
user's confirmation; choosing herdr's preview channel.

## Design

- **Managed copy.** An app bundle must not change (its signature covers the
  bundled herdr), so the agent keeps a copy of the bundled herdr in
  `~/.herdr-ide/herdr/herdr`, shared by all instances like herdr's own state
  (`internal/agent/herdrmgr.go`). The copy is made when the local agent first
  needs it, and replaced when an application upgrade brings a newer bundled
  herdr; an older bundle never replaces a newer copy. herdr resolution is:
  an installed herdr (`HERDR_BIN`, `PATH`, the usual locations, the login
  shell), then the managed copy, then the bundled file if copying failed.
  Without a bundled herdr (development builds) an existing copy is still
  used.
- **Agent op `herdr`** with actions `status`, `start`, `stop`, `restart`,
  `check`, `update` for `Header.Session`. The agent replies at once and
  sends the result as a second reply line, because an update can take longer
  than the core waits for a first reply. `start`, `stop`, `restart` and
  `update` are serialized.
  - `status` runs `herdr status server --json` and reports the herdr in use,
    its version, whether it is the managed copy, and the server's running
    state, version and `restart_needed`. Every action looks herdr up
    again: the path in use is kept only while it is still executable, else
    the usual search runs (past the core's last path and herdr's SSH
    metadata), and the version is read anew, so a herdr removed, reinstalled
    or moved since the agent started is noticed. Without any herdr the
    status is `not_found` and still tells, from a probe of the session's
    socket, whether a server runs.
  - `start` runs `herdr [--session S] server` in its own session (`setsid`),
    without the pane context of a herdr the core may run in, and waits up to
    15 s for the socket. The server belongs to the user and outlives the
    core, as when the herdr TUI starts it. Its output goes to
    `~/.herdr-ide/herdr/server.log` on that machine, replaced at every start
    (of any session or instance); a failed start reports the log's tail, and
    a server that did not come up is killed with its process group. On Linux
    the agent then starts the display keeper for the server
    ([14](14-gui-windows.md)). The server inherits the agent's environment
    without herdr's pane variables, as one started from an ssh login does:
    with the user's ssh configuration forwarding the agent to that machine,
    its panes get the forwarded `SSH_AUTH_SOCK` while the connection lasts.
  - `stop` runs `herdr [--session S] server stop`, which returns once the
    server has exited, within 30 s (`stop_failed` otherwise).
  - `restart` stops the server when one of this user answers on the
    session's socket, waits up to 10 s until nothing listens there, and
    starts one as `start` does. A server that is not running is only started
    (herdr's stop fails without one); a failed stop starts nothing.
  - Before any of these, the agent probes the socket: only a missing socket
    or a refused connection mean that no server runs. A listener of another
    user (peer credentials) gets no command (`foreign_server`), and one that
    takes no connections (a full backlog: a hung server that may still own
    its panes) is neither stopped nor replaced (`server_unresponsive`).
  - `check` reads `version` from `https://herdr.dev/latest.json`, the manifest
    `herdr update` uses, accepting only a version-shaped value.
  - `update` runs `herdr update --handoff` on the managed copy only (an
    installed herdr gives `not_managed`). herdr downloads the release,
    verifies it against the SHA-256 in its manifest, replaces the copy and
    hands running servers over to the new build where they support it.
- **Core.** `GET /api/m/{id}/herdr` returns the status;
  `POST /api/m/{id}/herdr/{start|stop|restart|check|update}` runs an action
  (`internal/server/herdr.go`). Every reply also replaces the herdr path and
  version the machine shows (`Machine.NoteHerdr`), which otherwise come from
  the session's first reply. The status and the server actions accept
  every machine whose agent is connected; `check` and `update` concern the
  application's copy and accept only the local machine (`not_local`
  otherwise). Actions are refused in read-only mode, audited as
  `herdr.start`, `herdr.stop`, `herdr.restart` and `herdr.update`, and
  refresh the machine so that its workspaces appear as soon as the server
  answers; after a start or restart that left a server running, the
  machine's pane surface reconnects at once instead of waiting for its
  backoff ([18](18-endpoint-surfaces.md)). Failures are codes (`not_found`,
  `start_failed`, `stop_failed`, `check_failed`, `update_failed`,
  `not_managed`, `not_local`, `foreign_server`, `server_unresponsive`,
  `transport`) with herdr's own output as detail. The audit records the
  machine, the session and the error code.
- **SSH machines.** Their server is started, stopped and restarted like the
  local one, with the herdr the agent found there; nothing is uploaded.
  herdr updates a remote machine only when the user
  attaches to it with `herdr --remote <target>`: it looks for an installed
  herdr there (PATH, Homebrew, mise, Nix, `~/.local/bin`), offers to install
  its own version when none matches (from the local file for the same
  platform, otherwise the release asset verified against its published
  SHA-256), asks before replacing a running server (default no; live handoff
  only with `--handoff`), records the path in its SSH metadata and attaches.
  The application runs exactly this command:
  `GET /api/m/{id}/herdr/remote` (a WebSocket) starts the local herdr — the
  one the local agent uses — as `herdr --remote=<target> [--session S]
  [--handoff]` in a PTY on the core host, like the authentication terminal,
  without the pane context of a herdr the core may run in. The user answers
  herdr's questions there. When it ends (or the window closes, which ends the
  local client only), the core reads the herdr path herdr recorded and
  reconnects the machine, so a new agent uses the herdr now installed. The
  sidebar shows a machine whose herdr is older than the local one, with an
  **Update herdr** button; the SSH machine's context menu always offers it.
  The installed version is the local herdr's: update the local one first.
- **herdr missing on an SSH machine** (the agent found no executable there:
  removed, moved or never installed). herdr's `--remote` flow above also
  installs it, so the same terminal is offered as **Install herdr**: in the
  status block of the *degraded* machine (whose detail says herdr is
  missing instead of the socket error), in a banner while a server that
  outlived its herdr keeps the machine *ready*, in the context menu (in
  place of **Update herdr…**) and in **Manage herdr**, which also shows
  whether a server still runs and offers **Check again** for a herdr the
  user installed by hand. **Restart herdr…** is disabled meanwhile: it
  would stop nothing and start nothing. When the terminal ends, the
  machine reconnects with the path herdr recorded.
- **UI** (not in read-only mode). **Manage herdr…** in a machine's context
  menu (for an SSH machine while its agent is connected) opens
  `web/src/components/HerdrDialog.tsx`, and so does the button in a
  machine's status block when it reports a problem: always on the local
  machine, on an SSH machine when it is *degraded*. The dialog shows the
  herdr in use, the server state, a start button or stop and restart
  buttons (asking first: they end every terminal on that machine; restart
  is highlighted when the server runs another herdr build) and, for the
  managed copy on the local machine, "Check for updates" and "Update".
  **Restart herdr…** in the context menu of every machine with a connected
  agent asks the same question, restarts the server (or starts it when it
  is not running) and reports the result in a toast.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Update the bundled file in place | Changes a signed app bundle; Gatekeeper may then refuse the app, and the next application upgrade would bring an old herdr back. |
| Download and verify updates in the core with pinned digests | Updates would wait for application releases; herdr's updater already verifies its release digests and performs live handoff. |
| Start the server automatically | herdr's own clients start it on request; an automatic start would make the application own a long-lived process and its lifetime. |
| Let **Retry** start a missing server | Retry reconnects the agent whatever made the machine *degraded* (a hung server, a moved socket); starting a server is a separate request the user makes, as on the local machine. |
| Start SSH servers only through `herdr --remote` | It attaches a client in a terminal and may offer to install herdr; a machine that rebooted only needs its installed server started. |
| Upload and replace herdr on SSH machines from the agent | Would need herdr for every platform in the core (about 100 MB), duplicate herdr's detection of package-manager installs and its server replacement, and change machines without herdr's confirmation. |
| Run `herdr --remote` without a terminal | herdr asks before installing and before stopping a server, and refuses without an interactive terminal; answering for the user would defeat that. |
| Use `herdr update` for an installed herdr | herdr refuses or defers updates of package-managed installs; the installer of that herdr owns it. |

## Failure modes

- Server exits or does not open its socket within 15 s → `start_failed` with
  the end of `server.log`; a server that did not come up in time is killed.
- SSH machine rebooted → the agent connects again and the machine is
  *degraded*; its status block offers **Manage herdr** with **Start
  server**, and the context menu **Restart herdr…**. herdr restores the
  workspaces it saved at shutdown, with new shells.
- Restart: herdr's stop fails or does not return within 30 s (a hung
  server), or a server still answers 10 s after it → `stop_failed` with
  herdr's output, and nothing is started; the user ends that server on the
  machine.
- The socket takes no connections → `server_unresponsive`; another user's
  process listens there (a socket path in a shared directory) →
  `foreign_server`. Nothing is started or stopped.
- The machine ends user processes at logout (logind `KillUserProcesses=yes`)
  → a server started over the agent's ssh login ends when that login does,
  at the latest 10 min after the core disconnects; `loginctl enable-linger`
  keeps it.
- The machine's agent is not connected → `transport`; the menu items are
  disabled for SSH machines.
- herdr removed, moved or reinstalled on an SSH machine → a new agent, or
  the next status or action of the connected one, finds the herdr there
  now. Without one the machine is *degraded* with "herdr is not installed
  here" (or stays *ready* with a warning while its old server runs), every
  server action returns `not_found` and starts or stops nothing, and
  **Install herdr** runs `herdr --remote`; a herdr installed by hand is
  picked up by **Check again** in **Manage herdr** or by **Retry**.
- No network or herdr.dev unavailable → `check_failed` or `update_failed`
  with herdr's message; the installed copy stays as it was.
- A server older than the new herdr → `restart_needed`; the dialog offers a
  restart (which closes terminals) when live handoff was not possible.
- Remote update: the local herdr is missing → `no_local_herdr`; ssh needs a
  password → herdr's ssh asks in the same terminal; the user declines → herdr
  leaves the machine as it was. `--remote` has no install-only mode, so after
  installing it attaches to that machine's herdr until the window closes.
- The core runs as a systemd service → a server started from the UI belongs
  to the service's cgroup; see the unit in
  [deployment](../deployment.md#running-as-a-service).

## Security

The actions are mutations behind the existing Host/Origin and proxy-secret
guards, refused in `--read-only` and audited. The server actions accept
every configured machine; there, as the user and with the herdr the agent
resolved, they run `herdr [--session S] server` or
`herdr [--session S] server stop`, as well as `herdr --version` and
`herdr [--session S] status server --json` for the status, and on Linux the
display keeper ([14](14-gui-windows.md)). Arguments are fixed or come from
the core's machine list, never from the request, and nothing runs through a
shell. Stopping and restarting end the terminals of that herdr session on
that machine, so the UI asks first. Nothing is started or stopped while
another user's process listens on the socket. The status
(`GET /api/m/{id}/herdr`) runs only the two read commands and is allowed in
read-only mode, for SSH machines too. Check and update are limited to the
local machine.
Updates trust herdr's release manifest at `herdr.dev` and the SHA-256 digests
it publishes, the same trust as running `herdr update`; they replace only the
application's copy, never the bundled file or an installation of the user's.
The remote update terminal (`GET /api/m/{id}/herdr/remote`) is refused in
read-only mode, audited as `herdr.remote`, accepted only for SSH machines,
and passes the target as one `--remote=` argument to the local herdr; what
happens on the machine is herdr's own flow, confirmed by the user.
See [SECURITY.md](../../SECURITY.md).

## Testing

`internal/agent/herdr_test.go` covers resolution order, the managed copy
following newer bundles but not older ones, version comparison, the manifest
check (including a malformed version), that only the managed copy is
updated, that a restart stops only a running server and starts nothing
after a failed, hanging or ineffective stop, that another user's listener
gets no command, how socket probes classify connection errors, that a herdr
removed while its server runs gives `not_found` with the server still
running and nothing started or stopped, and that a herdr installed
elsewhere replaces the stale path. `internal/machines/machines_test.go`
covers that a status's herdr replaces the machine's, as a new published
Info.
`internal/server/server_test.go` covers which actions
SSH machines accept, read-only and audit behavior of the endpoints, the
`herdr --remote` command line and environment, the remote terminal's guards
and the PTY bridge. `TestIntegrationHerdrManage` starts, stops and restarts
(stopped and running) a real server in the isolated `herdr-ide-it` session
with temporary `HOME` and herdr directories.
`web/src/__tests__/localHerdr.test.ts` covers requests, version comparison,
messages for every error code and when a machine's herdr counts as missing;
`menus.test.ts` covers the machine menu's entries, the confirmed restart and
**Install herdr…** with the restart disabled where herdr is missing.
