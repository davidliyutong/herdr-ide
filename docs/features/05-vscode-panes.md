# 05 · VS Code panes

## Context

Terminals are the primary surface, but reviewing an agent's work needs code
browsing, diffs, Git history and media previews, and users want VS Code
extensions such as Git Graph. VS Code must open on demand beside the
terminals, on the machine of the pane it comes from, at its working
directory, without covering them: a panel laid over the panes on a window
that is not wide enough hides the terminals, and with them the keys and
buttons that would close it. VS Code is therefore a pane like a terminal,
with its share of the split tree.

## Goals / non-goals

Goals: real VS Code with extensions on every machine; opened from panes and
terminal links, as a tab or beside the pane it came from, and moved,
maximized and closed as any pane; back after a reload; works without
internet on machines; costs nothing when not used.

Non-goals: replacing the terminal as the main surface; syncing VS Code
settings between machines; the app's keys inside VS Code beyond those VS
Code leaves (and `pane.close`, below).

## Design

**Provisioning** (`internal/codeserver`, agent `codeserver.go`)

- The `codeServer.install` setting (settings dialog, also per machine in
  its scope, or `--code-server-install` for every machine) picks how a
  machine gets code-server; `codeServer.path` names an installed one, also
  per machine:
  - `push` (default): the release for the machine's platform is resolved on
    the core host ([09](09-air-gapped-installs.md)), uploaded through the
    agent and unpacked into `~/.herdr-ide/code-server/<version>` (shared by
    instances);
  - `download`: the agent fetches the same release URL with the machine's
    curl or wget (its proxy and CA settings apply), checks the digest the
    core sends and unpacks it into the same place;
  - `existing`: the agent runs a code-server already on the machine (the
    `codeServer.path` setting or `--code-server-path`, an absolute or `~/`
    path, else `PATH` and the usual install locations); the core's requests
    then carry its path (`Header.Bin`).
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
- While code-server is being prepared, a VS Code pane shows a page that
  polls `/api/m/<machine>/code/status` and translates the phase codes, or
  the error that stopped it.

**VS Code panes** (`web/src/term/layout.ts`, `web/src/actions.ts`,
`web/src/codeFrames.ts`, `web/src/components/CodeLayer.tsx`)

- A VS Code pane is a leaf `{"code": {"id", "folder"}}` of a tab's split
  tree in the machine's layout document
  ([22](22-terminal-protocol.md)), named `code:<id>` there: VS Code of that
  machine for the folder (`""`: the one code-server opens). Like a
  terminal's it can be split beside (the new terminal starts in its
  folder), dragged by its header to swap with another pane or to move
  beside one, into another tab or a new tab, maximized, closed (which ends
  nothing) and be a tab's only pane; every client shows it, and it is back
  after a reload. A preview of a file is a pane the same way
  ([06](06-quick-look-and-files.md)).
