# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Panes are drawn from the cell grid herdr renders through its endpoint
  protocol (generation 1, on herdr's client socket) instead of one
  `herdr terminal session` and one xterm.js terminal per pane. herdr encodes
  keys and mouse events for each pane's modes (application cursor keys,
  kitty keyboard protocol, mouse reporting), sends focus events, and
  answers programs' color queries with the UI theme's colors; OSC 52 from
  programs offers a **Copy** button (pane output never writes the clipboard
  by itself) and the bell flashes the pane area. Selections stay inside their pane. Pane headers sit on the top
  border herdr draws. Requires herdr 0.9.5 or newer on every machine.
- One browser tab uses the session at a time, like a KVM console: another
  tab can take it over and the previous one says so. This replaces the
  control/observe arbitration of panes between browsers. A read-only
  browser never takes the session from a writable one.

### Added

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
