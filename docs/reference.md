# Reference

Single source for command-line flags, keyboard shortcuts, environment
variables and on-disk layout. `scripts/check.sh` fails when a flag is missing
here; both READMEs link to this page instead of repeating it.

## Commands

| Command | Description |
| --- | --- |
| `herdr-ide [serve] [flags]` | Run the server (default command). |
| `herdr-ide herdr [args]` | Run the herdr bundled beside the core with `args` and the caller's environment unchanged (for hosts without an installed herdr), e.g. `herdr-ide herdr machine list`. |
| `herdr-ide fetch-assets [flags] DIR` | Download and verify code-server releases and extensions into `DIR` for air-gapped installs. |
| `herdr-ide version` | Print the version. |
| `herdr-ide-agent serve [--instance NAME]` | Per-machine helper; started by the core over ssh, never by hand. |
| `herdr-ide-agent gui-keep --instance NAME --session S` | Holds a machine's virtual display while the herdr server of session `S` runs; started by the agent, never by hand. |

## `serve` flags

### Network and security

| Flag | Default | Description |
| --- | --- | --- |
| `--listen` | `127.0.0.1:7780` | Address to listen on. Non-loopback addresses are refused unless `--proxy-secret-file` or `--insecure-listen` is given. |
| `--allowed-origin` | – | Public origin of the reverse proxy, e.g. `https://ide.example.com` (repeatable). Host and Origin headers are checked against loopback plus these. |
| `--proxy-secret-file` | – | File with a secret (≥ 16 characters) that the reverse proxy sends in `X-herdr-ide-Proxy-Secret`. Required for requests not coming from loopback. |
| `--insecure-listen` | `false` | Accept a non-loopback `--listen` without a proxy secret. Anyone reaching the port gets shell access to every machine. |
| `--read-only` | `false` | Watch only: panes get no input, mutating herdr calls, uploads, ssh authentication and VS Code are refused. |
| `--audit-log` | – | Append security-relevant events (connections, mutating API calls, uploads, VS Code and bridge use, denials) as JSON lines. |
| `--user-header` | – | Header holding the authenticated user for the audit log. Without it, `Tailscale-User-Login`, `X-Forwarded-User`, `X-Auth-Request-User`, `Remote-User` and `X-Forwarded-Email` are tried. |

### Machines

| Flag | Default | Description |
| --- | --- | --- |
| `--local-session` | `default` | herdr session used on the local machine. |
| `--remote-session` | – | herdr session used on every remote machine instead of the one saved in herdr (development and tests against an isolated session). |
| `--local-only` | `false` | Do not connect to herdr's saved SSH machines (`--ssh` targets are still used). |
| `--machine` | – | Connect only these machines, by id, label or ssh target (repeatable). |
| `--ssh` | – | Extra ssh target (`~/.ssh/config` alias or `user@host`) not saved in herdr (repeatable). |
| `--instance` | – | State instance: machines use `~/.herdr-ide-<instance>` instead of `~/.herdr-ide`, with separate sockets, code-server process and settings. Lets a development core run next to the daily one. |

### code-server

| Flag | Default | Description |
| --- | --- | --- |
| `--code-server-version` | `4.144.0` | code-server release installed on machines. Default versions have pinned SHA-256 digests. |
| `--code-server-idle` | `20m` | Stop a machine's code-server after this long without VS Code connections; `0` keeps it while the agent lives. |
| `--code-server-url` | GitHub releases | Download URL template for code-server (`{version}`, `{asset}`, `{file}`); point it at a mirror. |
| `--extension-url` | Open VSX | Download URL template for extensions (`{publisher}`, `{name}`, `{version}`, `{file}`). |
| `--seed-dir` | – | Directory with pre-downloaded tarballs and VSIXs (from `fetch-assets`), searched before the cache (repeatable). |
| `--offline` | `false` | Never download; artifacts must come from `--seed-dir` or the cache. |
| `--code-server-install` | `push` | How machines get code-server: `push` (the core resolves, verifies and uploads the release), `download` (the machine fetches it with curl or wget, verified against the same digest) or `existing` (a code-server already installed on the machine). `download` and `existing` fall back to `push`; `--offline` disables `download`. Also a setting in the UI. |
| `--code-server-path` | – | code-server on machines for `existing` (absolute or `~/` path); empty searches `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/snap/bin`. Also a setting in the UI. |

