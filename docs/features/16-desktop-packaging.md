# 16 · Desktop app

## Context

The browser UI and the hub already contain the application's features. Desktop users also want an app they install with their system's installer and start from the Dock, the Start menu or the launcher, with a hub of its own and no terminal to keep open. The Electron shell is the browser UI as such an app on macOS, Windows and Linux. VS Code webviews depend on Chromium and a secure loopback origin, so the shell must preserve the existing HTTP, WebSocket and service-worker behavior.

The agent relies on POSIX (unix sockets with peer checks, process groups, code-server, Xvfb) and runs on Linux and macOS only (a Windows hub carries no machine side); this repository pins no Windows herdr-core (`backend/scripts/hcdist.ts`). On Windows the app is therefore a client of SSH machines only ([02](02-multi-machine-transport.md)).

## Goals / non-goals

Goals:

- one shell for macOS (arm64, x64), Windows (x64) and Linux (x64, arm64), with each system's installers and conventions (menus, quitting, window frames, folders opened with the app);
- a hub the app owns and cleans up the same way on all three systems;
- safe renderer windows;
- a native menu with the UI's commands and keybindings that never takes a key from a terminal;
- title bar, menu and dialogs following the hub's theme and language;
- on macOS, a way to grant Full Disk Access to every program that needs it;
- release builds that need no secret, with optional Developer ID signing and notarization on macOS;
- a development mode that cannot touch the daily instance.

Non-goals: a local machine on Windows (a WSL distribution with an ssh server can be added as an SSH machine); interactive ssh login on Windows; Windows on arm64; universal macOS binaries; automatic updates; signing the Windows and Linux packages; replacing browser access.

## Design

### Per-system behavior

Everything that depends on the system is a function of `process.platform` in `desktop/src/platform.ts`, so every system's rules run in the tests on any of them: the app id (the product's domain reversed and `desktop`, `app.veldr.desktop`; also the Windows AppUserModelID that notifications need and the Linux desktop entry's name; the Secure Enclave helper's is `app.veldr.desktop.enclave`), the keybinding platform (`mac`, `windows` or `linux`), where the hub's payloads are, whether closing the last window quits, and how a Linux command line names folders.

### Building

`scripts/desktop.sh` stages what the hub carries (`PAYLOAD_ONLY=1 scripts/build.sh`: the web UI, the build's release record and its own platform's executable for the local machine (no executable on Windows), the encoders, the VS Code extension), then builds the shell with the hub bundled for its utility process (`desktop/build.mjs`: `dist/hub.mjs` from `backend/hosts/electron`), then runs electron-builder (`desktop/electron-builder.cjs`). Modes: `build`, `app` (unpacked), `dist` (installers), `install` (macOS: copy into `/Applications`) and `dev`. `DESKTOP_OS` packages another system's unpacked app to check its packaging; `SKIP_BUILD=1` runs electron-builder alone.

- The hub's bundle (`dist/hub.mjs`) and node-pty, the native module its ssh logins run in (prebuilt for macOS and Windows, built by `pnpm install` on Linux; Node-API, so no rebuild for Electron; `build.mjs` makes its macOS `spawn-helper` executable, which node-pty 1.1.0's package is not), are unpacked from ASAR; the payloads are resources (`payload/`, `web/`), with the notices laid out as in the release archives. On macOS the vault's Secure Enclave helper (`desktop/helper/Enclave.swift`, built universal with `swiftc`) is an app bundle of its own in `Contents/Helpers/`, signed with the app ([30](30-variable-vault.md)); a build on a Mac without `swiftc` goes on without it, with a warning. The `beforePack` hook refuses an app of another architecture than its modules, a missing hub bundle, payloads or notices, or a macOS app without the helper.
- Artifacts (`dist/desktop/<name>-<version>-<os>-<arch>.<ext>`):
  - macOS: DMG and zip; hardened runtime; signed ad hoc unless a certificate is given, then Developer ID, and notarized when Apple credentials are set too.
  - Windows: a one-click per-user NSIS setup (no administrator rights), unsigned.
  - Linux: AppImage and deb, unsigned. The deb installs a desktop entry (`<slug>.desktop`, offered for folders) and, on Ubuntu 24.04 and later, an AppArmor profile that lets Chromium's sandbox create user namespaces.
