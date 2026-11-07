# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Program windows that keep changing (a simulator, a rotating 3D plot) are
  sent as video: H.264 through NVENC on NVIDIA GPUs or VA-API on Intel and
  AMD GPUs, else VP8 on the CPU, decoded in the browser with WebCodecs; once
  a window settles it is sent again as an exact picture. On by default
  (`gui-video`, also per machine in the settings). The core brings the
  encoder for linux/amd64 and linux/arm64 machines and pushes it to them;
  without WebCodecs (plain HTTP on a LAN) or when encoding fails, windows
  are sent as pictures. Measured with the MuJoCo viewer: 58 frames per
  second at 1.7 Mbit/s, against 29 pictures at 30 Mbit/s before, and 58
  instead of 8 on a 10 Mbit/s link.
- Program windows: `#stats` at the end of a program window's address shows
  frame statistics: what the machine spent capturing and encoding, the
  frames and bytes the browser received and how long it took to decode and
  draw them, and the time from capture to the picture being drawn.
- Desktop app: drag folders from Finder onto the sidebar or the app's Dock
  icon to create a workspace for each on the local machine. A drop on the
  Dock icon also launches the app, and the workspaces appear once the local
  machine is connected.
- Files dragged onto a pane are pasted as their paths. Files not on the
  pane's machine are uploaded into the pane's directory there first, under
  their own names (`-1`, `-2`… when taken; nothing is replaced); in the
  desktop app, files dropped on a pane of the local machine are pasted where
  they are. The pane shows what a drop does while files are over it.
  Before, only pasting files uploaded them, and a file dropped on the page
  replaced it in a browser.
- Right-clicking a pane opens a menu to copy the selection, paste, and
  preview, open in VS Code or copy the path (or URL) under the pointer or
  selected, also in programs that report the mouse such as Claude Code
  (programs no longer get the right button). Without a selection of the
  page, Copy (and ⌘/Ctrl+C) copies what the pane's program copied from its
  own selection. Before, the desktop app showed no menu at all.
- Every pane of a split tab has its own buttons in its header: program
  windows, VS Code, changes, Git Graph, split right / down, zoom and close,
  acting on that pane. The toolbar above the panes is shown only for a lone
  pane, as its header. Nothing is drawn over a pane's terminal any more.
- Setting **Programs copying to the clipboard** (terminal section):
  automatic, ask or off.
- Right-click a machine in the sidebar to disable or enable it (a disabled
  machine also has an **Enable** button). The choice is saved by herdr-ide
  (`machines.json` beside its settings) over herdr's saved machines and
  applies at once; disabling a connected machine asks first and keeps its
  panes running in herdr.
- Desktop app: `cmd+,` and **Settings…** in the app menu open the settings,
  `cmd+n` (File → New Workspace) creates a workspace, and `cmd+j` (View →
  Show or Hide VS Code) hides the VS Code panel or shows the last one again,
  also from inside VS Code (`desktop-settings-key`,
  `desktop-new-workspace-key`, `desktop-toggle-code-key`, changeable under
  Settings → Shortcuts; VS Code keeps its own `cmd+,` and `cmd+n`). The
  Tab menu is now the File menu.
- `make desktop-install` builds the macOS app and installs it into
  `/Applications`, quitting and reopening a running copy.

### Changed

- Program windows are captured through shared memory and encoded on
  several cores: a 1706×960 window takes about 4 ms to capture and encode
  as JPEG instead of 15–17 ms. How much a window may have on its way follows
  the connection (about twice what it delivers in a round trip) instead of
  three frames. The MuJoCo viewer's pictures are drawn at 48 whole windows
  per second instead of 29, 36 ms instead of 46 ms after capture; on a link
  they fill, they arrive as before.
- A program's copy (OSC 52) goes on the clipboard at once when it follows
  your own key or click in a pane within 10 s, such as selecting text in
  Claude Code, with a short toast saying what was copied; other copies, or
  ones the browser refuses, still wait for the toast's **Copy** button.
  Before, every copy needed that click.
- Pasted files' paths reach the pane as a paste instead of typed text, the
  way a terminal delivers dropped files.
