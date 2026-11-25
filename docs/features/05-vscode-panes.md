# 05 · VS Code panes

## Context

Terminals are the primary surface, but reviewing an agent's work needs code
browsing, diffs, Git history and media previews, and users want VS Code
extensions such as Git Graph. VS Code must open on demand beside the
terminals, on the machine of the pane it comes from, at its working
directory.

A panel laid over the panes would hide the terminals on a narrow window,
together with the keys and buttons that close it. VS Code is therefore a
pane like a terminal, with its share of the split tree.

## Goals / non-goals

Goals:

- real VS Code with extensions on every machine;
- opened from panes and terminal links, as a tab or beside the pane it came
  from, and moved, maximized and closed as any pane;
- back after a reload;
- works without internet on machines;
- costs nothing when not used.

Non-goals: replacing the terminal as the main surface; syncing VS Code
settings between machines; the app's keys inside VS Code beyond those
VS Code leaves.

## Design

### A plugin with a switch per kind of client

VS Code is the plugin `vscode` ([27](27-plugins.md); `web/src/plugins/vscode`,
`backend/features/vscode`). Its windows are served on the UI's own origin,
so any script in them (an extension, a webview) can do what the page can:
type into every machine's terminals, read and change files, use the
unlocked vault. VS Code is therefore off by default, with one switch per
kind of client ([08](08-web-access-and-security.md)):

- `plugins.vscode.enabled`: the desktop app's windows, toggled like any
  plugin;
- `plugins.vscode.browser`: browsers; turning it on first shows a dialog
  explaining the risk, whose **Enable** works only once the risk is
  acknowledged. The setting is the acceptance.

The hub tells the desktop app's requests by its launch token
([16](16-desktop-packaging.md)) and applies the requesting client's switch;
`GET /api/settings` reports the page's `client` so the UI follows the
same switch (`enableSetting` in `web/src/plugins/registry.ts`).

While off for a client:

- the UI offers no VS Code entry points; a path opened from a terminal
  shows in Quick Look; a VS Code pane in the layout says VS Code is off and
  offers to turn it on;
- the hub refuses code-server's status, start, proxy and bridge commands
  with `404 plugin_disabled`, and sends `bridge.*` messages only to pages
  whose switch is on;
- the page unregisters every service worker of the UI's origin
  (`web/src/plugins/vscode/workers.ts`), so nothing VS Code left keeps
  running.

Turning a switch off also ends running work: the client kind's proxied
requests and WebSockets close (in every browser), pending bridge commands
end, and with both switches off any code-server preparation stops. A request
re-checks the switch once it holds the context its work follows, so none
that raced the switch outlives it.

### Provisioning

`backend/features/vscode/provision.ts` and `artifacts.ts`; the agent's
side is `backend/features/vscode/machine.ts` (`machine/`), which answers
op `code-server` on the same files the Go machine build of earlier
releases used. The
`codeServer.install`
setting (global, per machine, or `--code-server-install`) picks how a
machine gets code-server:

- `push` (default): the release is resolved on the hub host
  ([09](09-air-gapped-installs.md)), uploaded through the agent with the
  digest the hub verified it by and unpacked into
  `~/.veldr/code-server/<version>-<os>-<arch>` (shared by instances); the
  machine side checks the digest before it unpacks anything;
- `download`: the agent fetches the same release with the machine's curl or
  wget and checks the digest the hub sends;
- `existing`: the agent runs a code-server already on the machine
  (`codeServer.path` or `--code-server-path`, else `PATH` and the usual
  locations).

`download` and `existing` fall back to `push`; `--offline` skips
`download`. A change applies the next time code-server starts.

