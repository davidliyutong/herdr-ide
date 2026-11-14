# 16 · Desktop packaging

## Context

The browser UI and Go core already contain the application's features.
macOS users also need an app they can launch from Finder and install by
dragging it out of a disk image. The Electron shell is the browser UI as
such an app, with its own core; the native macOS application
([23](23-macos-application.md)) is a separate client of the same core
protocols. VS Code webviews depend on Chromium features
and a secure loopback origin, so a native shell must preserve the existing
HTTP, WebSocket and service-worker behavior.

## Goals / non-goals

Goals: reproducible dependency resolution, native macOS arm64/x64 `.app`
and DMG builds, automatic core ownership and cleanup, safe renderer windows,
a native menu with the macOS application's commands and the core's
keybindings, the title bar and menu following the core's theme and
language, and a development mode that cannot touch the daily instance's
state or terminals.

Non-goals: Windows/Linux installers, universal binaries, automatic updates, Developer ID signing/notarization,
or replacing browser access. The shell and packaging configuration are
separate from the Go/Web application so additional platform targets can be
implemented independently.

## Design

- `scripts/desktop.sh` builds the existing embedded application and matches
  the Go core architecture to Electron (`x64` maps to Go `amd64`).
  `desktop/electron-builder.cjs` packages the core as an executable resource
  outside ASAR, at `Contents/Resources/bin/<slug>` as `scripts/macos-app.sh`
  does, with the notices laid out as in the release archives (`LICENSE`,
  `THIRD_PARTY_NOTICES.md`, the web bundle's `licenses.md`,
  `licenses/herdr-core/`, `licenses/herdr-detect/`, `licenses/encoder/`); the
  shell lives inside ASAR. Its `beforePack` hook refuses to package binaries
  built for another architecture than the Electron app. The DMG has an
  Applications shortcut. Builds sign ad hoc with the hardened runtime, the
  core included, without notarization.
  Its `install` mode (`make desktop-install`) copies the `.app` into
  `/Applications` (`INSTALL_DIR` names another directory) for
  development: a copy running from there gets SIGTERM, which quits it like
  the menu, so its core stops before the files change; the new copy is
  placed beside the old one first and opened again afterwards.
  Without `VERSION` the core reports `git describe` as in `scripts/build.sh`;
  the app metadata then uses `desktop/package.json`. A release tag's leading
  `v` stays in the core's version and is dropped for the app metadata, which
  must be semver.
