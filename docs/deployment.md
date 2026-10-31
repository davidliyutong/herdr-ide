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

The bundled herdr only spares installing herdr on this host. herdr-ide uses an
installed herdr when it finds one, otherwise the bundled one, and herdr keeps
its usual configuration, sessions and machine list either way. Start herdr
before using the local machine, for example by opening its TUI with
`./herdr-ide herdr`; `./herdr-ide herdr <args>` runs any herdr command, such
as `./herdr-ide herdr machine add user@host --label gpu`. SSH machines need
their own herdr installation and running session.

Machines come from herdr's saved SSH machines (`herdr machine list`); add
others with `--ssh`. herdr-ide uses OpenSSH with your `~/.ssh/config`
(ProxyJump, agent, keys) in BatchMode. A machine that needs a password, 2FA or
a host-key confirmation shows **Authentication required**; **Authenticate…**
opens a terminal for it, and later connections reuse that ssh ControlMaster.

## macOS desktop app

Build on a Mac with Go, Node.js 22.12+ and pnpm:

```bash
make desktop-app                       # host-architecture .app
VERSION=0.1.0 make desktop-dmg           # .app and DMG in dist/desktop/
ARCH=x64 make desktop-dmg               # Intel core and Electron
ARCH=arm64 make desktop-dmg             # Apple Silicon core and Electron
```

Each command builds the UI, bridge extension, four agents and the matching
macOS core before bundling Electron. Versions are pinned in the desktop
lockfile. The DMG contains an app and an Applications shortcut; drag the app
to Applications, eject the image, then launch it. The build is ad-hoc signed,
without a Developer ID or notarization; Gatekeeper may require explicit
approval for a downloaded copy. Public signed distribution and automatic
updates are outside this packaging mode. Windows and Linux installers are
not implemented. The app and disk image use the project's terminal-pane icon.

Editable icon sources live in `desktop/assets/icon.svg` and
`web/public/icon.svg` (the simpler small-size version). The 1024-pixel PNG
and multi-resolution ICNS are committed, so ordinary builds need no graphics
tools. After editing the sources, run `brew install librsvg` if needed, then
`make desktop-icons` on macOS and rebuild the app/DMG.

herdr and OpenSSH remain external prerequisites. Finder launches include
`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and system paths in the
core's PATH; `HERDR_BIN` can select another herdr binary. The launcher does
not execute shell startup files. Existing herdr servers and SSH configuration are reused.
The app never starts or stops herdr servers itself.

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
- **Read-only** – `--read-only` serves a watch-only view (observe streams, no
  input, no mutating herdr calls, no uploads, no VS Code). Run a second
  instance with it for sharing screens or phones.
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
| `herdr terminal session` processes | one per pane being viewed | Ends when the pane is no longer shown, or with the agent. |
| code-server | on first VS Code use | Stopped after `--code-server-idle` (default 20 min) without VS Code connections, when the agent exits (if that agent started it; for the local machine, when the core stops), or by the stop button in the VS Code panel. Hidden VS Code panels disconnect after 10 min. A process left behind by a killed agent is stopped by the next agent, and code-server exits by itself after 1 h without connections. |
| VS Code extension hosts | one per VS Code window | Disposed 5 min after the window disconnects. |
| ssh ControlMaster | per machine | Exits after 10 min unused. |
| Xvfb (virtual display) | when a remote Linux machine connects with the GUI setting on | Runs in its own session so programs keep their windows across disconnects; exits 6 h after its last client (programs and the agent's window manager) disconnected; the agent connects once after starting it, so this also holds when nothing attaches. With xorg-server before 21.1 it exits as soon as its last client leaves, and one that never got a client stays until an agent attaches. |
| `apt-get download xvfb` | when a machine has no Xvfb (never in `--read-only`) | Ends with the download (5 min limit); the package is unpacked into `~/.herdr-ide/xvfb/` and the download removed; a download left by a killed agent is removed by the next agent after 1 h. A failed install or start is retried after 5 s, doubling up to 5 min, while the machine stays connected. |
| curl or wget (`--code-server-install=download`) | while a machine downloads code-server | Ends with the download (20 min limit); the partial file in `~/.herdr-ide/code-server/` is removed, or with the unused versions after 14 days if the agent was killed. |
| Disk | see [reference](reference.md#files-and-directories) | Uploads and logs after 7 days; unused agent builds, code-server versions and Xvfb packages after 14 days. |

herdr servers, on the local host as on SSH machines, are started and stopped
by the user, not by herdr-ide. The bundled herdr and the licenses stay in the
extracted release directory until the user removes it; no herdr binary is
uploaded to SSH machines.

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

[Install]
WantedBy=default.target
```

Install the full release directory at the path shown above (or adjust the
path). The service must run as the user who owns the herdr sessions and the
ssh keys.

## Several cores and development builds

Two cores that connect to the same machine share one agent build directory
but nothing else unless they use the same instance. Give each one its own
`--instance` (state in `~/.herdr-ide-<instance>`); for development also use an
isolated herdr session:

```bash
herdr --session herdr-ide-dev server &
make dev-core     # go run ./cmd/herdr-ide --instance dev --local-only --local-session herdr-ide-dev --listen 127.0.0.1:7790
```