- A tab is shown when it is pressed, not when the click is released, and a
  drag (of a tab, workspace or pane) starts only after the pointer moved on
  the screen. In macOS full screen the menu bar sliding down moved the page
  under the pointer, so clicking a tab often started reordering it instead.
- Clicking "Display on … failed" in the status bar shows the error, how it
  is retried, and buttons to copy it or open the settings; before, the error
  was only in a tooltip.

### Fixed

- Machines no longer stay *degraded* on slow or congested links: herdr
  drops an API connection whose request has not arrived within 5 s, and the
  core now sends the request with the stream instead of after the agent's
  reply, which could queue behind pane surfaces and program windows.
- **Retry** on a *degraded* machine reconnects it; before, it did nothing
  while the agent stayed connected. Read-only browsers cannot retry, and a
  session younger than 5 s is kept.
- After the network changed or the computer slept, a machine reconnects
  without waiting a minute for the old ssh connection: the core tells an
  ssh control master whose connection stopped answering to take no new
  sessions, so the next connection opens a new one.
- The panes of a machine that reconnects (after a network loss, or when it
  is enabled again) show again within seconds, instead of after the
  surface's reconnect backoff of up to 16 s.
- Stopping herdr's server on a machine no longer leaves its virtual
  display (Xvfb) running for six hours: the display lasts while the server
  runs, programs use it or the core is connected, and ends a minute after.
- Moving the window to a display with another pixel density (for example
  from a Retina screen to a 1x external monitor) no longer changes the
  terminal text's size: the cell is measured again for the new display.
- Selecting text by dragging is smooth, also while the drag scrolls past a
  pane's edge: only rows whose highlight changed are painted, scrolled rows
  are copied on the canvas instead of painted again, text is painted about
  three times faster, and scrolling past the edge keeps its speed (and
  speeds up while held) however long herdr takes to answer.
- The desktop app's title bar follows the UI's theme: a dark UI on a light
  macOS no longer has a white title bar.
- A path or URL wrapped over several rows, by the terminal or by a program
  such as Claude Code, is one link: ⌘/Ctrl+click opened only the part on
  the row under the pointer.

## [0.2.0] - 2026-11-01

### Changed

- Panes are drawn from the cell grid herdr renders through its endpoint
  protocol (generation 1, on herdr's client socket) instead of one
  `herdr terminal session` and one xterm.js terminal per pane. herdr encodes
  keys and mouse events for each pane's modes (application cursor keys,
  kitty keyboard protocol, mouse reporting), sends focus events, and
  answers programs' color queries with the UI theme's colors; OSC 52 from
  programs offers a **Copy** button for 5 s (pane output never writes the
  clipboard by itself) and the bell flashes the pane area. Selections stay inside their pane. Pane headers sit on the top
  border herdr draws. Requires herdr 0.9.5 or newer on every machine.
- One browser tab uses the session at a time, like a KVM console: another
  tab can take it over and the previous one says so. This replaces the
  control/observe arbitration of panes between browsers. A read-only
  browser never takes the session from a writable one.

### Added

- Each tab has one toolbar above its panes, a single row however many panes
  it has, with the focused pane's title and folder and buttons for program
  windows, VS Code, the repository's changes, Git Graph, split, zoom and
  close. Its title renames the pane, it has the pane's menu and drags the
  pane. Pane headers no longer carry buttons, and a lone pane, which has no
  border row since panes are drawn from herdr's grid, no longer gets a
  header that shows on hover. In narrow workspaces the toolbar drops the
  folder, the title and less used buttons instead of overflowing.
- Desktop app: `cmd+t` opens a tab and `cmd+w` closes the current tab after
  asking (`ctrl+shift+t` / `ctrl+shift+w` on other systems). While VS Code
  has focus, both keys stay VS Code's (`cmd+w` closes the editor). Keys
  follow the keyboard layout's characters, so `cmd+z` on AZERTY stays undo.
  They are core settings (`--desktop-new-tab-key`, `--desktop-close-tab-key`),
  recorded or removed under **Settings → Shortcuts**, and shown in the new
  **Tab** menu. Browsers are unchanged.
