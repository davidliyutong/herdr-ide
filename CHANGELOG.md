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
- Project tooling: one-step rename with state migration, repository checks,
  pane input contract tests (browser and herdr key encodings), reproducible
  builds, third-party notices, CI, release workflow with
  checksums and build provenance, Dependabot.
