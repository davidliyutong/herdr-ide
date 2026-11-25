# Deployment

veldr runs on one host (your laptop or an always-on machine) and is used from browsers or its desktop app. It reaches its machines over ssh; nothing listens on the machines.

- [Local use](#local-use)
- [Desktop app](#desktop-app)
- [Remote access through a reverse proxy](#remote-access-through-a-reverse-proxy)
- [Air-gapped networks](#air-gapped-networks)
- [Remote resources](#remote-resources)
- [Running as a service](#running-as-a-service)
- [Several hubs and development builds](#several-hubs-and-development-builds)

## Local use

```bash
scripts/build.sh
cd dist/packages/veldr-$(scripts/platform.sh)
./veldr    # http://127.0.0.1:7780
```

The hub listens on `127.0.0.1:7780` and the same port on `::1`. Open it as `http://localhost:7780` if you want biometrics for the variable vault: browsers keep no WebAuthn credential for an IP address ([30](features/30-variable-vault.md)).

Release archives (`dist/release/`) are for Linux (amd64 and arm64, each for glibc and for musl) and macOS (amd64 and arm64) and include the licenses. On Windows the hub runs only inside the [desktop app](#desktop-app), in process, and reaches SSH machines only.

The hub is one executable built with Bun from `backend/` (about 110–135 MiB per platform: the Bun runtime and what it embeds; [42](features/42-typescript-backend.md#the-machine-side) has the sizes). What the hub embeds:

- The web UI, the VS Code bridge and the machine side of its own platform: the executable is that platform's machine build too ([42](features/42-typescript-backend.md)), the hub and the machine side (`veldr node`) with its platform's herdr-core and, on Linux, its video encoder, for Linux (amd64, arm64, each for glibc and for musl) and macOS (amd64, arm64); machines of other platforms get theirs from the release ([air-gapped networks](#air-gapped-networks)).
- herdr-core 0.1.21 (about 12 MB), the terminal core installed on machines ([21](features/21-terminal-core.md)): the executable's own platform's, with the digests of the Linux and macOS ones on amd64 and arm64. `scripts/build.sh` runs `backend/scripts/fetch-hc.ts`, which downloads the archives from `releases.herdr.dev` (or reuses `dist/hc/`) and verifies them against the digests pinned in `backend/scripts/hcdist.ts`; the build fails otherwise. `scripts/build.sh` stages everything the hub embeds in `dist/payload` first (herdr-core in `dist/machines-hc`); a hub run from the sources (`make dev-hub`) reads `dist/payload`, where it stages this host's executable.
- The video encoder for program windows on Linux machines ([14](features/14-gui-windows.md)), when `scripts/build-ffmpeg.sh` (Docker) built it into `dist/ffmpeg/`. Releases require it (`REQUIRE_ENCODER=1`); without it, windows are sent as pictures.

Nothing needs to be installed on machines beforehand. Add SSH machines with **Add Machine…** in the sidebar, or for one run with `--ssh`. The machines file is listed in [reference](reference.md#files-and-directories).

veldr uses OpenSSH with your `~/.ssh/config` in BatchMode. A machine that needs a password, 2FA or a host-key confirmation shows **Sign-in required**; **Sign in…** opens a terminal for it, and later connections reuse that ssh ControlMaster. Windows' OpenSSH has no ControlMaster, so a hub there has no sign-in ([Windows](#windows)).

Several browser tabs and the desktop app can show the same machines at once. They share each machine's layout ([04](features/04-layout-and-keyboard.md)); a terminal takes the size of the client that used it last.

## Desktop app

The desktop app is the web UI in an Electron window with a hub of its own, for macOS (Apple Silicon and Intel), Windows (x64) and Linux (x64 and arm64) ([16](features/16-desktop-packaging.md)). Each GitHub release attaches:

| System | Files |
| --- | --- |
| macOS | `veldr-<version>-mac-arm64.dmg` and `.zip`, `veldr-<version>-mac-x64.dmg` and `.zip` |
| Windows | `veldr-<version>-win-x64.exe` (setup) |
| Linux | `veldr-<version>-linux-amd64.deb`, `-linux-arm64.deb`, `-linux-x86_64.AppImage`, `-linux-arm64.AppImage` |

All are listed in `SHA256SUMS`. Check the digest (`shasum -a 256 -c SHA256SUMS --ignore-missing`; on Windows `Get-FileHash`) and, for a public repository, the provenance (`gh attestation verify <file> --repo <owner>/<repo>`) before the first launch. There are no automatic updates; install a newer release over the old one.

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Local machine | yes | no (`local_unsupported`) | yes |
| SSH machines | yes, with **Sign in…** | keys in the ssh agent, host keys accepted beforehand | yes, with **Sign in…** |
| Program windows | of remote Linux machines | of remote Linux machines | of remote Linux machines |
| Folders opened with the app | dropped on the sidebar or Dock icon | – | dropped on the sidebar, **Open With** |
| Blocked-agents badge | Dock icon | taskbar overlay | Unity launcher API docks |
| Closing the main window | app stays in the Dock | quits | quits |
| Signature | ad hoc, or Developer ID and notarized | none | none |

The app's hub runs inside the app (an Electron utility process) and listens on nothing: its windows reach it at `https://veldr.localhost`, which only the app serves. It has instance `desktop` for its own settings, vault and machines list, separate from the CLI default and `dev`; on every machine it uses the default namespace (`~/.veldr`), the same terminals and chats as a hub of the default instance ([39](features/39-nodes.md)):

- A hub that crashes is started again with the windows kept; one that keeps crashing (four times a minute) is reported and the app quits.
- What the page stores per browser (UI preferences, transfer history) was kept for `http://127.0.0.1:7781` by versions that ran the hub on that port; the app starts with it empty once.
- Opening the app twice focuses the existing window.
- Quitting stops its hub and agents, not the machines' terminal cores.
- External HTTP(S) links open in the default browser; other URL schemes are refused.
- ssh is the system's OpenSSH with the user's configuration.

### macOS

Drag the app from the DMG (or zip) into Applications. A release without the Developer ID secrets is signed ad hoc and Gatekeeper refuses its first launch. Allow it once: on macOS 14 and earlier Control-click → **Open**; on macOS 15 and later **Open Anyway** under System Settings → Privacy & Security; or `xattr -dr com.apple.quarantine /Applications/veldr.app`. To uninstall, move the app to the Trash (its files stay).

**Full Disk Access.** macOS keeps programs out of other apps' data and asks before they open Desktop, Documents, Downloads or external disks. Two programs need the grant:

- the app, for the file browser, uploads, downloads and VS Code;
- herdr-core (`~/.veldr/hosts/<host>/hc/herdr-core`), which macOS holds responsible for the terminals' programs.

**Settings → Terminal → Permissions → Full Disk Access** shows both and opens System Settings. A grant applies to processes started afterwards: quit and reopen the app, restart the terminal service and open new terminals. An ad hoc build's grant is for that exact build; after updating it, remove the entry and add it again. Developer ID builds and herdr-core keep their grant across updates.

Finder launches put `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and system paths on the hub's PATH. Shell startup files are not run.

To build on a Mac (Bun, Node.js 22.12+, pnpm):

```bash
make desktop-app                        # host-architecture .app in dist/desktop/mac-arm64/ or mac/
VERSION=0.1.0 make desktop-dist         # .app, DMG and zip in dist/desktop/
ARCH=x64 make desktop-dist              # Intel
ARCH=arm64 make desktop-dist            # Apple Silicon
make desktop-install                    # host-architecture .app into /Applications
```

Local builds are signed ad hoc. With `CSC_LINK` and `CSC_KEY_PASSWORD` (or `CSC_NAME`) they get a Developer ID signature, and with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` they are notarized ([reference](reference.md#environment-variables)).

`make desktop-install` copies the build over `/Applications/veldr.app` (`INSTALL_DIR` picks another folder). A running copy is quit first and reopened after; if it does not quit within 30 s nothing is installed. The new copy is assembled beside the old one, so a failure leaves the old app.

### Windows

The app needs Windows' OpenSSH Client (installed by default on Windows 10 1809+ and 11). The setup is unsigned: at SmartScreen choose **More info** → **Run anyway**. It installs per user, without administrator rights, into `%LOCALAPPDATA%\Programs\veldr-desktop\`. Uninstall from Settings → Apps (its files stay).

The app reaches SSH machines only (a WSL distribution running an ssh server can be added as one). Windows' ssh has no ControlMaster, so there is no **Sign in…**: every connection authenticates in BatchMode. Before adding a machine, accept its host key and make the key available:

```powershell
ssh user@host            # once: accept the host key, then exit
# a key with a passphrase: let Windows' ssh agent hold it
# (the service, once, in a PowerShell run as administrator)
Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent
ssh-add                  # adds ~/.ssh/id_* to the agent
```

Then **Retry** the machine. Notifications come from the installed app only (its Start menu shortcut carries the app id), not from `win-unpacked/`.

To build: install Bun, Node.js 22.12+, pnpm and Git for Windows, and run `scripts/desktop.sh app` or `scripts/desktop.sh dist` in Git Bash.

### Linux

```bash
sudo apt install ./veldr-<version>-linux-amd64.deb   # or -linux-arm64.deb
```

The deb installs into `/opt/veldr/`, adds the `veldr` command and a desktop entry, and recommends `openssh-client`. On Ubuntu 24.04+ it also installs the AppArmor profile Chromium's sandbox needs. Uninstall with `sudo apt remove veldr-desktop`.

The AppImage runs without installing and needs FUSE 2 (`libfuse2`, `libfuse2t64` on Ubuntu 24.04). On Ubuntu 24.04+ AppArmor keeps Chromium's sandbox from starting in an AppImage; use the deb there. The app never runs with `--no-sandbox`.

Notifications need a notification daemon on the session bus. Launchers put `~/.local/bin`, `/usr/local/bin` and system paths on the hub's PATH.

```bash
make desktop-app                        # dist/desktop/linux-unpacked/ (x64) or linux-arm64-unpacked/
make desktop-dist                       # AppImage and deb in dist/desktop/
ARCH=arm64 make desktop-dist            # arm64 packages, also on an x64 host
```

### Where the app keeps its files

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| The app | `/Applications/veldr.app` | `%LOCALAPPDATA%\Programs\veldr-desktop\` | `/opt/veldr/` (deb), or the AppImage |
| Settings, keybindings, machines (`*-desktop.json`), the hub's database (`hub-desktop-<host>[-<id>].db`: vault access log, AI usage history) | `~/Library/Application Support/veldr/` | `%AppData%\veldr\` | `$XDG_CONFIG_HOME/veldr/` (default `~/.config/veldr/`) |
| Electron profile (browser storage, single-instance lock, the vault's `vault-unlock.json`) | `~/Library/Application Support/veldr-desktop/` | `%AppData%\veldr-desktop\` | `~/.config/veldr-desktop/` |
| Key encrypting the vault's unlock secret (safeStorage) | login keychain item `veldr Safe Storage`; the build that made it in `~/Library/Application Support/veldr-desktop-keychain.json` | DPAPI | – |
| code-server downloads | `~/Library/Caches/veldr/code-server` | `%LocalAppData%\veldr\code-server` | `~/.cache/veldr/code-server` |
| Local machine's node and its state | `~/.veldr/` | – | `~/.veldr/` |
| ssh control sockets | `/tmp/veldr-<uid>/s-desktop` | – | `/tmp/veldr-<uid>/s-desktop` |

SSH machines keep their state in their own `~/.veldr/` ([remote resources](#remote-resources)). Uninstalling removes only the app. Removing the Electron profile also removes this install's vault unlock key: Touch ID or Windows Hello must then be turned on again in the vault's Settings.

### Development

```bash
make dev-desktop
```

This runs unpackaged Electron with the UI of `web/dist` (no hot reload) and the payloads of `dist/payload`, instance `dev` and local-only connections (on Windows it connects no machine). Quit other development hubs of the `dev` instance first. `make e2e` runs the desktop smoke test (`e2e/tests/desktop.spec.ts`) when the desktop's packages are installed.

For packaged smoke tests, set `VELDR_DESKTOP_DEV`: `1` for the `dev` instance, or a name of its own (not `desktop`):

```bash
VELDR_DESKTOP_DEV=smoke \
  dist/desktop/mac-arm64/veldr.app/Contents/MacOS/veldr --user-data-dir="$TMPDIR/veldr-smoke"
VELDR_DESKTOP_DEV=smoke \
  dist/desktop/linux-unpacked/veldr --user-data-dir=/tmp/veldr-smoke
```

On macOS launch the executable, not `open` (which activates a running copy). Development instances are local-only with an Electron profile of their own. A named instance leaves state like any instance (`settings-smoke.json`, `~/.veldr-smoke/`, terminal core session `veldr-smoke`); stop its terminal core (**Stop Terminal Service (Ends All Terminals)…** in the machine's menu) before removing it.

Icon sources are `desktop/assets/icon.svg` and `web/public/icon.svg`. The PNG, ICNS and ICO are committed; after editing the sources run `make desktop-icons` on macOS (needs `librsvg`).

## Remote access through a reverse proxy

The server has no login. Keep it on loopback behind a reverse proxy that authenticates users and terminates TLS. Use HTTPS: VS Code webviews, the clipboard and notifications need a secure context (only `http://localhost` is exempt).

VS Code is off for browsers by default. code-server is served on the UI's own origin, so its extensions can do whatever the user's page can. Turning it on for browsers (`plugins.vscode.browser`, **Settings › Plugins**) applies to every browser of the server; the desktop app's switch (`plugins.vscode.enabled`) does not affect browsers.

Tell veldr the public origin so its Host/Origin checks accept it:

```bash
veldr --allowed-origin https://ide.example.com
```

**Tailscale** (tailnet only, automatic certificates):

```bash
veldr --allowed-origin https://mac.your-tailnet.ts.net --user-header Tailscale-User-Login
tailscale serve --bg --https=443 http://127.0.0.1:7780
```

**Caddy** with forward auth (Authelia, oauth2-proxy, …):

```caddy
ide.example.com {
	forward_auth authelia:9091 {
		uri /api/verify?rd=https://auth.example.com
		copy_headers Remote-User
	}
	reverse_proxy 127.0.0.1:7780 {
		header_up X-veldr-Proxy-Secret {env.VELDR_PROXY_SECRET}
	}
}
```

**nginx**: forward WebSockets and keep the Host header.

```nginx
location / {
    auth_request /oauth2/auth;
    proxy_pass http://127.0.0.1:7780;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-veldr-Proxy-Secret "<secret>";
    proxy_read_timeout 1d;
}
```

### Guardrails

- **Proxy secret** – `--proxy-secret-file FILE` requires the `X-veldr-Proxy-Secret` header on every request not from a browser on the same host, so only your proxy can talk to the hub. With a secret, `--listen` may use a non-loopback address; without one that needs `--insecure-listen`.
- **Read-only** – `--read-only` serves a watch-only view: no terminal input, layout changes, uploads or VS Code, and no terminal core is installed or started. Run a second instance with it for screen sharing.
- **Audit log** – `--audit-log FILE` records connections, mutating terminal hub calls, uploads, VS Code and bridge use, the Agent SDK's installs on machines (`chat.sdk_install`) and refused requests as JSON lines, with the user from `--user-header`.
- The terminal core's API is reachable only through an allowlist: clients reach terminals and layouts, never the hub's machine, file or server commands.

See [SECURITY.md](../SECURITY.md) for the threat model.

## Air-gapped networks

Machines need no internet access: those that have it download their build (and the Agent SDK of Claude Code's chats, below) themselves, and the hub uploads them to the others; code-server and extensions are resolved on the hub host and pushed through the agent. The one exception is the AI usage plugin, which asks the providers from the machines ([29](features/29-ai-usage.md)); offline, it reports the failure.

The hub ([42](features/42-typescript-backend.md)) carries no other platform's executable. A machine that lacks its build first downloads its platform's archive from the hub's release itself (`curl` or `wget`; the setting `machines.download`, or `--machine-download=false`, turns this off, and a machine whose download failed is not asked first again for a day), checked against the release's `SHA256SUMS`, which the hub fetches over its own HTTPS (through the proxy of `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`). Otherwise the hub uploads it over ssh, from `--agent-dir`, its cache (`~/.veldr/cache/machine/`), its own executable (a machine of its platform), or a download from the release on the hub host: a hub that reaches the internet serves machines that do not. A hub that cannot reach the release (no name, no route) fetches `SHA256SUMS` through the machine instead, over `ssh -W` with its own TLS end to end; that needs the machine's sshd to allow forwarding (`AllowTcpForwarding`). A hub whose fetch reaches something it does not trust (a certificate, an HTTP error) stops there with `build_unavailable`, and never uses a manifest the machine downloaded itself.

For an offline site, put the release's `SHA256SUMS` and the archives (`veldr-<os>-<arch>[-musl].tar.gz`, or the executables in them saved as `veldr-<os>-<arch>[-musl]`) of the platforms you need into a directory and start the hub with `--agent-dir DIR`: each file is checked against that `SHA256SUMS`, which must be the hub's release's (it names the hub's own executable by its digest). A machine that gets its build from none of them shows `build_unavailable` with what each source said.

When the hub host is offline too, prepare a bundle on a connected machine:

```bash
veldr fetch-assets ./bundle                          # all platforms
veldr fetch-assets --platforms linux-amd64 ./bundle  # only what you need
```

Copy `./bundle` and the full release directory into the network, then run:

```bash
veldr --offline --seed-dir ./bundle
```

Lookup order: `--seed-dir` directories, the cache, then (unless `--offline`) `--code-server-url` / `--extension-url`, which can point at a mirror (`--code-server-url` without user information, query or fragment: machines downloading releases get it on their command lines). Verification:

- Default versions have SHA-256 digests compiled into the hub.
- Other versions are checked against a `<file>.sha256` beside the file (`fetch-assets` writes it).
- A mismatching seed is rejected, never replaced.
- A seed or cached file with neither a pinned digest nor a sidecar is used unverified, with a logged warning.
- A download with no known digest is accepted once and its digest recorded (trust on first use), with a warning.

Bundles are for your own installations: Git Graph's license restricts redistribution, so do not publish bundles containing it.

**Claude Code's chats on machines** run on Anthropic's Agent SDK, which no executable or app carries ([42](features/42-typescript-backend.md#claude-code)). Before such a chat starts, a machine that lacks it downloads the npm registry's tarball of the pinned version itself (curl or wget; not with `--offline`), else the hub uploads it from a `--seed-dir`, its cache (`~/.veldr/cache/npm/`) or its own download through `HTTPS_PROXY`. `--npm-registry` names a mirror: an `http` or `https` URL without user information, query or fragment, as `--code-server-url` is, since the machines get it on their command lines (the hub does not start with credentials in either). For a mirror that needs credentials, or an offline site, put the tarball into a `--seed-dir` directory under its own name (a regular file); on a connected machine:

```bash
curl -fsSLO https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.322.tgz
# or: npm pack @anthropic-ai/claude-agent-sdk@0.3.322
```

Whatever its source, the tarball is checked against the integrity pinned in the build (the npm lockfile's `sha512-r88ij7R3…`); another file is refused. A machine that gets it from none of them refuses the chat with `sdk_unavailable`, saying what each source said. Anthropic's terms govern your use of the SDK and of your Claude account; the chats run your own `claude` with your own sign-in.

Building needs npm packages, the Bun runtimes of the target platforms (`bun build --compile` downloads one for another platform) and the pinned herdr-core archives (verified archives in `dist/hc/` are reused); `scripts/build.sh` builds the executables of `TARGETS` (`linux/amd64-musl` and `linux/arm64-musl` among them) with `RELEASE_URL`, the release's download URL their machines use.

## Remote resources

What veldr starts or writes, and what ends or removes it. Feature documents give the reasoning ([10](features/10-remote-resource-lifecycle.md)). `<data>` is `~/.veldr[-<instance>]` on the machine, `<host>` the host's key and `<run>` the namespace's runtime directory on the host ([files](reference.md#files-and-directories)).

### Processes and connections

| Resource | Started | Ends |
| --- | --- | --- |
| Node (`veldr node`) | By a hub reaching the machine (`node dial` over ssh, the socket for its own machine) when no node answers, or one of an older build does; one per namespace and host (`<run>/node.lock`), in a session of its own. The node is the build's executable (`~/.veldr/agent/<build>/veldr node`); it takes over from a node of an older build. | 15 s after its last client left, on `node stop`, once taken over by a newer build's node and its clients moved (at most 10 min), or once its executable is removed (it then takes no new client). Log `<data>/hosts/<host>/node.log` (1 MiB, one old file). |
| Agent session | One per hub and machine while connected, served by the node. | With its ssh session or socket connection; a dead link is detected by keepalives within about 45 s. |
| A machine added from the UI | **Add Machine…** (`POST /api/machines`). | A record in the machines file; **Remove Machine…** deletes it and ends the session. The machine's terminal core and terminals keep running. |
| ssh ControlMaster | Per machine, on Linux and macOS hubs. | 10 min unused or 1 min without server answers; a hub that finds it dead sends `ssh -O stop`. |
| Desktop hub | Launched by Electron. | When the app closes its stdin (quit, crash; on Windows and Linux also closing the window); killed after 20 s. Machines' terminal cores keep running. |
| Terminal core (herdr-core) | First subscription to a machine with no terminal core answering (`term.start`), or **Start Terminal Service** / **Restart Terminal Service…** in the machine's menu (`hc.start`, `hc.restart`). Never in `--read-only`. | Detached (systemd user service or launchd job), session `veldr[-<instance>]-<host id>`, socket `<run>/hc.sock`. Outlives agent and hub. Ends with **Stop Terminal Service (Ends All Terminals)…** (`hc.stop`), the agent op `hc` action `stop`, `veldr node stop --terminal-core` on the machine, or the machine. A restart keeps the programs. |
| Connection to the terminal core | One per machine while a `/api/v1/term` client is subscribed. | 10 s after the last subscriber, or with the agent. |
| Terminals of the layout | New tabs, splits and agents (`terminal.run` with `keep: true`, audited); replacements after a terminal core restart ([33](features/33-workspace-restore.md)). | When the pane, tab or workspace closes (after the undo time), is killed, its program exits, or the terminal core stops. They outlive pages, hub and agent. Finished records stay 24 h in herdr-core's state. |
| A closed pane's terminal | **Close Pane** / **Close Tab**. | Labeled `closing`; any page showing the machine kills it after `layout.undoClose` (5 s) unless **Undo Close** brings it back. |
| Attached streams of a page | One per terminal shown or kept hidden (`performance.keptTerminals`, 12 by default, max 64; [26](features/26-web-terminals.md)). | With the pane, the page, the program, or the machine. No process, no disk. |
| Streams kept for terminals' sizes | When the last client that set a live terminal's size leaves ([22](features/22-terminal-protocol.md)). | At most one per terminal; closed when a new sizing viewer attaches, the terminal ends, or the connection to the terminal core closes. Buffered at most 256 KiB credit plus 4 MiB queue. |
| Agent detection (op `detect`) | While the connection to the terminal core lasts. | With that stream or the agent, or 45 s of the terminal core's silence (it sends a heartbeat every 15 s). One extra connection, an observing attach per agent terminal, screen reads at most every 300 ms; at most 10000 events waiting for the hub, past which the stream ends (the hub opens it again). No process, no disk. |
| Finding agents' sessions (`detect` with `sessions`, plugin `agents`) | Per terminal running Claude Code or Codex. | A follower per terminal (a task of the node), ending with the agent, the terminal, the stream or the plugin; stats every 2–5 s (backing off to 30 s), reads of the process table. Caches ≤ 1024 entries. No process, no disk ([35](features/35-agent-native-view.md)). |
| Confirming a session (`agents` action `resolve`) | A page bringing an agent back ([33](features/33-workspace-restore.md)); ≤ 8 at once per machine, 15 s each. | Reads the transcript's header; locations cached in memory (≤ 1024). No process, no disk. |
| A session's usage (`usage` action `session`) | The status bar's session item, at most every 10 s per session, ≤ 8 at once per machine. | Reads transcripts (≤ 256 MiB each); the last 16 (48 MiB) cached in memory. No process, no disk. |
| Terminal history captures (plugin `history`, `history.capture`, off by default) | Every `history.interval` s (30) per connected machine; not for a `--read-only` hub. | One at a time, ≤ 25 s: screen reads and short observing attaches over one terminal core connection. Data: see Files. |
| Full Disk Access check (macOS) | `GET /api/m/{id}/privacy`; one at a time per agent. | A `/bin/sh` run by the terminal core (`machine.exec`) that opens one folder; ended by herdr-core within 10 s. None if no terminal core runs. |
| code-server | First VS Code use. | A hub's `--code-server-idle` (20 min) without connections while no other hub of the node has one, the node's end, **Stop VS Code**, or VS Code switched off for every client kind. Orphans are stopped by the next agent; code-server exits by itself after 1 h without connections. |
| VS Code windows | One per VS Code pane on screen. | Off-screen windows stay loaded 10 min, at most 3 per page; a closed pane disconnects at once. |
| VS Code extension hosts | One per VS Code window. | 5 min after the window disconnects. |
| curl or wget (`--code-server-install=download`) | While a machine downloads code-server. | With the download (20 min limit, or past 1 GiB) or when the hub stops waiting; the partial file is removed. |
| Xvfb or Xwayland | A remote Linux machine connects with GUI on (`gui.display` picks). | In its own session; exits 1 min after its last client (programs, window manager, display keeper). Replaced by the other kind only while no program is connected. |
| GUI helper's window manager (`veldr-gui gui-wm`) | While a hub is attached to the display (op `gui` `attach`). | A child of the node: exits when its last hub leaves, the display ends, the node ends or a newer node takes over (its stdin closes), or the node stops reading (256 MB waiting). |
| GPU display compositor (`veldr-gui gui-wl`, the GUI helper's) | With each Xwayland. | Exits with its Xwayland; listens nowhere. Logs to `<data>/hosts/<host>/xwayland.log`. |
| Display keeper (`veldr-gui gui-keep`, the GUI helper's) | When a display is ready and when the terminal core becomes reachable (`gui.keep`; not in `--read-only`). | One per instance and host (`<run>/gui-keep.lock`); holds the display while the terminal core runs, exits once it stops or the display ends. |
| `apt-get download xvfb` | A machine has no Xvfb (not in `--read-only`). | With the download (5 min limit); retried with backoff up to 5 min while connected. |
| Video encoder | One per program window sent as video (`gui.video`); the GUI helper starts it. | 5 s without frames, window unwatched, resized or gone, video turned off, or with the agent or the helper (own process group, killed when its parent dies). NVENC sessions are limited per machine; it falls back to VA-API, VP8 or pictures. |
| Shared memory for captures | While the agent's window manager (the GUI helper's) runs. | One System V segment ≤ 64 MB (0600), marked for removal once attached, so it goes with the agent. |
| Port forwards (hub host loopback) | A browser pane opens a machine's port ([32](features/32-browser-and-ports.md)). | Listeners on `127.0.0.1`/`::1`, at most 32 with 128 connections each; end when stopped, idle for `browser.forwardIdle` (30 min), the machine removed, the plugin off, or the hub stops. Nothing listens on the machine. |
| Vault and bridge sockets (`<run>/vault.sock`, `<run>/bridge.sock`) | Served by the newest node of the instance. | Unix sockets (0600); a node removes them on exit only if they are still its own. Each connection is one stream to the hub (vault: at most 16 at once). |
| The vault's MCP servers | Started by a coding agent's CLI, never by veldr. | Exit when the CLI closes stdin or signals them. A `run_with_env` command runs in its own process group, killed when it returns, at `vault.runTimeout` (120 s, max `vault.runMaxTimeout`), on cancel, or when the server dies. Output kept in memory, ≤ 128 KiB. Approvals wait `vault.approvalTimeout` (60 s); at most 4 per machine, 32 in all. |
| File explorer (plugin `files`) | Changes, saves, uploads, polls. | No process on the machine. Long copies/removals stop when the request ends (10 min max). At most 8 stats at once per machine. **Reveal in Finder** (hub's own machine) runs `/usr/bin/open -R` or `xdg-open` from a fixed path; at most 4 waited for. |
| Git (plugin `git`) | One `git` process per request; `git.autoFetch` while a panel shows the repository. | At most 8 per machine, each its own process group, killed after 15 s (reads) or 120 s (changes, fetch, pull, push) or when the request ends. No background maintenance (`gc.autoDetach=false`). Hooks' background programs and fsmonitor daemons are the user's, as in a terminal. |
| Project Search (plugin `search`) | a search from the Search panel (300 ms after the last key, or Enter), one at a time per panel: a new one cancels the one in flight | One `rg` process per search where the machine has ripgrep, else none (the agent's walker): at most 4 searches at once per machine, each in a process group of its own killed after 30 s, once 5000 matches at most were read, or when the hub closes the request's stream (the browser abandoned the search, the hub's 45 s passed). Nothing is written on the machine and nothing is kept between searches ([41](features/41-project-search.md)). |
| AI usage limits (plugin `usage`) | The hub's scheduler while the plugin is on (manual, 1–60 min, or adaptive). | HTTPS requests (15 s each, 45 s per action). On macOS `security` for Claude's keychain item (10 s), `ps`/`lsof` for Antigravity (5 s). Manual refresh at most every 30 s. |
| SQLite worker thread (plugin `usage`) | A cost scan that reads OpenCode's or Antigravity's databases. | In the node's process; ended with the scan, or when a request (a batch of rows) is not answered in 30 s; a thread blocked in a system call (a FIFO swapped in, a dead mount) ends when the call returns. Reads only; writes nothing but the `-shm` SQLite makes beside a database whose WAL has none. |
| `agy -p /usage` (plugin `usage`) | No Antigravity language server answers: at most every 10 min, 30 min after a failure. | Own process group, killed after 20 s; output ≤ 4 MiB. |
| Download archives (`fs.archive`) | A folder or several files download. | Zipped into the stream; ends with it. No disk. |
| Chat host (`veldr chat-host`, plugin `chat`, [37](features/37-agent-chats.md)) | A writing chat request or a page's chat subscription with no host serving; a hidden terminal of the instance's terminal core, one per instance and machine. Never for a `--read-only` hub. | Outlives ssh, agent and hub. Exits after 60 s with no agent process and no connection, with the terminal core, or when a newer build asks it to make way while no chat works; a host holding its name without serving for 45 s is killed by the next agent. Log `<data>/chat-host-<host>[-<id>].log` (1 MiB, one old file). |
| Chat host's journal worker | The chat host, as it starts. | A worker thread in the host's process that runs the journal's statements in order; ends with the host, which waits for its writes first. At most 64 MiB of events wait for it; past that the chats that make events fail. The host's log waits for its file at most 1 MiB, the rest counted. |
| Agents of chats (`claude`, `codex app-server`, `kimi acp`, `grok agent … stdio`) | A chat's prompt, with the PATH of the user's login shell (`$SHELL -l -i -c env`, at most every 6 h). | Own process group under the chat host. Ended idle after `chat.idleStopMinutes` (30), the idlest beyond `chat.maxLive` (8), on close, archive, delete or handoff, and with the host: input closed, SIGTERM after 2 s, SIGKILL later. Their own session files are theirs and never removed. |
| Short agent processes of a chat host | Listing a directory's sessions; importing a session (Codex without a live app-server, ACP agents). | ≤ 4 at once per host, each within 60 s (2 min for an ACP load). |
| Connections to a chat host | Page subscriptions, chat requests and the hub's watch, as streams of op `plugin` to the host's socket. | ≤ 128 per machine, ≤ 32 subscriptions per page; the host serves ≤ 256 and drops one 8192 events or 16 MiB behind. The watch lets a host go after 2 min unused. Nothing on TCP. |
| The vault's key in the hub's memory (hub host) | An unlock. | A non-extractable WebCrypto key until the vault locks, which drops it; it never lies in the hub's memory as bytes, and Argon2id's output only until it is imported, then wiped ([30](features/30-variable-vault.md)). |
| Secure Enclave helper (desktop app, macOS) | One process per question (availability, a new key, a Touch ID unlock). | Answers one line and exits; killed after 2 min or 64 KiB of output. Keeps nothing. |

### Files

| Resource | Written | Removed |
| --- | --- | --- |
| Agent builds (`~/.veldr/agent/`) | On connect, by content hash: the executable (111–131 MiB; the release's archive, 48–58 MiB, downloaded by the machine or uploaded by the hub, and unpacked), put in place only when the SHA-256 the machine computed is the one expected, which the hub checks again. | Unused for 14 days (a running node touches its build's directory every 24 h). A partial download or upload (`.upload.<pid>` with its `.in` and `.rc`) is removed when its script ends: an upload when its input ends (the connection went), a download within its bounds (256 MiB, 5 min); what a killed shell left, by a node's housekeeping after 1 h. |
| Release manifests and archives (`~/.veldr/cache/machine/SHA256SUMS-<version>`, `veldr-<platform>-<digest>.tar.gz`, hub host) | The manifest when the hub fetches it from its release; an archive when a machine needs one the hub neither has in `--agent-dir` nor is (its own platform's), checked against the manifest first. | Unused for 14 days (touched on use); a cached file that is not the build when it is read. |
| herdr-core executable (`<data>/hosts/<host>/hc/herdr-core`) | First subscription when the machine has another build (`term.install`; not in `--read-only`). A running terminal core is restarted onto it, keeping programs. | Replaced whole by the next install; a partial upload is removed after 1 h. |
| herdr-core state (`~/.local/state/herdr-core/veldr[-<instance>]-<host id>/`) | By herdr-core. | Kept until the user removes it. |
| code-server versions (`~/.veldr/code-server/<version>-<os>-<arch>/`) | Install (an upload or a download is staged beside them as `.upload-*` or `.download-*` and unpacked into `.install-*`; at most 1 GiB, unpacked at most 4 GiB). | Unused for 14 days, at the next install; a start touches its version, and housekeeping also touches the running one and removes the unused ones every 24 h. What an interrupted install left: when it ends, else on the TypeScript machine side after a day. |
| Anthropic's Agent SDK (`<data>/claude-agent-sdk/<version>/`: `package.json`, `sdk.mjs`, `LICENSE.md`, `README.md`) | Before a Claude Code chat starts on a machine without it (not in `--read-only`): the machine's download (≤ 32 MiB) or the hub's upload is staged beside the versions as `.download-*` or `.upload-*` and unpacked into `.install-*`, checked against the pinned integrity first. | Unused for 14 days (each load by the chat host and each look of a hub counts as a use), by the node's housekeeping; what an interrupted install left after a day. |
| Agent SDK tarballs (`~/.veldr/cache/npm/claude-agent-sdk-<version>.tgz`, hub host) | When a machine needs the SDK the hub has in no `--seed-dir`, from the hub's download. | Unused for 14 days (touched on use); a cached file that is not the pinned one when it is read. |
| Xvfb packages (`~/.veldr/hosts/<host>/xvfb/`), video encoders (`~/.veldr/video/`, ~2 MB), GPU selection libraries (`~/.veldr/gpupick/`, 0600, `gui.pick`) | When needed (not in `--read-only`). | Unused for 14 days, when another is installed. |
| GUI helper (`<data>/gui/<sha256 prefix>/veldr-gui`, 0700) | Extracted from the machine build when program windows first need it on the host; checked by its SHA-256 before each start and written again when it differs. | Another build's unused for 14 days, by the node's housekeeping (a running one touches its directory at each start); an extraction left unfinished after 1 h. |
| Uploads (`<data>/staging/`, 0700/0600) | File explorer uploads (≤ 4 GiB). | When written or failed; one left by a killed agent is removed by an agent after 7 days. |
| Pasted files (`<data>/uploads/`) | Pasted files, and dropped files when the terminal's directory cannot take them. | After 7 days. |
| Dropped files (`.veldr-upload-*` while writing) | Files dropped on a pane, into its terminal's directory. | The files are the user's; a temporary file is removed when its stream ends early. |
| Trash | **Move to Trash** in the explorer. | The user's trash (`~/.local/share/Trash`, `~/.Trash` on macOS); emptied by the user. |
| code-server logs (`<data>/hosts/<host>/cs-data/logs/`) | code-server. | After 7 days. |
| Display and code-server logs (`<data>/hosts/<host>/xvfb.log`, `xwayland.log`, `gui-keep.log`, `code-server.log`) | Each start of the display, its keeper or code-server. | Overwritten at each start. |
| MCP command (`<data>/bin/veldr-mcp`, a script, and `veldr-mcp-<system>-<machine>`, a link per platform) | Each agent start: the script if it differs, the link of its platform. | Replaced by the next agent; removed with the data directory. |
| Machine database (`<data>/machine-<host>[-<id>].db`, 0600, [38](features/38-sqlite-state.md)) | Terminal history snapshots; the AI usage cost cache (Cost tab scans, ≤ 1/min per range, ≤ 2 min). | History: two generations per terminal of ≤ `history.lines` (2000) lines and 2 MiB, ≤ `history.maxTerminals` (32) terminals and `history.maxTotalMB` (64) in all, oldest first; removed after `history.days` (7), when the terminal ends or is gone 2 min, with **Clear Saved Output**, and when capture is turned off ([36](features/36-terminal-history.md)). Cost cache: records and logs older than 90 days leave at each scan; the housekeeping also drops a cache no scan saved for 90 days (the plugin off on that machine). |
| Chat journal (`<data>/chat-<host>[-<id>].db`, 0600) | The chat host. | Per chat ≤ `chat.maxChatMB` (64), in all ≤ `chat.maxTotalMB` (512) and `chat.maxChats` (500), archived then longest-closed first; closed and archived chats after `chat.retentionDays` (30); a deleted chat at once. |
| DeepSeek key (`<data>/usage/deepseek.key`, 0600) | **Save** in the usage panel (audited). | **Remove**, or the user deletes it. |
| Kimi Code credentials (`~/.kimi-code/`) | Renewed when expiring (`usage.kimiRefresh`; not in `--read-only`), with Kimi Code's own lock. | Kimi Code's files. |
| Vault access log (hub database `hub[-<instance>]-<host>[-<id>].db`, hub host, 0600) | Every MCP request and value a page takes; names, never values. | Keeps the last 1000 releases and 500 other records. |
| Old-name hub database (`core[-<instance>]-<host>[-<id>].db`, hub host) | Earlier releases. | Not read: the hub of its instance removes this host's with its journal files when it starts (one a process holds stays); another host's after 30 days unused ([38](features/38-sqlite-state.md#per-host-names)). |
| Desktop vault unlock key | Enrolling the desktop authenticator. | `vault-unlock.json` in the Electron profile, the macOS keychain item (moved to a rebuilt app after one prompt) or the Windows Hello key `veldr-vault-<install>`; kept until removed by hand. |
| Electron profile | First desktop launch. | Until removed by hand ([where](#where-the-app-keeps-its-files)); hub stderr is kept in memory only (16 KiB). |

**Home directories several hosts share** (NFS, [40](features/40-shared-homes.md)). Each host keeps its own SQLite files and chat host log, named `<name>-<host>[-<id>]` by host name and a hash of its machine id; another host's are removed after 30 days unopened, only under SQLite's writers' lock, so a database in use stays ([38](features/38-sqlite-state.md)). Sockets, locks and pid files are in the host-local runtime directory, the terminal core's session ends in the host's id, and the terminal core's executable, code-server's data and the logs are in `<data>/hosts/<host>/`. Each agent touches its host's directory at start and every 24 h; another host's directory unused for 30 days loses everything but the terminal core's executable (`hc/`), and goes whole after 180 days.

How machines get code-server is a setting (`codeServer.install`, per machine, or `--code-server-install`): the hub uploads it (default; works without internet on the machine), the machine downloads it (needs curl or wget and access to `--code-server-url`), or an installed one is used (`--code-server-path` or `PATH`). The last two fall back to uploading. A change applies the next time code-server starts; **Stop VS Code on `<machine>`** in a VS Code pane's menu restarts it now.

## Running as a service

macOS (launchd), `~/Library/LaunchAgents/app.veldr.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.veldr</string>
  <key>ProgramArguments</key><array>
    <string>/opt/veldr/veldr</string>
    <string>--allowed-origin</string><string>https://ide.example.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/veldr.log</string>
</dict></plist>
```

Linux (systemd user unit), `~/.config/systemd/user/veldr.service`:

```ini
[Unit]
Description=veldr

[Service]
ExecStart=%h/.local/lib/veldr/veldr --allowed-origin https://ide.example.com
Restart=on-failure
# ssh ControlMasters outlive restarts, so machines that needed an
# interactive login reconnect without one.
KillMode=process

[Install]
WantedBy=default.target
```

Install the full release directory at that path. The service must run as the user who owns the ssh keys. The local terminal core is not part of the unit (herdr-core runs it as its own user service), so terminals survive restarts. `KillMode=process` stops only the hub, whose agents then end their own processes.

## Several hubs and development builds

The chat host survives restarting or reinstalling the app; a newer build asks an older host to make way only while no chat works or waits. Builds of local changes (`-dirty.<time>` versions) are not ordered, so the Chats panel reminds you to **Restart Chat Host**; chats resume their sessions in the new host.

Two hubs reaching the same machine share only the agent build directory unless they use the same instance. Give each its own `--instance` (state in `~/.veldr-<instance>`, terminal core session `veldr-<instance>-<host id>`). For development:

```bash
make dev-hub      # this host's executable staged in dist/payload, then bun backend/hosts/bun/main.ts --instance dev --local-only --listen 127.0.0.1:7790 --web-dir web/dist
make dev-web      # Vite on top of it
```
