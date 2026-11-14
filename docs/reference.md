# Reference

Single source for command-line flags, keyboard shortcuts, environment
variables and on-disk layout. `scripts/check.sh` fails when a flag is missing
here; both READMEs link to this page instead of repeating it.

## Commands

| Command | Description |
| --- | --- |
| `herdr-ide [serve] [flags]` | Run the server (default command). |
| `herdr-ide fetch-assets [flags] DIR` | Download and verify code-server releases and extensions into `DIR` for air-gapped installs. |
| `herdr-ide version` | Print the version. |
| `herdr-ide-agent serve [--instance NAME]` | Per-machine helper; started by the core over ssh, never by hand. |
| `herdr-ide-agent gui-keep --instance NAME` | Holds a machine's virtual display while the instance's terminal core runs; started by the agent, never by hand. |

## `serve` flags

### Network and security

| Flag | Default | Description |
| --- | --- | --- |
| `--listen` | `127.0.0.1:7780` | Address to listen on. Non-loopback addresses are refused unless `--proxy-secret-file` or `--insecure-listen` is given. |
| `--allowed-origin` | – | Public origin of the reverse proxy, e.g. `https://ide.example.com` (repeatable). Host and Origin headers are checked against loopback plus these. |
| `--proxy-secret-file` | – | File with a secret (≥ 16 characters) that the reverse proxy sends in `X-herdr-ide-Proxy-Secret`. Required for requests not coming from loopback. |
| `--insecure-listen` | `false` | Accept a non-loopback `--listen` without a proxy secret. Anyone reaching the port gets shell access to every machine. |
| `--read-only` | `false` | Watch only: terminals get no input (they observe), writing terminal core calls (layout changes, new and ended terminals), uploads, ssh authentication and VS Code are refused, and no terminal core is installed or started. |
| `--audit-log` | – | Append security-relevant events (connections, mutating API calls, uploads, VS Code and bridge use, denials) as JSON lines. |
| `--user-header` | – | Header holding the authenticated user for the audit log. Without it, `Tailscale-User-Login`, `X-Forwarded-User`, `X-Auth-Request-User`, `Remote-User` and `X-Forwarded-Email` are tried. |

### Machines

| Flag | Default | Description |
| --- | --- | --- |
| `--local-only` | `false` | Do not connect to the stored SSH machines (`--ssh` targets are still used). |
| `--machine` | – | Connect only these machines, by id, label or ssh target (repeatable). |
| `--ssh` | – | Extra ssh target (`~/.ssh/config` alias or `user@host`) for this run, not stored; renaming or disabling it in the UI lasts until the core stops (repeatable). |
| `--instance` | – | State instance: machines use `~/.herdr-ide-<instance>` instead of `~/.herdr-ide`, with separate sockets, terminal core (session `herdr-ide-<instance>`), code-server process and settings. Lets a development core run next to the daily one. |

### code-server

| Flag | Default | Description |
| --- | --- | --- |
| `--code-server-version` | `4.144.0` | code-server release installed on machines. Default versions have pinned SHA-256 digests. |
| `--code-server-idle` | `20m` | Stop a machine's code-server after this long without VS Code connections; `0` keeps it while the agent lives. |
| `--code-server-url` | GitHub releases | Download URL template for code-server (`{version}`, `{asset}`, `{file}`); point it at a mirror. |
| `--extension-url` | Open VSX | Download URL template for extensions (`{publisher}`, `{name}`, `{version}`, `{file}`). |
| `--seed-dir` | – | Directory with pre-downloaded tarballs and VSIXs (from `fetch-assets`), searched before the cache (repeatable). |
| `--offline` | `false` | Never download; artifacts must come from `--seed-dir` or the cache. |
| `--code-server-install` | `push` | How machines get code-server: `push` (the core resolves, verifies and uploads the release), `download` (the machine fetches it with curl or wget, verified against the same digest) or `existing` (a code-server already installed on the machine). `download` and `existing` fall back to `push`; `--offline` disables `download`. The setting `codeServer.install`. |
| `--code-server-path` | – | code-server on machines for `existing` (absolute or `~/` path); empty searches `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/snap/bin`. The setting `codeServer.path`. |

### Program windows

