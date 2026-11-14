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
  none` (the socket directory is private), `--disable-proxy`, telemetry and
  update checks off, workspace trust off, `--reconnection-grace-time 300`,
  `--idle-timeout-seconds 3600`.

**Proxy** (`internal/server/codeserver.go`)

- `/m/<machine>/code/…` is reverse-proxied to the agent's `cs.sock` through a
  yamux stream (`dial-unix`), WebSockets included; the prefix is stripped and
  the Host header preserved (code-server compares Origin with Host).
- While code-server is being prepared, the panel shows a page that polls
  `/api/m/<machine>/code/status` and translates the phase codes.
- The panel sits beside the terminals or below them (a setting, also toggled
  from the panel's header); width and height are remembered per browser.

**One panel per workspace** (`web/src/state/store.ts` `docks`,
`web/src/components/Dock.tsx`)

- Each herdr workspace (machine and workspace id) has its own panel: what it
  shows (VS Code of a machine and folder, a preview, or nothing) and the
  VS Code panel it showed last. Selecting a workspace shows its panel;
  opening VS Code, a diff, Git Graph or a preview from a pane goes to the
  selected workspace's panel. Several VS Code windows (machines or folders)
  thus stay open, one per workspace, and switching workspace switches
  between them.
- The choice is kept per browser (local storage) and restored after a
  reload. A workspace closed in herdr, or a machine removed from herdr's
  machines while the page is open, takes its panel along; a machine that
  is reconnecting (no snapshot), or one a core started with fewer machines
  (`--local-only`) does not list, keeps them.
- VS Code is a same-origin iframe per machine and folder (`?folder=`, the
  focused pane's cwd when opened from a pane); workspaces showing the same
  folder share it. A window that is no longer shown stays loaded, so
  switching back is instant, for 10 minutes and among the 3 hidden most
  recently; then it is unmounted, which closes its connection and lets the
  core stop that machine's idle code-server. Windows keep their place in the
  document, since moving an iframe reloads it.
- A disabled machine's windows are unmounted and a panel showing it says so;
  enabling the machine loads it again. In read-only mode, where the proxy
  refuses VS Code, a VS Code panel kept from before shows nothing. Stopping
  code-server (the panel's power button) closes that machine's VS Code
  panels in every workspace and unmounts its windows; `cmd+j` brings one
  back, which starts code-server again.
- In the desktop app `cmd+j` (`desktop-toggle-code-key`,
  [04](04-layout-and-keyboard.md)) shows or hides the selected workspace's
  panel: an open panel (VS Code or preview) closes and the terminal gets the
  keys again; a closed one shows the VS Code panel that workspace showed
  last, as it was, while it belongs to the focused pane's machine (its window
  is kept as above, so it is usually back at once), else the focused pane's
  folder opens. It works while VS Code has focus too, so VS Code's own
  `cmd+j` (its panel) is not available there.

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
  `reveal`. With one window per machine and folder, the folder of the
  selected workspace's panel names its window, so commands reach the
  VS Code the user sees; `openFile` keeps that folder when the file is
  below it, else uses the focused pane's cwd or the file's directory.
- **Send to Agent** in the editor sends `@file:lines` plus the selection; the
  core adds the sending window's folders (`bridge.send`), and the browser
  pastes it, unsubmitted, into the focused pane when the selected
  workspace's panel shows that window, else into an agent pane (idle or done
  first) of the workspace whose panel shows it; without such a workspace,
  into the focused pane on that machine or its most attention-worthy agent.
- **Download (folders as zip)** in the explorer's menu (several entries can be
  selected) sends their paths; the core passes them to the browsers as
  `bridge.download`, and the page with the focus (the one whose VS Code panel
  the user just used) downloads them through `/api/m/<machine>/download`: one
  file as itself, folders and several entries as one zip
  ([06](06-quick-look-and-files.md)). A VS Code window opened on its own has
  no app page, so nothing downloads there; VS Code's own **Download…** remains.

**Downloads in VS Code**

- VS Code's own **Download…** saves a file up to 32 MB as a plain browser
  download, and folders and larger files through the File System Access API
  into a folder the user picks. Only Chromium-based browsers have that API,
  and only on `localhost` or HTTPS; elsewhere VS Code cannot save folders. The
  desktop app grants the API to the core's frames
  ([16](16-desktop-packaging.md)); before, it denied it and folder downloads
  failed silently.
- The bridge's **Download (folders as zip)** works in every browser and needs
  no permission: the browser streams the response from the core.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Official `code serve-web` | Microsoft Marketplace and Pylance, but the server build is fetched by the CLI at runtime, licensing limits redistribution, and the user chose code-server (Open VSX). |
| openvscode-server | No macOS builds. |
| Remote-SSH from desktop VS Code | Not in the browser; no integration with panes. |
| Driving the iframe from the page | VS Code exposes no command API to the embedding page; the extension host runs on the machine. |
| Reverse ssh socket forward for the bridge | Replaced by the agent's listener tunnelled over the existing yamux session. |
| Only VS Code's own Download… | Needs the File System Access API for folders and files over 32 MB: Chromium only, on a secure origin, and a permission the desktop app has to grant. |
| Routing a download to the exact page of the VS Code window | The extension host does not know which page shows its window; the page with the focus is the one whose panel was just used. |
| One VS Code window per machine, navigated to the folder of the selected workspace | Every workspace switch would reload VS Code; one window per folder keeps each workspace's editors as they were. |
| Keeping every workspace's VS Code window loaded | Each is a whole workbench in the browser, and its connection keeps code-server from stopping when idle; hidden windows are bounded by time and count instead. |
| One panel for all workspaces (before) | Only one VS Code at a time; opening a pane's folder replaced the window another workspace was using. |

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
- **A hidden window was unmounted** (10 minutes, or more than 3 hidden) →
  selecting its workspace loads it again; code-server restores its editors,
  and starts again first if it was stopped as idle.
- **herdr gives workspaces new ids** (for example a new session) → their
  stored panels no longer match a workspace and are dropped.
- **Two cores on one machine (same instance)** → the bridge socket stays with
  the first agent; the other logs that VS Code commands go to that core.
  Separate instances avoid this.

## Security

The socket directory is 0700 and the socket 0600; `--auth none` is safe only
because nothing else can connect. The proxy strips the proxy-secret header
and adds `X-Frame-Options: SAMEORIGIN`. Read-only mode refuses the panel.

code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is off: it
would serve whatever listens on a port of the machine, including another
user's service on a shared machine, with the UI's origin, where its scripts
could open `/ws` and type into every pane. code-server is started with
`--disable-proxy`, and the core refuses those paths (any case) itself, which
also covers a code-server started by an earlier build that is still reused.
VS Code's "open in browser" links for forwarded ports therefore do not work.

## Testing

`internal/codeserver/artifacts_test.go` (resolution and verification),
`internal/codeserver/manager_test.go` (install mode, recorded digests),
`internal/agent/codeserver_test.go` (finding an installed code-server,
verified machine downloads, start flags), `internal/server/server_test.go`
(bridge window selection, idle tracking, theme broadcast, refused port proxy
paths), `internal/server/download_test.go` (`bridge.download` to browsers),
`TestBridgeSendToAgent` (the sending window's folders in `bridge.send`),
`web/src/__tests__/workspaceDock.test.ts` (a panel per workspace, kept per
browser and dropped with its workspace or machine, windows per machine and
folder with their order, expiry and limit, disabled machines, read-only
mode, stopping code-server, the pane Send to Agent picks),
`web/src/__tests__/download.test.ts` (only the focused page downloads),
`desktop/src/policy.test.ts` (the File System Access permission). VS Code's
own Download… was traced in code-server 4.144.0: up to 32 MB it is a blob
download, which reaches Electron's `will-download`. The fallback from `existing` to
`push` and the theme switch in both directions were verified with
code-server 4.144.0 in Chrome.
Provisioning, Git Graph through the bridge and arm64 installs were verified
on a macOS host and an arm64 Linux VM.
