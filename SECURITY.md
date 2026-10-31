# Security

herdr-ide gives its users interactive shells, file access and code execution
on every connected machine, with the permissions of the account running it.
Treat access to it like ssh access to all those machines.

## Threat model

**Trusted:** the user running the core, the machines it connects to (and
their herdr servers), the reverse proxy and whoever it authenticates.

**Not trusted:** other local users on the core host and on the machines,
other web pages open in the same browser, the network between browser and
proxy, and output shown in terminals.

## What the code enforces

| Risk | Mitigation |
| --- | --- |
| Web content in the desktop app reaching native APIs | Electron windows, including popups, use sandboxing, context isolation, no Node integration and no preload bridge; web security and the core CSP stay enabled. Only the exact core origin can navigate a main frame or open native windows; external HTTP(S) links open in the browser and other schemes are denied. Webviews are disabled. Only the main window relaxes the autoplay policy, for notification sounds (`desktop/src/policy.test.ts`). Permissions are denied except notifications, clipboard reads and sanitized clipboard writes from the core origin inside a core window (`desktop/src/policy.test.ts`). Clipboard reads let VS Code paste from other apps, as the browser UI allows its VS Code frame after the browser's prompt; core-origin content (VS Code, its extensions' webviews) can therefore read the clipboard without a prompt. |
| Desktop launcher orphaning or attaching to the wrong core | The shell accepts readiness only from its own child pipe and checks its loopback URL and port. Bind failure never reuses another service. Parent-stdin EOF cancels the core; normal quit sends SIGTERM, waits for cleanup, then kills only that child after 20 s. Single-instance locking is per Electron profile. |
| Accidental exposure of the port | Listens on loopback by default; a non-loopback `--listen` is refused unless a proxy secret is configured or `--insecure-listen` is given. |
| Requests bypassing the proxy | `--proxy-secret-file`: requests not from a same-host browser must carry `X-herdr-ide-Proxy-Secret` (constant-time comparison); the header is stripped before reaching code-server. |
| DNS rebinding, cross-site WebSocket hijacking | Host and Origin must be loopback or an `--allowed-origin`. |
| Clickjacking, script injection through served files | CSP with `script-src 'self'` and `frame-ancestors 'self'` on the UI; files are served with `nosniff`, a sandboxing CSP, and HTML/JS as `text/plain`; code-server responses get `X-Frame-Options: SAMEORIGIN`. |
| Local services of a machine running with the UI's origin | code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is disabled (`--disable-proxy`) and the core refuses those paths in any case (audited as `denied.port_proxy`), also for a code-server started by an earlier build. Otherwise a page served by any process listening on the machine, including another user's on a shared machine, could script `/ws`. |
| Abuse of herdr's API from the UI | Method allowlist (workspace/tab/pane/agent/layout/worktree calls, snapshot, plugin actions); no server control, integration or plugin installation, raw event streams or client-shell calls. `--read-only` narrows it to reads. |
| Other users on the core host hijacking ssh | ssh control sockets live in `/tmp/herdr-ide-<uid>/s`, which must be a directory owned by the user with no group/other access, or the core refuses to start. |
| Other users on a machine | Agent state is in `~/.herdr-ide` (0700); code-server and the bridge listen only on unix sockets there (0600); nothing listens on TCP. |
| Tampered downloads | code-server releases and extensions are verified against pinned SHA-256 digests or `.sha256` sidecars; mismatches are refused. |
| Archive path traversal | Tarball extraction rejects absolute paths, `..` and links leaving the install directory. |
| Downloads made by machines (`--code-server-install=download`) | The machine fetches only `http(s)` URLs built from the core's `--code-server-url` template, with curl or wget and no shell; the tarball is checked against the digest the core knows before it is unpacked. A digest learnt on first use is recorded on the core like the core's own downloads. |
| Other users on a machine reaching the virtual display | Xvfb accepts only clients presenting its MIT-MAGIC-COOKIE-1 and runs with `-nolisten tcp`. The cookie is new at every Xvfb start and names the display; Xvfb reads its own copy (`run/xauth.server`), panes get `run/xauth` (both 0600 in the 0700 run directory), so a program changing its `XAUTHORITY` file cannot leave the server without a cookie. |
| Another user posing as the X server | X sockets live in world-writable `/tmp/.X11-unix` (libxcb before 1.16 cannot use another path), abstract ones in a namespace without permissions, and X clients cannot authenticate the server. The agent therefore uses a display number only while no lock file, socket or listener of another user is on it and `/tmp/.X11-unix` is a directory of root or the user that is sticky or not writable by group and others; it sends the cookie only to a server whose peer credentials (`SO_PEERCRED`) are this instance's Xvfb on the connection and on both its sockets (filesystem and abstract), and panes get `DISPLAY` only from a display verified this way. Residual: a pane created earlier keeps `DISPLAY=:n` after its display ended, and a program started there later reaches whatever server then takes `:n`; another local user who binds the abstract names of every candidate number (`:20`–`:519`) can make program windows unavailable. |
| Input to programs' windows from the browser | Window pages and their WebSockets pass the same guards as terminals (Host/Origin, proxy secret, app CSP); frames are images; closing a window (`POST /m/{id}/gui/{win}/close`, sent with `keepalive`) needs the page's own Origin like every mutation. Pages use `Referrer-Policy: same-origin`, so same-origin requests carry their Origin and other sites get no referrer. In `--read-only` mode viewers send no input, closing is refused, and a viewer can neither acknowledge frames it was not sent nor ask for the whole window more than twice a second. |
| Programs on one display | X11 does not isolate clients: every program on a machine's display (from any pane of the instance) can read and control the other windows on it, as on a desktop. |
| Fetching Xvfb on machines | Happens when a remote Linux machine connects with the GUI setting on for it, never in `--read-only` mode (which only shows a display that already runs); audited as `gui.install` and `gui.start`. `apt-get download xvfb` verifies the package against apt's signed lists (not for sources marked `[trusted=yes]`); it is unpacked with `dpkg-deb -x` into the user's `~/.herdr-ide/xvfb/` under a validated version name. Nothing runs as root. |
| VirtualGL in every program of a pane (`--gui-gpu=all`) | Opt-in; preloads only VirtualGL's faker libraries found in system or `/opt/VirtualGL` library directories, by their resolved path, and only when the library and every directory above it belong to root and cannot be written by group or others. |
| Typing into panes to enable program windows | `POST /api/m/{id}/gui/enable` is a mutation (same guards, refused in `--read-only`, audited as `gui.enable` with the panes typed into). The core types only into known shells (bash, zsh, fish, dash, sh, ksh and similar, by executable name, so not into a program that replaced its shell with `exec`) waiting at their prompt (their process group is in the foreground, checked again right before typing): first Ctrl-C, which discards a half-typed command line, then only ` export` of the display variables it computed, each value single-quoted. A shell running a builtin such as `read` also looks idle; the text then goes to it. The audit record lists the panes typed into, busy and unreachable, also when the request fails. |
| Per-machine settings | `PUT /api/settings` with `machine` passes the same guards, accepts only machines the core knows, settings defined as per machine and, for remote-only settings, remote machines; a command-line flag still fixes the value for every machine. |
| Changing settings from the UI | `PUT /api/settings` passes the same guards as every other request, is refused in `--read-only`, accepts only defined settings with validated values (enums, absolute paths, no control characters), and is audited (`settings.set`). A setting given on the command line cannot be changed. The code-server path chosen there is run on the machines, which gives no more than the shell access the UI already has. |
| Accountability | `--audit-log` records connections, mutating calls (with the names of environment variables the core added to new panes), uploads, VS Code and bridge use, provisioning and closing program windows, and refusals. |

