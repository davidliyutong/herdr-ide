# 17 · Managing herdr from the UI

## Context

The release and the macOS app include herdr so that the core host needs no
separate installation ([15](15-bundled-herdr.md)). Desktop users in
particular may never use a terminal: without a way to start herdr's server,
check for a newer herdr and install it from the UI, the included herdr would
still need the command line. herdr itself starts its server from its TUI and
updates through `herdr update`.

## Goals / non-goals

Goals: start, stop and restart the local machine's herdr server from the UI;
show which herdr is in use and the server's version; check for and install
herdr updates for the copy the application provides, without stopping
running terminals where herdr supports it; update herdr on SSH machines
exactly the way herdr does, with the user answering herdr's own questions.

Non-goals: starting the server automatically; updating a local installation
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
- **Agent op `herdr`** with actions `status`, `start`, `stop`, `check`,
  `update` for `Header.Session`. The agent replies at once and sends the
  result as a second reply line, because an update can take longer than the
  core waits for a first reply. `start`, `stop` and `update` are serialized.
  - `status` runs `herdr status server --json` and reports the herdr in use,
    its version, whether it is the managed copy, and the server's running
    state, version and `restart_needed`.
  - `start` runs `herdr [--session S] server` in its own session (`setsid`),
    without the pane context of a herdr the core may run in, and waits up to
    15 s for the socket. The server belongs to the user and outlives the
    core, as when the herdr TUI starts it. Its output goes to
    `~/.herdr-ide/herdr/server.log`, replaced at every start; a failed start
    reports the log's tail.
  - `stop` runs `herdr [--session S] server stop`.
  - `check` reads `version` from `https://herdr.dev/latest.json`, the manifest
    `herdr update` uses, accepting only a version-shaped value.
  - `update` runs `herdr update --handoff` on the managed copy only (an
    installed herdr gives `not_managed`). herdr downloads the release,
    verifies it against the SHA-256 in its manifest, replaces the copy and
    hands running servers over to the new build where they support it.
- **Core.** `GET /api/m/{id}/herdr` returns the status;
  `POST /api/m/{id}/herdr/{start|stop|check|update}` runs an action
  (`internal/server/herdr.go`). Both accept only the local machine
  (`not_local` otherwise). Actions are refused in read-only mode, audited as
  `herdr.start`, `herdr.stop` and `herdr.update`, and refresh the machine so
  that its workspaces appear as soon as the server answers. Failures are
  codes (`not_found`, `start_failed`, `stop_failed`, `check_failed`,
  `update_failed`, `not_managed`, `transport`) with herdr's own output as
  detail.
- **SSH machines.** herdr updates a remote machine only when the user
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
- **UI.** `web/src/components/HerdrDialog.tsx` opens from the local machine's
  context menu and from its status block when it reports a problem (not in
  read-only mode). It shows the herdr in use, the server state, a start
  button or stop/restart buttons (stopping asks first: it ends every
  terminal), and, for the managed copy, "Check for updates" and "Update".

## Alternatives considered

| Option | Why not |
| --- | --- |
| Update the bundled file in place | Changes a signed app bundle; Gatekeeper may then refuse the app, and the next application upgrade would bring an old herdr back. |
| Download and verify updates in the core with pinned digests | Updates would wait for application releases; herdr's updater already verifies its release digests and performs live handoff. |
| Start the server automatically | herdr's own clients start it on request; an automatic start would make the application own a long-lived process and its lifetime. |
| Upload and replace herdr on SSH machines from the agent | Would need herdr for every platform in the core (about 100 MB), duplicate herdr's detection of package-manager installs and its server replacement, and change machines without herdr's confirmation. |
| Run `herdr --remote` without a terminal | herdr asks before installing and before stopping a server, and refuses without an interactive terminal; answering for the user would defeat that. |
| Use `herdr update` for an installed herdr | herdr refuses or defers updates of package-managed installs; the installer of that herdr owns it. |

## Failure modes

- Server exits or does not open its socket within 15 s → `start_failed` with
  the end of `server.log`; a server that did not come up in time is killed.
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

The endpoints are mutations behind the existing Host/Origin and proxy-secret
guards, refused in `--read-only`, audited and limited to the local machine.
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
check (including a malformed version) and that only the managed copy is
updated. `internal/server/server_test.go` covers local-only, read-only and
audit behavior of the endpoints, the `herdr --remote` command line and
environment, the remote terminal's guards and the PTY bridge. `TestIntegrationHerdrManage` starts and
stops a real server in the isolated `herdr-ide-it` session with temporary
`HOME` and herdr directories. `web/src/__tests__/localHerdr.test.ts` covers
requests, version comparison and messages for every error code.