| Flag | Default | Description |
| --- | --- | --- |
| `--gui` | `true` | Show windows of programs on remote Linux machines in browser windows: new panes get a virtual display (`DISPLAY`, `XAUTHORITY`); Xvfb is fetched in user space when missing. Applies to panes created afterwards. `true` or `false` (`on` and `off` are accepted too). The setting `gui.enabled`. |
| `--gui-gpu` | `vglrun` | OpenGL on machines with VirtualGL: `vglrun` (programs started with `vglrun` render on the GPU) or `all` (every program in new panes runs under VirtualGL). The setting `gui.gpu`. |
| `--gui-video` | `true` | Send program windows that keep changing as video (H.264 on machines with an NVIDIA, Intel or AMD GPU, else VP8 on the CPU) to browsers that decode it with WebCodecs, encoded on the machine by the encoder the core brings; pictures otherwise, and always with `false` (`on`/`off` accepted). Release builds embed the encoder; a build without it (no `scripts/build-ffmpeg.sh` before `make build`) sends pictures. The setting `gui.video`. |

These flags set settings ([settings](#settings)); the settings dialog and the
settings file change them at runtime. code-server settings apply from the
next code-server start on each machine, GUI settings to panes created
afterwards, video from the next frame. The `gui.*` settings can also be set
per remote machine; a machine without its own value uses the global one. A
flag given on the command line wins, for every machine, and locks the
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

## Settings

Every setting of the core and of the user interfaces is defined in the core
(`internal/registry`) and shown by the settings dialog of every client
([13](features/13-settings-and-appearance.md)). Values live in
`settings[-<instance>].json` on the core host and can be edited there by
hand; the core reads the file again within two seconds.

| Section | Settings |
| --- | --- |
| Appearance | `appearance.language` (web UI), `appearance.theme`, `appearance.uiFontSize` |
| Layout | `layout.panelPosition` (web UI) |
| Terminal | `terminal.fontFamily`, `terminal.fontSize`, `terminal.fontWeight`, `terminal.lineHeight`, `terminal.cursorStyle`, `terminal.cursorBlink`, `terminal.scrollback`, `terminal.copyOnSelect`, `terminal.bell`, `terminal.boldIsBright`, `terminal.optionIsMeta`, `terminal.programClipboard`, `terminal.mathHover` (web UI) |
| Terminal colors | `terminal.colors.dark.{foreground,background,cursor,selection,palette}` and the same for `light` (palette: 16 colors) |
| Notifications | `notifications.sound`, `notifications.mutedAgents` (web UI) |
| VS Code | `codeServer.install`, `codeServer.path` |
| Program windows | `gui.enabled`, `gui.gpu`, `gui.video` (also per remote machine) |

```json
{
  "appearance.theme": "dark",
  "terminal.fontSize": 14,
  "terminal.colors.dark.palette": ["#484f58", "#ff7b72", "…14 more"],
  "[machine:gpu-box]": { "gui.video": false }
}
```

## Keyboard shortcuts

Keys come from the keybindings (`internal/keybindings`): defaults per
platform, changed in **Settings → Keyboard shortcuts** or in
`keybindings[-<instance>].json` on the core host, an array of
`{"key", "command", "when"}` rules (`"command": "-<id>"` removes a key;
`when` is `terminal`, `vscode`, `dialog` or `always`). A key is modifiers
(`cmd`, `ctrl`, `alt`, `shift`) and a key joined by `+`; a chord is strokes
separated by spaces (`ctrl+b c`: ctrl+b, then c within 3 s). The first
stroke needs `cmd`, `ctrl` or `alt` (or is a function key).

The defaults have a prefix keymap (prefix `ctrl+b`) on every platform:

| Keys | Command | Keys | Command |
| --- | --- | --- | --- |
| `ctrl+b v` / `ctrl+b -` | Split right / down | `ctrl+b h` `j` `k` `l` | Focus pane left / down / up / right |
| `ctrl+b z` | Zoom / restore pane | `ctrl+b x` | Close pane |
| `ctrl+b tab` / `shift+tab` | Next / previous pane | `ctrl+b c` | New tab |
| `ctrl+b n` / `p` / `1`…`9` | Next / previous / N-th tab | `ctrl+b shift+x` | Close tab |
| `ctrl+b shift+n` | New workspace | `ctrl+b shift+w` / `shift+d` | Rename / close workspace |
| `ctrl+b e` | Open the pane's folder in VS Code | `ctrl+b d` | Diff of the pane's repository |
| `ctrl+b shift+g` | Git Graph | `ctrl+b o` | Jump to the agent that needs attention |
| `ctrl+b space` / `ctrl+b g` | Command palette | `ctrl+b w` | Switch workspace or agent |
| `ctrl+b b` | Toggle sidebar | `ctrl+b ?` | Shortcut list |
| `ctrl+b shift+t` | Rename tab | `ctrl+b ,` | Settings |
| `ctrl+b )` / `(` | Next / previous workspace | `ctrl+b ctrl+b` | Send ctrl+b itself |

The desktop applications add direct shortcuts. On macOS (the macOS
application and the desktop app): `cmd+t` new tab, `cmd+d` / `cmd+shift+d`
split right / down, `cmd+w` close pane, `cmd+n` new workspace, `cmd+,`
settings, `cmd+b` sidebar, `cmd+j` show or hide VS Code, `cmd+}` / `cmd+{`
next / previous tab, `cmd+f` find, `cmd+g` / `cmd+shift+g` next / previous
match. On other systems (desktop app): `ctrl+shift+t` new tab,
`ctrl+shift+w` close tab, `ctrl+,` settings, `ctrl+shift+n` new workspace,
`ctrl+shift+j` VS Code. Browsers keep those keys for themselves; there
`cmd+f` (macOS) or `ctrl+shift+f` find. In VS Code only bindings for
`always` (show or hide VS Code) or `vscode` run; the others are VS Code's.
Keys follow the keyboard layout's characters.

Default prefix: `ctrl+b`. In terminals, keys reach the program in the
encoding it asked for (legacy, application cursor and keypad, kitty
keyboard protocol); the bytes of the keys the browser could keep are listed
in [`vt-keys.json`](../web/src/__tests__/testdata/vt-keys.json): Shift+Enter
is `CSI 13;2u` once a program enables the kitty keyboard protocol (Claude
Code and Codex insert a newline), Alt+Enter is `ESC CR`. Dragging selects
text (double click: a word, triple click: a line; Shift-drag where the
program takes the mouse); holding a selection drag above or below a
terminal scrolls its scrollback; `terminal.copyOnSelect` copies at release.
The wheel scrolls the scrollback (on the alternate screen it is the arrow
keys; programs that take the mouse get it). ⌘/Ctrl-click opens paths (media
in the preview panel, code in VS Code) and URLs. `cmd+f` (macOS) or
`ctrl+shift+f` (other systems) finds text in the focused terminal and its
scrollback (`find.open`; ASCII letters in either case): Enter goes to the
older match, Shift+Enter to the newer one, Escape closes the bar. Pasting or
dropping files uploads them to the terminal's machine (dropped files into
its directory) and pastes their paths; in the desktop app, files dropped on
a local terminal are pasted where they are. A terminal's right-click menu
downloads the path under the pointer and, with **Download files…**, files
and folders chosen in its directory (folders as zips; not for the desktop
app's own machine). The downloads panel in the status bar shows each
download's progress, speed and result, cancels it or downloads it again.

With the mouse: click a pane's title to rename it (empty restores the
terminal title); double-click a tab or workspace to rename it; drag a pane by
its header onto another pane to swap the two (centre) or to place it beside
that pane (edges), onto a tab to move it there, or onto `+` to move it into a
new tab; drag a tab along the tab bar, or a workspace along its machine's
list, to reorder it. Escape cancels a drag.

Right-click a pane header, a tab, a workspace or a machine for a menu of
its commands (rename, split, zoom, VS Code, new tab, move, close; a
machine's terminal core) with their bindings;
↑↓ Home End select, Enter runs, Escape closes. In read-only mode the
browser's menu shows instead.

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `HERDR_IDE_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `HERDR_IDE_CORE` | `pnpm -C web dev`, the macOS application | Core URL the Vite dev server proxies to (default `http://127.0.0.1:7780`); the macOS application uses that core instead of starting the one in its bundle. |
| `SIGN_IDENTITY`, `NOTARY_PROFILE` | `make macos-app` | A code-signing certificate's name (default `-`, an ad hoc signature) and a `notarytool` keychain profile; with both the application is notarized and stapled. `SKIP_CORE=1` reuses the core in `dist/`; `OUT_DIR` is where the `.app` goes (default `dist/macos`). |
| `HERDR_IDE_DEV` | the macOS application | `1` starts the bundled core as instance `dev`, local-only, like `make dev-desktop`. |
| `HERDR_IDE_SNAPSHOT`, `HERDR_IDE_ACTIONS` | debug builds of the macOS application | Development aids: a path the window is written to as a PNG every two seconds, and actions run two seconds apart (`new`, `split-right`, `split-down`, `close`, `next-tab`, `workspace:<name>[:<cwd>]` (a new workspace with a terminal, without the dialog), `rename-workspace:<name>`, `close-workspace` (without asking), `next-workspace`, `type:<text>`, `find:<text>`, `find-next`, `open:<path>`, `code`, `page`, `settings`, `settings:<section>`, `keys` (the keyboard shortcuts page), `set:<key>=<json>` (a setting changed through the core), `strokes:<stroke> <stroke>…` (strokes given to the key matcher), `key:cmd+<key>`, separated by `;`). |
| `HERDR_IDE_DESKTOP_DEV` | Electron | `1` forces isolated development even in a packaged app: instance `dev` (terminal core session `herdr-ide-dev`), local-only, separate Electron profile. Unpackaged Electron always uses this mode. |
| `HERDR_IDE_DESKTOP_PORT` | Electron | Loopback port (default `7781`, development `7791`); `0` chooses an ephemeral port, which gives a new browser storage origin. |
| `ARCH` | `make desktop-app`, `make desktop-dmg` | `arm64` or `x64`; defaults to the host Node architecture. The Go core architecture is matched automatically. |
| `VERSION` | desktop build | Semver for app metadata, DMG name and bundled core; a leading `v` (release tags such as `v0.2.0`) is kept for the core and dropped for the app metadata and DMG name. Without it the core reports `git describe` and the app uses the `desktop/package.json` version. |
| `HC_TEST_BIN` | `make it` | herdr-core executable for the integration tests; otherwise `hc` is found on `PATH`, and without one they are skipped. |
| `XDG_STATE_HOME` | core | Where the SSH machines herdr saved are read from for the one-time import (`$XDG_STATE_HOME/herdr/client/endpoints.json`, default `~/.local/state/herdr/client/endpoints.json`). |

## Files and directories

On every machine (the agent's `$HOME`):

| Path | Content | Lifetime |
| --- | --- | --- |
| `~/.herdr-ide/agent/<build>/` | Uploaded agent binaries | Builds unused for 14 days are removed. |
| `~/.herdr-ide/code-server/<version>/` | code-server releases (shared by instances) | Versions unused for 14 days are removed. |
| `~/.herdr-ide[-<instance>]/hc/herdr-core` (0700 directory) | The terminal core's executable, pushed by the core and accepted only with its SHA-256 | Replaced when the core brings another build; kept until removed. |
| `~/.herdr-ide[-<instance>]/run/` (0700) | `hc.sock` (the terminal core's API socket, 0600) and its holders' sockets; `cs.sock`, `cs.pid`, `bridge.sock`; `gui.json` (reserved display and Xvfb pid), `xauth` (terminals' display cookie) and `xauth.server` (Xvfb's copy), both 0600 and replaced at each Xvfb start, `gui.lock`, `gui-keep.lock` (held by the display keeper) | Sockets while the agent (code-server, bridge) or the terminal core runs; the display files are kept so terminals keep a valid environment. |
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
downloaded themselves), the settings in `settings[-<instance>].json`, the
keybindings in `keybindings[-<instance>].json` and the machines in
`machines[-<instance>].json` (`{"version": 1, "machines": [{id, label,
kind, target, enabled}]}`: the SSH machines, and the local machine's
enabled flag once it was changed; the SSH machines herdr saved
(`~/.local/state/herdr/client/endpoints.json`) are imported into it the
first time a core of the instance starts without one), all in the
user configuration directory (`~/Library/Application Support/herdr-ide/` on
macOS, `~/.config/herdr-ide/` on Linux; directory 0700, files 0600 replaced
atomically, kept until removed). The settings and keybindings files can be
edited by hand: the core reads them again within two seconds, keeps entries
it does not know and reports values it cannot use. The machines file is
read when the core starts and written by it at every change.

A release directory holds the core, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`licenses.md` and `licenses/` (`herdr-core/` (the terminal core the core
embeds for machines), `herdr-detect/` (herdr's agent detection rules, which
the agents carry), `encoder/`); they stay until the user removes the
directory and are not copied to SSH machines.

In the browser, in `localStorage` under `herdr-ide.*` (state of that
browser only; settings are the core's):

- sidebar and panel sizes
- the selected workspace
- find options
- the upload history (the last 50 finished uploads: file names, machines
  and paths on them)

Browser settings of earlier versions kept there (language, theme, font
sizes, …) are moved to the core's settings once, when a page of a writable
core loads, and then removed.

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
