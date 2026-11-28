# 05 · VS Code panes

## Context

Reviewing an agent's work needs code browsing, diffs, Git history and extensions such as Git Graph. VS Code opens on demand on the machine and at the directory of the pane it comes from, as a pane of the split tree: a panel over the panes would hide the terminals on a narrow window.

## Goals / non-goals

Goals: real VS Code with extensions on every machine, handled as any pane; back after a reload; no internet needed on machines; no cost when unused.

Non-goals: replacing the terminal as the main surface; syncing VS Code settings between machines; the app's keys inside VS Code beyond those VS Code leaves.

## Design

**Switches.** The plugin `vscode` ([27](27-plugins.md); `web/src/plugins/vscode`, `backend/features/vscode`) serves code-server on the UI's own origin, so its extensions and webviews can do whatever the page can. It is off by default with one switch per kind of client ([08](08-web-access-and-security.md)): `plugins.vscode.enabled` for the desktop app's windows ([16](16-desktop-packaging.md)), `plugins.vscode.browser` for browsers, turned on only through a dialog that acknowledges the risk. While off for a client, the UI offers no entry points, the status, start, proxy and bridge routes answer `404 plugin_disabled`, bridge messages skip its pages and the page unregisters the origin's service workers (`workers.ts`); turning a switch off ends that client kind's requests in flight (`work.ts`).

**Provisioning** (`provision.ts`, `artifacts.ts`; machine side `machine.ts`, op `code-server`). `codeServer.install` chooses upload by the hub (default), download by the machine or an existing install, the last two falling back to upload ([09](09-air-gapped-installs.md)). The machine checks the digest the hub verified before unpacking, refuses an archive with an entry leaving the release, and runs the release's Node once so an unusable release (an old glibc) is reported, without holding the node's thread ([42](42-typescript-backend.md#the-machine-side)). The bridge extension and Git Graph are installed from VSIX files the hub uploads. code-server listens only on a unix socket (`--socket-mode 600` in the private run directory, hence `--auth none`) with its port proxy off; the hub releases it after `--code-server-idle` without connections ([deployment.md](../deployment.md#remote-resources)).

**Proxy** (`proxy.ts`, `relay.ts`). `/m/<machine>/code/…`, WebSockets included, goes to the agent's `cs.sock` over a yamux stream, keeping the Host header that code-server compares with Origin.

**Panes** (`web/src/term/layout.ts`, `actions.ts`, `codeFrames.ts`, `components/CodeLayer.tsx`). A VS Code pane is a leaf `{"code": {"id", "folder"}}` of the machine's layout document ([22](22-terminal-protocol.md)). **Open in VS Code** (`code.open`) opens a tab for the terminal's directory; **Show Changes in VS Code** (`code.diff`) and **Open Git Graph** (`code.gitGraph`) a split beside the source pane; ⌘/Ctrl+click on a file in a terminal (`files.openLinks` = `vscode`, or the File Explorer off) the file in the closest pane whose folder holds it. Each reuses a pane already showing that folder. Each pane on screen is one same-origin iframe, one VS Code window; moving an iframe in the DOM reloads it, so all live in one layer placed over their panes. Off-screen windows stay loaded briefly, a few at most, then unmount so code-server can idle out.

**Keys.** Keys typed in VS Code are VS Code's; on macOS in the desktop app a key VS Code leaves reaches the application menu ([04](04-layout-and-keyboard.md)). The bridge extension hands control back: `cmd+w` / `ctrl+w` with no editor open closes the pane, and **Give the Keyboard Back** (`ctrl+b` on macOS, `ctrl+alt+shift+b` elsewhere) moves the keyboard to the pane's header.

**Bridge** (`extensions/veldr-bridge`, `bridge.ts`). The extension connects to the agent's bridge socket, tunnelled to the hub (op `bridge`), and announces its window id, folders and keyboard focus. It cannot see the page's URL, so a page learns its iframe's window by matching the window that reports focus with the iframe that has the keyboard. UI commands (`POST /api/m/{id}/bridge`: a file, a diff, Git Graph) go to the window the page names, else a just-opened or the last used window of the folder. Windows send **Send to Agent** (pasted unsubmitted into an agent of the pane's tab or workspace, never another workspace) and **Download (folders as zip)** ([06](06-quick-look-and-files.md)), and follow the pages' light or dark theme.

## Alternatives considered

| Option | Why not |
| --- | --- |
| On by default, one switch for every client | VS Code's scripts run with the page's access; a desktop user's choice should not reach browsers. |
| code-server on an origin of its own | Removes the risk, but every deployment would need a second host name or port. |
| `code serve-web`, openvscode-server | Server fetched at runtime with limited redistribution; no macOS builds. |
| Remote-SSH from desktop VS Code | Not in the browser; no integration with panes. |
| Driving the iframe from the page | VS Code exposes no command API to the embedding page. |
| One window per machine and folder | Two panes of one folder can be on screen; per-pane windows also target commands. |

## Failure modes

- **code-server crashes or the agent reconnects** → the ready state resets; the next request prepares code-server again.
- **The socket answers but serves no VS Code** → the agent probes it before reuse and starts a new one.
- **No window for the folder** → the bridge waits, falls back to a window containing it, then reports an error.

## Security

- The socket directory is 0700 and the socket 0600: `--auth none` is safe only because nothing else can connect.
- The proxy strips the proxy-secret header and the desktop app's cookie both ways (`cookies.ts`), drops code-server's `Service-Worker-Allowed` (a worker could cover the UI's pages and outlast the switch) and adds `X-Frame-Options: SAMEORIGIN`.
- code-server's port proxy (`/proxy/<port>/`, `/absproxy/<port>/`) is off and the hub refuses those paths: it would serve any service of the machine on the UI's origin. Forwarded ports open in the browser pane instead ([32](32-browser-and-ports.md)).
- Read-only mode refuses bridge commands and VS Code altogether.

## Testing

- `backend/features/vscode/*.test.ts`: switches, the machine side against a stand-in code-server, the proxy's headers, bridge routing; `integration.test.ts` runs a real release in `make it` with `E2E_CODE_SERVER_SEED` or `IT_WITH_VSCODE=1`.
- `web/src/__tests__/codePanes.test.ts` (entry points, reuse, windows' lifetime, command targeting), `vscodeRisk.test.ts`, `vscodeWorkers.test.ts`.