### Program windows

| Flag | Default | Description |
| --- | --- | --- |
| `--gui` | `on` | Show windows of programs on remote Linux machines in browser windows: new panes get a virtual display (`DISPLAY`, `XAUTHORITY`); Xvfb is fetched in user space when missing. Applies to panes created afterwards. Also a setting in the UI. |
| `--gui-gpu` | `vglrun` | OpenGL on machines with VirtualGL: `vglrun` (programs started with `vglrun` render on the GPU) or `all` (every program in new panes runs under VirtualGL). Also a setting in the UI. |
| `--gui-video` | `on` | Send program windows that keep changing as video (H.264 on machines with an NVIDIA, Intel or AMD GPU, else VP8 on the CPU) to browsers that decode it with WebCodecs, encoded on the machine by the encoder the core brings; pictures otherwise, and always with `off`. Release builds embed the encoder; a build without it (no `scripts/build-ffmpeg.sh` before `make build`) sends pictures. Also a setting in the UI. |

### Desktop app shortcuts

| Flag | Default | Description |
| --- | --- | --- |
| `--desktop-new-tab-key` | `cmd+t` (macOS), `ctrl+shift+t` | Desktop app: shortcut for a new tab. Modifiers (`cmd`, `ctrl`, `alt`, `shift`, at least one of the first three) and a key joined by `+`, or `none`. Also a setting in the UI (desktop app only). |
| `--desktop-close-tab-key` | `cmd+w` (macOS), `ctrl+shift+w` | Desktop app: shortcut that closes the current tab, after a confirmation; same format. Also a setting in the UI (desktop app only). |

Settings marked "also a setting in the UI" can be changed in the settings
dialog; the value is saved on the core host. code-server settings apply from
the next code-server start on each machine, GUI settings to panes created
afterwards, video from the next frame. `--gui`, `--gui-gpu` and `--gui-video` can also be set per remote machine in the
dialog ("Per machine"); a machine without its own value uses the global one.
A flag given on the command line wins, for every machine, and locks the
setting in the UI.

### Development

| Flag | Default | Description |
| --- | --- | --- |
| `--agent-dir` | – | Directory with uncompressed `herdr-ide-agent-<os>-<arch>` builds, used instead of the embedded ones. |
| `--ext-dir` | – | Directory containing `herdr-ide-bridge.vsix`, used instead of the embedded one. |
| `--web-dir` | – | Serve the UI from this directory instead of the embedded build. |
| `--parent-stdio` | `false` | Launcher lifecycle: write one `{"event":"ready","url":"http://host:port"}` line to stdout after binding; cancel and clean up when stdin closes. Logs remain on stderr; SIGPIPE is ignored, so a launcher that disappeared does not kill the core before its cleanup. Used by Electron; does not change HTTP guards. |

## `fetch-assets` flags

`--platforms` (default `linux-amd64,linux-arm64,macos-amd64,macos-arm64`)
selects the code-server builds; `--code-server-version`, `--code-server-url`,
`--extension-url`, `--seed-dir` and `--offline` behave as above.

## Keyboard shortcuts

The prefix and bindings are read from the host's herdr configuration
(`~/.config/herdr/config.toml`, `[keys]`), so they match the herdr TUI; the
defaults are shown. Custom `[[keys.command]]` entries of type `plugin_action`
run on the pane's machine.

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| `prefix v` / `prefix -` | Split right / down | `prefix h` `j` `k` `l` | Focus pane left / down / up / right |
| `prefix z` | Zoom / restore pane | `prefix x` | Close pane |
| `prefix tab` / `shift+tab` | Next / previous pane | `prefix c` | New tab |
| `prefix n` / `p` / `1..9` | Next / previous / N-th tab | `prefix shift+x` | Close tab |
| `prefix shift+n` | New workspace | `prefix shift+w` / `shift+d` | Rename / close workspace |
| `prefix e` | Open the pane's folder in VS Code | `prefix d` | Diff of the pane's repository |
| `prefix shift+g` | Git Graph | `prefix o` | Jump to the agent that needs attention |
| `prefix space` | Command palette | `prefix w` | Switch workspace or agent |
| `prefix b` | Toggle sidebar | `prefix ?` | Shortcut list |
| `prefix shift+t` | Rename tab | `prefix ,` | Settings |
| `prefix prefix` | Send the prefix key itself | | |

