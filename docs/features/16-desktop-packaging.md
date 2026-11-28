# 16 · Desktop app

## Context

Desktop users want an app installed with their system's installer and started from the Dock, Start menu or launcher, with a hub of its own and no terminal to keep open. The Electron shell is the browser UI as such an app on macOS, Windows and Linux; VS Code webviews need Chromium and a secure origin with service workers. The agent is POSIX-only, so on Windows the app reaches SSH machines only ([02](02-multi-machine-transport.md)).

## Goals / non-goals

Goals: one shell for macOS (arm64, x64), Windows (x64) and Linux (x64, arm64) with each system's installers and conventions; a hub the app owns; safe renderers; a menu that never takes a key from a terminal; chrome following the hub's theme and language; macOS Full Disk Access; release builds needing no secret; development that cannot touch the daily instance.

Non-goals: a local machine or ssh login on Windows; Windows on arm64; universal macOS binaries; automatic updates; signed Windows and Linux packages.

## Design

Installers, file locations, Gatekeeper, SmartScreen and development runs are in [deployment](../deployment.md#desktop-app). Everything system-dependent is a function of `process.platform` in `desktop/src/platform.ts`, so every system's rules run in the tests anywhere.

### Building

`scripts/desktop.sh` is Stage 2 of the build: it stages this system's Stage 1 hub executable, all 6 machine archives with `SHA256SUMS` and the license notices, builds the shell (`desktop/build.mjs`) and runs electron-builder (`desktop/electron-builder.cjs`, whose `beforePack` refuses an incomplete app). The machine archives stay untouched by signing, so the app and the command line deploy identical builds. On macOS the vault's Secure Enclave helper (`desktop/helper/`) is a signed bundle in `Contents/Helpers/` ([30](30-variable-vault.md)).

Artifacts: macOS DMG and zip, hardened runtime, ad hoc signed unless Developer ID credentials are given (then notarized); a per-user NSIS setup on Windows; AppImage and deb on Linux, the deb with a desktop entry for folders and an AppArmor profile for Chromium's sandbox on Ubuntu 24.04+. A release builds each installer on its own system; only the macOS packaging step gets the optional signing credentials, and a final job writes `SHA256SUMS`, attests provenance and publishes.

### The hub

The main process spawns the hub executable as a child (`<slug> desktop`) speaking a multiplex over its stdio (`desktop/src/hub.ts`; process model in [42](42-typescript-backend.md), wire in [architecture](../architecture.md#desktop-app)). Nothing listens on TCP: the app's session intercepts `https://<slug>.localhost` and hands each request to the hub with the requesting frame's Origin; WebSockets are MessagePorts the main process brokers. The origin is a secure context and the same at every launch, which keeps the page's storage and permissions. A request is the app's because the main process hands it over; no browser reaches this hub ([08](08-web-access-and-security.md)).

- A per-launch verify key in the start message lets the shell sign the vault's presence prompts (Touch ID, Windows Hello), whose text comes from the hub, never the page ([30](30-variable-vault.md)).
- A crashed hub restarts with the windows kept, a bounded number of times a minute; then the app reports it and quits. Quitting asks the hub to stop and kills it after a deadline, never holding up a logout; the hub also stops when its stdin closes, so it never outlives the shell.
- Production is instance `desktop` (its ssh control directory and Electron profile) in the default namespace ([39](39-nodes.md#namespaces)): on machines it shares the terminals and chats of the default namespace, and on its own host the settings, keybindings, machines list, vault and hub database in `~/.veldr/` with `veldr` run without `--instance`. Development runs are local-only instances (`dev`, or the one `VELDR_DESKTOP_DEV` names, never `desktop`), each with its own namespace and Electron profile ([reference](../reference.md#environment-variables)).
- On macOS and Linux the hub's PATH gains `~/.local/bin`, Homebrew's and the system directories, since launchers load no shell startup files.

### Windows and menus

- Closing the main window leaves the app in the Dock on macOS and quits elsewhere. Quitting with unsaved panes lets the page offer **Save All**, **Don't Save**, **Cancel** (`desktop/src/closeGuard.ts`, `web/src/quitGuard.ts`).
- On macOS the traffic lights sit in the UI's header row (`desktop/src/titlebar.ts`); other windows keep the native frame. Torn-off tabs open in detached windows with their own close guard (`desktop/src/detached.ts`).
- The shell follows its hub's settings over `/ws` (`desktop/src/follow.ts`): `appearance.theme` and `appearance.language` drive native chrome, `window.zoom` is the only stored zoom.
- The menu (`desktop/src/menu.ts`) shows commands with their first single-stroke key and sends a chosen item to the main window's page, or a focused detached window's for its own panes. **The page sees every key first** ([04](04-layout-and-keyboard.md)): macOS registers Cmd keys only, for where the page does not act (text fields, VS Code); Windows and Linux register none, since Ctrl+C, Ctrl+M or Ctrl+Q belong to terminals.
- The page's bridge (`desktop/src/preload.ts`, `web/src/shell.ts`) carries menu commands, opened folders, close answers, notifications, the badge, Full Disk Access actions and dropped files' paths ([06](06-quick-look-and-files.md)). Folders dropped on the Dock icon (macOS) or opened through the desktop entry (Linux) become workspaces (`desktop/src/folders.ts`).
- Notifications are native, validated and bounded on both sides (`desktop/src/notifications.ts`), else the web Notification API ([07](07-agent-native-workflow.md)).

### Full Disk Access (macOS)

The user grants Full Disk Access in System Settings to the process macOS holds responsible, which children inherit. The hub is the app's child and starts the local node, which starts code-server, so files and VS Code access files as **the app**. Terminals access them as **herdr-core**, a launchd job whose holders disclaim inherited responsibility, so `~/.veldr[-<instance>]/hosts/<host>/hc/herdr-core` needs the grant too.

The Terminal settings' **Permissions** row (`web/src/fullDiskAccess.ts`, `desktop/src/privacy.ts`) shows both: `GET /api/m/{id}/privacy` opens and closes a folder only Full Disk Access opens, in the agent and through the terminal core (`backend/machine/privacy.ts`), reading nothing. Its buttons open System Settings, reveal herdr-core in Finder and offer **Restart Terminal Service…** or **Quit and Reopen…**, which relaunches through Launch Services so the new app is its own responsible process. An ad hoc signature ties a grant to one build; a Developer ID keeps it across updates.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Tauri/WKWebView | VS Code webviews require Chromium's service workers. |
| The hub on a loopback port | Any local process could reach it, and the app's requests would need a launch cookie. |
| A custom scheme for the app's origin | code-server's resources and CacheStorage need https. |
| Menu keys on Windows and Linux | Ctrl+C, Ctrl+M, Ctrl+Q are programs' keys in terminals. |
| Only an AppImage on Linux | AppArmor blocks its sandbox on Ubuntu 24.04+. |
| `--no-sandbox` | Turns off the renderer sandbox for everything the hub serves. |
| The terminal core as the app's child | herdr-core's holders disclaim responsibility anyway, and terminals must outlive the app. |
| `app.relaunch()` for **Quit and Reopen…** | The new app would be the old one's child, not responsible for itself. |

## Failure modes

- **The hub cannot start or keeps crashing**: a localized dialog with its log's tail, and the app quits.
- **Electron crashes**: the hub stops as its stdin closes ([10](10-remote-resource-lifecycle.md)).
- **Windows**: the local machine shows `local_unsupported`; an SSH machine needing a password, passphrase or host key shows `auth_required` with what to run once.
- **Linux**: an AppImage needs FUSE 2 and cannot sandbox on Ubuntu 24.04+; notifications need a daemon.
- **A rebuilt ad hoc app** reads Full Disk Access **Not granted** until re-added.

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security) within [SECURITY.md](../../SECURITY.md)'s trust boundaries:

- No Node integration; sandbox, context isolation and web security in every renderer.
- Only the main and detached tab windows have the shell's preload, which accepts messages only from their top frames on the app's origin and checks their shape; browser-pane webviews get none, in a sandboxed partition of their own (`desktop/src/policy.ts`, [32](32-browser-and-ports.md)).
- Navigation stays on the app's origin; external links only credential-free HTTP(S); permissions limited to notifications, clipboard, File System Access and local fonts.
- Neither shell nor hub listens on anything; Full Disk Access actions carry nothing from the page; release builds get no secret but the macOS signing credentials.

## Testing

- `desktop/src/*.test.ts` (fake Electron, no network): the hub's lifecycle and channels, per-system menus and keys, the bridge, policies, close guards, notifications, the vault's prompts.
- `web/src/__tests__/` (`quitGuard`, `desktop`, `zoom`, `drop`, `fullDiskAccess`); `backend/machine/housekeeping.test.ts` (privacy probes).
- CI packages the unpacked app on Ubuntu, macOS and Windows; `e2e/tests/desktop.spec.ts` runs the unpackaged app on an isolated instance (no TCP listener, a terminal, an ssh login, a hub restart, a VS Code window).