- Releases publish the DMGs: the tag's release workflow builds arm64 and x64
  in parallel on a macOS runner (x64 with the Intel Electron and a
  cross-compiled core, so no Intel runner is needed) beside the archive
  build, and a final job writes one `SHA256SUMS`, attests provenance for all
  files and creates the release only after every build succeeded. Pull
  requests and `main` only check that the `.app` packages, so CI artifacts
  never stand in for releases.
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
  the web dictionaries, in the language of `appearance.language` once the
  shell has read it (else the system's); exit codes and similar details
  are appended as is.
- Production uses loopback port 7781 and instance `desktop`. A stable origin
  keeps what the page stores per browser (the sidebar, panel sizes,
  transfer history) and the permissions granted to it; an explicit port
  override is available (`HERDR_IDE_DESKTOP_PORT`). Settings and
  keybindings are the core's, in the instance's files. Dev
  uses port 7791, instance `dev` (terminal core session `herdr-ide-dev`)
  and local-only. Unpackaged runs always use dev mode, and packaged runs can
  opt into it. Both modes have separate Electron profiles and single-instance
  locks; `--user-data-dir` on the command line replaces the profile and its
  lock, for smoke tests beside an installed copy. Closing the main window
  quits; a second launch focuses it.
- Finder PATH gains common binary locations without executing a shell.
  The app carries the notices of the herdr-core its core embeds in
  `licenses/herdr-core/` ([21](21-terminal-core.md)) and of herdr's agent
  detection rules in `licenses/herdr-detect/`. OpenSSH is user-installed.
  The desktop shell does not start or stop terminal cores; the web UI
  starts, restarts and stops a machine's terminal core
  ([22](22-terminal-protocol.md)). All inherited environment and SSH configuration
  remain available to the core.
- The shell follows its core as the macOS application does
  (`desktop/src/follow.ts`): it holds its own event channel (`/ws`), reads
  `GET /api/settings` and `GET /api/keybindings` when it opens and applies
  the `settings` and `keybindings` messages after every change; if the
  channel drops it opens it again after 0.5 s, doubling to 8 s.
  `appearance.theme` (`system`, `dark` or `light`) becomes Electron's
  `nativeTheme.themeSource`: the title bar, native controls and the window
  background (`color.background` of `design/tokens.json`) follow the UI's
  theme, also when it differs from the system's appearance; `system` keeps
  following macOS. `appearance.language` is the language of the menu and
  the error dialogs; `auto` follows the system's preferred languages.
- The application menu (`desktop/src/menu.ts`) is the macOS application's
  ([23](23-macos-application.md)): the application's menu (About, Settings…,
  Keyboard Shortcuts…, Hide, Quit), **Shell** (New Terminal, Split Right,
  Split Down, New, Rename and Close Workspace…, Rename Tab…, Close
  Terminal, Close Tab), **Edit** (Undo, Redo, Cut, Copy, Paste, Select All,
  Find…, Find Next, Find Previous), **View** (Command Palette…, Switch
  Workspace…, Toggle Sidebar, Show or Hide VS Code, Zoom Pane, next and
  previous tab, workspace and pane, Focus Pane Left, Right, Above, Below)
  and **Window** (Minimize). Edit's Undo, Redo, Cut, Copy, Paste and
  Select All are Electron's standard roles, as AppKit's actions are in the
  macOS application: Chromium's text fields, like AppKit's, edit with Cmd
  keys only through the menu. The
  macOS application's Files… and Add Machine… open its own windows; the web
  UI's sidebar adds machines. Titles are the web UI's `desktop.menu.*`
  strings, the macOS application's `menu.*` ones in English and Chinese.
  Each command item shows the first single-stroke key the keybindings give
  its command (the registry's defaults until the core answers) and the menu
  is rebuilt when the keybindings or the language change. The page sees a
  key first and cancels those it runs, so the menu acts only on keys the
  page left; keys without Cmd are shown but not registered, since macOS
  would offer them to a menu before the page
  ([04](04-layout-and-keyboard.md)). Such a key therefore runs its command
  only where the page matches keys itself: in a terminal or elsewhere in
  the page outside text fields and VS Code's panel. A command for
  everywhere (Show or Hide VS Code) bound to a key without Cmd does not run
  from a text field or from VS Code, where the macOS application's key
  matcher runs it. An item chosen sends its command to the main window's
  page, which runs it where it applies (`web/src/desktop.ts`); with a
  program window or one of VS Code's own windows in front, closing a pane
  or a tab closes that window instead. Items are not enabled and disabled
  by context as the macOS application's are (Electron's menu has no
  validation when it opens): one chosen where its command does not apply
  (a command for terminals while a dialog is open or VS Code has the
  keyboard) does nothing. The shell's core never runs
  read-only, since the shell does not pass `--read-only`, so no item needs
  disabling for that.
- The main window has a preload (`desktop/src/preload.ts`, sandboxed) that
  exposes one object, `desktopShell` (`web/src/shell.ts`): the commands of
  menu items chosen, where a dropped file is on disk, and the folders opened
  with the app. The page sends only whether it takes opened folders;
  messages count only from the top frame of the main window showing the
  core's origin. Program windows have no preload.
- The bridge's `pathForFile` returns where a file the user dropped on the page
  is on disk (`webUtils.getPathForFile`; Electron removed `File.path`), and an
  empty string for a File made in JavaScript or anything else. Folders
  dropped from Finder on the sidebar thus become workspaces on the local
  machine, whose core runs on the same Mac ([04](04-layout-and-keyboard.md)),
  and files or folders dropped on a pane of the local machine are pasted as
  their own paths instead of being uploaded ([06](06-quick-look-and-files.md)).
  It is answered in the preload; nothing goes to the main process.
