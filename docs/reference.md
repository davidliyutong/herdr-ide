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
| `--ssh` | – | Extra ssh target (`~/.ssh/config` alias or `user@host`) for this run, not stored; renaming or disabling it in the UI lasts until the core stops (repeatable). At most 255 bytes, not starting with `-`, without whitespace, control characters or any of ``! " $ & ' ( ) * ; < > ? \ ` { \| }`` (ASCII letters, digits, `# % + , - . / : = @ [ ] ^ _ ~` and Unicode letters, marks and numbers); the core refuses to start otherwise. |
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
hand; the core reads the file again within two seconds. A setting with a
flag is fixed by that flag when it is given (for every machine) and locked
in the UI; a setting with a scope can have its own value per machine, under
`"[machine:<id>]"`. The table is generated from the registry by
`scripts/registry` (`make tokens`; `make check` fails when it is stale).

<!-- scripts/registry: settings -->

| Setting | Values | Default | Flag | Scope |
| --- | --- | --- | --- | --- |
| `appearance.language` | `auto`, `en`, `zh-CN` | `"auto"` | – | – |
| `appearance.theme` | `system`, `dark`, `light` | `"system"` | – | – |
| `appearance.uiFontSize` | integer, 11–20 | `13` | – | – |
| `layout.panelPosition` | `right`, `bottom` | `"right"` | – | – |
| `terminal.fontFamily` | string | `""` | – | – |
| `terminal.fontSize` | number, 6–40 | `13` | – | – |
| `terminal.fontWeight` | `regular`, `medium` | `"regular"` | – | – |
| `terminal.lineHeight` | number, 0.8–2 | `1.05` | – | – |
| `terminal.cursorStyle` | `block`, `bar`, `underline` | `"block"` | – | – |
| `terminal.cursorBlink` | `true`, `false` | `true` | – | – |
| `terminal.scrollback` | integer, 0–1000000 | `10000` | – | – |
| `terminal.copyOnSelect` | `true`, `false` | `false` | – | – |
| `terminal.bell` | `none`, `sound`, `visual` | `"visual"` | – | – |
| `terminal.boldIsBright` | `true`, `false` | `false` | – | – |
| `terminal.optionIsMeta` | `true`, `false` | `false` | – | – |
| `terminal.programClipboard` | `auto`, `ask`, `off` | `"auto"` | – | – |
| `terminal.mathHover` | `true`, `false` | `true` | – | – |
| `terminal.colors.dark.foreground` | color `#rrggbb` | `"#f0f0f0"` | – | – |
| `terminal.colors.dark.background` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.dark.cursor` | color `#rrggbb` | `"#f0f0f0"` | – | – |
| `terminal.colors.dark.selection` | color `#rrggbb` | `"#3b4a6b"` | – | – |
| `terminal.colors.dark.palette` | 16 colors | 16 colors of `design/tokens.json` | – | – |
| `terminal.colors.light.foreground` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.light.background` | color `#rrggbb` | `"#ffffff"` | – | – |
| `terminal.colors.light.cursor` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.light.selection` | color `#rrggbb` | `"#b6d4fe"` | – | – |
| `terminal.colors.light.palette` | 16 colors | 16 colors of `design/tokens.json` | – | – |
| `notifications.sound` | `true`, `false` | `true` | – | – |
| `notifications.mutedAgents` | string | `"droid"` | – | – |
| `codeServer.install` | `push`, `download`, `existing` | `"push"` | `--code-server-install` | – |
| `codeServer.path` | string | `""` | `--code-server-path` | – |
| `gui.enabled` | `true`, `false` | `true` | `--gui` | per remote machine |
| `gui.gpu` | `vglrun`, `all` | `"vglrun"` | `--gui-gpu` | per remote machine |
| `gui.video` | `true`, `false` | `true` | `--gui-video` | per remote machine |

<!-- end of scripts/registry: settings -->

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
separated by spaces (`ctrl+k c`: ctrl+k, then c within 3 s). The first
stroke needs `cmd`, `ctrl` or `alt` (or is a function key). While a chord
starting with a stroke is bound, that stroke waits for the next one instead
of reaching the terminal; typing it twice (`ctrl+k ctrl+k`) lets the second
press through to the terminal as any key no binding takes.