The desktop app adds direct shortcuts, without the prefix: `cmd+t` new tab
and `cmd+w` close tab, which asks first (`ctrl+shift+t` / `ctrl+shift+w` on
other systems). They work wherever focus is except in VS Code, which keeps
its own `cmd+t` / `cmd+w`, and are changed or removed under
**Settings → Shortcuts** (or `--desktop-new-tab-key`,
`--desktop-close-tab-key`); a removed shortcut gives the key back to the
window (`cmd+w` closes it again). Keys follow the keyboard layout's
characters. Browsers keep `cmd+t` / `cmd+w` for themselves and use the
prefix bindings.

Default prefix: `ctrl+b`. In panes: Shift+Enter sends `ESC CR` (newline in
Claude Code and similar prompts; the bytes of every key are listed in
[`keys.json`](../web/src/__tests__/testdata/keys.json)); Option/Alt-drag selects text locally;
holding a selection drag above or below a pane scrolls it and extends the
selection, and copying then copies all of it;
⌘/Ctrl-click opens paths (media in the preview panel, code in VS Code) and
URLs. Pasting or dropping files uploads them to the pane's machine (dropped
files into the pane's directory) and pastes their paths; in the desktop app,
files dropped on a local pane are pasted where they are.

With the mouse: click a pane's title to rename it (empty restores the
terminal title); double-click a tab or workspace to rename it; drag a pane by
its header onto another pane to swap the two (centre) or to place it beside
that pane (edges), onto a tab to move it there, or onto `+` to move it into a
new tab; drag a tab along the tab bar, or a workspace along its machine's
list, to reorder it. Escape cancels a drag.

Right-click a pane header (the toolbar above a lone pane), a tab or a
workspace for a menu of its commands
(rename, split, zoom, VS Code, new tab, move, close) with their bindings;
↑↓ Home End select, Enter runs, Escape closes. In read-only mode the
browser's menu shows instead.

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `HERDR_IDE_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `HERDR_IDE_CORE` | `pnpm -C web dev` | Core URL the Vite dev server proxies to (default `http://127.0.0.1:7780`). |
| `HERDR_IDE_DESKTOP_DEV` | Electron | `1` forces isolated development even in a packaged app: instance `dev`, local-only, local/remote session `herdr-ide-dev`, separate Electron profile. Unpackaged Electron always uses this mode. |
| `HERDR_IDE_DESKTOP_PORT` | Electron | Loopback port (default `7781`, development `7791`); `0` chooses an ephemeral port, which gives a new browser storage origin. |
| `ARCH` | `make desktop-app`, `make desktop-dmg` | `arm64` or `x64`; defaults to the host Node architecture. The Go core architecture is matched automatically. |
| `VERSION` | desktop build | Semver for app metadata, DMG name and bundled core; a leading `v` (release tags such as `v0.2.0`) is kept for the core and dropped for the app metadata and DMG name. Without it the core reports `git describe` and the app uses the `desktop/package.json` version. |
| `HERDR_BIN` | agent | herdr binary to use on a machine. Without it, an installed herdr is searched; the local machine falls back to its copy of the bundled one. |
| `HERDR_TEST_BIN` | `make it` | herdr executable for the integration test (for example the bundled one); otherwise found on `PATH`. |
| `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH` | core, agent | Honoured like herdr does when locating its state, configuration and sockets. |

## Files and directories

