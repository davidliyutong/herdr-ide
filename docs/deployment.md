# Deployment

herdr-ide runs on one host (your laptop or an always-on machine) and is used
from browsers. It reaches its machines over ssh; nothing listens on the
machines.

- [Local use](#local-use)
- [Desktop app](#desktop-app)
- [Remote access through a reverse proxy](#remote-access-through-a-reverse-proxy)
- [Air-gapped networks](#air-gapped-networks)
- [Remote resources](#remote-resources)
- [Running as a service](#running-as-a-service)
- [Several cores and development builds](#several-cores-and-development-builds)
- [Migrating from versions that used herdr](#migrating-from-versions-that-used-herdr)

## Local use

```bash
scripts/build.sh
cd dist/packages/herdr-ide-$(go env GOOS)-$(go env GOARCH)
./herdr-ide    # http://127.0.0.1:7780
```

Each `dist/release/` archive contains the core and its licenses
(`licenses/`). Release archives are for Linux and macOS on amd64 and arm64.
A core for Windows x64 ships only inside the [desktop app](#desktop-app)'s
setup (`TARGETS=windows/amd64 scripts/build.sh` writes
`dist/herdr-ide-windows-amd64.exe` and no archive); it reaches SSH machines
only, since the agent runs on Linux and macOS.

The core embeds the video encoder it puts on Linux machines to send program
windows as video ([14](features/14-gui-windows.md)). `scripts/build.sh`
embeds it when `scripts/build-ffmpeg.sh` (Docker) built it into
`dist/ffmpeg/`; the release workflow builds it on native amd64 and arm64
runners and requires it (`REQUIRE_ENCODER=1`). A build without it sends
program windows as pictures.

The core also embeds herdr-core 0.1.21, the terminal core its agent installs
on machines ([21](features/21-terminal-core.md)), for Linux and macOS on
amd64 and arm64: about 12 MB in the core. `scripts/build.sh` runs
`scripts/fetch-hc`, which downloads the four release archives from
`releases.herdr.dev` (or reuses those in `dist/hc/`), checks them against
the SHA-256 digests pinned in `internal/hcdist` and writes the executables,
gzip-compressed, to `internal/embedded/hc/`; the build fails when an archive
cannot be fetched or verified. To build without network access, put the four
archives into `dist/hc/` first. herdr-core's license and notices are in the
archive's `licenses/herdr-core/`. A core built with `go build` alone has no
herdr-core unless `go run ./scripts/fetch-hc <os>/<arch> ...` ran before it.

The browser UI shows the terminals of each machine's terminal core
(herdr-core, installed and started through the agent when you first show a
machine; [21](features/21-terminal-core.md)); nothing needs to be installed
on the machines beforehand. SSH machines are added with **Add machine…** in
the sidebar (an ssh target and a label); the first start of an instance
imports the SSH machines herdr saved
(`~/.local/state/herdr/client/endpoints.json`), if any.

Several browser tabs, windows and the desktop app can show the same
machines at once: they share each machine's arrangement of
workspaces, tabs and panes ([04](features/04-layout-and-keyboard.md)), and
a terminal takes the size of the client that used it last.

Machines come from the core's machines file
([reference](reference.md#files-and-directories)); add others for one run
with `--ssh`. herdr-ide uses OpenSSH with your `~/.ssh/config`
(ProxyJump, agent, keys) in BatchMode. A machine that needs a password, 2FA or
a host-key confirmation shows **Sign-in required**; **Sign in…**
opens a terminal for it, and later connections reuse that ssh ControlMaster.
Windows' OpenSSH has no ControlMaster, so a core there offers no sign-in:
its SSH machines need a key the ssh agent holds (or one without a
passphrase) and a host key accepted beforehand
([Windows](#windows)).

## Desktop app

The desktop app is the browser UI in an Electron window with a core of its
own, for macOS (Apple Silicon and Intel), Windows (x64) and Linux (x64 and
arm64) ([16](features/16-desktop-packaging.md)). Each GitHub release
attaches, built by the release workflow from the tag:

| System | Files |
| --- | --- |
| macOS | `herdr-ide-<version>-mac-arm64.dmg` and `.zip` (Apple Silicon), `herdr-ide-<version>-mac-x64.dmg` and `.zip` (Intel) |
| Windows | `herdr-ide-<version>-win-x64.exe` (setup) |
| Linux | `herdr-ide-<version>-linux-amd64.deb`, `-linux-arm64.deb`, `-linux-x86_64.AppImage`, `-linux-arm64.AppImage` |

They are listed in `SHA256SUMS` with the archives. Check the digest
(`shasum -a 256 -c SHA256SUMS --ignore-missing`; on Windows compare
`Get-FileHash <file>` with its line) and, for a public repository, the
provenance (`gh attestation verify <file> --repo <owner>/<repo>`) before the
first launch. There are no automatic updates: install a newer release over
the old one.

What the app does on each system:

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Local machine (terminals, files, VS Code) | yes | no: shown as needing Linux or macOS (`local_unsupported`) | yes |
| SSH machines | yes, with **Sign in…** for passwords and host keys | yes, with keys in the ssh agent and host keys accepted beforehand | yes, with **Sign in…** |
| Program windows | of remote Linux machines | of remote Linux machines | of remote Linux machines |
| Folders opened with the app | dropped on the sidebar or the Dock icon | – | dropped on the sidebar, or **Open With** in the file manager |
| Notifications and the blocked-agents badge | the Dock icon's badge | the taskbar button's overlay; notifications of the installed app | with a notification daemon; the badge in docks that implement the Unity launcher API |
| Closing the main window | the app stays in the Dock until quit | quits | quits |
| Signature | ad hoc, or Developer ID and notarized when the release has the secrets | none | none |

The core listens at `127.0.0.1:7781` with instance `desktop`, separate from
the CLI default and `dev`. The app follows the core's settings: its theme
colors the title bar, its language the menu, and the menu shows the
keybindings in effect. A fixed origin preserves UI preferences across
launches. `HERDR_IDE_DESKTOP_PORT` overrides the port; changing it changes
the browser storage origin. An occupied port fails visibly; the app never
attaches to an existing listener. Opening the app twice focuses the
original window (on macOS, opens it again when it was closed). Quitting
stops its core and agents, not the machines' terminal cores; closing a
program window leaves the main app running. HTTP(S) external links open in
the default browser; custom URL schemes are refused. OpenSSH is the
system's, with the user's SSH configuration.

### macOS

Open the DMG, drag the app to Applications, eject the image, then launch
it (or unpack the zip and move the app there). A release built without the
Developer ID secrets is signed ad hoc, and Gatekeeper refuses the
downloaded app's first launch: "“herdr-ide” cannot be opened because Apple
cannot check it for malicious software" (or that it is damaged). Allow it
once: on macOS 14 and earlier Control-click the app and choose **Open**; on
macOS 15 and later try to open it, then choose **Open Anyway** under System
Settings → Privacy & Security. Removing the quarantine attribute does the
same: `xattr -dr com.apple.quarantine /Applications/herdr-ide.app`. A
release built with the secrets is signed with a Developer ID and notarized,
and opens without this. To update, quit the app and replace it with the
newer one; to uninstall, quit it and move it to the Trash (the files below
stay).

**Full Disk Access.** Without it macOS keeps programs out of other apps'
data (Mail, Messages, Safari) and Time Machine backups, and asks before
they open Desktop, Documents, Downloads or external disks. It is granted to
two programs: the app, for the file browser, uploads, downloads and
VS Code, and herdr-core, `~/.herdr-ide-desktop/hc/herdr-core`, for the
programs of terminals (macOS holds herdr-core, not the app, responsible for
them). **Settings → Terminal → Permissions → Full Disk Access** shows
whether each has it and opens System Settings at the list (also **Open
Full Disk Access Settings…** in the command palette): turn on herdr-ide
and add herdr-core with **+** or by dragging it from the Finder window
**Show herdr-core in Finder** opens. macOS applies it to processes started
afterwards: quit and reopen the app (**Quit and Reopen…**; terminals keep
running), restart the terminal service (**Restart Terminal Service…**;
programs keep running) and open new terminals; terminals opened before
stay without it until closed. macOS keeps a grant for the code that
satisfies the program's designated requirement: for an app signed ad hoc
that is this very build, so after rebuilding or updating it remove the
app's entry with **−** and add it again; a Developer ID release keeps its
grant across updates, and so does herdr-core, signed with Herdr's
Developer ID.

Finder launches include `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` and system paths in the core's PATH. The launcher does not
execute shell startup files, so variables exported there reach the core only
when the app is started from that shell.

To build on a Mac, install Go, Node.js 22.12+ and pnpm:

```bash
make desktop-app                        # host-architecture .app in dist/desktop/mac-arm64/ or mac/
VERSION=0.1.0 make desktop-dist         # .app, DMG and zip in dist/desktop/
ARCH=x64 make desktop-dist              # Intel core and Electron
ARCH=arm64 make desktop-dist            # Apple Silicon core and Electron
make desktop-install                    # host-architecture .app into /Applications
```

Each command builds the UI, bridge extension, four agents and the matching
core before bundling Electron. Versions are pinned in the desktop lockfile.
Local builds are signed ad hoc; with `CSC_LINK` and `CSC_KEY_PASSWORD` (or
`CSC_NAME`) they are signed with that Developer ID, and with `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` also notarized
([reference](reference.md#environment-variables)).

`make desktop-install` builds the `.app` like `make desktop-app` and copies it
over `/Applications/herdr-ide.app` (`INSTALL_DIR=~/Applications` picks another
folder). If that copy is running, it is quit first, which stops its core and
agents but not the machines' terminal cores, and opened again after the copy. An app that
does not quit within 30 s is left as is and nothing is installed. The new
copy is assembled next to the old one, so a failed copy leaves the old app in
place.

### Windows

The app needs Windows' OpenSSH Client (Settings → System → Optional
features; installed by default on Windows 10 1809 and later and on
Windows 11). Run the setup; it is not signed, so SmartScreen may show
"Windows protected your PC": choose **More info**, then **Run anyway**. It
installs for the current user, without administrator rights, into
`%LOCALAPPDATA%\Programs\herdr-ide-desktop\` with a Start menu shortcut.
To update, run a newer setup with the app closed; to uninstall, use
Settings → Apps → Installed apps (the files below stay).

On Windows the app reaches SSH machines only: the agent runs on Linux and
macOS, so the local machine is listed with a note and never connected
(WSL is not built in; a WSL distribution running an ssh server can be added
as an SSH machine). Windows' ssh cannot share a connection (no
ControlMaster), so the app has no **Sign in…**: every connection
authenticates by itself in BatchMode, with the configuration in
`%USERPROFILE%\.ssh\config`. Before adding a machine, accept its host key
and make the key available, in PowerShell:

```powershell
ssh user@host            # once: accept the host key, then exit
# a key with a passphrase: let Windows' ssh agent hold it
# (the service, once, in a PowerShell run as administrator)
Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent
ssh-add                  # adds ~/.ssh/id_* to the agent
```

A key without a passphrase needs no agent. A machine that still needs a
password, 2FA or a host key shows **Sign-in required** with these steps;
**Retry** it afterwards. ssh runs without console windows. Windows shows
the notifications of the installed app (its Start menu shortcut carries
the app's id), not of a copy run from `win-unpacked/`.

To build on Windows, install Go, Node.js 22.12+, pnpm and Git for Windows,
and run `scripts/desktop.sh app` (the unpacked app in
`dist/desktop/win-unpacked/`) or `scripts/desktop.sh dist` (the setup) in
Git Bash; the `make desktop-*` targets run the same script where `make` is
installed.

### Linux

Install the Debian package for your architecture:

```bash
sudo apt install ./herdr-ide-<version>-linux-amd64.deb   # or -linux-arm64.deb
```

It installs into `/opt/herdr-ide/`, adds the `herdr-ide` command, a desktop
entry (Development) and icons, depends on the libraries Electron needs
(ALSA's `libasound2` among them) and recommends `openssh-client`. On
Ubuntu 24.04 and later it also installs an AppArmor profile, without which
Chromium's sandbox cannot start there. To update, install a newer package
the same way; to uninstall, `sudo apt remove herdr-ide-desktop` (the files
below stay).

The AppImage runs without installing: `chmod +x
herdr-ide-<version>-linux-x86_64.AppImage`, then start it. It needs FUSE 2
(`sudo apt install libfuse2`, `libfuse2t64` on Ubuntu 24.04). On Ubuntu
24.04 and later AppArmor's restriction of unprivileged user namespaces keeps
Chromium's sandbox from starting in an AppImage, and the app exits: use the
deb there. The app never turns the sandbox off (`--no-sandbox`). To update,
replace the file.

The desktop entry offers the app for folders: **Open With** in the file
manager makes a workspace of each on the local machine, as dropping them on
the sidebar does. Notifications need a notification daemon on the session
bus (`org.freedesktop.Notifications`), which desktop environments run; the
count of blocked agents shows on the app's icon in docks that implement the
Unity launcher API. Launchers include `~/.local/bin`, `/usr/local/bin` and
system paths in the core's PATH, as on macOS.

To build on Linux, install Go, Node.js 22.12+ and pnpm:

```bash
make desktop-app                        # dist/desktop/linux-unpacked/ (x64) or linux-arm64-unpacked/
make desktop-dist                       # AppImage and deb in dist/desktop/
ARCH=arm64 make desktop-dist            # arm64 packages, also on an x64 host
```

### Where the app keeps its files

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| The app | `/Applications/herdr-ide.app` | `%LOCALAPPDATA%\Programs\herdr-ide-desktop\` | `/opt/herdr-ide/` (deb), or the AppImage where you put it |
| Settings, keybindings, machines (`settings-desktop.json`, `keybindings-desktop.json`, `machines-desktop.json`) | `~/Library/Application Support/herdr-ide/` | `%AppData%\herdr-ide\` | `$XDG_CONFIG_HOME/herdr-ide/` (default `~/.config/herdr-ide/`) |
| Electron profile (browser storage, permissions, the single-instance lock) | `~/Library/Application Support/herdr-ide-desktop/` | `%AppData%\herdr-ide-desktop\` | `~/.config/herdr-ide-desktop/` |
| code-server downloads | `~/Library/Caches/herdr-ide/code-server` | `%LocalAppData%\herdr-ide\code-server` | `~/.cache/herdr-ide/code-server` |
| The local machine's agent state | `~/.herdr-ide-desktop/` | – | `~/.herdr-ide-desktop/` |
| ssh control sockets | `/tmp/herdr-ide-<uid>/s` | – | `/tmp/herdr-ide-<uid>/s` |

Every SSH machine keeps the instance's state in its own
`~/.herdr-ide-desktop/` ([remote resources](#remote-resources)). Uninstalling
removes only the app; remove the rest by hand. Removing the Electron
profile resets the app's browser preferences, which are separate from a
browser's.

### Development

```bash
make dev-desktop
```

This builds the embedded UI (no hot reload) and runs unpackaged Electron
with port 7791, instance `dev` (terminal core session `herdr-ide-dev`) and
local-only connections; on Windows such a run connects no machine, since it
is local-only and the local machine has no agent there. Quit other
development cores using the `dev` instance first. For packaged smoke tests,
launch the executable with `HERDR_IDE_DESKTOP_DEV`: `1` for the `dev`
instance, or a name of its own (lowercase letters, digits and dashes) to run
beside a development instance in use (`desktop` is refused), with port
`0`, e.g.:

```bash
HERDR_IDE_DESKTOP_DEV=smoke HERDR_IDE_DESKTOP_PORT=0 \
  dist/desktop/mac-arm64/herdr-ide.app/Contents/MacOS/herdr-ide --user-data-dir="$TMPDIR/herdr-ide-smoke"
HERDR_IDE_DESKTOP_DEV=smoke HERDR_IDE_DESKTOP_PORT=0 \
  dist/desktop/linux-unpacked/herdr-ide --user-data-dir=/tmp/herdr-ide-smoke
```

On macOS launch the executable rather than `open` the bundle: `open`
activates a running copy with the same bundle identifier instead. Every
development instance is local-only and has an Electron profile and
single-instance lock of its own (`herdr-ide-desktop-dev`,
`herdr-ide-desktop-smoke`); `--user-data-dir` replaces both. A named instance leaves its own state like any instance
(`settings-smoke.json` beside the others, `~/.herdr-ide-smoke/` and the
terminal core session `herdr-ide-smoke` on the local machine); stop that
terminal core from the machine's menu (**Stop terminal core…**) before
removing them. Core state and resource retention follow
[Remote resources](#remote-resources).

Editable icon sources live in `desktop/assets/icon.svg` and
`web/public/icon.svg` (the simpler small-size version). The 1024-pixel PNG,
the multi-resolution ICNS and the ICO are committed, so ordinary builds need
no graphics tools. After editing the sources, run `brew install librsvg` if
needed, then `make desktop-icons` on macOS and rebuild the app.

## Remote access through a reverse proxy

The server has no login. It must stay on loopback behind a reverse proxy that
authenticates users and terminates TLS. HTTPS is required in practice: VS Code
webviews (Git Graph, media preview) need service workers, and the clipboard
and notification APIs need a secure context (plain `http://localhost` is the
only exception).

VS Code is off by default. code-server is served on the UI's own origin, so
its extensions and webviews can do whatever a user's page can; a user turns
it on for browsers in **Settings › Plugins**, after accepting that risk, and
the setting (`plugins.vscode.browser`) applies to every browser of the
server until it is turned off. The desktop app's switch
(`plugins.vscode.enabled`) does not turn it on in browsers.

Tell herdr-ide the public origin so its Host/Origin checks accept it:

```bash
herdr-ide --allowed-origin https://ide.example.com
```

**Tailscale** (tailnet only, automatic certificates):

```bash
herdr-ide --allowed-origin https://mac.your-tailnet.ts.net --user-header Tailscale-User-Login
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
		header_up X-herdr-ide-Proxy-Secret {env.HERDR_IDE_PROXY_SECRET}
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
    proxy_set_header X-herdr-ide-Proxy-Secret "<secret>";
    proxy_read_timeout 1d;
}
```

### Guardrails

- **Proxy secret** – `--proxy-secret-file FILE` makes herdr-ide require the
  `X-herdr-ide-Proxy-Secret` header on every request that does not come from a
  browser on the same host, so only your proxy can talk to it. With a secret,
  `--listen` may use a non-loopback address (e.g. a proxy in a container);
  without one, that needs the explicit `--insecure-listen`.
- **Read-only** – `--read-only` serves a watch-only view (terminals
  without input, which follow the size other clients set; no layout
  changes, uploads or VS Code; no terminal core is installed or started).
  Run a second instance with it for sharing screens or phones.
- **Audit log** – `--audit-log FILE` records connections, mutating terminal
  core calls, uploads, VS Code and bridge use and refused requests as JSON
  lines, with the user from `--user-header`.
- The terminal core's API is exposed through an allowlist: clients reach
  terminals and layout documents, never the core's commands for machines,
  files or its server.

See [SECURITY.md](../SECURITY.md) for the threat model.

## Air-gapped networks

Machines never need internet access: code-server releases and extensions are
resolved on the core host and pushed through the agent. The AI usage plugin is the
one exception: it asks the AI providers' hosts from the machines whose CLIs
are signed in to them ([29](features/29-ai-usage.md)); without internet its
requests fail and the panel says so. When the core host is
offline too, prepare a bundle on a connected machine:

```bash
herdr-ide fetch-assets ./bundle                          # all platforms
herdr-ide fetch-assets --platforms linux-amd64 ./bundle  # only what you need
```

Copy `./bundle` (tarballs, VSIXs and `.sha256` files) and the full application release directory
into the network, then run:

```bash
herdr-ide --offline --seed-dir ./bundle
```

Lookup order: `--seed-dir` directories, then the cache, then (unless
`--offline`) a download from `--code-server-url` / `--extension-url`, which
can point at an internal mirror. Every file is verified: the default versions
have SHA-256 digests compiled into the binary; other versions need a
`<file>.sha256` next to the file (written by `fetch-assets`). A mismatching
seed is rejected, never replaced. A download without any known digest is
accepted once and its digest recorded (logged as a warning).

Bundles are for your own installations: Git Graph explicitly restricts
derivative distribution and does not clearly grant general redistribution
of the original, so do not publish bundles containing it without permission.

The web UI, agents, herdr-core for machines and VS Code bridge are embedded
in the core; code-server and external extensions are resolved at runtime.
Building needs Go modules, npm packages and the pinned herdr-core downloads
(verified archives in `dist/hc/` are reused).

## Remote resources

What herdr-ide starts on a machine and how it is reclaimed:

| Resource | Started | Reclaimed |
| --- | --- | --- |
| Desktop core | Electron launches its bundled binary | The app closes the core's stdin when it quits (on Windows and Linux also when the main window closes; on macOS the app and its core keep running in the Dock until quit), and when Electron crashes the pipe closes as well; the core then stops its agents. That owned child alone is killed after 20 s. No signal is sent, on any system. The machines' terminal cores and their programs remain running. |
| Electron profile | First desktop launch | Kept until manually removed, also by uninstalling ([where](#where-the-app-keeps-its-files)); Chromium manages its caches. Development has a separate profile. Core stderr is bounded to 16 KiB in memory; no desktop log files accumulate. |
| `herdr-ide-agent` | one per core while connected | Exits when its ssh session ends; a dead link is detected by keepalives within about 45 s. |
| A machine added from the UI | **Add machine…** (`POST /api/machines`) | Only a record in the core's `machines[-<instance>].json` and an agent while it is connected. **Remove machine…** deletes the record and ends the session (the agent exits and stops what it started); the machine's terminal core and terminals keep running there; the agent builds left in `~/.herdr-ide/agent/` follow their usual retention. |
| Full Disk Access check (macOS) | `GET /api/m/{id}/privacy` (the desktop app's settings, on macOS, when the row appears and when the window regains focus); one at a time per agent | `/bin/sh` run by the machine's terminal core through herdr-core's `machine.exec`, only while that core runs (none is started), opening and closing one folder; herdr-core ends it and everything it started after 10 s at most, and sweeps the token it keeps for it in its state directory when it ended (or at its next start, after a crash). The agent writes nothing. |
| A closed pane's terminal | **Close Pane** or **Close Tab** in a page | The pane leaves at once; the terminal keeps running 5 s, labeled `closing` with the time it ends, so that **Undo Close** can bring it back. Every page showing the machine ends a terminal so labeled that has no pane once that time is over (`terminal.kill`), also when the page that closed it is gone; with no page open, the next page to show the machine ends it. |
| Terminal core (herdr-core) | when a client of `/api/v1/term` first subscribes to the machine's terminals and no core answers (never in `--read-only`; audited as `term.start`), or **Start terminal core** / **Restart terminal core…** in the machine's menu (browser UI, desktop app) (`POST /api/m/{id}/hc/{start\|restart}`, audited as `hc.start`, `hc.restart`) | Started by herdr-core detached from the agent (a systemd user service on Linux, a launchd job on macOS) in the session `herdr-ide[-<instance>]`, with its socket in `~/.herdr-ide[-<instance>]/run/hc.sock`. It belongs to the user and outlives the agent and the core, so its programs keep running; it ends with **Stop terminal core…** in the machine's menu (`POST /api/m/{id}/hc/stop`, asked first, audited as `hc.stop`: every terminal there ends, and the core starts none again until it is started from the menu or a client subscribes to the machine anew), with the agent op `hc` action `stop`, with `HC_SESSION=herdr-ide[-<instance>] HC_SOCKET=<socket> herdr-core server stop`, and with the machine. A restart keeps the programs (the core's successor adopts them). Its state (terminal records, saved screens, logs) is herdr-core's, in `~/.local/state/herdr-core/herdr-ide[-<instance>]/`, and stays until the user removes it. |
| herdr-core executable | pushed with the first subscription to a machine's terminals when the machine has another build than the core carries (never in `--read-only`; audited as `term.install`); a core already running is then restarted onto it (`term.restart`), and its programs keep running | One file, `~/.herdr-ide[-<instance>]/hc/herdr-core`, verified by SHA-256 and replaced whole by the next install; a running core keeps the executable it started from. A partial upload left by a killed agent is removed by the next install after 1 h. |
| Connection to the terminal core | one per machine while a client of `/api/v1/term` is subscribed to it | Closed 10 s after the last subscriber left, and with the agent; attached streams end with their client. No process is started by it. |
| Agent detection (op `detect`) | while the core's connection to a machine's terminal core lasts | In the agent: one more connection to the terminal core, an event subscription, and for each terminal running a coding agent an observing attach and screen reads (`terminal.read`, at most every 300 ms after output); everything ends when the core closes the stream (10 s after the last subscriber left, or the connection to the terminal core ended) or with the agent. No process is started and nothing is written to disk. |
| code-server | on first VS Code use | Stopped after `--code-server-idle` (default 20 min) without VS Code connections (turning VS Code off for the desktop app or for browsers closes the connections of that kind of client; turning both off also ends a preparation under way), when the agent exits (if that agent started it; for the local machine, when the core stops), or by **Stop VS Code on `<machine>`** in a VS Code pane's menu. Each VS Code pane on screen is a VS Code window of its own, loaded only once its pane is on screen; a window off screen (another tab, workspace or machine) stays loaded for 10 min, and at most 3 such windows stay per page (the oldest go first); then it disconnects. A pane closed in the layout, by any client, disconnects its window at once, as a disabled or removed machine does its windows. A process left behind by a killed agent is stopped by the next agent, and code-server exits by itself after 1 h without connections. |
| VS Code extension hosts | one per VS Code window | Disposed 5 min after the window disconnects. |
| ssh ControlMaster | per machine, on a core on Linux or macOS (Windows' ssh has none, and each connection ends with its session) | Exits after 10 min unused or after 1 min without answers from the server. When the core finds its connection dead (an agent session lost while ssh kept running, a probe timing out) it tells it to take no new sessions (`ssh -O stop`), and it exits with the last session open through it. |
| Xvfb (virtual display) | when a remote Linux machine connects with the GUI setting on | Runs in its own session so programs keep their windows across disconnects; exits 1 min after its last client (programs, the agent's window manager, the display keeper) disconnected, so soon after the terminal core stopped and its programs exited; the agent connects once after starting it, so this also holds when nothing attaches. With xorg-server before 21.1 it exits as soon as its last client leaves, and one that never got a client stays until an agent attaches. |
| Display keeper (`herdr-ide-agent gui-keep`) | when a display is ready and each time the machine's terminal core becomes reachable again (never in `--read-only`; audited as `gui.keep`) | One per instance (`run/gui-keep.lock`), in its own session; holds a connection to the display while the instance's terminal core runs (checked every 5 s by the socket's peer process and its start time), follows a terminal core restarted within 30 s, and exits once it no longer runs or when the display ends. |
| `apt-get download xvfb` | when a machine has no Xvfb (never in `--read-only`) | Ends with the download (5 min limit); the package is unpacked into `~/.herdr-ide/xvfb/` and the download removed; a download left by a killed agent is removed by the next agent after 1 h. A failed install or start is retried after 5 s, doubling up to 5 min, while the machine stays connected. |
| Video encoder (`gui.video`, on by default) | one per program window sent as video (never for windows over 4096 pixels a side) | Started by the agent's window manager while a watched window keeps changing; ends after 5 s without frames (also while its viewers stopped acknowledging), when the window is no longer watched, resized or gone, when its viewers change to another stream, when video is turned off for the machine, or with the agent (own process group, killed with the agent). With NVENC each holds one GPU encode session; consumer NVIDIA cards allow 8 per machine for all users together, and a stream that cannot open one uses VA-API or VP8, else pictures. VA-API holds a context on the render node while it runs. |
| Pushing the video encoder (`gui.video`) | when a Linux machine's display is ready and video is on for it (never in `--read-only`) | One upload of about 2 MB per build and machine, verified by SHA-256 and kept in `~/.herdr-ide/video/`; builds unused for 14 days are removed when another is installed. |
| Shared memory for captures | while the agent's window manager runs | One System V segment of at most 64 MB, 0600, marked for removal as soon as the agent attached it (on Linux; elsewhere once Xvfb attached it): it disappears when the agent and its connection to the display are gone, also when the agent is killed. A segment whose capture failed is freed with the next captures, which go through the X connection. |
| curl or wget (`--code-server-install=download`) | while a machine downloads code-server | Ends with the download (20 min limit), or when the core stops waiting (VS Code turned off, the machine left); the partial file in `~/.herdr-ide/code-server/` is removed, or with the unused versions after 14 days if the agent was killed. |
| File explorer (plugin `files`) | changes from its panel and saves from its editor pane | No process: each change is one request to the agent; a copy or removal of a large tree stops between entries when the core stops waiting (its request ended, 10 min at most). Files deleted with **Move to Trash** go to the user's trash on the machine (`~/.local/share/Trash` or `$XDG_DATA_HOME/Trash` with their `.trashinfo`, `.Trash/<uid>` in an administrator's sticky `.Trash` or `.Trash-<uid>` at the top of another mount, each used only while it is the user's own and closed to others, `~/.Trash` on macOS) and stay there until the user empties it, as files the system's file manager deletes do. A save writes `.herdr-ide-save-*` beside the file and renames it over the file; a failed or broken-off save removes it. Polls (one stat of the shown directories every 2 s, the next only once the last one answered, less often after failures) run only while the panel is shown and the page visible; at most 8 stats run at once on the machine and a path is stat'ed once while a stat of it runs, so a mount that does not answer holds at most 8 threads until it does (each poll answers within 10 s, with those paths' state unknown). |
| Git (plugin `git`) | one `git` process per request of the panel, the graph or a diff (the panel polls `watch`, which starts none, every 2 s while shown and reads the status when it moved or every 10 s; after a status that took over 2 s or timed out, less often, waiting up to 5 minutes); with `git.autoFetch` set, one `git fetch --all --prune` every so many minutes while a page shows the panel (none while a change runs); a change with thousands of paths runs git once per 96 KiB of them, one after the other | At most 8 runs at once per machine. Each run is a process group of its own, killed after 15 s (reads) or 120 s (changes, fetch, pull, push), or when the core closes the request's stream (the browser went away); a run whose git exited ends at most 2 s later. Reads start no file system monitor and no maintenance, and automatic maintenance a change starts runs inside the run (`gc.autoDetach=false`, `maintenance.autoDetach=false`), so the plugin leaves no git process running. What remains is the user's, as in a terminal: programs hooks start in the background, which keep running after a run that ended (a run killed at its timeout or cancelled kills those still in its process group), and the file system monitor daemon or hook a change starts when the repository's `core.fsmonitor` asks for one. git writes what the user asked for into the repository (index, refs, objects, stashes) as in a terminal; the plugin keeps no files of its own. |
| Vault and bridge sockets (`run/vault.sock`, `run/bridge.sock`) | by every agent while it runs; the newest agent of the instance takes them over | Unix sockets (0600) served by one agent of the instance at a time: one that starts takes them over (the agent of a session that lingers after a reconnect no longer gets the connections), one whose sockets were taken over checks every 2 s and serves them again once they are free (the newer agent gone), and an agent removes a socket when it exits only while it is its own (same inode), so they are served while any agent of the instance runs and none is left after the last. A connection is relayed to the core over one stream, opened once it sent its first bytes, that ends with it (the vault's: one request, at most 16 at once); nothing is started. |
| MCP link (`~/.herdr-ide[-<instance>]/bin/herdr-ide-mcp`) | pointed at the running executable whenever an agent starts (on the local machine: the core's executable) | One symbolic link, replaced by the next agent; kept so MCP configurations stay valid; removed with the data directory. |
| The vault's MCP servers | by a coding agent's CLI (Claude Code, Codex…) the user configured with the link, never by herdr-ide | Belong to the CLI that starts them and exit when it closes their stdin or sends them SIGTERM, SIGINT or SIGHUP, after killing the commands they run. A command of `run_with_env` runs in its own process group, killed when the command returns (programs it left in the background with it), after its timeout (120 s by default, at most 600 s), when the client cancels the call, or when the server ends, however it ends: a watcher in the group holds a pipe only the server writes to and kills the group when the pipe closes (also when the server is killed with SIGKILL), and on Linux the command's shell also gets SIGKILL when the server dies. A program that leaves the group (`setsid`, a daemon) escapes it; its output is kept in memory only (at most 128 KiB). A request waiting for approval ends after 60 s, or when the client cancels the call; at most 4 wait per machine and 32 in all. |
| Download archives (`fs.archive`) | while a folder or several files download | No process and nothing on disk: the agent zips into the download's stream and its walk ends with the stream, also when the download is cancelled. |
| AI usage limits (plugin `usage`, action `limits`) | the core's scheduler, while the plugin is on: by hand, every 1–60 min, or adaptive (by default 5 min while a panel is open in a page that is shown, 10 while a coding agent works, else 30; each a setting) | No process except below: HTTPS requests to the providers (15 s each, the action at most 45 s, ended sooner when the core stops waiting) through one client per agent, whose idle connections close after 90 s; the loopback requests to Antigravity's language server close their connections with the answer; nothing is written. On macOS, `security find-generic-password` for Claude's keychain item (10 s limit); `ps` and `lsof` (5 s each) to find Antigravity's language server. A manual refresh polls at most once per 30 s. |
| `agy -p /usage` (plugin `usage`) | when no Antigravity language server answers and `agy` is installed: at most every 10 min (the polls in between get its last answer), not again for 30 min after it failed or timed out | Runs in a process group of its own, killed with everything it started after 20 s, and again once `agy` exited (`AGY_CLI_DISABLE_AUTO_UPDATE=true`, so it updates nothing); its output is read, at most 4 MiB. |
| AI usage cost cache (plugin `usage`, action `cost`) | when the Cost tab is shown (at most once a minute per range, one scan at a time per machine, stopped when the core stops waiting, at most 2 min; what it read stays in the cache) | `~/.herdr-ide[-<instance>]/usage/cost-cache.json` (0600): per log file its size, time and usage records; one record per response; records older than 90 days and logs that are gone or older than 90 days leave it at each scan. A scan that changed it writes it when the file is older than 5 min or the scan read at least 8 MiB of logs (else the next scan reads on from the file's offsets), a long scan every 20 s, and one that is cancelled what it read. |
| DeepSeek key file (plugin `usage`) | **Save** in the panel's DeepSeek section (`PUT /api/m/{id}/p/usage/deepseek-key`, audited) | `~/.herdr-ide[-<instance>]/usage/deepseek.key` (0600) until **Remove** (an empty key) or the user deletes it. |
| Disk | see [reference](reference.md#files-and-directories) | Uploads and logs after 7 days; agent builds and code-server versions unused for 14 days; Xvfb packages and video encoders unused for 14 days when another one is installed. Files dropped on a pane are written into its terminal's directory and belong to the user, like files copied there by hand. A cancelled or interrupted upload leaves nothing: the agent removes its temporary file (`.herdr-ide-upload-*` beside the target) when the stream ends early; only an agent killed during an upload leaves one. |

The licenses stay in the extracted release directory until the user removes
it.

How machines get code-server is a setting (the settings dialog, for every
machine or in one machine's own settings, or `--code-server-install` for
all of them): the core uploads the release (default; works for
machines without internet), each machine downloads it itself (faster when the
machines have a better connection than the path through the core; needs curl
or wget and access to the `--code-server-url` host), or a code-server already
installed on the machine is used (`--code-server-path`, or found on `PATH` and
the usual locations). The last two fall back to uploading. A change applies
the next time code-server starts on a machine; to restart it now, stop it
from a VS Code pane's menu (**Stop VS Code on `<machine>`**), then press
**Start VS Code** in the pane.

## Running as a service

macOS (launchd), `~/Library/LaunchAgents/dev.herdr-ide.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.herdr-ide</string>
  <key>ProgramArguments</key><array>
    <string>/opt/herdr-ide/herdr-ide</string>
    <string>--allowed-origin</string><string>https://ide.example.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/herdr-ide.log</string>
</dict></plist>
```

Linux (systemd user unit), `~/.config/systemd/user/herdr-ide.service`:

```ini
[Unit]
Description=herdr-ide

[Service]
ExecStart=%h/.local/lib/herdr-ide/herdr-ide --allowed-origin https://ide.example.com
Restart=on-failure
# ssh ControlMasters outlive restarts, so machines that needed an
# interactive login reconnect without one.
KillMode=process

[Install]
WantedBy=default.target
```

Install the full release directory at the path shown above (or adjust the
path). The service must run as the user who owns the ssh keys. The local
machine's terminal core is not part of the unit: herdr-core runs it as a
user service of its own, so its terminals survive restarts. systemd stops
every process of a unit by default, including the ssh ControlMasters the
core started; `KillMode=process` stops only the core, whose agents then end
their own processes.

## Several cores and development builds

Two cores that connect to the same machine share one agent build directory
but nothing else unless they use the same instance. Give each one its own
`--instance` (state in `~/.herdr-ide-<instance>`, terminal core session
`herdr-ide-<instance>`). For development:

```bash
make dev-core     # go run ./cmd/herdr-ide --instance dev --local-only --listen 127.0.0.1:7790 --agent-dir dist/agents
make dev-web      # Vite on top of it
```

## Migrating from versions that used herdr

Earlier versions drew their panes from herdr, the terminal multiplexer, and
kept part of their configuration in it. This version keeps everything in
its own files and its own terminal core; starting it once moves what can be
moved. The steps are one way: an earlier version does not read the new
files.

- **Settings.** A `settings[-<instance>].json` of the earlier format
  (string values under the flags' names, machines' values under
  `"machines"`) is converted when the core first reads it and rewritten in
  the new format ([13](features/13-settings-and-appearance.md)). Settings a
  browser kept in `localStorage` (language, theme, font sizes…) are moved
  into the core's settings once, by the first page of a writable core.
- **Keybindings.** The desktop app's shortcut settings (`desktop-*-key`)
  become rules of a new `keybindings[-<instance>].json` once, while that
  file does not exist, and are dropped from the settings; otherwise the
  file is created by the first change of a key. Keys set in herdr's own
  configuration no longer apply, and ⌘W in the desktop app now closes the
  focused pane (`pane.close`), not the tab.
- **The prefix chords are gone.** The defaults no longer have the
  `ctrl+b` chords of herdr's keymap (`ctrl+b c` new tab, `ctrl+b v` split,
  `ctrl+b space` palette…): `ctrl+b` and every key that is not a default
  now reach the program in the terminal on their first press, and the
  commands are in the menus, the context menus, the pane headers and the
  command palette (the status bar's button; `cmd+shift+p` in the
  desktop app on macOS, `ctrl+shift+p` on Windows and Linux). The defaults
  left are in the
  [reference](reference.md#keyboard-shortcuts). Chords can be bound again,
  one rule per key, under **Settings → Keyboard shortcuts** or in
  `keybindings[-<instance>].json` in the core host's user configuration
  directory (`keybindings-desktop.json` for the desktop app), for example:

  ```json
  [
    { "key": "ctrl+b c", "command": "tab.new" },
    { "key": "ctrl+b v", "command": "pane.splitRight" },
    { "key": "ctrl+b space", "command": "app.commandPalette" }
  ]
  ```

  While a chord starting with `ctrl+b` is bound, `ctrl+b` waits for its
  next key; pressed twice it reaches the terminal.
- **Machines.** The first start of an instance without a
  `machines[-<instance>].json` imports the SSH machines herdr saved
  (`$XDG_STATE_HOME/herdr/client/endpoints.json`, default
  `~/.local/state/herdr/client/endpoints.json`): their ids, labels, targets
  and whether they were enabled. Names of herdr sessions other than the
  default that machines used are not kept; every machine gets the
  instance's own terminal core. Later changes to herdr's file are not
  read. A machine whose target the core refuses (one that starts with `-`
  or holds whitespace, a control character or a shell character such as
  `$`, `;` or `|`) is imported too and shown in error (`invalid_target`),
  never connected, until it is renamed, removed or corrected in the
  machines file.
- **Terminals.** Terminals, workspaces and tabs that lived in herdr
  sessions are not migrated: each machine now has a terminal core of the
  instance's own (herdr-core, session `herdr-ide[-<instance>]`,
  [21](features/21-terminal-core.md)), which starts empty. The old
  terminals keep running in herdr and remain reachable with the herdr CLI
  until they are ended there; this version neither stops nor attaches to
  them.
- **Find** in a terminal finds plain text (ASCII letters in either case);
  regular expressions and whole-word matching are gone.
