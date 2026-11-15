# 16 · Desktop app

## Context

The browser UI and the Go core already contain the application's features.
Desktop users also want an app they install with their system's installer
and start from the Dock, the Start menu or the application launcher, with
a core of its own and no terminal to keep open. The Electron shell is the
browser UI as such an app on macOS, Windows and Linux. VS Code webviews
depend on Chromium features and a secure loopback origin, so the shell must
preserve the existing HTTP, WebSocket and service-worker behavior.

The core reaches its machines through agents: the local machine's inside
the core, the SSH machines' over OpenSSH ([02](02-multi-machine-transport.md)).
The agent relies on POSIX: unix sockets with peer checks, process groups,
code-server and the Xvfb displays of program windows. It is built for
Linux and macOS only (`//go:build unix`). Upstream publishes a
herdr-core archive for Windows (0.1.21), but this repository pins none
(`internal/hcdist`), and the agent does not run on Windows. On Windows, the
app is therefore a client of SSH machines.

## Goals / non-goals

Goals: one shell for macOS (arm64, x64), Windows (x64) and Linux (x64,
arm64), with each system's installers and conventions (menus, quitting,
window frames, folders opened with the app); automatic core ownership and
cleanup through a mechanism that works on all three; safe renderer windows;
a native menu with the UI's commands and the core's keybindings that never
takes a key from a terminal; the title bar and menu following the core's
theme and language; reproducible dependency resolution; release builds that
need no secret, with optional Developer ID signing and notarization on
macOS; a development mode that cannot touch the daily instance's state or
terminals.

Non-goals: a local machine on Windows (WSL is not built in; a WSL
distribution running an ssh server can be added as an SSH machine); the
interactive ssh login on Windows; Windows on arm64; universal macOS
binaries; automatic updates; signing the Windows and Linux packages;
replacing browser access.

## Design

**What differs per system** (`desktop/src/platform.ts`). Everything that
depends on the system is a function of `process.platform`, so every
system's rules run in the tests on any of them:

- `APP_ID` (`dev.<slug>.desktop`, also electron-builder's `appId`): the
  macOS bundle identifier and the Windows AppUserModelID, which the shell
  sets with `app.setAppUserModelId`. Windows shows an app's notifications
  only under the id of its Start menu shortcut, which the setup gives the
  same id.
- `keyPlatform`: the keybindings of the `mac` platform on macOS and `pc`
  elsewhere; the page picks the same (`web/src/keybindings.ts`).
- `coreBinary`: `bin/<slug>` (`bin/<slug>.exe` on Windows) in the packaged
  app's resources, or the `dist/<slug>-<goos>-<goarch>[.exe]` that
  `scripts/build.sh` wrote, unpackaged.
- `quitsWithLastWindow`: closing the main window quits on Windows and
  Linux; on macOS the app stays in the Dock with its core.
- `foldersOf`: the folders a Linux command line names (below).

**Building** (`scripts/desktop.sh`, `desktop/electron-builder.cjs`)

- The script builds the core for the app's system and architecture
  (`TARGETS=<goos>/<goarch> scripts/build.sh`: the web UI, the bridge
  extension, the four agents, herdr-core for machines and, when built, the
  video encoders), then the shell, then runs electron-builder. Modes:
  `build` (the core, web UI and shell only), `app` (the unpacked app),
  `dist` (this system's installers), `install` (macOS: the `.app` copied
  into `/Applications`) and `dev` (unpackaged Electron). `ARCH` is `arm64`
  or `x64` (default the host Node's; `x64` is Go's `amd64`; Windows is x64
  only). `DESKTOP_OS=mac|win|linux` packages another system's unpacked app
  (`build` and `app` only) to check its packaging; installers and `dev`
  run on their own system. `SKIP_BUILD=1` runs electron-builder alone on
  what `build` made.
- The core is an executable resource outside ASAR, `bin/<slug>[.exe]`,
  with the notices laid out as in the release archives (`LICENSE`,
  `THIRD_PARTY_NOTICES.md`, the web bundle's `licenses.md`,
  `licenses/herdr-core/`, `licenses/herdr-detect/`, `licenses/encoder/`);
  the shell and `assets/icon.png` (the Linux window icon) live inside
  ASAR. The `beforePack` hook refuses a core built for another
  architecture than the Electron app, and a missing core or notices.
- Artifacts are `dist/desktop/<name>-<version>-<os>-<arch>.<ext>`:
  - macOS: a DMG with an Applications shortcut and a zip, `mac-arm64` and
    `mac-x64` (x64 with the Intel Electron and a cross-compiled core, also
    on an Apple Silicon Mac). Hardened runtime; signed ad hoc, the core
    included, unless a certificate is given (`CSC_LINK` with
    `CSC_KEY_PASSWORD`, or `CSC_NAME` of a keychain identity): then
    Developer ID, and notarized when `APPLE_ID`,
    `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set too.
  - Windows: `win-x64.exe`, a one-click NSIS setup that installs for the
    user (`%LOCALAPPDATA%\Programs\<slug>-desktop\`, no administrator
    rights) with a Start menu shortcut and an uninstaller; unsigned.
  - Linux: AppImages (`linux-x86_64`, `linux-arm64`) and Debian packages
    (`linux-amd64`, `linux-arm64`, the arm64 ones also from an x64 host),
    unsigned. The deb (package `<slug>-desktop`) installs into
    `/opt/<name>/`, links `/usr/bin/<slug>`, writes
    `/usr/share/applications/<slug>.desktop` (category Development,
    `MimeType=inode/directory;`) and hicolor icons of 16–512 px, which
    electron-builder generates from the ICNS, depends on
    electron-builder's usual libraries plus `libasound2` (Electron links
    ALSA; `libasound2t64` provides it on Debian 13 and Ubuntu 24.04) and
    recommends `openssh-client`; its homepage is the release workflow's
    repository or the checkout's origin. On Ubuntu 24.04 and later its
    after-install script (electron-builder's) installs an AppArmor
    profile that lets Chromium's sandbox create user namespaces. The
    `desktopName` `<slug>.desktop` (`linux.syncDesktopName`) is Electron's
    app id on Wayland, its window class on X11 and the name the launcher
    badge needs.
  - Unpacked apps: `mac-arm64/`, `mac/` (x64), `win-unpacked/`,
    `linux-unpacked/`, `linux-arm64-unpacked/`.
- `install` mode (`make desktop-install`, macOS) copies the `.app` into
  `/Applications` (`INSTALL_DIR` names another directory) for development:
  a copy running from there gets SIGTERM, which quits it like the menu, so
  its core stops before the files change; the new copy is placed beside
  the old one first and opened again afterwards.
- Without `VERSION` the core reports `git describe` as in
  `scripts/build.sh`; the app metadata then uses `desktop/package.json`. A
  release tag's leading `v` stays in the core's version and is dropped for
  the app metadata, which must be semver.
- Releases: the tag's release workflow builds each installer on its own
  system, beside the archive build: macOS arm64 and x64 on `macos-26`,
  Windows x64 on `windows-2025`, Linux x64 and arm64 on `ubuntu-24.04`. One
  step (`scripts/desktop.sh build`) builds everything without any secret;
  the next, **Package** (`SKIP_BUILD=1 scripts/desktop.sh dist`), runs
  electron-builder alone and is the only one that receives, on macOS, the
  optional Developer ID certificate and notarization credentials. A final
  job writes one `SHA256SUMS` over the archives and installers, attests
  provenance for all of them and creates the release only after every
  build succeeded. Pull requests and `main` package the unpacked app on
  each of the three systems, so CI artifacts never stand in for releases.

**The owned core** (`desktop/src/core.ts`, `desktop/src/main.ts`)

- The shell owns one child core. `--parent-stdio` adds one JSON readiness
  message to stdout and cancels the core when stdin closes. Logs stay on
  stderr, and the core ignores SIGPIPE so that writing to the pipes of a
  crashed launcher fails instead of killing it before cleanup. The core is
  spawned with `windowsHide`, since Windows would give the console program
  a console window. Failed binding never connects the UI to an unrelated
  listener. The shell has a 30 s startup timeout.
- Stopping closes the core's stdin, on every system: Windows has no signal
  a process can clean up after (Node's `kill` terminates it there). The
  core allows 3 s for HTTP and 15 s for its agents; after 20 s the shell
  kills that child only. Agent and code-server cleanup is the core's
  usual. When the system logs out, restarts or shuts down (Windows reports
  it with the main window's `session-end`, macOS and Linux with
  `powerMonitor`'s `shutdown`), the shell closes the core's stdin and quits
  without waiting, because delaying the quit would cancel or hold up the
  system's request.
- Startup and core failures are reported with English/Chinese messages from
  the web dictionaries, in the language of `appearance.language` once the
  shell has read it (else the system's); exit codes and similar details
  are appended as is.
- Production uses loopback port 7781 and instance `desktop`. A stable
  origin keeps what the page stores per browser (the sidebar, panel sizes,
  transfer history) and the permissions granted to it; an explicit port
  override is available (`HERDR_IDE_DESKTOP_PORT`). Settings and
  keybindings are the core's, in the instance's files. Development uses
  port 7791 and instance `dev` (terminal core session `herdr-ide-dev`), or
  the instance `HERDR_IDE_DESKTOP_DEV` names (`1` is `dev`; lowercase
  letters, digits and dashes, at most 32, not `desktop`, else a startup
  error), so that a smoke test can run beside a development instance in
  use; every development instance is local-only. Unpackaged runs always
  use development mode, and packaged runs opt into it with that variable.
  Each instance has its own Electron profile and single-instance lock
  (`<slug>-desktop`, `<slug>-desktop-dev`, `<slug>-desktop-<instance>`);
  `--user-data-dir` on the command line replaces the profile and its
  lock, for smoke tests beside another copy.
- On macOS and Linux the core's PATH gains `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin` and the system directories,
  without executing a shell, because Finder and desktop launchers load no
  shell startup files. On Windows the core gets the environment as it is.
  The app carries the notices of the herdr-core its core embeds in
  `licenses/herdr-core/` ([21](21-terminal-core.md)) and of herdr's agent
  detection rules in `licenses/herdr-detect/`. OpenSSH is the system's.
  The desktop shell does not start or stop terminal cores; the web UI
  starts, restarts and stops a machine's terminal core
  ([22](22-terminal-protocol.md)). The inherited environment and SSH
  configuration remain available to the core.

**Windows, quitting and window frames**

- macOS: closing the main window leaves the app in the Dock with its core,
  as Mac apps do; clicking the Dock icon (`activate`), a second launch, a
  folder opened with the app or a menu item opens a new main window.
  Quitting (the menu, ⌘Q) stops the core. Windows and Linux: closing the
  main window quits, and program windows do not keep the app open; a
  second launch focuses the main window.
- Each system's native window frame and title bar. On Windows and Linux
  the menu bar is in the window; on Linux the main window gets the app's
  icon (macOS and Windows take it from the application). About shows the
  name and version on every system (`app.setAboutPanelOptions` on Windows
  and Linux; macOS reads its bundle).
- The shell follows its core (`desktop/src/follow.ts`): it holds its own
  event channel (`/ws`), reads `GET /api/settings` and
  `GET /api/keybindings` when it opens and applies the `settings` and
  `keybindings` messages after every change; if the channel drops it
  opens it again after 0.5 s, doubling to 8 s. `appearance.theme`
  (`system`, `dark` or `light`) becomes Electron's
  `nativeTheme.themeSource`: the title bar, native controls and the window
  background (`color.background` of `design/tokens.json`) follow the UI's
  theme, also when it differs from the system's appearance; `system`
  follows the system. `appearance.language` is the language of the menu
  and the error dialogs; `auto` follows the system's preferred languages.
- **Zoom.** `window.zoom` (percent, 50–300, 100 by default) is the zoom of
  the app's windows, as VS Code's `window.zoomLevel` is: the shell sets
  the main window's page to it (`webContents.setZoomFactor`) whenever the
  setting changes and after each page load. Chromium keeps a zoom per
  origin, so the app's other windows on the core's origin (program
  windows, VS Code's own) have it too. **Zoom In**, **Zoom Out** and
  **Reset Zoom** (`view.zoomIn`, `view.zoomOut`, `view.zoomReset`, in the
  View menu and the palette; ⌘+ or ⌘=, ⌘− and ⌘0 on macOS, Ctrl with the
  same keys on Windows and Linux; commands for everywhere, so they run
  while a dialog is open too, and on macOS from a text field or VS Code
  through the menu, which holds ⌘+, ⌘− and ⌘0) step the setting through Chromium's levels (50, 67, 75, 80,
  90, 100, 110, 125, 150, 175, 200, 250, 300); the settings dialog sets
  any whole percent. The setting is the only place the zoom is kept:
  Electron's own zoom is not persisted, the menu has no zoom roles and the
  page's keys never zoom by themselves. A zoom scales everything,
  terminals included: their pixel ratio changes with it, so each terminal
  measures its cells again at the new ratio (sharp text) and fits its grid
  to its pane's new size, which resizes the program
  ([26](26-web-terminals.md)). Interface text size
  (`appearance.uiFontSize`) and the terminal font size stay what they are
  inside the zoom. In a browser the commands do not run, the setting is
  not shown, and the browser's zoom keys work as ever.

**The menu** (`desktop/src/menu.ts`, `menusFor`)

- macOS: the application's menu (About, Settings…, Keyboard Shortcuts,
  Hide, Hide Others, Show All, Quit), then Shell, Edit, View and
  **Window** (Minimize, Zoom, Bring All to Front and, as macOS's Window
  menu, the list of windows). Windows and Linux: **File** (Settings…,
  Keyboard Shortcuts, Quit, titled Exit on Windows), Shell, Edit, View,
  **Window** (Minimize) and **Help** (About). The other menus are the same
  everywhere: **Shell** (New Tab, Split Right, Split Down, New, Rename and
  Close Workspace…, Rename Tab, Close Pane, Close Tab, Add Machine…),
  **Edit** (Undo, Redo, Cut, Copy, Paste, Select All, Find…, Find Next,
  Find Previous), **View** (Command Palette…, Go to Workspace…, Go to Agent
  Needing Attention, Toggle Sidebar, Toggle VS Code Panel, Maximize Pane,
  next and previous tab, workspace and pane, focusing the pane in each
  direction, Zoom In, Zoom Out, Reset Zoom, Toggle Full Screen). Items of commands have the commands'
  names (`command.<id>`), as the palette, the keyboard shortcuts page and
  the tooltips have them; menus and Electron's roles (Edit's Undo … Select
  All, Hide, Zoom, Full Screen…) are titled with the web UI's
  `desktop.menu.*` strings, in English and Chinese.
- Each command item shows the first single-stroke key the keybindings give
  its command (the registry's defaults until the core answers), and the
  menu is rebuilt when the keybindings or the language change. The page
  sees a key first, matches it itself and cancels the keys it runs
  ([04](04-layout-and-keyboard.md)).
- On macOS the menu registers the keys with Cmd, so it acts on those the
  page left (a text field, VS Code or another window has the keyboard);
  Chromium's text fields edit with Cmd keys only through the Edit roles.
  Keys without Cmd are shown but not registered, since macOS would offer
  them to a menu before the page. Such a key therefore runs its command
  only where the page matches keys itself: in a terminal or elsewhere in
  the page outside text fields and VS Code's panel. A command for
  everywhere (Show or Hide VS Code) bound to a key without Cmd does not
  run from a text field or from VS Code.
- On Windows and Linux the menu registers no key at all (its items and
  roles have `registerAccelerator: false`) and only shows them: every key
  goes to the page and its terminals, where Ctrl+C, Ctrl+M or Ctrl+Q are
  the programs' keys, and Chromium's text fields edit with Ctrl keys by
  themselves. A key typed in a text field, in VS Code's panel or in
  another window thus runs no command of the menu; its item does.
- An item chosen sends its command to the main window's page, which runs
  it where it applies (`web/src/desktop.ts`); with a program window or one
  of VS Code's own windows in front, closing a pane or a tab closes that
  window instead. The page tells the shell which commands cannot run now
  (`desktopShell.setDisabledCommands`, sent again whenever that changes:
  no terminal for pane commands, one tab for next and previous tab, one
  pane for focus moves, a dialog or the palette open for the commands of
  the main UI, read-only mode), and their items are disabled
  (`MenuItem.enabled`, kept when the menu is rebuilt). The shell takes the
  list only from the main window's page, as command ids, and uses those of
  its menu's items (`parseDisabled`). One chosen anyway (by its key) where its command does
  not apply does nothing.

**The page's bridge, dropped and opened folders**

- The main window has a preload (`desktop/src/preload.ts`, sandboxed) that
  exposes one object, `desktopShell` (`web/src/shell.ts`): the commands of
  menu items chosen, where a dropped file is on disk, and the folders
  opened with the app. The page sends only whether it takes opened
  folders and which commands' items to disable; messages count only from
  the top frame of the main window showing the core's origin. Program windows have no preload.
- The bridge's `pathForFile` returns where a file the user dropped on the
  page is on disk (`webUtils.getPathForFile`; Electron removed
  `File.path`), and an empty string for a File made in JavaScript or
  anything else. On macOS and Linux, folders dropped from the file manager
  on the sidebar thus become workspaces on the local machine, whose core
  runs on the same computer ([04](04-layout-and-keyboard.md)), and files or
  folders dropped on a pane of the local machine are pasted as their own
  paths instead of being uploaded ([06](06-quick-look-and-files.md)). It
  is answered in the preload; nothing goes to the main process.
- Folders opened with the app: on macOS the app's Info.plist declares
  folders (`public.folder`, rank `None`: the Dock accepts dropped folders,
  but the app never becomes Finder's opener for them), so folders dropped
  on the Dock icon arrive as `open-file`, also the ones that launch the
  app; macOS reports the items of one request in a row, and `open -a`
  passes any file. On Linux the desktop entry offers the app for folders
  (`MimeType=inode/directory;`), and a file manager's Open With passes them
  on the command line, as paths or `file:` URLs, to the first launch or,
  through `second-instance`, to the running one; `foldersOf` takes the
  arguments after the executable (and the app's directory when Electron
  runs unpackaged), ignores switches and counts the items that are not
  directories. Windows opens none, since no agent runs on its local
  machine. The shell keeps a request's folders and the number of other
  items (`desktop/src/folders.ts`) until the page asks for them through
  the bridge's `onOpenFolders`, which the page does on load and the shell
  forgets when the page navigates, its renderer goes or the window closes;
  it then sends them to the main page and brings the window forward. The
  page creates the workspaces as for folders dropped on the sidebar and
  notes how many other items it skipped ([04](04-layout-and-keyboard.md)).
  Unpackaged development runs on macOS use Electron's own Info.plist and
  get no Dock drops; `open -a` still reports folders there.
- On Windows the local machine is listed in error with
  `local_unsupported` ([02](02-multi-machine-transport.md)): the page
  takes no folder drops on the sidebar and makes no workspaces from opened
  folders.

**Notifications and the badge.** The page's notifications are the web
Notification API, granted by the shell's permission policy, and its count
of blocked agents is the Badging API (`navigator.setAppBadge`,
[07](07-agent-native-workflow.md)); the settings **System notifications**
and **Badge count** turn each off, and the page then shows none and clears
the badge. Electron shows the count as the Dock
icon's badge on macOS, as an overlay on the taskbar button on Windows, and
on Linux through the Unity launcher API (D-Bus `LauncherEntry`), which
docks that implement it show for the desktop entry `<slug>.desktop`.
Windows shows notifications of the installed app (its Start menu shortcut
carries the AppUserModelID); Linux needs a notification daemon on the
session bus (`org.freedesktop.Notifications`), which desktop environments
run.

**Brand and icons.** The web brand constants and English/Chinese message
dictionaries are imported into the shell; build metadata (`appId`,
`productName`) reads the same brand file. The app icon shows three
terminal panes: a blue primary pane with a white prompt and two smaller
green/slate panes, representing several machines in one workspace.
`desktop/assets/icon.svg` is the 1024-unit master with an inset
rounded-square body, transparent outer margins and restrained depth.
`web/public/icon.svg` is an optically adjusted flat version for small sizes
and the browser/PWA. `make desktop-icons` (`scripts/icons.sh`, macOS with
librsvg and `iconutil`) regenerates the committed `icon.png` (1024 px),
`icon.icns` (16–1024 px) and `icon.ico` (PNG entries of 16–256 px, packed
by a small Node snippet); the entries up to 32 px use the simpler drawing.
Builds need no icon tools. The macOS app and DMG use the ICNS, the Windows
setup and executable the ICO, the Linux packages icons generated from the
ICNS; development sets the Dock icon from the PNG.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Reimplement the UI for desktop | Duplicates terminal rendering, layout and VS Code integration. |
| Tauri/WKWebView | The project's VS Code webviews require Chromium service-worker behavior. |
| Attach to an existing server on a well-known port | Cannot prove ownership or safely reclaim it; might attach to another instance. |
| Always choose a random port | Browser storage and permissions are per origin; what the page keeps per browser (sidebar, panel sizes, transfer history) would be lost at every launch. An explicit port `0` remains useful for isolated smoke tests. |
| Parse the human log for readiness | Log wording is not a protocol; a dedicated JSON line is unambiguous. |
| Kill the child only on normal quit | Leaves agents and code-server behind after a launcher crash; pipe EOF also handles that case. |
| Stopping the core with SIGTERM | Windows has no signal a process can clean up after; closing stdin stops the core the same way on every system. |
| A local machine on Windows (the agent ported, a Windows herdr-core pinned) | The agent's sockets and peer checks, process groups, code-server and Xvfb displays are POSIX; it would be a port of the agent, and the repository pins no Windows herdr-core. |
| WSL built in | A WSL distribution running an ssh server is reached as an SSH machine through the same transport. |
| The sign-in terminal on Windows | Win32-OpenSSH has no ControlMaster, so a login would hold nothing for the BatchMode connections that follow (and the core opens no PTY there); keys in the ssh agent and an accepted host key serve instead. |
| Registering the menu's keys on Windows and Linux as on macOS | The standard roles' keys (Ctrl+C, Ctrl+M, Ctrl+Q…) are programs' keys in terminals; the page already runs every binding it sees, and text fields edit with Ctrl keys without the menu. |
| Quitting when the main window closes on macOS | Mac apps stay in the Dock until quit; the core keeps its machines, so the window reopens at once. |
| Only an AppImage on Linux | On Ubuntu 24.04 and later AppArmor keeps Chromium's sandbox in an AppImage from creating user namespaces; the deb installs the profile that allows it. |
| `--no-sandbox` | Turns off Chromium's renderer sandbox for everything the core serves, VS Code's extensions and webviews included. |

## Failure modes

- Missing bundled core, occupied port, invalid configuration or an invalid
  `HERDR_IDE_DESKTOP_DEV` instance: startup fails with a localized dialog
  and a bounded stderr tail; the owned child is stopped before showing the
  dialog.
- Unexpected core or renderer exit: report the error and quit; reopening
  starts a fresh owned core. No restart loop runs unattended.
- Electron crash: the pipe closes and Go cancels its context. A normal
  quit allows agent cleanup before the child is killed; force-killed
  agents retain their existing orphan-reaping and idle-timeout protection.
- The local terminal core fails to start: the machine's status in the web
  UI shows the error and offers **Start Terminal Service**; the desktop shell
  does not start or alter terminal cores.
- Windows: the local machine shows `local_unsupported` and is never
  connected. An SSH machine that needs a password, a key's passphrase the
  ssh agent does not hold, or a host key to accept shows *auth_required*
  with what to do in a terminal (`ssh <target>` once, `ssh-add`), then
  **Retry**. Without the OpenSSH Client feature every SSH machine shows
  ssh's error. A copy run from `win-unpacked/` has no Start menu shortcut,
  and Windows shows none of its notifications.
- Linux: an AppImage without FUSE 2 does not start; on Ubuntu 24.04 and
  later an AppImage cannot start Chromium's sandbox and exits (the deb
  works). Without a notification daemon no notifications appear; a dock
  without the Unity launcher API shows no badge.
- A downloaded app the system does not trust: Gatekeeper blocks an app
  signed ad hoc until the user allows it, SmartScreen warns before the
  unsigned setup runs ([deployment](../deployment.md#desktop-app)).

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
renderer and child windows have no Node integration; only the main window
has a preload, whose bridge carries menu commands (strings) and opened
folders (paths and a count, both checked in the preload) to the page and,
from it, one boolean (whether it takes opened folders); it also tells the
page the disk path of a file the user dropped on it, which a browser keeps
from pages but which reveals nothing the user did not hand over; sandboxing,
context isolation and web security are enabled on every system, and the
app is never started with `--no-sandbox` (the deb's AppArmor profile lets
Chromium's sandbox run on Ubuntu 24.04 and later). The shell reads its
settings and keybindings from its own core over loopback (`/ws`, and the
two `GET` endpoints) like any other client, behind the same guards; it
takes nothing from them but the theme, the language and well-formed
bindings, and listens on nothing. The main window alone allows audio
without a prior user gesture, so agent notification sounds ([07](07-agent-native-workflow.md)) play after
a restart before the first click. Navigation and
native popups are restricted to the exact owned core origin; external links
accept only credential-free HTTP(S), with other schemes refused. Permissions
require both the requesting frame and its top window to belong to the core;
only notifications, clipboard reads, sanitized clipboard writes, the File
System Access API and local fonts are allowed. Local fonts let the
settings' font picker list the monospace fonts installed on the computer
(their names and read-only font data), which a browser grants after asking
([13](13-settings-and-appearance.md)). Clipboard reads let VS Code paste text copied
in other apps; the browser UI grants its frame the same permission, where the
browser asks once, while the desktop app has no prompt. VS Code's
**Download…** saves folders and files over 32 MB through the File System
Access API into a folder the user picks in the native dialog (smaller files
are a plain download, which Electron saves through its save dialog); without
the permission it failed silently ([05](05-vscode-panel.md)). The existing
HTTP guards, API allowlist, read-only behavior and CSP remain in force. On
Windows the core keeps no ssh control sockets and offers no ssh login
([02](02-multi-machine-transport.md)). Release builds get no secret; only
the macOS Package step receives the optional signing and notarization
credentials. See [SECURITY.md](../../SECURITY.md) for the local HTTP trust
boundary.

## Testing

`cmd/herdr-ide/parent_test.go` covers readiness, pipe EOF/error cancellation
and surviving writes to broken stdout pipes (`TestBrokenPipesDoNotKill`
skips on Windows). `desktop/src/*.test.ts` cover what differs per system
(`platform`: the keybindings' platform, quitting with the last window and
the app id; the core's path packaged and unpackaged; folders on a command
line as paths or `file:` URLs, with switches and leading arguments left
out), the owned core (`core`: isolation arguments and development instance
names, PATH on macOS and Linux and Windows' kept as is, stopping by closing
stdin without a signal, a stuck core killed after the deadline, spawn
failures, malformed readiness, ephemeral ports, unexpected exits, late
child errors and idempotent child shutdown, with fake Node children),
opened folders waiting for the page (`folders`), the settings and
keybindings read and followed over a stand-in event channel, which is
opened again when it drops, and the zoom taken from them only within
Chromium's limits (`follow`), the menu (`menu`: every item a
registered command or a standard role titled in both languages,
accelerators, a rebinding, an unbinding, chords, and the Windows and Linux
menus: File to Help, Exit on Windows, no key registered), URL and
permission policy (`policy`) and the preload's functions against a
stand-in for Electron (`preload`), with no network or real terminal cores.
`web/src/__tests__/desktop.test.ts` covers the page's side of menu
commands (dialogs, VS Code with the keyboard), `zoom.test.ts` the zoom
commands (levels, the setting they change, when they are enabled, their
keys taken from the terminal only while bound) and `drop.test.ts` dropped
and opened folders, which a local machine with `local_unsupported` does not
take. `make check test` includes desktop type, format and unit checks
(without Electron's binary when `ELECTRON_SKIP_BINARY_DOWNLOAD=1`), and
`scripts/check.sh` vets the core for Linux, macOS and Windows. CI's
`desktop` job runs, on `ubuntu-24.04`, `macos-26` and `windows-2025`, the
Go tests (on Linux in the check job, with the race detector), the web and
desktop tests and `scripts/desktop.sh app`; the release workflow builds and
publishes the installers.

Packaged smoke tests launch the executable directly with
`HERDR_IDE_DESKTOP_DEV` and their own `--user-data-dir`. On macOS the
packaged app ran this way (an instance of its own, local-only): the UI
loaded, a terminal of the local machine ran `uname -sm` (`Darwin arm64`),
closing the main window kept the app and its core running, a second launch
reopened the window, and the Dock badge followed `navigator.setAppBadge`.
The linux-arm64 deb, built on macOS, was installed with apt in a Debian 13
arm64 container (its dependencies resolved) and run under Xvfb as a
non-root user, with `--no-sandbox` only because the container's seccomp
policy blocks Chromium's sandbox: the UI loaded with the `pc` keys
(Ctrl+Shift+P), a terminal of the local machine ran `uname -sm`
(`Linux aarch64`), a folder named on the command line became a workspace
whose terminal started in it, a second launch naming a folder and a file
(as a `file:` URL) handed both to the first, which made a workspace of the
folder and noted the skipped item, and SIGTERM quit the
app and its core (the terminal core stays, as designed). Under Xvfb WebGL2
is blocklisted and the terminals draw with Canvas 2D. The Windows setup is
built and packaged (also from macOS, with `DESKTOP_OS=win`) and covered by
the unit tests and CI's packaging.