On every machine (the agent's `$HOME`):

| Path | Content | Lifetime |
| --- | --- | --- |
| `~/.herdr-ide/agent/<build>/` | Uploaded agent binaries | Builds unused for 14 days are removed. |
| `~/.herdr-ide/code-server/<version>/` | code-server releases (shared by instances) | Versions unused for 14 days are removed. |
| `~/.herdr-ide/herdr/herdr` | Core host only: the application's copy of the bundled herdr (shared by instances) | Replaced by **Update** and by a newer bundled herdr; kept until removed. |
| `~/.herdr-ide/herdr/server.log` | Core host only: output of the herdr server last started from the UI | Replaced at every start from the UI. |
| `~/.herdr-ide[-<instance>]/run/` (0700) | `cs.sock`, `cs.pid`, `bridge.sock`; `gui.json` (reserved display and Xvfb pid), `xauth` (panes' display cookie) and `xauth.server` (Xvfb's copy), both 0600 and replaced at each Xvfb start, `gui.lock`, `gui-keep.lock` (held by the display keeper) | Sockets while the agent runs; the display files are kept so panes keep a valid environment. |
| `~/.herdr-ide/xvfb/<version>/` | Xvfb unpacked from the distribution's package (shared by instances) | Versions unused for 14 days are removed when another is unpacked. |
| `~/.herdr-ide/video/<sha256 prefix>/encoder` | Video encoder pushed by the core (`gui-video`, shared by instances), run only while its SHA-256 matches | Builds unused for 14 days are removed when another is installed; unfinished installs after 1 h. |
| `~/.herdr-ide[-<instance>]/xvfb.log` | Output of the last Xvfb started | Replaced at each start. |
| `~/.herdr-ide[-<instance>]/gui-keep.log` | Output of the last display keeper | Replaced at each start. |
| `~/.herdr-ide[-<instance>]/cs-data/`, `cs-ext/` | VS Code settings, extensions | Kept; logs older than 7 days are pruned. |
| `~/.herdr-ide[-<instance>]/uploads/` | Pasted and dropped files | Files older than 7 days are pruned. |

On the core host: ssh control sockets in `/tmp/herdr-ide-<uid>/s` (must be
owned by you, mode 0700), downloads in the user cache directory
(`~/Library/Caches/herdr-ide/code-server` on macOS, `~/.cache/herdr-ide/code-server`
on Linux) with `.sha256` sidecars (also recorded for releases that machines
downloaded themselves), and settings changed in the UI in
`settings[-<instance>].json` in the user configuration directory
(`~/Library/Application Support/herdr-ide/` on macOS, `~/.config/herdr-ide/` on
Linux; directory 0700, file replaced atomically).

A release directory holds the core, the bundled `herdr`, `LICENSE`,
`THIRD_PARTY_NOTICES.md`, `licenses.md` and `licenses/herdr/`; they stay until
the user removes the directory and are not copied to SSH machines. herdr's own
files (configuration, sessions, machine list) are where herdr puts them,
whichever herdr is used.

In the browser: preferences in `localStorage` under `herdr-ide.*` (language,
theme, font sizes, terminal font weight, panel position, Option as Meta,
what programs copying to the clipboard do, sidebar and panel sizes, the
selected workspace).

Desktop artifacts: `dist/desktop/mac-arm64/herdr-ide.app` (arm64),
`dist/desktop/mac/herdr-ide.app` (x64), and
`dist/desktop/herdr-ide-<version>-mac-<arch>.dmg`. Generated shell code lives
in `desktop/dist/`; `make clean` removes these build outputs.
Icon sources and distributable PNG/ICNS are kept in `desktop/assets/`, with
the small SVG in `web/public/icon.svg`; `make desktop-icons` regenerates the
PNG and ICNS on macOS with librsvg and iconutil.
Electron's persistent profile is
`~/Library/Application Support/herdr-ide-desktop/` (`-dev` for development).
It holds browser preferences and Chromium data until manually removed.
The core uses `settings-desktop.json` and `~/.herdr-ide-desktop/` state;
development uses the existing `dev` instance. No desktop log files are kept:
stderr is streamed and the last 16 KiB is retained in memory for error dialogs.
