# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
- Project tooling: one-step rename with state migration, repository checks,
  pane input contract tests (browser and herdr key encodings), reproducible
  builds, third-party notices, CI, release workflow with
  checksums and build provenance, Dependabot.

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

### Security

- code-server's port proxy (`/m/<machine>/code/proxy/<port>/`) is disabled
  and refused by the core: it served any service listening on a machine,
  including another user's on a shared machine, with the UI's origin, where
  its scripts could type into every pane.

### Changed

- Pane header actions use icons with larger targets and stay visible; read-only
  mode hides actions it would refuse; the VS Code loading page follows the UI
  language and theme.

- Renamed from webherdr to herdr-ide: binaries, Go module, `~/.herdr-ide`,
  `HERDR_IDE_*` variables and the `herdr-ide.herdr-ide-bridge` extension.
  Existing installs migrate on first start: machines move `~/.webherdr` to
  `~/.herdr-ide`, browsers move their stored preferences, code-server drops
  the old bridge extension and the core removes the old download cache.