- Where VS Code opens:

  | From | Opens | Reuses |
  | --- | --- | --- |
  | **Open in VS Code** (`code.open`: a terminal header's button, the pane menu, the palette, `cmd+j` in the desktop app on macOS, `ctrl+shift+j` in the desktop app elsewhere) | a new tab of the selected workspace, for the terminal's directory (the focused pane's for the key), else the workspace's folder | the workspace's VS Code pane for that folder, in any tab: it is selected |
  | **Show Changes in VS Code** (`code.diff`), **Open Git Graph** (`code.gitGraph`) | a split to the right of the pane they came from, then runs the command there | the VS Code pane of that tab for that folder |
  | cmd/ctrl+click on a file in a terminal, **Open … in VS Code** in its menu | the file at its line in a VS Code pane of the terminal's workspace, else in a split beside the terminal, for the terminal's directory or the workspace's when the file is below it, else for the file's directory | of the workspace's VS Code panes: one of the terminal's tab whose folder holds the file, then one of another tab that holds it, then any of the terminal's tab, then any |

  A pane opened or reused this way is shown and gets the keyboard.
- Each VS Code pane on screen is a same-origin iframe of its own
  (`/m/<machine>/code/?folder=`), a VS Code window. Moving an iframe in the
  document reloads it, so the iframes live in one layer over the panes and
  are placed over their pane's body (`.code-slot`), following its size and
  place; moving the pane, maximizing it, or switching tab, workspace or
  machine only places the iframe elsewhere or hides it. The layer covers
  the workspace's area of the page (not the sidebar or the status bar) and
  clips to it; iframes are placed relative to it, so they move with the
  workspace when the sidebar opens or changes width, and one not placed
  again yet cannot draw over the sidebar. The window resizing, the layer
  resizing and a slot resizing place them again. The layer lies
  above the panes' bodies and below the split handles, a header's menu,
  dialogs and menus.
- An iframe is made when its pane comes on screen, so a layout with many
  VS Code panes starts no window for those not shown. A window off screen
  stays loaded, so coming back is instant, for 10 minutes and among the 3
  off screen used most recently; then it is unmounted, which closes its
  connection and lets the core stop that machine's idle code-server. A pane
  closed in the layout (by any client) unmounts its window at once; one of
  a machine whose layout is not read keeps it until it expires.
- Pressing a VS Code pane (its header or VS Code itself) gives it the
  keyboard and makes it its tab's focused pane, as a terminal pane is made.
- The header: VSCodium's mark (`web/src/assets/vscodium`, MIT, recolored
  to the text's color), the folder's name (its tooltip names the
  machine and the folder), the folder's path, and **Reload VS Code**, the
  split buttons, maximize, the pane's menu on narrow panes, close. The menu
  has these and **Stop VS Code on <machine>**, which stops that machine's
  code-server (freeing its memory there): this page's VS Code panes of the
  machine then say so and offer to start it again, which loads them again.
  A tab holding no terminal shows the pane's mark and folder name in the
  tab bar instead of its number.
- A disabled machine's windows are unmounted and its VS Code panes say so;
  enabling the machine loads them again. In read-only mode, where the proxy
  refuses VS Code, a VS Code pane says that VS Code is not available.
- Keys typed in VS Code are VS Code's, and the page runs none of its own
  bindings for them. VS Code keeps its own keys:
  `cmd+j` there shows or hides its bottom panel, `cmd+p` and
  `cmd+shift+p` are its own. In the desktop app on macOS a key VS Code
  leaves reaches the application menu, whose commands then act on the
  VS Code pane that has the keyboard, as on a terminal pane
  ([04](04-layout-and-keyboard.md)). The key of `pane.close` (`cmd+w` in
  the desktop app on macOS) is the one key the page takes before VS Code
  sees it (a listener on the iframe's window, in the capture phase): it
  closes the VS Code pane, as it closes a terminal pane, where VS Code
  would close an editor (VS Code's editors close with their tab's ×).

**Theme** (`theme` WebSocket message, `bridgeHub.setTheme`)

- The browser sends the light/dark kind in use (`{t: "theme", kind}`) on
  connect and when it changes. The core keeps the last one and sends it to
  every bridge window, and to each window when it connects.
- The extension switches `workbench.colorTheme` to the user's
  `workbench.preferredLightColorTheme` / `preferredDarkColorTheme` unless
  the current theme is already of that kind, so a chosen theme is kept.
  VS Code's settings are per instance (`cs-data` in the instance's
  directory on the machine), so all browsers of one core share the last
  choice. The loading page reads the language and theme from the embedding
  page.

**Bridge** (`extensions/herdr-ide-bridge`, `internal/server/bridge.go`)

- The extension runs in code-server's extension host on the machine and
  connects to `$HERDR_IDE_BRIDGE_SOCKET`, which the agent tunnels to the core.
  It announces its window (a random id per extension host), its workspace
  folders and whether it has the keyboard, and says when it gets the
  keyboard. Each iframe is a window of its own; the core tells the pages
  which window got the keyboard (`bridge.focus`), and the page whose iframe
  has the keyboard, in the window that has it, learns which window that
  iframe shows when the folders match.
- The core routes UI commands (`openFile` (path, line, column), `openDiff`
  (multi-file "View Changes"), `gitGraph` (repository root), `openMedia`,
  `reveal`) to a window: the one the page names, else, for an iframe the
  page has just created (`fresh`), the first window of that folder that
  connects after the request, else the window showing the folder (waiting
  up to 60 s for the iframe to load, accepting a containing folder after a
  grace period, the window used last among several). Its reply names the
  window, which the page keeps for that iframe. So a command reaches the
  pane it was meant for, also when other panes or other browsers show the
  same folder.
- **Send to Agent** in the editor sends `@file:lines` plus the selection;
  the core adds the sending window's id and folders (`bridge.send`). The
  page whose VS Code pane shows that window (known, or the pane whose iframe
  has the keyboard in the page that has it) pastes it, unsubmitted, into an
  agent of the pane's tab, else of the pane's workspace (those waiting for
  input first), else into the workspace's terminal focused last on that
  page; never into another workspace's (another project's agent): without
  one a note names the workspace. A window of no pane of the page with the
  keyboard (VS Code opened on its own) sends to the focused terminal on that
  machine, else its agent waiting for input; other pages ignore it.
- **Download (folders as zip)** in the explorer's menu (several entries can be
  selected) sends their paths; the core passes them to the browsers as
  `bridge.download` with the window's id, and the page showing that window
  (else the page with the focus) downloads them through
  `/api/m/<machine>/download`: one file as itself, folders and several
  entries as one zip ([06](06-quick-look-and-files.md)). A VS Code window
  opened on its own has no app page, so nothing downloads there; VS Code's
  own **Download…** remains.