The default keys differ by platform: `mac` is the macOS application and
the desktop app on macOS, `mac-browser` browsers on macOS, `pc` the desktop
app on other systems and `pc-browser` browsers there. No default is a
chord, and none is `ctrl` or `alt` with a letter alone: `ctrl+b` and every
other key that is not in the table reach the program in the terminal on
their first press. The applications have direct shortcuts, which browsers
keep for themselves (`cmd+t`, `cmd+w`…); browsers get find, the list of
shortcuts and, on macOS, the command palette (`cmd+k`; in browsers on
other systems the status bar's **Command palette** opens it). A command
without a key (–) runs from the menus, the command palette, its button and
the context menus, and any key or chord can be bound to it. Both
applications' menus show the keys; in the desktop app the page runs the
keys it sees and the menu the keys the page leaves. While VS Code has the
keyboard its own keys come first; a key it leaves runs a command only for
`always` (show or hide VS Code) or `vscode`. Keys follow the keyboard
layout's characters. The table is generated from the registry by
`scripts/registry`.

<!-- scripts/registry: commands -->

| Command | When | `mac` | `mac-browser` | `pc` | `pc-browser` |
| --- | --- | --- | --- | --- | --- |
| `app.commandPalette` | `terminal` | `cmd+shift+p` | `cmd+k` | `ctrl+shift+p` | – |
| `app.keyboardShortcuts` | `terminal` | `cmd+slash` | `cmd+slash` | `ctrl+shift+slash` | `ctrl+shift+slash` |
| `app.settings` | `terminal` | `cmd+comma` | – | `ctrl+comma` | – |
| `app.agentAttention` | `terminal` | – | – | – | – |
| `workspace.switch` | `terminal` | – | – | – | – |
| `workspace.next` | `terminal` | – | – | – | – |
| `workspace.previous` | `terminal` | – | – | – | – |
| `workspace.new` | `terminal` | `cmd+n` | – | `ctrl+shift+n` | – |
| `workspace.rename` | `terminal` | – | – | – | – |
| `workspace.close` | `terminal` | – | – | – | – |
| `tab.new` | `terminal` | `cmd+t` | – | `ctrl+shift+t` | – |
| `tab.rename` | `terminal` | – | – | – | – |
| `tab.next` | `terminal` | `cmd+shift+bracketright` | – | – | – |
| `tab.previous` | `terminal` | `cmd+shift+bracketleft` | – | – | – |
| `tab.select1` | `terminal` | – | – | – | – |
| `tab.select2` | `terminal` | – | – | – | – |
| `tab.select3` | `terminal` | – | – | – | – |
| `tab.select4` | `terminal` | – | – | – | – |
| `tab.select5` | `terminal` | – | – | – | – |
| `tab.select6` | `terminal` | – | – | – | – |
| `tab.select7` | `terminal` | – | – | – | – |
| `tab.select8` | `terminal` | – | – | – | – |
| `tab.select9` | `terminal` | – | – | – | – |
| `tab.close` | `terminal` | – | – | `ctrl+shift+w` | – |
| `pane.splitRight` | `terminal` | `cmd+d` | – | – | – |
| `pane.splitDown` | `terminal` | `cmd+shift+d` | – | – | – |
| `pane.close` | `terminal` | `cmd+w` | – | – | – |
| `pane.zoom` | `terminal` | – | – | – | – |
| `pane.focusLeft` | `terminal` | – | – | – | – |
| `pane.focusDown` | `terminal` | – | – | – | – |
| `pane.focusUp` | `terminal` | – | – | – | – |
| `pane.focusRight` | `terminal` | – | – | – | – |
| `pane.focusNext` | `terminal` | – | – | – | – |
| `pane.focusPrevious` | `terminal` | – | – | – | – |
| `view.toggleSidebar` | `terminal` | `cmd+b` | – | – | – |
| `view.toggleCode` | `always` | `cmd+j` | – | `ctrl+shift+j` | – |
| `find.open` | `terminal` | `cmd+f` | `cmd+f` | `ctrl+shift+f` | `ctrl+shift+f` |
| `find.next` | `terminal` | `cmd+g` | – | – | – |
| `find.previous` | `terminal` | `cmd+shift+g` | – | – | – |
| `code.open` | `terminal` | – | – | – | – |
| `code.diff` | `terminal` | – | – | – | – |
| `code.gitGraph` | `terminal` | – | – | – | – |

<!-- end of scripts/registry: commands -->

In terminals, keys reach the program in the
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

## HTTP and WebSocket endpoints

Every endpoint passes the same guards (Host, Origin, proxy secret,
[SECURITY.md](../SECURITY.md)); those marked *writes* are refused with
`--read-only`. Protocols and messages are in
[architecture](architecture.md); `{id}` is a machine's id. `make check`
fails when a route the server registers (`internal/server/server.go`) is
missing here.

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /ws` | – | The event channel (WebSocket): machines, agents, settings, keybindings, program windows, downloads. |
| `GET /api/v1/term` | – | The terminal protocol (WebSocket): the machines' terminals, their events and byte streams ([22](features/22-terminal-protocol.md)). |
| `GET /api/config` | – | Name, slug, version and whether the core is read-only. |
| `GET /api/settings` | – | Definitions, values (per machine too) and problems of the settings. |
| `PUT /api/settings` | writes | Sets one value (`{"key", "value", "machine"?}`). |
| `DELETE /api/settings` | writes | Removes one value, which falls back to the global value or the default. |
| `GET /api/keybindings` | – | Commands, default keys per platform, the user's rules, the bindings in effect and their conflicts. |
| `PUT /api/keybindings` | writes | Replaces the user's rules. |
| `GET /api/machines` | – | Every machine's state, its agent's information and its terminal core's state. |
| `POST /api/machines` | writes | Adds and stores an SSH machine (`{"target", "label"}`). |
| `DELETE /api/m/{id}` | writes | Removes a stored machine. |
| `PUT /api/m/{id}/label` | writes | Renames a machine. |
| `PUT /api/m/{id}/enabled` | writes | Enables or disables a machine. |
| `GET /api/m/{id}/hc` | – | The machine's terminal core: installed, running, version. |
| `POST /api/m/{id}/hc/{action}` | writes | `start`, `stop` or `restart` the machine's terminal core. |
| `GET /api/m/{id}/auth` | writes | Interactive ssh login of a machine that needs one (WebSocket, `?cols=&rows=`). |
| `POST /api/m/{id}/bridge` | writes | A command for the VS Code window of a folder (open a file at a line, diff, Git Graph). |
| `GET /api/m/{id}/file` | – | A file (`?path=`, `&download=1` as an attachment), with HTTP ranges. |
| `GET /api/m/{id}/download` | – | One file as an attachment, or several paths (folders included) as a zip (`?path=`…, `&dl=<id>` to follow it on `/ws`). |
| `POST /api/m/{id}/upload` | writes | Writes the request body to a file (`?name=`, `&dir=` absolute, else the upload directory). |
| `GET /api/m/{id}/list` | – | A directory's entries (`?path=`). |
| `GET /api/m/{id}/code/status` | – | Whether the machine's code-server is installed and runs. |
| `POST /api/m/{id}/code/start` | writes | Installs and starts the machine's code-server. |
| `POST /api/m/{id}/code/stop` | – | Releases the machine's code-server (allowed read-only: it only stops). |
| `/m/{id}/code/` | writes | The machine's code-server behind the core's proxy (`/m/{id}/code` redirects here). |
| `GET /m/{id}/gui/{win}` | – | The page of a program window. |
| `GET /m/{id}/gui/{win}/ws` | – | A program window's frames and events, its input (WebSocket; `?video=` names the video streams the browser decodes). |
| `POST /m/{id}/gui/{win}/close` | writes | Asks a program window to close. |
| `POST /api/m/{id}/gui/enable` | writes | Gives open terminals the machine's display (`{"terminals": [...]}`, empty for all). |
| `GET /api/gui` | – | The program windows of every machine. |
| `/` | – | The web UI (`/licenses.md`: the notices of its bundle); any other path gets the app shell for the UI's own routes, except `/api/…` paths no route takes, which are 404. |

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `HERDR_IDE_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `HERDR_IDE_CORE` | `pnpm -C web dev`, the macOS application | Core URL the Vite dev server proxies to (default `http://127.0.0.1:7780`); the macOS application uses that core instead of starting the one in its bundle when it is on loopback (`http(s)://127.0.0.1` or `localhost`), and ignores it otherwise. |
| `HERDR_IDE_DEV` | the macOS application | `1` starts the bundled core as instance `dev`, local-only, like `make dev-desktop`. |
| `HERDR_IDE_SNAPSHOT`, `HERDR_IDE_ACTIONS` | debug builds of the macOS application | Development aids: a path the window is written to as a PNG every two seconds, and actions run two seconds apart (`new`, `split-right`, `split-down`, `close`, `next-tab`, `workspace:<name>[:<cwd>]` (a new workspace with a terminal, without the dialog), `rename-workspace:<name>`, `close-workspace` (without asking), `close-workspace:<names>`, `next-workspace`, `type:<text>`, `find:<text>`, `find-next`, `open:<path>`, `code`, `page`, `settings`, `settings:<section>`, `keys` (the keyboard shortcuts page), `set:<key>=<json>` (a setting changed through the core), `strokes:<stroke> <stroke>…` (strokes given to the key matcher), `key:cmd+<key>`, `command:<id>` (a command of the keybindings), `folder:<path>` (a folder dropped on the Dock icon), `palette:<text>`, `drag:<from>:<to>:<zone>` (a pane dragged by its header, or `tab`), `add-machine`, `machine:<add\|signin\|remove\|menu>:<target>`, `transfers`, `files:<dir>`, `select:<names>`, `download-to:<file>`, `upload-file:<file>`, `paste-file:<file>`, `paste-image:<png>`, `record:<command>:<strokes>` (the key recorder), `hover:<column>,<row>` (the pointer resting on a cell), separated by `;`); the window's other windows are written beside it as `<path>.window.png`, `.window2.png`…. |
| `HERDR_IDE_DESKTOP_DEV` | Electron | `1` forces isolated development even in a packaged app: instance `dev` (terminal core session `herdr-ide-dev`), local-only, separate Electron profile. Unpackaged Electron always uses this mode. |
| `HERDR_IDE_DESKTOP_PORT` | Electron | Loopback port (default `7781`, development `7791`); `0` chooses an ephemeral port, which gives a new browser storage origin. |
| `--user-data-dir=<dir>` | Electron command line | Replaces the Electron profile and its single-instance lock, so a copy launched by its executable (not with `open`, which activates a running copy of the same bundle identifier) runs beside an installed one; for isolated smoke tests with `HERDR_IDE_DESKTOP_DEV=1`. |
| `XDG_STATE_HOME` | core | Where the SSH machines herdr saved are read from for the one-time import (`$XDG_STATE_HOME/herdr/client/endpoints.json`, default `~/.local/state/herdr/client/endpoints.json`). |

Variables of the build scripts and tests:

| Variable | Where | Description |
| --- | --- | --- |
| `TARGETS` | `scripts/build.sh` | Core platforms to build and package (default the host's), e.g. `"linux/amd64 darwin/arm64"`. |
| `AGENT_PLATFORMS` | `scripts/build.sh` | Agent and herdr-core platforms to embed (default all four). |
| `SKIP_WEB`, `SKIP_EXT` | `scripts/build.sh` | `1` reuses `web/dist` or the built bridge extension. |
| `REQUIRE_ENCODER` | `scripts/build.sh` | `1` (release builds) fails when a Linux video encoder (`scripts/build-ffmpeg.sh`) is missing. |
| `VERSION` | `scripts/build.sh`, desktop and macOS builds | The version the core and agents report (default `git describe`). Desktop builds take a semver for the app metadata and DMG name; a leading `v` (release tags such as `v0.2.0`) is kept for the core and dropped for the app metadata. The macOS application uses it as its bundle version. |
| `FFMPEG_PLATFORMS` | `scripts/build-ffmpeg.sh` | Linux platforms to build the video encoder for (default both). |
| `GHOSTTY_SRC` | `make vt-wasm` | A Ghostty checkout to build libghostty-vt from instead of the pinned clone. |
| `ARCH` | `make desktop-app`, `make desktop-dmg` | `arm64` or `x64`; defaults to the host Node architecture. The Go core architecture is matched automatically. |
| `INSTALL_DIR` | `make desktop-install` | Where the Electron app is installed (default `/Applications`). |
| `SIGN_IDENTITY`, `NOTARY_PROFILE` | `make macos-app`, `scripts/macos-app.sh sign` | A code-signing certificate's name (default `-`, an ad hoc signature) and a `notarytool` keychain profile; with both the application is notarized and stapled. `scripts/macos-app.sh sign` signs (and notarizes) a bundle built before again. `SKIP_CORE=1` reuses the core in `dist/`; `OUT_DIR` is where the `.app` goes (default `dist/macos`). |
| `DEVELOPER_DIR` | `make macos-*` | The Xcode to use; the script picks `/Applications/Xcode.app` when the active developer directory is the command line tools. |
| `DEV_LISTEN` | `make dev-core`, `make dev-web` | The development core's address (default `127.0.0.1:7790`). |
| `HC_TEST_BIN` | `make it` | herdr-core executable for the integration tests; otherwise `hc` is found on `PATH`, and without one they are skipped. `go run ./scripts/fetch-hc -exe <file> <os>/<arch>` writes the pinned one. |
| `GUI_TEST_INSTALL` | `go test ./internal/agent` on Linux | `1` lets the program-window tests fetch Xvfb when it is not installed. |

## Files and directories

On every machine (the agent's `$HOME`):

| Path | Content | Lifetime |
| --- | --- | --- |
| `~/.herdr-ide/agent/<build>/` | Uploaded agent binaries | Builds unused for 14 days are removed. |
| `~/.herdr-ide/code-server/<version>/` | code-server releases (shared by instances) | Versions unused for 14 days are removed. |
| `~/.herdr-ide[-<instance>]/hc/herdr-core` (0700 directory) | The terminal core's executable, pushed by the core and accepted only with its SHA-256 | Replaced when the core brings another build; kept until removed. |
| `~/.local/state/herdr-core/herdr-ide[-<instance>]/` (`$XDG_STATE_HOME` when set) | The terminal core's own state (herdr-core's: terminal records, saved screens, logs) | Kept by herdr-core until the user removes it. |
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
read when the core starts and written by it at every change, keeping the
entries and fields it does not use; a stored machine whose target the core
refuses is listed with the code `invalid_target` and never connected.

A release directory holds the core, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`licenses.md` and `licenses/` (`herdr-core/` (the terminal core the core
embeds for machines), `herdr-detect/` (herdr's agent detection rules, which
the agents carry), `encoder/`); they stay until the user removes the
directory and are not copied to SSH machines.

In the browser, in `localStorage` under `herdr-ide.*` (state of that
browser only; settings and keybindings are the core's, the workspaces,
tabs and splits the terminal core's):

- whether the sidebar is open (`sidebarOpen`) and the VS Code panel's size
  (`dockWidth`, `dockHeight`)
- what each workspace's panel shows (`docks`)
- the selected machine (`machine`)
- the upload and download histories (`uploads`, `downloads`: the last 50
  finished transfers each, with file names, machines and paths, no
  contents)

Browser settings of earlier versions kept there (language, theme, font
sizes, …) are moved to the core's settings once, when a page of a writable
core loads, and then removed.

The macOS application keeps, in its preferences (`dev.herdr-ide.mac`), the
window's frames and the transfers' history (the last 50 finished uploads
and downloads: file names, machines and paths, no contents), until the user
clears the history in the transfers panel or removes the preferences; its
Quick Look copies are in a private temporary directory emptied when the
next preview is complete and at quit.

Desktop artifacts: `dist/desktop/mac-arm64/herdr-ide.app` (arm64),
`dist/desktop/mac/herdr-ide.app` (x64), and
`dist/desktop/herdr-ide-<version>-mac-<arch>.dmg`; the macOS application is
built to `dist/macos/herdr-ide.app` (`make macos-app`; releases publish it
zipped as `herdr-ide-<version>-mac-native-arm64.zip`) and its Xcode build
products are in `macos/.build/`, the renderer it is built with in
`macos/.deps/`. Generated shell code lives
in `desktop/dist/`; `make clean` removes these build outputs.
Icon sources and distributable PNG/ICNS are kept in `desktop/assets/`, with
the small SVG in `web/public/icon.svg`; `make desktop-icons` regenerates the
PNG and ICNS on macOS with librsvg and iconutil.
Electron's persistent profile is
`~/Library/Application Support/herdr-ide-desktop/` (`-dev` for development,
or the `--user-data-dir` given).
It holds browser preferences and Chromium data until manually removed.
The core uses `settings-desktop.json` and `~/.herdr-ide-desktop/` state;
development uses the existing `dev` instance. No desktop log files are kept:
stderr is streamed and the last 16 KiB is retained in memory for error dialogs.
