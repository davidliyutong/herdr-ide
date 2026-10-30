# 05 · VS Code panel

## Context

Terminals are the primary surface, but reviewing an agent's work needs code
browsing, diffs, Git history and media previews, and users want VS Code
extensions such as Git Graph. The panel must open on demand next to the
terminals, on the machine of the focused pane, at its working directory.

## Goals / non-goals

Goals: real VS Code with extensions on every machine; opened from panes and
terminal links; works without internet on machines; costs nothing when not
used.

Non-goals: replacing the terminal as the main surface; syncing VS Code
settings between machines.

## Design

**Provisioning** (`internal/codeserver`, agent `codeserver.go`)

- The `code-server-install` setting (settings dialog or flag) picks how a
  machine gets code-server:
  - `push` (default): the release for the machine's platform is resolved on
    the core host ([09](09-air-gapped-installs.md)), uploaded through the
    agent and unpacked into `~/.herdr-ide/code-server/<version>` (shared by
    instances);
  - `download`: the agent fetches the same release URL with the machine's
    curl or wget (its proxy and CA settings apply), checks the digest the
    core sends and unpacks it into the same place;
  - `existing`: the agent runs a code-server already on the machine
    (`code-server-path`, or `PATH` and the usual install locations); the
    core's requests then carry its path (`Header.Bin`).
  `download` and `existing` fall back to `push` (logged); `--offline` skips
  `download`. A change applies the next time code-server starts on a
  machine, since a running process is reused.
- The bundled Node is run once after unpacking; if it fails (old glibc), the
  error is reported and the rest of herdr-ide keeps working.
- Extensions are installed from VSIX files uploaded by the core: the
  embedded bridge extension and the default extensions (Git Graph). Markers
  in the extensions directory skip reinstallation.
- Start flags: unix socket only (`--socket … --socket-mode 600`), `--auth
  none` (the socket directory is private), telemetry and update checks off,
  workspace trust off, `--reconnection-grace-time 300`,
  `--idle-timeout-seconds 3600`.

**Proxy** (`internal/server/codeserver.go`)

- `/m/<machine>/code/…` is reverse-proxied to the agent's `cs.sock` through a
  yamux stream (`dial-unix`), WebSockets included; the prefix is stripped and
  the Host header preserved (code-server compares Origin with Host).
- While code-server is being prepared, the panel shows a page that polls
  `/api/m/<machine>/code/status` and translates the phase codes.
- The panel is a same-origin iframe, one per machine, kept while used;
  `?folder=` selects the workspace folder (the focused pane's cwd). It sits
  beside the terminals or below them (a setting, also toggled from the
  panel's header); width and height are remembered per browser.

**Theme** (`theme` WebSocket message, `bridgeHub.setTheme`)

- The browser sends the light/dark kind in use (`{t: "theme", kind}`) on
  connect and when it changes. The core keeps the last one and sends it to
  every bridge window, and to each window when it connects.
- The extension switches `workbench.colorTheme` to the user's
  `workbench.preferredLightColorTheme` / `preferredDarkColorTheme` unless
  the current theme is already of that kind, so a chosen theme is kept.
  Settings are per instance, so all browsers of one core share the last
  choice. The loading page reads the language and theme from the embedding
  page.

**Bridge** (`extensions/herdr-ide-bridge`, `internal/server/bridge.go`)

- The extension runs in code-server's extension host on the machine and
  connects to `$HERDR_IDE_BRIDGE_SOCKET`, which the agent tunnels to the core.
  It announces its window id and workspace folders.
- The core routes UI commands to the window that shows the requested folder
  (waiting up to 60 s for the iframe to load, accepting a containing folder
  after a grace period): `openFile` (path, line, column), `openDiff`
  (multi-file "View Changes"), `gitGraph` (repository root), `openMedia`,
  `reveal`.
- **Send to Agent** in the editor sends `@file:lines` plus the selection; the
  browser pastes it, unsubmitted, into the focused agent pane.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Official `code serve-web` | Microsoft Marketplace and Pylance, but the server build is fetched by the CLI at runtime, licensing limits redistribution, and the user chose code-server (Open VSX). |
| openvscode-server | No macOS builds. |
| Remote-SSH from desktop VS Code | Not in the browser; no integration with panes. |
| Driving the iframe from the page | VS Code exposes no command API to the embedding page; the extension host runs on the machine. |
| Reverse ssh socket forward for the bridge | Replaced by the agent's listener tunnelled over the existing yamux session. |

## Failure modes

- **code-server crashes or the agent reconnects** → proxy errors invalidate
  the ready state; the next request runs Ensure again.
- **Something on the socket does not serve VS Code** (for example a
  code-server whose installation directory was moved or deleted: it accepts
  connections and answers `/healthz`, but every page is 404) → before reusing
  a running code-server the agent requests `/`; on an error status it stops
  the recorded process, or the socket's peer process group when there is no
  pid file, and starts a new one.
- **No window for the folder** → the bridge waits, then falls back to a
  window containing the folder, then reports an error.
- **Two cores on one machine (same instance)** → the bridge socket stays with
  the first agent; the other logs that VS Code commands go to that core.
  Separate instances avoid this.

## Security

The socket directory is 0700 and the socket 0600; `--auth none` is safe only
because nothing else can connect. The proxy strips the proxy-secret header
and adds `X-Frame-Options: SAMEORIGIN`. Read-only mode refuses the panel.

## Testing

`internal/codeserver/artifacts_test.go` (resolution and verification),
`internal/codeserver/manager_test.go` (install mode, recorded digests),
`internal/agent/codeserver_test.go` (finding an installed code-server,
verified machine downloads), `internal/server/server_test.go` (bridge window
selection, idle tracking, theme broadcast). The fallback from `existing` to
`push` and the theme switch in both directions were verified with
code-server 4.144.0 in Chrome.
Provisioning, Git Graph through the bridge and arm64 installs were verified
on a macOS host and an arm64 Linux VM.
