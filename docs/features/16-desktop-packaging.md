# 16 · Desktop app

## Context

The browser UI and the Go core already contain the application's features.
Desktop users also want an app they install with their system's installer
and start from the Dock, the Start menu or the launcher, with a core of its
own and no terminal to keep open. The Electron shell is the browser UI as
such an app on macOS, Windows and Linux. VS Code webviews depend on
Chromium and a secure loopback origin, so the shell must preserve the
existing HTTP, WebSocket and service-worker behavior.

The agent relies on POSIX (unix sockets with peer checks, process groups,
code-server, Xvfb) and is built for Linux and macOS only
(`//go:build unix`); this repository pins no Windows herdr-core
(`internal/hcdist`). On Windows the app is therefore a client of SSH
machines only ([02](02-multi-machine-transport.md)).

## Goals / non-goals

Goals:

- one shell for macOS (arm64, x64), Windows (x64) and Linux (x64, arm64),
  with each system's installers and conventions (menus, quitting, window
  frames, folders opened with the app);
- a core the app owns and cleans up the same way on all three systems;
- safe renderer windows;
- a native menu with the UI's commands and keybindings that never takes a
  key from a terminal;
- title bar, menu and dialogs following the core's theme and language;
- on macOS, a way to grant Full Disk Access to every program that needs it;
- release builds that need no secret, with optional Developer ID signing
  and notarization on macOS;
- a development mode that cannot touch the daily instance.

Non-goals: a local machine on Windows (a WSL distribution with an ssh
server can be added as an SSH machine); interactive ssh login on Windows;
Windows on arm64; universal macOS binaries; automatic updates; signing the
Windows and Linux packages; replacing browser access.

## Design

### Per-system behavior

Everything that depends on the system is a function of `process.platform`
in `desktop/src/platform.ts`, so every system's rules run in the tests on
any of them: the app id (`dev.<slug>.desktop`, also the Windows
AppUserModelID that notifications need), the keybinding platform (`mac`,
`windows` or `linux`), the core binary's path, whether closing the last window quits, and
how a Linux command line names folders.

### Building

`scripts/desktop.sh` builds the core for the target (`scripts/build.sh`),
then the shell, then runs electron-builder (`desktop/electron-builder.cjs`).
Modes: `build`, `app` (unpacked), `dist` (installers), `install` (macOS:
copy into `/Applications`) and `dev`. `DESKTOP_OS` packages another
system's unpacked app to check its packaging; `SKIP_BUILD=1` runs
electron-builder alone.

- The core is an executable resource outside ASAR (`bin/<slug>[.exe]`),
  with the notices laid out as in the release archives. On macOS the
  vault's Secure Enclave helper (`desktop/helper/Enclave.swift`, built
  universal with `swiftc`) is an app bundle of its own in
  `Contents/Helpers/`, signed with the app ([30](30-variable-vault.md)); a
  build on a Mac without `swiftc` goes on without it, with a warning. The
  `beforePack` hook refuses a core of another architecture, missing
  notices, or a macOS app without the helper.
- Artifacts (`dist/desktop/<name>-<version>-<os>-<arch>.<ext>`):
  - macOS: DMG and zip; hardened runtime; signed ad hoc unless a
    certificate is given, then Developer ID, and notarized when Apple
    credentials are set too.
  - Windows: a one-click per-user NSIS setup (no administrator rights),
    unsigned.
  - Linux: AppImage and deb, unsigned. The deb installs a desktop entry
    (`<slug>.desktop`, offered for folders) and, on Ubuntu 24.04 and later,
    an AppArmor profile that lets Chromium's sandbox create user
    namespaces.
- Release: each installer is built on its own system. The build step gets
  no secret; only the macOS **Package** step (`SKIP_BUILD=1
  scripts/desktop.sh dist`) receives the optional signing credentials. A
  final job writes `SHA256SUMS`, attests provenance, and publishes only
  after every build succeeded. Pull requests package the unpacked app on
  all three systems.