Not provided by herdr-ide: user authentication, TLS, rate limiting, per-user
authorization. Use the reverse proxy for these.

The desktop core has the same loopback HTTP trust boundary as CLI local use;
the launcher does not add authentication against other processes on the
host. Its app/DMG build uses ad-hoc signing, not Developer ID signing or
Apple notarization. Do not treat the build as a notarized public release.
The DMGs attached to GitHub releases are built the same way by the release
workflow; their integrity rests on `SHA256SUMS` and, for a public repository,
GitHub build-provenance attestations, both covering archives and DMGs. Only
the final publish job of that workflow holds write permissions; the build
jobs read the repository.

## Bundled herdr

Release archives include upstream herdr downloaded at build time and verified
against SHA-256 digests pinned in `internal/herdrdist` before packaging
(`internal/herdrdist/release_test.go` covers a corrupt download). At runtime
the bundled herdr is trusted like an installed one and not re-verified. The
local agent uses a copy of it in `~/.herdr-ide/herdr/` (directory 0700) only
when no installed herdr is found (`internal/agent/herdr_test.go`), with the
caller's environment and herdr's usual sockets, which herdr creates with mode
0600. herdr-ide never uploads herdr to SSH machines itself. **Update herdr**
runs the local herdr's `herdr --remote=<target>` in a terminal on the core
host (`GET /api/m/{id}/herdr/remote`: refused in `--read-only`, audited as
`herdr.remote`, SSH machines only, the target passed as one argument); herdr
then asks the user before installing anything there or stopping a server.

The local machine's herdr can be managed from the UI
([17](docs/features/17-local-herdr-management.md)):
`POST /api/m/{id}/herdr/{start|stop|check|update}` are mutations behind the
usual guards, refused in `--read-only`, audited (`herdr.start`, `herdr.stop`,
`herdr.update`) and accepted only for the local machine
(`internal/server/server_test.go`). An update runs herdr's own
`herdr update --handoff` on the application's copy only: it trusts herdr's
release manifest on `herdr.dev` and the SHA-256 digests it publishes, like a
user running `herdr update`, and never changes the bundled file or an
installation of the user's. Servers are started only on request, never
automatically.

## Supported versions

Security fixes go to the latest release and to `main`.

## Reporting a vulnerability

Please report privately instead of opening a public issue: use the
repository host's private vulnerability reporting ("Report a vulnerability"
under the Security tab) or contact the maintainers. Include the version
(`herdr-ide version`), configuration flags and steps to reproduce. You will
get an acknowledgement within a few days.
