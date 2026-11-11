# Deployment

herdr-ide runs on one host (your laptop or an always-on machine) and is used
from browsers. It reaches herdr machines over ssh; nothing listens on the
machines.

- [Local use](#local-use)
- [macOS desktop app](#macos-desktop-app)
- [Remote access through a reverse proxy](#remote-access-through-a-reverse-proxy)
- [Air-gapped networks](#air-gapped-networks)
- [Remote resources](#remote-resources)
- [Running as a service](#running-as-a-service)
- [Several cores and development builds](#several-cores-and-development-builds)

## Local use

```bash
scripts/build.sh
cd dist/packages/herdr-ide-$(go env GOOS)-$(go env GOARCH)
./herdr-ide    # http://127.0.0.1:7780
```

Each `dist/release/` archive contains the core, a native herdr 0.9.5 beside it
and licenses. Extract it as a directory; moving just the core loses the bundled
herdr. Supported hosts are Linux/macOS on amd64/arm64.

The core embeds the video encoder it puts on Linux machines to send program
windows as video ([14](features/14-gui-windows.md)). `scripts/build.sh`
embeds it when `scripts/build-ffmpeg.sh` (Docker) built it into
`dist/ffmpeg/`; the release workflow builds it on native amd64 and arm64
runners and requires it (`REQUIRE_ENCODER=1`). A build without it sends
program windows as pictures.

The bundled herdr only spares installing herdr on this host. herdr-ide uses an
installed herdr when it finds one, otherwise its own copy of the bundled
one, and herdr keeps its usual configuration, sessions and machine list
either way. Start herdr's server before using the local machine: **Manage
herdr** in the local machine's context menu (or its status when it reports a
problem) starts and stops it and updates the application's copy of herdr;
opening the TUI with `./herdr-ide herdr` also starts it.
`./herdr-ide herdr <args>` runs any herdr command, such as
`./herdr-ide herdr machine add user@host --label gpu`. SSH machines need their
own herdr installation and running session. Panes need herdr 0.9.5 or newer
on every machine (herdr's endpoint protocol, generation 1); with an older
herdr the machine's state and actions work and its panes ask for an update
(**Update herdr**).

One browser tab uses herdr-ide at a time, like a KVM console: another tab
offers to take the session over, and the previous one then shows that it
was taken over. herdr-ide is herdr's foreground client while you use it:
its window size sets the size of herdr's tabs, and herdr's own TUI, if you
open one at the same time, follows the tab herdr-ide shows.

Machines come from herdr's saved SSH machines (`herdr machine list`); add
others with `--ssh`. herdr-ide uses OpenSSH with your `~/.ssh/config`
(ProxyJump, agent, keys) in BatchMode. A machine that needs a password, 2FA or
a host-key confirmation shows **Authentication required**; **Authenticate…**
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
agents but not herdr's sessions, and opened again after the copy. An app that
does not quit within 30 s is left as is and nothing is installed. The new
copy is assembled next to the old one, so a failed copy leaves the old app in
place.

Editable icon sources live in `desktop/assets/icon.svg` and
`web/public/icon.svg` (the simpler small-size version). The 1024-pixel PNG
and multi-resolution ICNS are committed, so ordinary builds need no graphics
tools. After editing the sources, run `brew install librsvg` if needed, then
`make desktop-icons` on macOS and rebuild the app/DMG.

The app includes herdr (`herdr-ide.app/Contents/Resources/bin/herdr`), used
only when no installed herdr is found; OpenSSH remains an external
prerequisite. Finder launches include `~/.local/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` and system paths in the core's PATH. The launcher does not
execute shell startup files, so variables exported there, such as
`HERDR_BIN`, reach the core only when the app is started from that shell.
Existing herdr servers and SSH configuration are reused. The app never starts
herdr's server by itself; start it, stop it and update herdr with **Manage
herdr** in the local machine's context menu, without a terminal.

The core listens at `127.0.0.1:7781` with instance `desktop`, separate from
the CLI default and `dev`. A fixed origin preserves UI preferences across
launches. `HERDR_IDE_DESKTOP_PORT` overrides the port; changing it changes
the browser storage origin. An occupied port fails visibly; the app never
attaches to an existing listener. Opening the app twice focuses the original
window. Closing the main window or quitting stops its core and agents;
closing a program window leaves the main app running. HTTP(S) external links
open in the default browser; custom URL schemes are refused.

For development, start only an isolated herdr session and run:

```bash
herdr --session herdr-ide-dev server &
make dev-desktop
```

This builds the embedded UI (no hot reload) and uses port 7791, instance
`dev`, local-only connections and session `herdr-ide-dev`. For packaged
smoke tests, launch the executable with `HERDR_IDE_DESKTOP_DEV=1`, e.g.:

```bash
HERDR_IDE_DESKTOP_DEV=1 dist/desktop/mac-arm64/herdr-ide.app/Contents/MacOS/herdr-ide
```

Quit other development cores using the `dev` instance first. Electron uses
its own persistent profile (`herdr-ide-desktop`, or `herdr-ide-desktop-dev`)
under Application Support; remove that directory manually to reset desktop
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
- **Read-only** – `--read-only` serves a watch-only view (panes without
  input, no mutating herdr calls, no uploads, no VS Code). Run a second
  instance with it for sharing screens or phones; while it shows a machine it
  is herdr's foreground client of that machine too, so its window size sets
  the size of herdr's tabs.
- **Audit log** – `--audit-log FILE` records connections, mutating herdr
  calls, uploads, VS Code and bridge use and refused requests as JSON lines,
  with the user from `--user-header`.
- The herdr API is exposed through an allowlist: the UI cannot stop herdr
  servers, install integrations, link plugins or open raw event streams.

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

The web UI, agents and VS Code bridge are embedded in the core, and the
bundled herdr is beside it; code-server and external extensions are resolved
at runtime. Building needs Go modules, npm packages and the pinned herdr
download (verified files in `dist/herdr/` are reused).

## Remote resources

What herdr-ide starts on a machine and how it is reclaimed:

| Resource | Started | Reclaimed |
| --- | --- | --- |
| Desktop core | Electron launches its bundled binary | SIGTERM on normal quit, with a 20 s deadline before SIGKILL of that owned child; parent-stdin EOF also stops it if Electron crashes. herdr servers and pane programs remain running. |
| Electron profile | First desktop launch | Kept until manually removed; Chromium manages its caches. Development has a separate profile. Core stderr is bounded to 16 KiB in memory; no desktop log files accumulate. |
| `herdr-ide-agent` | one per core while connected | Exits when its ssh session ends; a dead link is detected by keepalives within about 45 s. |
| herdr server started from the UI (local or SSH machine) | **Manage herdr** or **Restart herdr…**, on request | Belongs to the user like one started by the herdr TUI and outlives the core and the agent; stopped with **Manage herdr** or `herdr server stop`, and with the machine. On a machine whose logind ends user processes at logout (`KillUserProcesses=yes`) it ends with the agent's ssh login unless the user enabled lingering (`loginctl enable-linger`). Its output goes to `~/.herdr-ide/herdr/server.log` there, replaced at every start from the UI of any session. |
| `herdr update` | **Update** in **Manage herdr** | Ends with the update (15 min limit); herdr's temporary download is in `~/.herdr-ide/herdr/`. |
| `herdr machine add` (core host) | **Add machine…** | Ends when herdr exits or the window closes. A herdr it installs on the machine and the server it starts there belong to the user, like after `herdr machine add` in a terminal; **Remove machine…** (`herdr machine remove`) forgets the machine without stopping them. A removed machine's agent exits with its session; the agent builds left in `~/.herdr-ide/agent/` follow their usual retention. |
| `herdr --remote` client (core host) | **Update herdr** for an SSH machine | Ends when herdr exits or the window closes. A herdr it installs on the machine (usually `~/.local/bin/herdr`) is herdr's own installation and stays until the user removes it; a server it starts there belongs to the user. |
| Connection to herdr's client socket | one per core, to the machine the browser shows | Closed when another machine is shown, 10 s after the owning browser left (unless another browser takes over), or with the agent; no process is started. |
| code-server | on first VS Code use | Stopped after `--code-server-idle` (default 20 min) without VS Code connections, when the agent exits (if that agent started it; for the local machine, when the core stops), or by the stop button in the VS Code panel. Hidden VS Code panels disconnect after 10 min. A process left behind by a killed agent is stopped by the next agent, and code-server exits by itself after 1 h without connections. |
| VS Code extension hosts | one per VS Code window | Disposed 5 min after the window disconnects. |
| ssh ControlMaster | per machine | Exits after 10 min unused or after 1 min without answers from the server. When the core finds its connection dead (an agent session lost while ssh kept running, a probe timing out) it tells it to take no new sessions (`ssh -O stop`), and it exits with the last session open through it. |
| Xvfb (virtual display) | when a remote Linux machine connects with the GUI setting on | Runs in its own session so programs keep their windows across disconnects; exits 1 min after its last client (programs, the agent's window manager, the display keeper) disconnected, so soon after the herdr server stops and its programs exit; the agent connects once after starting it, so this also holds when nothing attaches. With xorg-server before 21.1 it exits as soon as its last client leaves, and one that never got a client stays until an agent attaches. |
| Display keeper (`herdr-ide-agent gui-keep`) | when a display is ready and each time the machine's herdr server becomes reachable again (never in `--read-only`; audited as `gui.keep`), and when herdr's server is started from the UI | One per instance (`run/gui-keep.lock`), in its own session; holds a connection to the display while the session's herdr server runs (checked every 5 s by its socket's peer process and start time), follows a server restarted within 30 s, and exits otherwise or when the display ends. |
| `apt-get download xvfb` | when a machine has no Xvfb (never in `--read-only`) | Ends with the download (5 min limit); the package is unpacked into `~/.herdr-ide/xvfb/` and the download removed; a download left by a killed agent is removed by the next agent after 1 h. A failed install or start is retried after 5 s, doubling up to 5 min, while the machine stays connected. |
| Video encoder (`gui-video`, on by default) | one per program window sent as video (never for windows over 4096 pixels a side) | Started by the agent's window manager while a watched window keeps changing; ends after 5 s without frames (also while its viewers stopped acknowledging), when the window is no longer watched, resized or gone, when its viewers change to another stream, when video is turned off for the machine, or with the agent (own process group, killed with the agent). With NVENC each holds one GPU encode session; consumer NVIDIA cards allow 8 per machine for all users together, and a stream that cannot open one uses VA-API or VP8, else pictures. VA-API holds a context on the render node while it runs. |
| Pushing the video encoder (`gui-video`) | when a Linux machine's display is ready and video is on for it (never in `--read-only`) | One upload of about 2 MB per build and machine, verified by SHA-256 and kept in `~/.herdr-ide/video/`; builds unused for 14 days are removed when another is installed. |
| Shared memory for captures | while the agent's window manager runs | One System V segment of at most 64 MB, 0600, marked for removal as soon as the agent attached it (on Linux; elsewhere once Xvfb attached it): it disappears when the agent and its connection to the display are gone, also when the agent is killed. |
| curl or wget (`--code-server-install=download`) | while a machine downloads code-server | Ends with the download (20 min limit); the partial file in `~/.herdr-ide/code-server/` is removed, or with the unused versions after 14 days if the agent was killed. |
| Disk | see [reference](reference.md#files-and-directories) | Uploads and logs after 7 days; agent builds and code-server versions unused for 14 days; Xvfb packages and video encoders unused for 14 days when another one is installed. Files dropped on a pane are written into the pane's directory and belong to the user, like files copied there by hand. A cancelled or interrupted upload leaves nothing: the agent removes its temporary file (`.herdr-ide-upload-*` beside the target) when the stream ends early; only an agent killed during an upload leaves one. |

herdr servers are started and stopped by the user: through herdr, or
through **Manage herdr** and **Restart herdr…** in a machine's context menu
(an SSH machine that rebooted is *degraded* until its server is started
again; **Retry** does not start it). herdr on an SSH
machine changes only through herdr's own `herdr --remote` flow, which
**Update herdr** (the machine's context menu) runs in a terminal where the
user answers herdr's questions; where herdr was removed or moved (or a
reinstalled system lost it) the same flow is offered as **Install herdr**. The bundled herdr and
the licenses stay in the extracted release directory until the user removes
it; the application's copy of herdr and the log of servers it started are
described in [reference](reference.md#files-and-directories). No herdr binary
is uploaded to SSH machines.

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
# A herdr server started with Manage herdr must survive restarts of the service.
KillMode=process

[Install]
WantedBy=default.target
```

Install the full release directory at the path shown above (or adjust the
path). The service must run as the user who owns the herdr sessions and the
ssh keys. systemd stops every process of a unit by default, including a herdr
server started from the UI and all its terminals; `KillMode=process` stops only
the core, whose agents then end their own processes.

## Several cores and development builds

Two cores that connect to the same machine share one agent build directory
but nothing else unless they use the same instance. Give each one its own
`--instance` (state in `~/.herdr-ide-<instance>`); for development also use an
isolated herdr session:

```bash
herdr --session herdr-ide-dev server &
make dev-core     # go run ./cmd/herdr-ide --instance dev --local-only --local-session herdr-ide-dev --listen 127.0.0.1:7790
```
