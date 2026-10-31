# 16 · Desktop packaging

## Context

The browser UI and Go core already contain the application's features.
macOS users also need an app they can launch from Finder and install by
dragging it out of a disk image. VS Code webviews depend on Chromium features
and a secure loopback origin, so a native shell must preserve the existing
HTTP, WebSocket and service-worker behavior.

## Goals / non-goals

Goals: reproducible dependency resolution, native macOS arm64/x64 `.app`
and DMG builds, automatic core ownership and cleanup, safe renderer windows,
and a development mode that cannot connect to the default herdr session.

Non-goals: Windows/Linux installers, universal binaries, automatic updates, Developer ID signing/notarization,
or replacing browser access. The shell and packaging configuration are
separate from the Go/Web application so additional platform targets can be
implemented independently.

## Design

- `scripts/desktop.sh` builds the existing embedded application and matches
  the Go core architecture to Electron (`x64` maps to Go `amd64`).
  `desktop/electron-builder.cjs` packages the core as an executable resource
  outside ASAR, with licenses (including the web bundle's `licenses.md`); the
  shell lives inside ASAR. Its `beforePack` hook refuses to package binaries
  built for another architecture than the Electron app. The DMG has an
  Applications shortcut. Builds use ad-hoc signing without notarization.
  Without `VERSION` the core reports `git describe` as in `scripts/build.sh`;
  the app metadata then uses `desktop/package.json`.
- `desktop/src/main.ts` owns one child core. `--parent-stdio` adds one JSON
  readiness message to stdout and cancels the core when stdin closes. Logs
  stay on stderr, and the core ignores SIGPIPE so that writing to the pipes of
  a crashed launcher fails instead of killing it before cleanup. Failed
  binding never connects the UI to an unrelated listener. The shell has a
  30 s startup timeout and a 20 s shutdown deadline; core cleanup retains its
  existing agent and code-server behavior. When macOS logs out, restarts or
  shuts down, the shell signals the core and quits without waiting, because
  delaying the quit would cancel the system's request.
- Startup and core failures are reported with English/Chinese messages from
  the web dictionaries; exit codes and similar details are appended as is.
- Production uses loopback port 7781 and instance `desktop`. A stable origin
  preserves browser settings; an explicit port override is available. Dev
  uses port 7791, instance `dev`, local-only and local/remote session
  `herdr-ide-dev`. Unpackaged runs always use dev mode, and packaged runs can
  opt into it. Both modes have separate Electron profiles and single-instance
  locks. Closing the main window quits; a second launch focuses it.
- Finder PATH gains common binary locations without executing a shell.
  The app carries the release's herdr and its notices in
  `Contents/Resources/bin/herdr` and `licenses/herdr/`, beside the core, which
  uses it only when no installed herdr is found
  ([15](15-bundled-herdr.md)). OpenSSH is user-installed. The desktop shell
  does not start or stop herdr's servers. All inherited environment and SSH configuration
  remain available to the core.
- The web brand constants and English/Chinese message dictionaries are
  imported into the shell. Build metadata reads the same brand file. Native
  error dialogs follow the OS locale; UI language still follows web settings.
- The app icon shows three terminal panes: a blue primary pane with a white
  prompt and two smaller green/slate panes, representing several machines in
  one workspace. `desktop/assets/icon.svg` is the 1024-unit master with an
  inset rounded-square body, transparent outer margins and restrained depth.
  `web/public/icon.svg` is an optically adjusted flat version for small sizes
  and the browser/PWA. `make desktop-icons` uses librsvg and macOS `iconutil`
  to regenerate the committed PNG and ICNS (16–1024 physical pixels); the
  16/32-pixel entries use the simpler drawing. Builds need no icon tools.
  Both the app and DMG use the ICNS; development sets the Dock icon from PNG.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Reimplement the UI for desktop | Duplicates terminal rendering, layout and VS Code integration. |
| Tauri/WKWebView | The project's VS Code webviews require Chromium service-worker behavior. |
| Attach to an existing server on a well-known port | Cannot prove ownership or safely reclaim it; might attach to another instance. |
| Always choose a random port | localStorage is origin-specific; preferences would disappear on every launch. An explicit port `0` remains useful for isolated smoke tests. |
| Parse the human log for readiness | Log wording is not a protocol; a dedicated JSON line is unambiguous. |
| Kill the child only on normal quit | Leaves agents and code-server behind after a launcher crash; pipe EOF also handles that case. |

## Failure modes

- Missing bundled core, occupied port or invalid configuration: startup
  fails with a localized dialog and a bounded stderr tail; the owned child
  is stopped before showing the dialog.
- Unexpected core or renderer exit: report the error and quit; reopening
  starts a fresh owned core. No restart loop runs unattended.
- Electron crash: the pipe closes and Go cancels its context. A normal
  quit allows agent cleanup before SIGKILL; force-killed agents retain their
  existing orphan-reaping and idle-timeout protection.
- No local herdr session running: the existing machine status UI shows the
  error; the desktop shell does not bootstrap or alter herdr sessions.
- Downloaded ad-hoc signed app blocked by Gatekeeper: explicit user approval
  can be required; this build is not a notarized distribution.

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
renderer and child windows have no Node integration or preload bridge;
sandboxing, context isolation and web security are enabled. Navigation and
native popups are restricted to the exact owned core origin; external links
accept only credential-free HTTP(S), with other schemes refused. Permissions
require both the requesting frame and its top window to belong to the core;
only notifications, clipboard reads and sanitized clipboard writes are
allowed. Clipboard reads let VS Code paste text copied in other apps; the
browser UI grants its frame the same permission, where the browser asks once,
while the desktop app has no prompt. The existing
HTTP guards, API allowlist, read-only behavior and CSP remain in force.
See [SECURITY.md](../../SECURITY.md) for the local HTTP trust boundary.

## Testing

`cmd/herdr-ide/parent_test.go` covers readiness, pipe EOF/error cancellation
and surviving writes to broken stdout pipes. `desktop/src/*.test.ts` cover
isolation arguments, URL and permission policy, spawn failures, malformed
readiness, ephemeral ports, unexpected exits, late child errors and idempotent
child shutdown, using fake Node children and no network or real herdr
sessions. `make check test` includes desktop type, format and unit checks
(outside macOS without downloading Electron). macOS CI packages the app for
pull requests and builds the DMG on `main`; packaged smoke tests use `HERDR_IDE_DESKTOP_DEV=1` and an
isolated home/session, checking load, popup restrictions and child cleanup.