The bundled Node is run once after unpacking; if it fails (old glibc), the
error is reported and the rest of the product keeps working. An archive
with an entry that would leave the release (an absolute path, `..`, a
link pointing out) is refused whole; unpacking it does not hold the node's one
thread ([42](42-typescript-backend.md#the-machine-side)). Extensions
(the bridge extension and the defaults, Git Graph) are installed from VSIX
files uploaded by the hub.

code-server listens only on a unix socket (`--socket-mode 600`) with
`--auth none` (the socket directory is private) and `--disable-proxy`;
telemetry, update checks and workspace trust are off, and it exits by
itself after an hour unused (`--idle-timeout-seconds`).

### Proxy

`backend/features/vscode/proxy.ts`, `relay.ts`. `/m/<machine>/code/…` is
reverse-proxied, WebSockets included, to the agent's `cs.sock` through a
yamux stream; the prefix is stripped and the Host header kept
(code-server compares Origin with Host). While code-server is being
prepared, the pane shows a page (`loading.ts`) that polls
`/api/m/<machine>/code/status` and shows the phase or the error.

### VS Code panes

`web/src/term/layout.ts`, `web/src/actions.ts`, `web/src/codeFrames.ts`,
`web/src/components/CodeLayer.tsx`.

A VS Code pane is a leaf `{"code": {"id", "folder"}}` of a tab's split tree
in the machine's layout document ([22](22-terminal-protocol.md)). Like a
terminal's it can be split, dragged, maximized, closed (which ends nothing)
and be a tab's only pane; every client shows it. File previews are panes the
same way ([06](06-quick-look-and-files.md)).

Where VS Code opens:

| From | Opens | Reuses |
| --- | --- | --- |
| **Open in VS Code** (`code.open`: header button, menu, palette, `cmd+j` / `ctrl+shift+j` in the desktop app) | a new tab for the terminal's directory, else the workspace's folder | the workspace's VS Code pane for that folder, in any tab |
| **Show Changes in VS Code** (`code.diff`), **Open Git Graph** (`code.gitGraph`) | a split to the right of the source pane, then runs the command | the tab's VS Code pane for that folder |
| cmd/ctrl+click on a file in a terminal | the file at its line, in a VS Code pane whose folder holds it, else a split beside the terminal | the closest such pane: same tab first, then any |

The Git plugin ([31](31-git.md)) shows changes and the graph without
VS Code; these commands remain for VS Code's own views.

**One window per pane, in a layer.** Each VS Code pane on screen is a
same-origin iframe (`/m/<machine>/code/?folder=`), one VS Code window.
Moving an iframe in the DOM reloads it, so all iframes live in one layer
over the workspace area and are positioned over their pane's slot
(`.code-slot`). Moving, maximizing or switching tab, workspace or machine
only repositions or hides them. The layer clips to the workspace area and
sits below split handles, menus and dialogs.

**Bounded windows.** An iframe is made when its pane comes on screen. A
window off screen stays loaded for instant return, but only for
10 minutes and only the 3 used most recently; then it is unmounted, which
lets the machine's idle code-server stop. A pane closed in the layout
unmounts its window at once.

**Header.** VSCodium's mark (`web/src/assets/vscodium`, MIT), the folder's
name and path, **Reload VS Code**, split, maximize and close. The menu adds
**Stop VS Code on <machine>**, which stops that machine's code-server to
free its memory. A disabled machine's windows are unmounted; in read-only
mode the proxy refuses VS Code and the pane says so.

### Keys

Keys typed in VS Code are VS Code's (`cmd+p`, `cmd+shift+p`, `cmd+j`,
`cmd+w` close its editors). In the desktop app on macOS, a key VS Code
leaves reaches the application menu, whose commands act on the focused
VS Code pane ([04](04-layout-and-keyboard.md)).

The bridge extension adds two keybindings that hand control back:

- `cmd+w` / `ctrl+w` in a window with no editor open (where VS Code would
  close its window) runs `closePane`: the hub sends `bridge.close` and the
  page whose iframe has the keyboard closes that pane (not the only pane
  of a pinned tab). Holding `cmd+w` closes the editors, then the pane.
- **Give the Keyboard Back** (`ctrl+b` on macOS, `ctrl+alt+shift+b`
  elsewhere; not while VS Code's terminal is focused) sends `bridge.leave`,
  and the page moves the keyboard to that pane's header. There
  **Open in VS Code** (`cmd+j`) returns to the pane focused before, as
  VS Code's `cmd+j` hides its panel.

### Theme

The browser sends its light/dark kind (`{t: "theme", kind}`) on connect and
on change; the hub keeps the last one and sends it to every bridge window
(`Bridge.setTheme`). The extension switches to the user's preferred
light or dark VS Code theme unless the current theme already matches.
VS Code's settings are per instance on the machine, so all browsers of one
hub share them.

### Bridge

`extensions/veldr-bridge`, `backend/features/vscode/bridge.ts`.

The extension runs in code-server's extension host on the machine and
connects to `$VELDR_BRIDGE_SOCKET`, which the agent tunnels to the hub.
It announces its window (a random id), its folders and keyboard focus.
The extension host cannot see the page's URL, so a page learns which window
its iframe shows by matching the window that reports focus with the iframe
that has the keyboard.

The hub routes UI commands (`openFile`, `openDiff`, `gitGraph`,
`openMedia`, `reveal`) to a window chosen in this order:

1. the window the page names;
2. for a just-created iframe (`fresh`), the first window of that folder to
   connect after the request;
3. a window showing the folder, the one used last first (waiting for the
   iframe to load, then accepting a containing folder).

The reply names the window, which the page keeps for that iframe, so a
command reaches the intended pane even when several show the same folder.

**Send to Agent** in the editor sends `@file:lines` plus the selection
(`bridge.send`, with the window's id and folders). The page showing that
window pastes it, unsubmitted, into an agent of the pane's tab, else of its
workspace (those waiting for input first), else the workspace's last
focused terminal. It never goes to another workspace.

**Download (folders as zip)** in the explorer's menu sends the paths
(`bridge.download`); the page showing that window (else the focused page)
downloads them through `/api/m/<machine>/download`, folders and several
entries as one zip ([06](06-quick-look-and-files.md)). Unlike VS Code's own
**Download…**, which needs the File System Access API for folders and large
files (Chromium on a secure origin only), it works in every browser.

## Alternatives considered

| Option | Why not |
| --- | --- |
| On by default, one switch for every client | VS Code's scripts run with the page's access; a desktop user's choice should not reach browsers. |
| Official `code serve-web` | Server build fetched at runtime, redistribution limited; code-server uses Open VSX. |
| openvscode-server | No macOS builds. |
| Remote-SSH from desktop VS Code | Not in the browser; no integration with panes. |
| Driving the iframe from the page | VS Code exposes no command API to the embedding page. |
| Reverse ssh socket forward for the bridge | The agent's listener over the existing yamux session needs no extra forwarding. |
| Only VS Code's own Download… | Folders and large files need the File System Access API: Chromium, secure origin, a permission. |
| Routing a download to the exact page of the window | The extension host cannot know its page; focus matching plus the focused page suffice. |
| A panel docked beside or below the panes | Covered the terminals and its own close controls on narrow windows; a pane covers nothing. |
| The iframe inside its pane's element | Re-parenting reloads VS Code; the layer keeps iframes in place. |
| One window per machine and folder, shared by panes | Two panes of one folder can be on screen; per-pane windows also target commands. |
| Telling the extension its pane through the iframe's URL | The extension host sees neither the page's URL nor its storage. |
| Keeping every window loaded | Each is a full workbench and keeps code-server from idling out. |
| Taking app keys (or `cmd+w`) from VS Code | Users expect VS Code's keys there; `cmd+w` closed the pane instead of an editor. |

## Failure modes

- **code-server crashes or the agent reconnects** → proxy errors reset the
  ready state; the next request prepares code-server again.
- **The socket answers but does not serve VS Code** (e.g. its installation
  directory was removed) → before reusing a running code-server the agent
  requests `/`; on an error status it stops that process and starts a new
  one.
- **No window for the folder** → the bridge waits, falls back to a window
  containing the folder, then reports an error.
- **The page does not know a pane's window yet** → the page gives the pane
  the keyboard and waits briefly for the window to report it, then the hub
  routes by folder.
- **A window off screen was unmounted** → showing its pane loads it again;
  code-server restores its editors (and restarts if it idled out).
- **The layout document starts over** → its VS Code panes and windows go.
- **Two agents of one instance on a machine** (a reconnect while the old
  agent lingers) → the newest takes over the bridge socket; the other takes
  it back once free. The extension reconnects.
- **An archive that would leave the release** → refused; nothing is
  written outside the release.

## Security

VS Code runs on the UI's origin: its extensions and webviews, and the files
on the machines that feed them, have the page's access to every machine.
Hence off by default, an explicit risk acceptance in browsers, and a
desktop switch that does not reach browsers
([08](08-web-access-and-security.md)). Serving code-server from its own
origin would remove the risk at the cost of a second host name or port in
every deployment.

- The socket directory is 0700 and the socket 0600; `--auth none` is safe
  only because nothing else can connect.
- The proxy strips the proxy-secret header and the cookie that marked the
  desktop app's requests while it ran the hub as a child (none is set
  now) and adds `X-Frame-Options: SAMEORIGIN`.
- From code-server's responses it drops `Service-Worker-Allowed` (which
  would let a worker's scope cover the UI's pages and outlast the switch)
  and any `Set-Cookie` naming that cookie.
- code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is off
  (`--disable-proxy`) and the hub also refuses those paths: it would serve
  any service on the machine, including another user's, on the UI's origin.
  VS Code's "open in browser" links for forwarded ports therefore do not
  work.
- Bridge commands go through the guarded, audited `POST /api/m/{id}/bridge`;
  read-only mode refuses it and VS Code altogether.

## Testing

- Switches: `backend/features/vscode/hub.test.ts` (`routes follow their
  client's switch`, `a switch turned off ends its work`, `a switch turned
  off ends its requests and bridge commands in flight`, `preparations end
  with the last switch`), `backend/features/vscode/work.test.ts` (work
  taken only while its client's switch is on, ended when it goes off),
  `backend/kernel/hub.test.ts` (`browserRisk`,
  `enabledFor`: `plugins.vscode.enabled` is the desktop app's switch only),
  `backend/features/vscode/proxy.test.ts` (the desktop app's cookie, header
  filtering), `bridge.test.ts` (bridge messages per switch),
  `web/src/__tests__/vscodeRisk.test.ts`,
  `web/src/__tests__/vscodeWorkers.test.ts`.
- Provisioning: `backend/features/vscode/artifacts.test.ts`,
  `provision.test.ts` (the upload's digest); the machine side's
  `backend/features/vscode/machine.test.ts` (existing binary, verified
  downloads, start flags, replacing a broken listener, through the wire
  with a stand-in for code-server, and uploads checked before unpacking,
  archives leaving the release refused, release kept for another hub,
  the node's end, hand-over and orphans, extensions and markers,
  retention, the node's thread kept free) and, in `make it` with
  `E2E_CODE_SERVER_SEED`, `integration.test.ts` (a real release started on
  its socket only).
- Bridge socket ownership between agents: `machine.test.ts` (`the bridge
  socket`: the hub that last opened
  VS Code, the newest agent taking it over).
- Bridge routing, idle tracking, theme, refused port proxy, Send to Agent,
  close/leave and downloads: `backend/features/vscode/bridge.test.ts`
  (`pick`, `targets`, `theme`, `send to agent, focus`, `close, leave,
  download`), `proxy.test.ts` (`idle tracking`, `the port proxy is
  refused`), `hub.test.ts` (`idle code-servers are released`).
- Layout: `spec/vectors/layout/views.json`.
- UI: `web/src/__tests__/codePanes.test.ts` (entry points, reuse, windows'
  lifetime and placement, command targeting, Send to Agent),
  `desktop.test.ts` (menu and keys), `paneHeader.test.ts`,
  `tabLabels.test.ts`, `download.test.ts`; `desktop/src/policy.test.ts`
  (File System Access permission).

Verified manually with code-server 4.144.0 in Chrome, headless Chrome and
the desktop app on macOS, on a macOS host and an arm64 Linux VM:
provisioning, the `existing` → `push` fallback, theme switching, Git Graph
through the bridge, panes (splits, drag, maximize, reload, two panes of one
folder) and the keys `cmd+j` and `cmd+w` in VS Code's iframe.
