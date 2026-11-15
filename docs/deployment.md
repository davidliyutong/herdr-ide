# Deployment

herdr-ide runs on one host (your laptop or an always-on machine) and is used
from browsers. It reaches its machines over ssh; nothing listens on the
machines.

- [Local use](#local-use)
- [macOS desktop app](#macos-desktop-app)
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
(`licenses/`). Supported hosts are Linux/macOS on amd64/arm64.

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

## macOS desktop app

Each GitHub release attaches `herdr-ide-<version>-mac-arm64.dmg` (Apple
Silicon) and `herdr-ide-<version>-mac-x64.dmg` (Intel), built by the release
workflow from the tag and listed in `SHA256SUMS` with the archives. Check the
digest (`shasum -a 256 -c SHA256SUMS --ignore-missing`) and, for a public
repository, the provenance (`gh attestation verify <dmg> --repo <owner>/<repo>`)
before the first launch. The released DMGs are signed ad hoc like local
builds, so macOS blocks the first launch of the downloaded app; allow it once
under System Settings → Privacy & Security.

To build on a Mac, install Go, Node.js 22.12+ and pnpm:

```bash
make desktop-app                       # host-architecture .app
VERSION=0.1.0 make desktop-dmg           # .app and DMG in dist/desktop/
ARCH=x64 make desktop-dmg               # Intel core and Electron
ARCH=arm64 make desktop-dmg             # Apple Silicon core and Electron
make desktop-install                    # host-architecture .app into /Applications
```

Each command builds the UI, bridge extension, four agents and the matching
macOS core before bundling Electron. Versions are pinned in the desktop
lockfile. The DMG contains an app and an Applications shortcut; drag the app
to Applications, eject the image, then launch it. The build is ad-hoc signed,
without a Developer ID or notarization; Gatekeeper may require explicit
approval for a downloaded copy. Public signed distribution and automatic
updates are outside this packaging mode. Windows and Linux installers are
not implemented. The app and disk image use the project's terminal-pane icon.

`make desktop-install` builds the `.app` like `make desktop-app` and copies it
over `/Applications/herdr-ide.app` (`INSTALL_DIR=~/Applications` picks another
folder). If that copy is running, it is quit first, which stops its core and
agents but not the machines' terminal cores, and opened again after the copy. An app that
does not quit within 30 s is left as is and nothing is installed. The new
copy is assembled next to the old one, so a failed copy leaves the old app in
place.

Editable icon sources live in `desktop/assets/icon.svg` and
`web/public/icon.svg` (the simpler small-size version). The 1024-pixel PNG
and multi-resolution ICNS are committed, so ordinary builds need no graphics
tools. After editing the sources, run `brew install librsvg` if needed, then
`make desktop-icons` on macOS and rebuild the app/DMG.

OpenSSH is an external prerequisite; the SSH configuration is reused.
Finder launches include `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` and system paths in the core's PATH. The launcher does not
execute shell startup files, so variables exported there reach the core only
when the app is started from that shell.

The core listens at `127.0.0.1:7781` with instance `desktop`, separate from
the CLI default and `dev`. The app follows the core's settings: its theme
colors the title bar, its language the menu, and the menu shows the
keybindings in effect. A fixed origin preserves UI preferences across
launches. `HERDR_IDE_DESKTOP_PORT` overrides the port; changing it changes
the browser storage origin. An occupied port fails visibly; the app never
attaches to an existing listener. Opening the app twice focuses the original
window. Closing the main window or quitting stops its core and agents;
closing a program window leaves the main app running. HTTP(S) external links
open in the default browser; custom URL schemes are refused.

For development run:

```bash
make dev-desktop
```

This builds the embedded UI (no hot reload) and uses port 7791, instance
`dev` (terminal core session `herdr-ide-dev`) and local-only connections. For packaged
smoke tests, launch the executable with `HERDR_IDE_DESKTOP_DEV=1` and, beside
an installed copy, a profile of its own, e.g.:

```bash
HERDR_IDE_DESKTOP_DEV=1 dist/desktop/mac-arm64/herdr-ide.app/Contents/MacOS/herdr-ide \
  --user-data-dir="$TMPDIR/herdr-ide-smoke"
```

Launch the executable rather than `open` the bundle: `open` activates a
running copy with the same bundle identifier instead. Quit other development
cores using the `dev` instance first. Electron uses its own persistent
profile (`herdr-ide-desktop`, or `herdr-ide-desktop-dev`) under Application
Support, which also holds its single-instance lock; `--user-data-dir`
replaces both. Remove that directory manually to reset desktop
preferences. Browser and desktop preferences are separate. Core state and
resource retention follow [Remote resources](#remote-resources).

## Remote access through a reverse proxy

The server has no login. It must stay on loopback behind a reverse proxy that
authenticates users and terminates TLS. HTTPS is required in practice: VS Code
webviews (Git Graph, media preview) need service workers, and the clipboard
and notification APIs need a secure context (plain `http://localhost` is the
only exception).

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
resolved on the core host and pushed through the agent. When the core host is
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
| Desktop core | Electron launches its bundled binary | SIGTERM on normal quit, with a 20 s deadline before SIGKILL of that owned child; parent-stdin EOF also stops it if Electron crashes. The machines' terminal cores and their programs remain running. |
| Electron profile | First desktop launch | Kept until manually removed; Chromium manages its caches. Development has a separate profile. Core stderr is bounded to 16 KiB in memory; no desktop log files accumulate. |
| `herdr-ide-agent` | one per core while connected | Exits when its ssh session ends; a dead link is detected by keepalives within about 45 s. |
| A machine added from the UI | **Add machine…** (`POST /api/machines`) | Only a record in the core's `machines[-<instance>].json` and an agent while it is connected. **Remove machine…** deletes the record and ends the session (the agent exits and stops what it started); the machine's terminal core and terminals keep running there; the agent builds left in `~/.herdr-ide/agent/` follow their usual retention. |
| Terminal core (herdr-core) | when a client of `/api/v1/term` first subscribes to the machine's terminals and no core answers (never in `--read-only`; audited as `term.start`), or **Start terminal core** / **Restart terminal core…** in the machine's menu (browser UI, desktop app) (`POST /api/m/{id}/hc/{start\|restart}`, audited as `hc.start`, `hc.restart`) | Started by herdr-core detached from the agent (a systemd user service on Linux, a launchd job on macOS) in the session `herdr-ide[-<instance>]`, with its socket in `~/.herdr-ide[-<instance>]/run/hc.sock`. It belongs to the user and outlives the agent and the core, so its programs keep running; it ends with **Stop terminal core…** in the machine's menu (`POST /api/m/{id}/hc/stop`, asked first, audited as `hc.stop`: every terminal there ends, and the core starts none again until it is started from the menu or a client subscribes to the machine anew), with the agent op `hc` action `stop`, with `HC_SESSION=herdr-ide[-<instance>] HC_SOCKET=<socket> herdr-core server stop`, and with the machine. A restart keeps the programs (the core's successor adopts them). Its state (terminal records, saved screens, logs) is herdr-core's, in `~/.local/state/herdr-core/herdr-ide[-<instance>]/`, and stays until the user removes it. |
| herdr-core executable | pushed with the first subscription to a machine's terminals when the machine has another build than the core carries (never in `--read-only`; audited as `term.install`); a core already running is then restarted onto it (`term.restart`), and its programs keep running | One file, `~/.herdr-ide[-<instance>]/hc/herdr-core`, verified by SHA-256 and replaced whole by the next install; a running core keeps the executable it started from. A partial upload left by a killed agent is removed by the next install after 1 h. |
| Connection to the terminal core | one per machine while a client of `/api/v1/term` is subscribed to it | Closed 10 s after the last subscriber left, and with the agent; attached streams end with their client. No process is started by it. |
| Agent detection (op `detect`) | while the core's connection to a machine's terminal core lasts | In the agent: one more connection to the terminal core, an event subscription, and for each terminal running a coding agent an observing attach and screen reads (`terminal.read`, at most every 300 ms after output); everything ends when the core closes the stream (10 s after the last subscriber left, or the connection to the terminal core ended) or with the agent. No process is started and nothing is written to disk. |
| code-server | on first VS Code use | Stopped after `--code-server-idle` (default 20 min) without VS Code connections, when the agent exits (if that agent started it; for the local machine, when the core stops), or by the stop button in the VS Code panel. Hidden VS Code windows (each workspace has its own panel) disconnect after 10 min, and at most 3 stay loaded per page. A process left behind by a killed agent is stopped by the next agent, and code-server exits by itself after 1 h without connections. |
| VS Code extension hosts | one per VS Code window | Disposed 5 min after the window disconnects. |
| ssh ControlMaster | per machine | Exits after 10 min unused or after 1 min without answers from the server. When the core finds its connection dead (an agent session lost while ssh kept running, a probe timing out) it tells it to take no new sessions (`ssh -O stop`), and it exits with the last session open through it. |
| Xvfb (virtual display) | when a remote Linux machine connects with the GUI setting on | Runs in its own session so programs keep their windows across disconnects; exits 1 min after its last client (programs, the agent's window manager, the display keeper) disconnected, so soon after the terminal core stopped and its programs exited; the agent connects once after starting it, so this also holds when nothing attaches. With xorg-server before 21.1 it exits as soon as its last client leaves, and one that never got a client stays until an agent attaches. |
| Display keeper (`herdr-ide-agent gui-keep`) | when a display is ready and each time the machine's terminal core becomes reachable again (never in `--read-only`; audited as `gui.keep`) | One per instance (`run/gui-keep.lock`), in its own session; holds a connection to the display while the instance's terminal core runs (checked every 5 s by the socket's peer process and its start time), follows a terminal core restarted within 30 s, and exits once it no longer runs or when the display ends. |
| `apt-get download xvfb` | when a machine has no Xvfb (never in `--read-only`) | Ends with the download (5 min limit); the package is unpacked into `~/.herdr-ide/xvfb/` and the download removed; a download left by a killed agent is removed by the next agent after 1 h. A failed install or start is retried after 5 s, doubling up to 5 min, while the machine stays connected. |
| Video encoder (`gui.video`, on by default) | one per program window sent as video (never for windows over 4096 pixels a side) | Started by the agent's window manager while a watched window keeps changing; ends after 5 s without frames (also while its viewers stopped acknowledging), when the window is no longer watched, resized or gone, when its viewers change to another stream, when video is turned off for the machine, or with the agent (own process group, killed with the agent). With NVENC each holds one GPU encode session; consumer NVIDIA cards allow 8 per machine for all users together, and a stream that cannot open one uses VA-API or VP8, else pictures. VA-API holds a context on the render node while it runs. |
| Pushing the video encoder (`gui.video`) | when a Linux machine's display is ready and video is on for it (never in `--read-only`) | One upload of about 2 MB per build and machine, verified by SHA-256 and kept in `~/.herdr-ide/video/`; builds unused for 14 days are removed when another is installed. |
| Shared memory for captures | while the agent's window manager runs | One System V segment of at most 64 MB, 0600, marked for removal as soon as the agent attached it (on Linux; elsewhere once Xvfb attached it): it disappears when the agent and its connection to the display are gone, also when the agent is killed. |
| curl or wget (`--code-server-install=download`) | while a machine downloads code-server | Ends with the download (20 min limit); the partial file in `~/.herdr-ide/code-server/` is removed, or with the unused versions after 14 days if the agent was killed. |
| Download archives (`fs.archive`) | while a folder or several files download | No process and nothing on disk: the agent zips into the download's stream and its walk ends with the stream, also when the download is cancelled. |
| Disk | see [reference](reference.md#files-and-directories) | Uploads and logs after 7 days; agent builds and code-server versions unused for 14 days; Xvfb packages and video encoders unused for 14 days when another one is installed. Files dropped on a pane are written into its terminal's directory and belong to the user, like files copied there by hand. A cancelled or interrupted upload leaves nothing: the agent removes its temporary file (`.herdr-ide-upload-*` beside the target) when the stream ends early; only an agent killed during an upload leaves one. |

The licenses stay in the extracted release directory until the user removes
it.

How machines get code-server is a setting (the settings dialog or
`--code-server-install`): the core uploads the release (default; works for
machines without internet), each machine downloads it itself (faster when the
machines have a better connection than the path through the core; needs curl
or wget and access to the `--code-server-url` host), or a code-server already
installed on the machine is used (`--code-server-path`, or found on `PATH` and
the usual locations). The last two fall back to uploading. A change applies
the next time code-server starts on a machine; stop it from the VS Code panel
to restart it now.

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
  desktop app). The defaults left are in the
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