Operator details (where the app keeps its files, Gatekeeper, SmartScreen,
FUSE) are in [deployment](../deployment.md#desktop-app).

### The owned core

`desktop/src/core.ts`, `desktop/src/main.ts`, `cmd/herdr-ide/parent*.go`.

- The shell starts one child core with `--parent-stdio`. The core reads a
  hello (one JSON line) on stdin, writes a JSON readiness line on stdout,
  and stops when stdin closes. A dedicated JSON line, not log parsing,
  signals readiness. The core ignores SIGPIPE so a crashed launcher's pipes
  cannot kill it before cleanup.
- **Stopping closes stdin on every system**, because Windows has no signal
  a process can clean up after. The shell kills the child only if it has
  not exited 20 s later. On logout or shutdown the shell closes stdin and
  quits without waiting, so it never holds up the system.
- **The app's token.** VS Code has one switch for the app and one for
  browsers ([05](05-vscode-panes.md)), so the core must tell the app's
  requests from a browser's on the same computer. Each launch makes a
  random token, sends it in the hello, and sets it as a host-only,
  HttpOnly, SameSite=Strict session cookie for the core's origin before
  the window loads. Chromium then sends it with every request of the app's
  windows, VS Code's frames and WebSockets included; the core compares it
  in constant time ([08](08-web-access-and-security.md)). The token is
  never in the core's environment, which terminals and code-server
  inherit.
- The hello also carries `verify_key`, a per-launch key for the variable
  vault's presence prompts (Touch ID, Windows Hello): the shell signs the
  core's nonces with it after the prompt, showing text it takes from the
  core, never from the page, and seals the vault's unlock material for the
  core so the page relays it unread (`desktop/src/verify.ts`,
  `windowsHello.ts`, `enclave.ts`, `relay.ts`, `unlockStore.ts`,
  `keychain.ts`; [30](30-variable-vault.md)).
- Production uses port 7781 and instance `desktop`; a stable origin keeps
  what the page stores per browser and the permissions granted to it.
  `HERDR_IDE_DESKTOP_PORT` overrides the port. Development uses port 7791
  and instance `dev`, or the instance `HERDR_IDE_DESKTOP_DEV` names (never
  `desktop`); unpackaged runs are always development. Each instance has its
  own Electron profile and single-instance lock.
- On macOS and Linux the core's PATH gains `~/.local/bin`, Homebrew's and
  the system directories without running a shell, since launchers load no
  shell startup files.
- The shell never starts or stops terminal cores; the web UI does
  ([22](22-terminal-protocol.md)).

### Windows, quitting and title bar

- macOS: closing the main window leaves the app in the Dock with its core;
  the Dock icon, a second launch or an opened folder reopens it. Quitting
  stops the core. Windows and Linux: closing the main window quits; a
  second launch focuses it.
- Quitting closes the main window first and stops the core once it has
  closed. While panes have unsaved changes, the page asks: it lists the
  files, and offers **Save All**, **Don't Save** and **Cancel**
  (`desktop/src/closeGuard.ts`, `web/src/quitGuard.ts`). A page that does
  not answer quickly, or another unload objection (a VS Code window),
  falls back to Electron's native question.
- **Title bar** (`desktop/src/titlebar.ts`). On macOS the main window hides
  its title bar and places the traffic lights in the UI's top header row,
  whose empty regions drag the window. Their position follows
  `appearance.uiFontSize` and `window.zoom`; native full screen clears the
  inset. Secondary windows, and the main window on Windows and Linux, keep
  the native frame.
- **Following the core** (`desktop/src/follow.ts`). The shell is a client
  of its core's event channel (`/ws`) and settings endpoints, reconnecting
  with backoff. `appearance.theme` becomes `nativeTheme.themeSource`, so
  native chrome follows the UI's theme even when it differs from the
  system's; `appearance.language` is the menu's and dialogs' language.
- **Zoom.** `window.zoom` (percent) is the zoom of the app's windows, like
  VS Code's `window.zoomLevel`. The setting is the only place the zoom is
  kept: Electron's own zoom is not persisted and the page's keys never
  zoom by themselves. **Zoom In**, **Zoom Out** and **Reset Zoom** step it
  through Chromium's levels. Terminals re-measure their cells at the new
  pixel ratio and refit their grid ([26](26-web-terminals.md)). Browsers
  keep their own zoom.

### The menu

`desktop/src/menu.ts`.

- Each system's layout: macOS has the application menu and a Window menu
  with the window list; Windows and Linux have File (Exit on Windows) and
  Help. Shell, Edit and View are the same everywhere. Items carry the
  commands' names and the first single-stroke key bound to them, and the
  menu is rebuilt when keybindings or language change.
- **The page sees every key first** and runs the bindings itself
  ([04](04-layout-and-keyboard.md)). The menu therefore registers keys only
  where that cannot steal one from a terminal:
  - macOS registers Cmd keys only, so the menu acts where the page does not
    (text fields, VS Code panes, other windows); keys without Cmd are shown
    but not registered, since macOS would offer them to the menu first.
  - Windows and Linux register no key at all: Ctrl+C, Ctrl+M or Ctrl+Q
    belong to the terminal's programs.
- A chosen item sends its command to the main window's page
  (`web/src/desktop.ts`). The page tells the shell which commands cannot
  run now, and those items are disabled.

### The page's bridge

The main window has a sandboxed preload (`desktop/src/preload.ts`,
channels in `desktop/src/bridge.ts`) exposing one object, `desktopShell`
(`web/src/shell.ts`). The shell accepts messages only from the top frame
of the main window on the core's origin, and checks their shape. Program
windows and browser-pane webviews have no preload.

- Shell to page: menu commands, folders opened with the app, the
  unsaved-changes question, native full-screen state, clicked
  notifications' targets, and pages a browser pane opened as windows
  ([32](32-browser-and-ports.md)).
- Page to shell: whether it takes opened folders, the disabled commands,
  the number of unsaved panes, the close answer, Full Disk Access actions,
  native notifications, and the vault's Touch ID / Windows Hello requests.
- `pathForFile` (answered in the preload) gives a dropped file's disk path,
  so folders dropped on the sidebar become local workspaces and files
  dropped on a local pane are pasted as paths
  ([06](06-quick-look-and-files.md)).
- `metrics` reports the app's Electron processes for the Performance page
  ([13](13-settings-and-appearance.md)); the core reports itself.

**Folders opened with the app** (`desktop/src/folders.ts`). On macOS the
app declares folders with rank `None`, so the Dock accepts dropped folders
without the app becoming Finder's opener. On Linux the desktop entry offers
the app for folders and the paths (or `file:` URLs) arrive on the command
line, also through `second-instance`. The shell holds them until the page
asks, and the page creates workspaces as for sidebar drops. Windows opens
none: its local machine is `local_unsupported`.

### Full Disk Access (macOS)

`desktop/src/privacy.ts`, `web/src/fullDiskAccess.ts`,
`web/src/components/settings/FullDiskAccess.tsx`,
`internal/agent/privacy.go`.

macOS has no request for Full Disk Access: the user turns it on in System
Settings. It checks the process it holds responsible, which children
inherit:

- The core is the app's child and code-server the core's, so the file
  browser and VS Code access files as **the app**.
- Terminals access them as **herdr-core**: it runs the terminal core as a
  launchd job and its holders disclaim inherited responsibility, so a
  terminal's programs have what
  `~/.herdr-ide[-<instance>]/hosts/<host>/hc/herdr-core` was granted. Starting the core
  as the app's child would not change this.

Both need the grant. The Terminal settings page shows a **Permissions** row
in the desktop app on macOS only. `GET /api/m/local/privacy` probes by
opening and closing a folder only Full Disk Access opens: in the agent's
own process for the app, and through `/bin/sh` run by the terminal core
(`machine.exec`) for terminals. `EPERM` is **Not granted**, success
**Granted**, anything else or no terminal core **Unknown**. Nothing is
read and no terminal core is started.

The row's buttons open System Settings at Full Disk Access and reveal
herdr-core in Finder (a hidden folder the **+** dialog does not show). A
grant applies to processes started afterwards, so the row offers the
matching restart:

- **Restart Terminal Service…** for terminals; open terminals keep their
  old holder until closed.
- **Quit and Reopen…** for the app: a helper has Launch Services open the
  bundle once the app is gone, so the new app is its own responsible
  process (`app.relaunch()` would make it the old one's child; only
  development uses it).

A grant is tied to the program's designated requirement. An ad hoc
signature makes it the code hash, so each new build needs the grant again;
with a Developer ID it survives updates. herdr-core is signed with Herdr's
Developer ID, so its grant survives reinstalls at the same path.

### Notifications, badge and icons

- Notifications are native (`desktop/src/notifications.ts`): the page
  asks through the bridge, both sides validate and bound title, body, tag
  and click target (a pane, chat or panel), and active ones are
  deduplicated by tag and bounded. A click shows the main window (on macOS
  reopening it) and hands the target to the page, queued while it loads.
  Without native notifications the page falls back to the web Notification
  API ([07](07-agent-native-workflow.md)). Windows shows them only for the
  installed app (its Start menu shortcut carries the AppUserModelID);
  Linux needs a notification daemon.
- The blocked-agent count uses the Badging API. Electron shows the badge
  on the Dock (macOS), as a taskbar overlay (Windows) and through the
  Unity launcher API (Linux).
- The shell imports the web brand constants and message dictionaries;
  electron-builder's metadata reads the same brand file.
- `desktop/assets/icon.svg` is the master icon and `web/public/icon.svg` a
  simplified version for small sizes. `make desktop-icons`
  (`scripts/icons.sh`) regenerates the committed PNG, ICNS and ICO; builds
  need no icon tools.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Reimplement the UI for desktop | Duplicates terminal rendering, layout and VS Code integration. |
| Tauri/WKWebView | VS Code webviews require Chromium's service-worker behavior. |
| Attach to an existing server on a well-known port | Cannot prove ownership; might attach to another instance. |
| Always choose a random port | Per-origin storage and permissions would be lost at every launch. |
| Parse the human log for readiness | Log wording is not a protocol. |
| Kill the child only on normal quit | Leaves agents behind after a launcher crash; pipe EOF covers both. |
| Stop the core with SIGTERM | Windows has no signal a process can clean up after. |
| A local machine on Windows | The agent is POSIX; it would be a port, and no Windows herdr-core is pinned. |
| WSL built in | A WSL distribution with an ssh server already works as an SSH machine. |
| The sign-in terminal on Windows | Win32-OpenSSH has no ControlMaster, so a login holds nothing for later connections. |
| Register menu keys on Windows and Linux | Ctrl+C, Ctrl+M, Ctrl+Q are programs' keys in terminals. |
| Quit when the main window closes on macOS | Mac apps stay in the Dock until quit. |
| Only an AppImage on Linux | AppArmor blocks Chromium's sandbox in an AppImage on Ubuntu 24.04+. |
| `--no-sandbox` | Turns off the renderer sandbox for everything the core serves. |
| Full Disk Access for the app alone, terminal core as its child | herdr-core's holders disclaim responsibility anyway, and terminals must outlive the app. |
| Check Full Disk Access in the shell's process | Shows only the app's access, not herdr-core's. |
| Read the privacy database (`TCC.db`) | Needs Full Disk Access itself; private format. |
| `app.relaunch()` for **Quit and Reopen…** | The new app would be the old one's child and not responsible for itself. |

## Failure modes

- Missing core, occupied port, invalid configuration or development
  instance: startup fails with a localized dialog and a bounded stderr
  tail, after stopping the child.
- Unexpected core or renderer exit: the error is reported and the app
  quits; reopening starts a fresh core. No unattended restart loop.
- Electron crash: the pipe closes and the core cancels; force-killed agents
  are covered by orphan reaping and idle timeouts
  ([10](10-remote-resource-lifecycle.md)).
- Local terminal core fails to start: the web UI shows the error and offers
  **Start Terminal Service**.
- Windows: the local machine shows `local_unsupported`. An SSH machine that
  needs a password, an unloaded key passphrase or a host key shows
  `auth_required` with what to run once in a terminal. A copy run from
  `win-unpacked/` shows no notifications (no Start menu shortcut).
- Linux: an AppImage needs FUSE 2 and cannot sandbox on Ubuntu 24.04+ (the
  deb works). No notification daemon means no notifications; a dock
  without the Unity API shows no badge.
- Full Disk Access: an ad hoc build that was rebuilt keeps its switch on in
  System Settings but reads **Not granted** until re-added.
- Gatekeeper blocks an ad hoc app until allowed; SmartScreen warns before
  the unsigned setup ([deployment](../deployment.md#desktop-app)).

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security):

- No Node integration in any renderer; sandboxing, context isolation and
  web security on every system; never `--no-sandbox`.
- Only the main window has a preload; its bridge accepts messages only from
  the main window's top frame on the core's origin, checks their shape, and
  exposes nothing beyond the channels above. A dropped file's path reveals
  only what the user handed over; `metrics` reports kinds and amounts,
  nothing processes hold.
- Navigation and popups are limited to the exact core origin; external
  links accept only credential-free HTTP(S). Browser-pane webviews are
  forced into their own sandboxed partition with no preload
  (`desktop/src/policy.ts`, [32](32-browser-and-ports.md)).
- Permissions require the frame and its top window to be the core's; only
  notifications, clipboard read and sanitized write, the File System Access
  API (VS Code's **Download…**) and local fonts (the font picker) are
  allowed.
- The shell reads its settings over loopback like any client, behind the
  same guards, takes only appearance settings and well-formed bindings,
  and listens on nothing.
- Full Disk Access requests carry nothing from the page: one fixed System
  Settings URL, the instance's own herdr-core path, the app's own bundle.
  The probes open a folder without reading it.
- The launch token identifies the app's windows to the core; it is not
  authentication against other local processes, which reach the loopback
  core anyway.
- Release builds get no secret except the macOS Package step's optional
  signing credentials.

See [SECURITY.md](../../SECURITY.md) for the local HTTP trust boundary.

## Testing

- `cmd/herdr-ide/parent_test.go`: the hello, readiness, cancellation on
  pipe EOF, surviving broken pipes.
- `desktop/src/*.test.ts` (fake Electron and Node children, no network):
  `platform`, `core` (token, cookie, stop by closing stdin, kill after
  deadline, spawn and readiness failures), `folders`, `follow`, `menu`
  (items, accelerators, per-system menus, no keys registered on Windows and
  Linux), `policy`, `privacy`, `preload`, `closeGuard`, `titlebar`,
  `notifications` (validation, bounds, tag deduplication, click targets),
  `verify`, `windowsHello`, `enclave`, `relay`, `unlockStore`, `keychain`.
- `web/src/__tests__/`: `quitGuard`, `desktop` (menu commands),
  `zoom`, `drop` (dropped and opened folders), `fullDiskAccess`.
- `internal/agent/privacy_test.go`, `privacy_op_test.go` and the server
  tests: the probes, the op and the endpoint; `TestIntegrationHC` runs the
  probe through a real herdr-core.
- CI's `desktop` job runs the Go, web and desktop tests and
  `scripts/desktop.sh app` on Ubuntu, macOS and Windows.
- Packaged smoke tests launch the executable with `HERDR_IDE_DESKTOP_DEV`
  and their own `--user-data-dir`; the macOS app and the linux-arm64 deb
  (in a Debian 13 container under Xvfb) were run this way.