- Release: each installer is built on its own system. The build step gets no secret; only the macOS **Package** step (`SKIP_BUILD=1 scripts/desktop.sh dist`) receives the optional signing credentials. A final job writes `SHA256SUMS`, attests provenance, and publishes only after every build succeeded. Pull requests package the unpacked app on all three systems.

Operator details (where the app keeps its files, Gatekeeper, SmartScreen, FUSE) are in [deployment](../deployment.md#desktop-app).

### The hub in process

`desktop/src/hub.ts`, `protocol.ts`, `frames.ts`, `main.ts`, `backend/hosts/electron` ([42](42-typescript-backend.md)).

- The hub runs in an Electron utility process the main process forks (`utilityProcess`), started with a message on its parent port: the instance, the node instance, the payloads' directories and the verify key of the launch. Nothing listens: the app's windows live in a session of their own, which intercepts `https://<slug>.localhost` and hands each request to the hub over a MessagePort, with the origin of the page that made it (Electron's `initiatorOrigin`) as its Origin; requests to other hosts go to the network. The origin is a secure context, as code-server and its service workers need, and the same at every launch, which keeps what the page stores per browser and the permissions granted to it (a page of an earlier version, at `http://127.0.0.1:7781`, kept its own).
- **Channels.** The hub's WebSockets are MessagePorts: a frame of the app's origin asks for one (`desktopChannels`, which the preload of every app window gives each frame of that origin), the main process checks the frame, builds the request's Origin and Host itself and hands one end to the hub, the other to the frame. The web UI opens its channels with `openChannel` (`web/src/lib/transport.ts`); VS Code's frames get a WebSocket that opens one for their own host.
- **The app's client.** VS Code has one switch for the app and one for browsers ([05](05-vscode-panes.md)), so the hub must tell the app's requests from a browser's. A request is the app's because the main process hands it over (in process, on the hub's host); no browser reaches this hub, and no cookie or token marks the app's requests.
- The start message also carries the verify key, a per-launch key for the variable vault's presence prompts (Touch ID, Windows Hello): the shell signs the hub's nonces with it after the prompt, showing text it takes from the hub (asked directly, not through a page), never from the page, and seals the vault's unlock material for the hub so the page relays it unread (`desktop/src/verify.ts`, `windowsHello.ts`, `enclave.ts`, `relay.ts`, `unlockStore.ts`, `keychain.ts`; [30](30-variable-vault.md)).
- **Crashes and stops.** A hub that crashes after it served is started again with the windows kept (their channels close and reconnect), at most 3 times a minute; then the app reports it and quits. Quitting asks the hub to stop: it ends its machines' sessions (up to 15 s); the shell kills only that process if it has not exited 20 s later. On logout or shutdown the shell asks and quits without waiting, so it never holds up the system; Electron ends its utility processes with it.
- Production uses instance `desktop`. Development uses instance `dev`, or the instance `VELDR_DESKTOP_DEV` names (never `desktop`); unpackaged runs are always development, and may take the payloads, machine builds and a code-server seed of a test run (`VELDR_DESKTOP_PAYLOAD`, `VELDR_AGENT_DIR`, `VELDR_SEED_DIR`). Each instance has its own Electron profile and single-instance lock.
- On macOS and Linux the hub's PATH gains `~/.local/bin`, Homebrew's and the system directories without running a shell, since launchers load no shell startup files.
- The shell never starts or stops terminal cores; the web UI does ([22](22-terminal-protocol.md)).

### Windows, quitting and title bar

- macOS: closing the main window leaves the app in the Dock with its hub; the Dock icon, a second launch or an opened folder reopens it. Quitting stops the hub. Windows and Linux: closing the main window quits; a second launch focuses it.
- Quitting closes the main window first and stops the hub once it has closed. While panes have unsaved changes, the page asks: it lists the files, and offers **Save All**, **Don't Save** and **Cancel** (`desktop/src/closeGuard.ts`, `web/src/quitGuard.ts`). A page that does not answer quickly, or another unload objection (a VS Code window), falls back to Electron's native question.
- **Title bar** (`desktop/src/titlebar.ts`). On macOS the main window hides its title bar and places the traffic lights in the UI's top header row, whose empty regions drag the window. Their position follows `appearance.uiFontSize` and `window.zoom`; native full screen clears the inset. Secondary windows, and the main window on Windows and Linux, keep the native frame.
- **Following the hub** (`desktop/src/follow.ts`). The shell is a client of its hub's event channel (`/ws`) and settings endpoints, reached directly, reconnecting with backoff. `appearance.theme` becomes `nativeTheme.themeSource`, so native chrome follows the UI's theme even when it differs from the system's; `appearance.language` is the menu's and dialogs' language.
- **Zoom.** `window.zoom` (percent) is the zoom of the app's windows, like VS Code's `window.zoomLevel`. The setting is the only place the zoom is kept: Electron's own zoom is not persisted and the page's keys never zoom by themselves. **Zoom In**, **Zoom Out** and **Reset Zoom** step it through Chromium's levels. Terminals re-measure their cells at the new pixel ratio and refit their grid ([26](26-web-terminals.md)). Browsers keep their own zoom.

### The menu

`desktop/src/menu.ts`.

- Each system's layout: macOS has the application menu and a Window menu with the window list; Windows and Linux have File (Exit on Windows) and Help. Shell, Edit and View are the same everywhere. Items carry the commands' names and the first single-stroke key bound to them, and the menu is rebuilt when keybindings or language change.
- **The page sees every key first** and runs the bindings itself ([04](04-layout-and-keyboard.md)). The menu therefore registers keys only where that cannot steal one from a terminal:
  - macOS registers Cmd keys only, so the menu acts where the page does not (text fields, VS Code panes, other windows); keys without Cmd are shown but not registered, since macOS would offer them to the menu first.
  - Windows and Linux register no key at all: Ctrl+C, Ctrl+M or Ctrl+Q belong to the terminal's programs.
- A chosen item sends its command to the main window's page (`web/src/desktop.ts`). The page tells the shell which commands cannot run now, and those items are disabled.

### The page's bridge

The main window has a sandboxed preload (`desktop/src/preload.ts`, channels in `desktop/src/bridge.ts`) that runs in each of its frames: a frame of the app's origin gets its channels to the hub (`desktopChannels`), the top frame also one object, `desktopShell` (`web/src/shell.ts`). The shell accepts messages only from the top frame of the main window on the app's origin, and checks their shape. Program windows and VS Code's own windows get the channels only (`desktop/src/framePreload.ts`); browser-pane webviews have no preload.

- Shell to page: menu commands, folders opened with the app, the unsaved-changes question, native full-screen state, clicked notifications' targets, and pages a browser pane opened as windows ([32](32-browser-and-ports.md)).
- Page to shell: whether it takes opened folders, the disabled commands, the number of unsaved panes, the close answer, Full Disk Access actions, native notifications, and the vault's Touch ID / Windows Hello requests.
- `pathForFile` (answered in the preload) gives a dropped file's disk path, so folders dropped on the sidebar become local workspaces and files dropped on a local pane are pasted as paths ([06](06-quick-look-and-files.md)).
- `metrics` reports the app's Electron processes for the Performance page ([13](13-settings-and-appearance.md)); the hub reports itself.

**Folders opened with the app** (`desktop/src/folders.ts`). On macOS the app declares folders with rank `None`, so the Dock accepts dropped folders without the app becoming Finder's opener. On Linux the desktop entry offers the app for folders and the paths (or `file:` URLs) arrive on the command line, also through `second-instance`. The shell holds them until the page asks, and the page creates workspaces as for sidebar drops. Windows opens none: its local machine is `local_unsupported`.

### Full Disk Access (macOS)

`desktop/src/privacy.ts`, `web/src/fullDiskAccess.ts`, `web/src/components/settings/FullDiskAccess.tsx`, `backend/machine/privacy.ts`.

macOS has no request for Full Disk Access: the user turns it on in System Settings. It checks the process it holds responsible, which children inherit:

- The hub is the app's utility process and code-server the hub's child, so the file browser and VS Code access files as **the app**.
- Terminals access them as **herdr-core**: it runs the terminal core as a launchd job and its holders disclaim inherited responsibility, so a terminal's programs have what `~/.veldr[-<instance>]/hosts/<host>/hc/herdr-core` was granted. Starting the terminal core as the app's child would not change this.

Both need the grant. The Terminal settings page shows a **Permissions** row in the desktop app on macOS only. `GET /api/m/local/privacy` probes by opening and closing a folder only Full Disk Access opens: in the agent's own process for the app, and through `/bin/sh` run by the terminal core (`machine.exec`) for terminals. `EPERM` is **Not granted**, success **Granted**, anything else or no terminal core **Unknown**. Nothing is read and no terminal core is started.

The row's buttons open System Settings at Full Disk Access and reveal herdr-core in Finder (a hidden folder the **+** dialog does not show). A grant applies to processes started afterwards, so the row offers the matching restart:

- **Restart Terminal Service…** for terminals; open terminals keep their old holder until closed.
- **Quit and Reopen…** for the app: a helper has Launch Services open the bundle once the app is gone, so the new app is its own responsible process (`app.relaunch()` would make it the old one's child; only development uses it).

A grant is tied to the program's designated requirement. An ad hoc signature makes it the code hash, so each new build needs the grant again; with a Developer ID it survives updates. herdr-core is signed with Herdr's Developer ID, so its grant survives reinstalls at the same path.

### Notifications, badge and icons

- Notifications are native (`desktop/src/notifications.ts`): the page asks through the bridge, both sides validate and bound title, body, tag and click target (a pane, chat or panel), and active ones are deduplicated by tag and bounded. A click shows the main window (on macOS reopening it) and hands the target to the page, queued while it loads. Without native notifications the page falls back to the web Notification API ([07](07-agent-native-workflow.md)). Windows shows them only for the installed app (its Start menu shortcut carries the AppUserModelID); Linux needs a notification daemon.
- The blocked-agent count uses the Badging API. Electron shows the badge on the Dock (macOS), as a taskbar overlay (Windows) and through the Unity launcher API (Linux).
- The shell imports the web brand constants and message dictionaries; electron-builder's metadata reads the same brand file.
- `desktop/assets/icon.svg` is the master icon and `web/public/icon.svg` a simplified version for small sizes. `make desktop-icons` (`scripts/icons.sh`) regenerates the committed PNG, ICNS and ICO; builds need no icon tools.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Reimplement the UI for desktop | Duplicates terminal rendering, layout and VS Code integration. |
| Tauri/WKWebView | VS Code webviews require Chromium's service-worker behavior. |
| The hub as a child process on a loopback port | Any process of the host could reach it; the app's requests needed a cookie of the launch to be told apart. |
| A custom scheme for the app's origin | code-server's resources and CacheStorage need https ([42](42-typescript-backend.md)). |
| A loopback listener for VS Code only | Not needed: its frames' WebSockets are channels too. |
| Restart the hub without a bound | A hub that crashes at once would loop; after 3 a minute the app reports it. |
| A local machine on Windows | The agent is POSIX; it would be a port, and no Windows herdr-core is pinned. |
| WSL built in | A WSL distribution with an ssh server already works as an SSH machine. |
| The sign-in terminal on Windows | Win32-OpenSSH has no ControlMaster, so a login holds nothing for later connections. |
| Register menu keys on Windows and Linux | Ctrl+C, Ctrl+M, Ctrl+Q are programs' keys in terminals. |
| Quit when the main window closes on macOS | Mac apps stay in the Dock until quit. |
| Only an AppImage on Linux | AppArmor blocks Chromium's sandbox in an AppImage on Ubuntu 24.04+. |
| `--no-sandbox` | Turns off the renderer sandbox for everything the hub serves. |
| Full Disk Access for the app alone, terminal core as its child | herdr-core's holders disclaim responsibility anyway, and terminals must outlive the app. |
| Check Full Disk Access in the shell's process | Shows only the app's access, not herdr-core's. |
| Read the privacy database (`TCC.db`) | Needs Full Disk Access itself; private format. |
| `app.relaunch()` for **Quit and Reopen…** | The new app would be the old one's child and not responsible for itself. |

## Failure modes

- A hub that cannot start (missing payloads, invalid configuration or development instance): startup fails with a localized dialog and a bounded tail of the hub's log, after stopping it.
- The hub crashes: it is started again, the windows reconnect; a fourth crash within a minute is reported and the app quits. A renderer's exit is reported and the app quits; reopening starts a fresh hub.
- Electron crash: its utility processes end with it; force-killed agents are covered by orphan reaping and idle timeouts ([10](10-remote-resource-lifecycle.md)).
- Local terminal core fails to start: the web UI shows the error and offers **Start Terminal Service**.
- Windows: the local machine shows `local_unsupported`. An SSH machine that needs a password, an unloaded key passphrase or a host key shows `auth_required` with what to run once in a terminal. A copy run from `win-unpacked/` shows no notifications (no Start menu shortcut).
- Linux: an AppImage needs FUSE 2 and cannot sandbox on Ubuntu 24.04+ (the deb works). No notification daemon means no notifications; a dock without the Unity API shows no badge.
- Full Disk Access: an ad hoc build that was rebuilt keeps its switch on in System Settings but reads **Not granted** until re-added.
- Gatekeeper blocks an ad hoc app until allowed; SmartScreen warns before the unsigned setup ([deployment](../deployment.md#desktop-app)).

## Security

Following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security):

- No Node integration in any renderer; sandboxing, context isolation and web security on every system; never `--no-sandbox`.
- Only the main window has a preload; its bridge accepts messages only from the main window's top frame on the hub's origin, checks their shape, and exposes nothing beyond the channels above. A dropped file's path reveals only what the user handed over; `metrics` reports kinds and amounts, nothing processes hold.
- Navigation and popups are limited to the exact hub origin; external links accept only credential-free HTTP(S). Browser-pane webviews are forced into their own sandboxed partition with no preload (`desktop/src/policy.ts`, [32](32-browser-and-ports.md)).
- Permissions require the frame and its top window to be the hub's; only notifications, clipboard read and sanitized write, the File System Access API (VS Code's **Download…**) and local fonts (the font picker) are allowed.
- The shell reads its settings from its hub directly, behind the same guards, takes only appearance settings and well-formed bindings, and listens on nothing; neither does the hub.
- Full Disk Access requests carry nothing from the page: one fixed System Settings URL, the instance's own herdr-core path, the app's own bundle. The probes open a folder without reading it.
- The main process's word identifies the app's windows to the hub; no other process of the host reaches the hub, which listens on nothing.
- Release builds get no secret except the macOS Package step's optional signing credentials.

See [SECURITY.md](../../SECURITY.md) for the trust boundaries.

## Testing

- `desktop/src/*.test.ts` (fake Electron and Node children, no network): `platform`, `hub` (the start message, restarts after crashes and their bound, start failures and timeouts, stop and kill after the deadline, a frame's channel request), `hubBridge` (requests, bodies with credit, cancels, failures, channels), `protocol`, `frames`, `folders`, `follow`, `menu` (items, accelerators, per-system menus, no keys registered on Windows and Linux), `policy`, `privacy`, `preload`, `closeGuard`, `titlebar`, `notifications` (validation, bounds, tag deduplication, click targets), `verify`, `windowsHello`, `enclave`, `relay`, `unlockStore`, `keychain`.
- `web/src/__tests__/`: `quitGuard`, `desktop` (menu commands), `zoom`, `drop` (dropped and opened folders), `fullDiskAccess`.
- `backend/machine/housekeeping.test.ts` and `backend/features/terminals/terminals.test.ts` (`the terminal core’s lifecycle from the UI`): the probes, the op and the endpoint.
- CI's `desktop` job runs the web and desktop tests (the hub's on macOS) and `scripts/desktop.sh app` on Ubuntu, macOS and Windows.
- `e2e/tests/desktop.spec.ts` (`make e2e`, when the desktop's packages are installed) launches the unpackaged app with Playwright on an isolated instance (`VELDR_DESKTOP_DEV`), profile (`--user-data-dir`), home and mock keychain (`e2e/harness/desktop.ts`, the `desktop` fixture, which other desktop tests reuse): the UI from the app's origin with no TCP listener of the hub, the local machine, a terminal, an ssh login through node-pty, a download, a restart after the hub is killed, and a VS Code window given a code-server release (`E2E_CODE_SERVER_SEED`; [42](42-typescript-backend.md)).
- Packaged smoke tests launch the executable with `VELDR_DESKTOP_DEV` and their own `--user-data-dir`.