**Downloads in VS Code**

- VS Code's own **Download…** saves a file up to 32 MB as a plain browser
  download, and folders and larger files through the File System Access API
  into a folder the user picks. Only Chromium-based browsers have that API,
  and only on `localhost` or HTTPS; elsewhere VS Code cannot save folders. The
  desktop app grants the API to the core's frames
  ([16](16-desktop-packaging.md)).
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
| Routing a download to the exact page of the VS Code window | The extension host does not know which page shows its window; the page learns it when the window reports the keyboard while its pane's iframe has it, and the page with the focus decides otherwise. |
| A panel docked beside or below the panes | On a narrow window it covered the terminals, the keys that would close it (the terminal could not take them) and its own close button; a pane takes its share of the tab and covers nothing. |
| The iframe inside its pane's element | Moving the pane, switching tabs or workspaces re-parents or unmounts the element, and VS Code reloads; the layer keeps every iframe where it is in the document. |
| One VS Code window per machine and folder, shared by the panes showing it | Two panes of one folder can be on screen together in a tab, and an iframe has one place; one window per pane also tells which pane a command or a Send to Agent is for. |
| Telling the extension its pane through the iframe's URL | The extension host runs on the machine and sees neither the page's URL nor its storage; the window's focus, which it does see, is matched with the iframe that has the keyboard. |
| Keeping every VS Code window loaded | Each is a whole workbench in the browser, and its connection keeps code-server from stopping when idle; windows off screen are bounded by time and count instead. |
| Taking every app key from VS Code | VS Code's own keys (`cmd+p`, `cmd+shift+p`, `cmd+j`, `cmd+1…9`) are what its users expect there; only closing the pane, which VS Code's `cmd+w` would make close an editor, goes to the app first. |
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
  window containing the folder, then reports an error; a fresh pane's
  command waits up to 60 s for its window.
- **The page does not know a pane's window yet** (its iframe never had the
  keyboard) → the page gives the pane the keyboard and waits up to 1.5 s
  for the window to report it, then the core goes by folder, the window
  used last first.
- **A window off screen was unmounted** (10 minutes, or more than 3) →
  showing its pane loads it again; code-server restores its editors, and
  starts again first if it was stopped as idle.
- **The layout document starts over** (the terminal core's state was
  removed) → its VS Code panes go with it; their windows are unmounted.