- The app's Info.plist declares folders (`public.folder`, rank `None`: the
  Dock accepts dropped folders, but the app never becomes Finder's opener for
  them), so folders dropped on the Dock icon arrive as `open-file`, also the
  ones that launch the app. The shell gathers the items of one request,
  counting those that are not directories (`open -a` passes any file), and
  keeps them (`desktop/src/folders.ts`) until the page asks for them through
  the bridge's `onOpenFolders`, which the page does on load and the shell
  forgets when the page navigates or its renderer goes; it then sends them
  to the main page and brings the window forward. The page creates the
  workspaces as for folders dropped on the sidebar and notes how many other
  items it skipped, as the macOS application does
  ([04](04-layout-and-keyboard.md)). Unpackaged development runs use
  Electron's own Info.plist and get no Dock drops; `open -a` still reports
  folders there.
- The web brand constants and English/Chinese message dictionaries are
  imported into the shell. Build metadata reads the same brand file.
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
| Always choose a random port | Browser storage and permissions are per origin; what the page keeps per browser (sidebar, panel sizes, transfer history) would be lost at every launch. An explicit port `0` remains useful for isolated smoke tests. |
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
- The local terminal core fails to start: the machine's status in the web
  UI shows the error and offers **Start terminal core**; the desktop shell
  does not start or alter terminal cores.
- Downloaded ad-hoc signed app blocked by Gatekeeper: explicit user approval
  can be required; this build is not a notarized distribution.

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
renderer and child windows have no Node integration; only the main window
has a preload, whose bridge carries menu commands (strings) and opened
folders (paths and a count, both checked in the preload) to the page and,
from it, one boolean (whether it takes opened folders); it also tells the
page the disk path of a file the user dropped on it, which a browser keeps
from pages but which reveals nothing the user did not hand over; sandboxing,
context isolation and web security are enabled. The shell reads its
settings and keybindings from its own core over loopback (`/ws`, and the
two `GET` endpoints) like any other client, behind the same guards; it
takes nothing from them but the theme, the language and well-formed
bindings, and listens on nothing. The main window alone allows audio
without a prior user gesture, so agent notification sounds ([07](07-agent-native-workflow.md)) play after
a restart before the first click. Navigation and
native popups are restricted to the exact owned core origin; external links
accept only credential-free HTTP(S), with other schemes refused. Permissions
require both the requesting frame and its top window to belong to the core;
only notifications, clipboard reads, sanitized clipboard writes and the File
System Access API are allowed. Clipboard reads let VS Code paste text copied
in other apps; the browser UI grants its frame the same permission, where the
browser asks once, while the desktop app has no prompt. VS Code's
**Download…** saves folders and files over 32 MB through the File System
Access API into a folder the user picks in the native dialog (smaller files
are a plain download, which Electron saves through its save dialog); without
the permission it failed silently ([05](05-vscode-panel.md)). The existing
HTTP guards, API allowlist, read-only behavior and CSP remain in force.
See [SECURITY.md](../../SECURITY.md) for the local HTTP trust boundary.

## Testing

`cmd/herdr-ide/parent_test.go` covers readiness, pipe EOF/error cancellation
and surviving writes to broken stdout pipes. `desktop/src/*.test.ts` cover
the owned core (`core`: isolation arguments, spawn failures, malformed
readiness, ephemeral ports, unexpected exits, late child errors and
idempotent child shutdown, with fake Node children), opened folders waiting
for the page (`folders`), the settings and keybindings read and followed
over a stand-in event channel, which is opened again when it drops
(`follow`), the menu (`menu`: its structure
and titles against `macos/Sources/App/main.swift` and the macOS
application's `Localizable.strings`, accelerators, a rebinding, an
unbinding, chords), URL and permission policy (`policy`) and the preload's
functions against a stand-in for Electron (`preload`), with no network or
real terminal cores. `web/src/__tests__/desktop.test.ts` covers the page's
side of menu commands (dialogs, VS Code with the keyboard) and
`drop.test.ts` dropped and opened folders. `make check test` includes
desktop type, format and unit checks (outside macOS without downloading Electron). macOS CI packages the app for
pull requests and `main`; the release workflow builds and publishes the
DMGs. Packaged smoke tests launch the executable directly with
`HERDR_IDE_DESKTOP_DEV=1` and their own `--user-data-dir`, checking load,
the menu, popup restrictions and child cleanup.