- Release archives for Linux/macOS on amd64/arm64 include herdr 0.9.5
  (verified at build time against pinned SHA-256 digests) with its license
  and dependency notices. The local machine uses it when no herdr is
  installed; it keeps herdr's usual configuration, sessions and machines.
  SSH machines still use their own herdr.
- `herdr-ide herdr [args]` runs the included herdr with the arguments and
  environment unchanged.
- **Manage herdr** (context menu of the local machine): start, stop and
  restart the local herdr server, and check for and install herdr updates for
  the application's copy of herdr through herdr's own updater, without a
  terminal. The server is never started automatically; local herdr
  installations of the user's are not updated.
- **Update herdr** for SSH machines (context menu, and a hint when a
  machine's herdr is older than the local one) runs herdr's own
  `herdr --remote` in a terminal, where herdr asks before installing its
  version there or replacing a running server.
- Terminal-pane app icon shared by the desktop and browser, with editable
  SVG sources, small-size artwork and a multi-resolution macOS ICNS for
  the app and DMG; regenerate with `make desktop-icons`.
- macOS Electron packaging: `make desktop-app` and `make desktop-dmg`
  produce an ad-hoc signed `.app` and a drag-to-Applications DMG for arm64
  or x64. The sandboxed desktop shell owns its bundled core, preserves the
  web UI and supports internal program/VS Code windows and external links.
  The app includes the bundled herdr and its notices. GitHub releases attach
  arm64 and x64 DMGs, covered by `SHA256SUMS` and build provenance like the
  archives; CI no longer uploads DMGs from `main`.
- `--parent-stdio` reports core readiness as JSON and stops on parent-pipe
  EOF; `make dev-desktop` uses the isolated development session and instance.
- Ignored `.worktrees/` directory for branch workspaces.
- **Terminal font weight** setting (regular or medium; medium comes close to
  Ghostty's `font-thicken`).
- **Notification sounds**: the browser plays a chime when an agent needs
  input and another when it finishes (not while its pane is on screen in a
  focused window), as herdr does in its own client. On by default with
  **Silent agents** (`droid` by default) in the new Notifications section of
  the settings. With several browsers open, only the one used most recently
  plays them. The sounds are synthesized; the desktop app's main window
  allows them without a prior click.

### Changed

- Terminals draw with JetBrains Mono 2.304, shipped in the UI (SIL Open Font
  License, listed in `licenses.md`), instead of the first monospace font a
  system happens to have (often SF Mono or Menlo), and rows are a little
  taller. The dark terminal palette is now GitHub Dark Default: brighter text
  and colors made for its background; black and dim text were nearly
  invisible before.

### Fixed

- The **Authenticate…** and **Update herdr** terminals could end before
  showing the command's last output (for example ssh's final error): the
  core now forwards what is left in the terminal before closing it.
- `make it` no longer leaves workspaces in the isolated `herdr-ide-it`
  session, where herdr restored them (each with a shell) on every later run:
  the test closes the workspaces it creates and deletes the session before
  and after the run.

## [0.1.0] - 2026-10-31

### Added

- Program windows: windows of programs on remote Linux machines (matplotlib,
  MuJoCo, …) open in browser windows, one per program window, with mouse and
  keyboard. New panes get a virtual display; Xvfb is fetched in user space
  with `apt-get download` when missing; VirtualGL renders OpenGL on the GPU
  (`vglrun`, or every program with `--gui-gpu=all`). Settings `--gui` and
  `--gui-gpu`, also per remote machine in the settings dialog, which shows
  each machine's display state. Panes opened before can be caught up
  ("Enable in open panes", or the palette for the focused pane): shells at
  their prompt get the variables typed in.
- Core settings can be defined per machine: the settings file keeps
  per-machine values, `PUT /api/settings` takes `machine`.
- A page loaded before the core was replaced offers to reload.
- `--remote-session`: use an isolated herdr session on remote machines
  (development and tests).
- Web IDE for herdr: workspaces, tabs and split layouts from herdr's socket
  API; one xterm.js terminal per pane fed by herdr terminal-session streams;
  herdr-compatible prefix keymap and command palette.
- Multiple machines from herdr's saved SSH machines, through a static agent
  (linux/macOS, amd64/arm64) uploaded automatically and multiplexed over one
  ssh session; interactive ssh authentication in the browser.
- Control/observe arbitration of panes across several browsers.
- VS Code panels via code-server per machine with Git Graph and a bridge
  extension (open files at a line, diffs, Git Graph, send code to agents).
- Preview of images, GIFs, video, audio, PDF, text and directories from
  terminal paths; uploads of pasted and dropped files.
- Agent inbox, notifications and starting agents from the palette.
- Air-gapped installs: `fetch-assets`, `--seed-dir`, `--offline`, mirror URL
  templates, pinned SHA-256 digests.
- Guardrails: loopback default, proxy secret, Host/Origin checks, herdr API
  allowlist, read-only mode, CSP, audit log.
- Reclamation of remote resources: code-server idle stop, ownership and
  orphan reaping, retention of uploads, logs and old versions; `--instance`.
- English and Simplified Chinese UI.
- Settings dialog (`prefix ,`) rendered from setting definitions: language,
  light/dark/system theme (VS Code panels follow it), interface and terminal
  font sizes, VS Code panel beside or below the terminals, Option as Meta,
  and core settings saved on the core host (`/api/settings`, flags lock them).
- code-server installation methods (`--code-server-install`): uploaded by the
  core, downloaded by each machine (verified), or an existing install
  (`--code-server-path`), with fallback to uploading.
- Dragging panes by their header to swap them, place them beside another pane
  or move them to another or a new tab; renaming panes, tabs and workspaces
  in place.
- In-app dialogs for creating workspaces (folder completion on the machine,
  optional name) and for confirming closes, instead of the browser's
  `prompt()` and `confirm()`.
- Dragging tabs along the tab bar and workspaces along their machine's list
  in the sidebar to reorder them (`tab.move`, `workspace.move`).
- Context menus on pane headers, tabs and workspaces with their commands and
  key bindings, usable from the keyboard; read-only mode keeps the browser's
  menu.
- Tabs that do not fit continue on more rows instead of scrolling the tab
  bar, so every tab stays visible and can be dragged anywhere; long labels
  are cut with an ellipsis.
- Selections longer than a pane: holding a selection drag above or below
  the pane scrolls herdr's scrollback (`pane.scroll`) and extends the
  selection; copying copies the whole range, read from herdr
  (`pane.selection.read`).
- Project tooling: one-step rename with state migration, repository checks,
  pane input contract tests (browser and herdr key encodings), reproducible
  builds, third-party notices, CI, release workflow with
  checksums and build provenance (from a public repository), Dependabot.

### Fixed

- A finished agent opened by hand (not from the inbox) stayed marked as
  pending: the pane focused in the UI is now focused in herdr when it is done.
- The VS Code panel showed "Not Found" when a code-server whose installation
  had moved (after a rename) still listened on the socket: such a process is
  replaced, the rename migration stops the old code-server first, and the
  core stops the local machine's code-server when it exits.
- Tabs were shown sorted by `Tab.number`, which herdr keeps with a tab when
  it moves; tabs and workspaces now follow herdr's order, and `prefix 1..9`
  picks tabs by position. A new tab created from another workspace's menu no
  longer takes the cwd of a pane elsewhere.

### Changed

- Pane header actions use icons with larger targets and stay visible; read-only
  mode hides actions it would refuse; the VS Code loading page follows the UI
  language and theme.
- Renamed from webherdr to herdr-ide: binaries, Go module, `~/.herdr-ide`,
  `HERDR_IDE_*` variables and the `herdr-ide.herdr-ide-bridge` extension.
  Existing installs migrate on first start: machines move `~/.webherdr` to
  `~/.herdr-ide`, browsers move their stored preferences, code-server drops
  the old bridge extension and the core removes the old download cache.

### Security

- code-server's port proxy (`/m/<machine>/code/proxy/<port>/`) is disabled
  and refused by the core: it served any service listening on a machine,
  including another user's on a shared machine, with the UI's origin, where
  its scripts could type into every pane.
- Pages are served with `Referrer-Policy: same-origin` instead of
  `no-referrer`, so same-origin POSTs carry their Origin (requests from other
  sites still get no referrer).