- **Two cores on one machine (same instance)** → the bridge socket stays with
  the first agent; the other logs that VS Code commands go to that core.
  Separate instances avoid this.

## Security

The socket directory is 0700 and the socket 0600; `--auth none` is safe only
because nothing else can connect. The proxy strips the proxy-secret header
and adds `X-Frame-Options: SAMEORIGIN`. Read-only mode refuses VS Code.
Window ids are random per extension host and broadcast to every page; a
command naming one goes through the same guarded, audited
`POST /api/m/{id}/bridge` as one naming a folder, which read-only mode
refuses.

code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is off: it
would serve whatever listens on a port of the machine, including another
user's service on a shared machine, with the UI's origin, where its scripts
could open `/ws` and type into every pane. code-server is started with
`--disable-proxy`, and the core refuses those paths (any case) itself, which
also covers a code-server started by an earlier build that is still reused.
VS Code's "open in browser" links for forwarded ports therefore do not work.

## Testing

- `internal/codeserver/artifacts_test.go` (resolution and verification),
  `internal/codeserver/manager_test.go` (`TestInstallMode`,
  `TestRecordDigest`).
- `internal/agent/codeserver_test.go`: finding an installed code-server
  (`TestCodeServerExistingBin`), verified machine downloads
  (`TestCodeServerDownload`), start flags (`TestCodeServerArgsDisableProxy`),
  a listener that does not serve VS Code replaced
  (`TestCodeServerReplacesBrokenListener`).
- `internal/server/server_test.go`: bridge window selection
  (`TestBridgePick`; `TestBridgeTargets`: a named window, the window used
  last, a fresh pane's window that connects after the request although
  others show the folder), idle tracking (`TestCodeServerIdleTracking`),
  theme broadcast (`TestBridgeTheme`), refused port proxy paths
  (`TestCodeServerPortProxyRefused`), the sending window's folders and id
  in `bridge.send` and `bridge.focus` (`TestBridgeSendToAgent`);
  `internal/server/download_test.go` (`TestBridgeDownload`:
  `bridge.download` to browsers, with the window's id).
- `design/testdata/layout/views.json`: VS Code panes in the layout
  document (open, split, swap, move, close, kept by pruning, unknown
  shapes kept as nodes).
- `web/src/__tests__/codePanes.test.ts`: where each entry point opens
  VS Code and which pane it reuses, previews, splitting and closing a
  VS Code pane, stopping and reloading; the windows (one per pane on
  screen, kept off screen, expiry and limit, closed panes, machines without
  VS Code), their placement over the pane, learning a pane's window, the
  commands' window or `fresh`, where Send to Agent goes; the browser keys of
  the earlier panel dropped. `web/src/__tests__/desktop.test.ts`: Open in VS Code
  by the menu, the menu's commands acting on the VS Code pane that has the
  keyboard, `cmd+w` taken from VS Code. `paneHeader.test.ts` (a VS Code
  pane's header), `tabLabels.test.ts` (a VS Code tab's label).
- `web/src/__tests__/download.test.ts` (only the focused page downloads),
  `desktop/src/policy.test.ts` (the File System Access permission).

VS Code's
own Download… was traced in code-server 4.144.0: up to 32 MB it is a blob
download, which reaches Electron's `will-download`. The fallback from `existing` to
`push` and the theme switch in both directions were verified with
code-server 4.144.0 in Chrome.
Provisioning, Git Graph through the bridge and arm64 installs were verified
on a macOS host and an arm64 Linux VM. VS Code panes were verified with
code-server 4.144.0 in headless Chrome (a tab, the changes and Git Graph in
a split, a cmd+click at a line, a swap by dragging, maximizing, a reload,
two panes of one folder with a command reaching the one it was meant for,
Send to Agent, headers at 1400, 800 and 600 px) and in the desktop app on
macOS (an image preview's and Git Graph's webviews; `cmd+j` and `cmd+w`
with VS Code's iframe focused).
