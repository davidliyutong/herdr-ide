# Reference

Single source for command-line flags, keyboard shortcuts, environment
variables and on-disk layout. `scripts/check.sh` fails when a flag is missing
here; both READMEs link to this page instead of repeating it.

## Commands

| Command | Description |
| --- | --- |
| `herdr-ide [serve] [flags]` | Run the server (default command). |
| `herdr-ide fetch-assets [flags] DIR` | Download and verify code-server releases and extensions into `DIR` for air-gapped installs. |
| `herdr-ide mcp [--instance NAME] [--socket PATH]` | The variable vault's MCP server on stdio, for coding agents' CLIs; asks the instance's agent through `vault.sock` and exits when stdin closes ([30](features/30-variable-vault.md)). |
| `herdr-ide version` | Print the version. |
| `herdr-ide-agent serve [--instance NAME]` | Per-machine helper; started by the core over ssh, never by hand. |
| `herdr-ide-agent mcp [--instance NAME] [--socket PATH]`, `~/.herdr-ide[-<instance>]/bin/herdr-ide-mcp` | The same MCP server on a machine; started by the stable link's name it takes no arguments and asks the agent of the data directory the link is in. |
| `herdr-ide-agent gui-keep --instance NAME` | Holds a machine's virtual display while the instance's terminal core runs; started by the agent, never by hand. |

## `serve` flags

### Network and security

| Flag | Default | Description |
| --- | --- | --- |
| `--listen` | `127.0.0.1:7780` | Address to listen on. Non-loopback addresses are refused unless `--proxy-secret-file` or `--insecure-listen` is given. |
| `--allowed-origin` | – | Public origin of the reverse proxy, e.g. `https://ide.example.com` (repeatable). Host and Origin headers are checked against loopback plus these. |
| `--proxy-secret-file` | – | File with a secret (≥ 16 characters) that the reverse proxy sends in `X-herdr-ide-Proxy-Secret`. Required for requests not coming from loopback. |
| `--insecure-listen` | `false` | Accept a non-loopback `--listen` without a proxy secret. Anyone reaching the port gets shell access to every machine. |
| `--read-only` | `false` | Watch only: terminals get no input (they observe), writing terminal core calls (layout changes, new and ended terminals), uploads, ssh authentication and VS Code are refused, no terminal core is installed or started, and agents do not renew Kimi Code's sign-in (`usage.kimiRefresh`). |
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
| `--parent-stdio` | `false` | Launcher lifecycle: read the launcher's hello, one JSON line on stdin, before serving (`{"desktop_token":"…"}`: the desktop app's token of this launch, 32 to 256 letters, digits, `-` or `_`, which its windows' requests carry in the cookie `herdr-ide-desktop`; `{}` for none; a missing or malformed hello stops the core); write one `{"event":"ready","url":"http://host:port"}` line to stdout after binding; cancel and clean up when stdin closes. Logs remain on stderr; SIGPIPE is ignored, so a launcher that disappeared does not kill the core before its cleanup. Used by Electron; does not change HTTP guards. |

## `fetch-assets` flags

`--platforms` (default `linux-amd64,linux-arm64,macos-amd64,macos-arm64`)
selects the code-server builds; `--code-server-version`, `--code-server-url`,
`--extension-url`, `--seed-dir` and `--offline` behave as above.

## Settings

Every setting of the core and of the user interface is defined in the core
(`internal/registry`) and shown by the UI's settings dialog
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
| `appearance.theme` | `system`, `light`, `dark` | `"system"` | – | – |
| `appearance.colorTheme` | `blue`, `vscode`, `teal`, `violet`, `rose`, `amber`, `graphite` | `"blue"` | – | – |
| `appearance.language` | `auto`, `en`, `zh-CN` | `"auto"` | – | – |
| `appearance.uiFontSize` | integer, 11–20 | `13` | – | – |
| `window.zoom` | integer, 50–300 | `100` | – | – |
| `terminal.fontFamily` | string | `""` | – | – |
| `terminal.fontSize` | number, 6–40 | `13` | – | – |
| `terminal.fontWeight` | `regular`, `medium` | `"regular"` | – | – |
| `terminal.lineHeight` | number, 0.8–2 | `1.05` | – | – |
| `terminal.cursorStyle` | `block`, `bar`, `underline` | `"bar"` | – | – |
| `terminal.cursorWidth` | number, 0.5–4 | `1` | – | – |
| `terminal.cursorBlink` | `true`, `false` | `true` | – | – |
| `terminal.scrollback` | integer, 0–100000 | `10000` | – | – |
| `terminal.bell` | `none`, `sound`, `visual` | `"visual"` | – | – |
| `terminal.optionIsMeta` | `true`, `false` | `false` | – | – |
| `terminal.mathHover` | `true`, `false` | `true` | – | – |
| `terminal.copyOnSelect` | `true`, `false` | `false` | – | – |
| `terminal.programClipboard` | `auto`, `ask`, `off` | `"auto"` | – | – |
| `terminal.colorScheme.dark` | `default`, `dracula`, `gruvbox-dark`, `gruvbox-light`, `nord`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `tomorrow`, `tomorrow-night` | `"default"` | – | – |
| `terminal.colorScheme.light` | `default`, `dracula`, `gruvbox-dark`, `gruvbox-light`, `nord`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `tomorrow`, `tomorrow-night` | `"default"` | – | – |
| `terminal.boldIsBright` | `true`, `false` | `false` | – | – |
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
| `notifications.system` | `true`, `false` | `true` | – | – |
| `notifications.badge` | `true`, `false` | `true` | – | – |
| `notifications.mutedAgents` | list of strings | `["droid"]` | – | – |
| `codeServer.install` | `push`, `download`, `existing` | `"push"` | `--code-server-install` | per machine |
| `codeServer.path` | string | `""` | `--code-server-path` | per machine |
| `plugins.vscode.enabled` | `true`, `false` | `false` | – | – |
| `plugins.vscode.browser` | `true`, `false` | `false` | – | – |
| `plugins.files.enabled` | `true`, `false` | `true` | – | – |
| `plugins.git.enabled` | `true`, `false` | `true` | – | – |
| `plugins.usage.enabled` | `true`, `false` | `true` | – | – |
| `plugins.vault.enabled` | `true`, `false` | `true` | – | – |
| `files.showHidden` | `true`, `false` | `false` | – | – |
| `files.exclude` | list of strings | `[".git",".svn",".hg","CVS",".DS_Store","Thumbs.db"]` | – | – |
| `files.sortOrder` | `default`, `mixed`, `filesFirst`, `type`, `modified` | `"default"` | – | – |
| `files.followFocus` | `true`, `false` | `true` | – | – |
| `files.confirmTrash` | `true`, `false` | `false` | – | – |
| `git.mixedLineEndings` | `keep`, `unify`, `readOnly` | `"keep"` | – | – |
| `git.changesView` | `list`, `tree` | `"list"` | – | – |
| `git.untrackedChanges` | `mixed`, `separate` | `"mixed"` | – | – |
| `git.autoFetch` | integer, 0–240 | `0` | – | – |
| `git.confirmSync` | `true`, `false` | `false` | – | – |
| `git.graphPageSize` | integer, 50–1000 | `300` | – | – |
| `usage.refresh` | `manual`, `1`, `2`, `5`, `15`, `30`, `60`, `adaptive` | `"adaptive"` | – | – |
| `usage.refreshOpen` | integer, 1–60 | `5` | – | – |
| `usage.refreshWorking` | integer, 1–120 | `10` | – | – |
| `usage.refreshIdle` | integer, 5–240 | `30` | – | – |
| `usage.costRefresh` | integer, 1–1440 | `15` | – | – |
| `usage.statusBar` | `true`, `false` | `true` | – | – |
| `usage.alerts` | `true`, `false` | `true` | – | – |
| `usage.thresholds` | list of strings | `["80","95"]` | – | – |
| `usage.providers.claude` | `true`, `false` | `true` | – | – |
| `usage.providers.codex` | `true`, `false` | `true` | – | – |
| `usage.providers.grok` | `true`, `false` | `true` | – | – |
| `usage.providers.antigravity` | `true`, `false` | `true` | – | – |
| `usage.providers.kimi` | `true`, `false` | `true` | – | – |
| `usage.providers.deepseek` | `true`, `false` | `true` | – | – |
| `usage.codexHomes` | list of strings | `[]` | – | – |
| `usage.claudeKeychain` | `true`, `false` | `true` | – | – |
| `usage.kimiRefresh` | `true`, `false` | `true` | – | – |
| `vault.approvalTimeout` | integer, 10–600 | `60` | – | – |
| `vault.autoLock` | integer, 0–1440 | `60` | – | – |
| `vault.sessionIdle` | integer, 1–240 | `30` | – | – |
| `vault.sessionMax` | integer, 1–24 | `12` | – | – |
| `vault.runTimeout` | integer, 5–3600 | `120` | – | – |
| `vault.runMaxTimeout` | integer, 5–3600 | `600` | – | – |
| `vault.runOutput` | integer, 4–1024 | `64` | – | – |
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

VS Code has two switches, both off by default
([05](features/05-vscode-panes.md)): `plugins.vscode.enabled` turns it on
in the desktop app's windows (settings files of earlier versions, where it
turned VS Code on everywhere, keep their value for the desktop app), and
`plugins.vscode.browser` in browsers. VS Code runs on the UI's own origin,
where its extensions and webviews can do whatever the page can; the UI sets
`plugins.vscode.browser` only after the user accepted that risk in a
dialog, and setting it in the file by hand is the same acceptance.

## Keyboard shortcuts

Keys come from the keybindings (`internal/keybindings`): defaults per
platform, changed in **Settings → Keyboard Shortcuts** or in
`keybindings[-<instance>].json` on the core host, an array of
`{"key", "command", "when"}` rules (`"command": "-<id>"` removes a key;
`when` is `terminal`, `vscode`, `dialog` or `always`). A key is modifiers
(`cmd`, `ctrl`, `alt`, `shift`) and a key joined by `+`; a chord is strokes
separated by spaces (`ctrl+k c`: ctrl+k, then c within 3 s). The first
stroke needs `cmd`, `ctrl` or `alt` (or is a function key). While a chord
starting with a stroke is bound, that stroke waits for the next one instead
of reaching the terminal; typing it twice (`ctrl+k ctrl+k`) lets the second
press through to the terminal as any key no binding takes.

The default keys differ by platform: `mac` is the desktop app on macOS,
`mac-browser` browsers on macOS, `pc` the desktop app on other systems and
`pc-browser` browsers there. No default is a chord, and none is `ctrl` or `alt` with a letter alone: `ctrl+b` and every
other key that is not in the table reach the program in the terminal on
their first press. The desktop app has direct shortcuts, which browsers
keep for themselves (`cmd+t`, `cmd+w`…); browsers get find, the keyboard
shortcuts and, on macOS, the command palette (`cmd+k`; in browsers on
other systems the status bar's **Command Palette…** opens it). On Windows
and Linux the desktop app's tab keys are `ctrl+tab`, `ctrl+shift+tab` and
`alt+1`…`alt+9`, as in GNOME Terminal and Konsole; `tab.select9` is the
last tab. A command
without a key (–) runs from the menus, the command palette, its button and
the context menus, and any key or chord can be bound to it. The desktop
app's menu shows the keys; there the page runs the keys it sees, and on
macOS the menu the keys the page leaves (on Windows and Linux the menu
takes no key, so Ctrl keys reach the terminals). While a VS Code pane has
the keyboard VS Code's own keys come first (`cmd+j` toggles its own bottom
panel there), except the key of `pane.close`, which the page takes first
to close the VS Code pane; in the desktop app on macOS a key VS Code
leaves runs, through the menu, a command for `terminal`, `vscode` or
`always`, on that pane. Rules naming `view.toggleCode` and
`workspace.rename`, commands of earlier versions, apply to `code.open` and
`workspace.edit`. `app.fullDiskAccess` (**Open
Full Disk Access Settings…**) exists only in the desktop app on macOS, and
the palette and the keyboard shortcuts page list it only there. Keys follow
the keyboard layout's characters. The table is generated from the registry
by `scripts/registry`.

<!-- scripts/registry: commands -->

| Command | When | `mac` | `mac-browser` | `pc` | `pc-browser` |
| --- | --- | --- | --- | --- | --- |
| `app.commandPalette` | `terminal` | `cmd+shift+p` | `cmd+k` | `ctrl+shift+p` | – |
| `app.keyboardShortcuts` | `terminal` | `cmd+slash` | `cmd+slash` | `ctrl+shift+slash` | `ctrl+shift+slash` |
| `app.settings` | `terminal` | `cmd+comma` | – | `ctrl+comma` | – |
| `app.agentAttention` | `terminal` | `cmd+shift+a` | – | `ctrl+shift+a` | – |
| `app.addMachine` | `terminal` | – | – | – | – |
| `app.fullDiskAccess` | `terminal` | – | – | – | – |
| `workspace.switch` | `terminal` | `cmd+p` | – | – | – |
| `workspace.next` | `terminal` | `cmd+ctrl+down` | – | – | – |
| `workspace.previous` | `terminal` | `cmd+ctrl+up` | – | – | – |
| `workspace.new` | `terminal` | `cmd+n` | – | `ctrl+shift+n` | – |
| `workspace.edit` | `terminal` | – | – | – | – |
| `workspace.close` | `terminal` | – | – | – | – |
| `workspace.closeOthers` | `terminal` | – | – | – | – |
| `tab.new` | `terminal` | `cmd+t` | – | `ctrl+shift+t` | – |
| `tab.rename` | `terminal` | – | – | – | – |
| `tab.next` | `terminal` | `cmd+shift+bracketright`, `ctrl+tab` | – | `ctrl+tab` | – |
| `tab.previous` | `terminal` | `cmd+shift+bracketleft`, `ctrl+shift+tab` | – | `ctrl+shift+tab` | – |
| `tab.select1` | `terminal` | `cmd+1` | – | `alt+1` | – |
| `tab.select2` | `terminal` | `cmd+2` | – | `alt+2` | – |
| `tab.select3` | `terminal` | `cmd+3` | – | `alt+3` | – |
| `tab.select4` | `terminal` | `cmd+4` | – | `alt+4` | – |
| `tab.select5` | `terminal` | `cmd+5` | – | `alt+5` | – |
| `tab.select6` | `terminal` | `cmd+6` | – | `alt+6` | – |
| `tab.select7` | `terminal` | `cmd+7` | – | `alt+7` | – |
| `tab.select8` | `terminal` | `cmd+8` | – | `alt+8` | – |
| `tab.select9` | `terminal` | `cmd+9` | – | `alt+9` | – |
| `tab.close` | `terminal` | `cmd+shift+w` | – | `ctrl+shift+w` | – |
| `tab.closeOthers` | `terminal` | – | – | – | – |
| `tab.closeRight` | `terminal` | – | – | – | – |
| `pane.splitRight` | `terminal` | `cmd+d` | – | – | – |
| `pane.splitDown` | `terminal` | `cmd+shift+d` | – | – | – |
| `pane.close` | `terminal` | `cmd+w` | – | – | – |
| `pane.zoom` | `terminal` | `cmd+shift+enter` | – | `ctrl+shift+enter` | – |
| `pane.rename` | `terminal` | – | – | – | – |
| `pane.actions` | `terminal` | – | – | – | – |
| `pane.focusLeft` | `terminal` | `cmd+alt+left` | – | – | – |
| `pane.focusDown` | `terminal` | `cmd+alt+down` | – | – | – |
| `pane.focusUp` | `terminal` | `cmd+alt+up` | – | – | – |
| `pane.focusRight` | `terminal` | `cmd+alt+right` | – | – | – |
| `pane.focusNext` | `terminal` | – | – | – | – |
| `pane.focusPrevious` | `terminal` | – | – | – | – |
| `pane.back` | `terminal` | `cmd+bracketleft` | – | – | – |
| `pane.forward` | `terminal` | `cmd+bracketright` | – | – | – |
| `pane.undoClose` | `terminal` | `cmd+z` | – | – | – |
| `view.toggleSidebar` | `terminal` | `cmd+b` | – | – | – |
| `view.togglePanel` | `terminal` | `cmd+alt+b` | – | – | – |
| `view.panel.files` | `terminal` | `cmd+shift+e` | – | – | – |
| `view.zoomIn` | `always` | `cmd+shift+equal`, `cmd+equal` | – | `ctrl+shift+equal`, `ctrl+equal` | – |
| `view.zoomOut` | `always` | `cmd+minus` | – | `ctrl+minus` | – |
| `view.zoomReset` | `always` | `cmd+0` | – | `ctrl+0` | – |
| `view.panel.vault` | `terminal` | – | – | – | – |
| `view.panel.usage` | `terminal` | – | – | – | – |
| `view.panel.git` | `terminal` | `ctrl+shift+g` | – | `ctrl+shift+g` | – |
| `find.open` | `terminal` | `cmd+f` | `cmd+f` | `ctrl+shift+f` | `ctrl+shift+f` |
| `find.next` | `terminal` | `cmd+g` | – | – | – |
| `find.previous` | `terminal` | `cmd+shift+g` | – | – | – |
| `code.open` | `terminal` | `cmd+j` | – | `ctrl+shift+j` | – |
| `code.diff` | `terminal` | – | – | – | – |
| `code.gitGraph` | `terminal` | – | – | – | – |
| `git.graph` | `terminal` | – | – | – | – |

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
in a preview pane, code in a VS Code pane, of the terminal's workspace or
split beside the terminal) and URLs. `cmd+f` (macOS) or
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

With the mouse: double-click a terminal pane's title to rename it (empty
restores the terminal title); double-click a tab or workspace to rename it;
drag a pane (a terminal, VS Code or a preview) by its header onto another
pane to swap the two (centre) or to place it beside that pane (edges),
onto a tab to move it there, or onto `+` to move it into a new tab; drag a
tab along the tab bar, a workspace along its machine's list, or a machine
by its header among the machines, to reorder it. Escape cancels a drag.

Right-click a pane header (or press its ⋯ button, shown when the header is
narrow), a tab, a workspace or a machine for a menu of its commands
(rename, split, zoom, VS Code, new tab, move, close; a machine's terminal
core) with their bindings;
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
| `GET /api/config` | – | Name, slug, version, whether the core is read-only (`read_only`), whether it offers the interactive ssh login (`ssh_login`; false on Windows, whose ssh keeps no control sockets) and which kind of client asks (`client`: `desktop` for a request with the desktop app's token of this launch in its cookie, else `browser`). |
| `GET /api/settings` | – | Definitions, values (per machine too) and problems of the settings, and which kind of client asks (`client`, as in `/api/config`): the switch of VS Code that applies to the page (`plugins.vscode.enabled` in the desktop app, `plugins.vscode.browser` in a browser). |
| `PUT /api/settings` | writes | Sets one value (`{"key", "value", "machine"?}`). |
| `DELETE /api/settings` | writes | Removes one value, which falls back to the global value or the default. |
| `GET /api/keybindings` | – | Commands, default keys per platform, the user's rules, the bindings in effect and their conflicts. |
| `PUT /api/keybindings` | writes | Replaces the user's rules. |
| `GET /api/machines` | – | Every machine's state, its agent's information and its terminal core's state. A machine that is never connected is in `error` with a `code`: `invalid_target` (a stored ssh target the core refuses) or `local_unsupported` (the local machine of a core on Windows, where no agent runs). |
| `POST /api/machines` | writes | Adds and stores an SSH machine (`{"target", "label"}`). |
| `PUT /api/machines/order` | writes | Puts the machines in an order and stores it (`{"order": [ids]}`, each machine once; `400 invalid` otherwise). |
| `GET /api/ssh/hosts` | writes | The Host aliases of the core host's `~/.ssh/config` (and the files it includes) that are no machine's target yet, as `[{"alias", "hostname"?, "user"?}]`, for the Add Machine dialog; nothing else of the configuration ([02](features/02-multi-machine-transport.md)). Refused read-only, where no machine can be added. |
| `DELETE /api/m/{id}` | writes | Removes a stored machine. |
| `PUT /api/m/{id}/label` | writes | Renames a machine. |
| `PUT /api/m/{id}/enabled` | writes | Enables or disables a machine. |
| `GET /api/m/{id}/hc` | – | The machine's terminal core: installed, running, version. |
| `POST /api/m/{id}/hc/{action}` | writes | `start`, `stop` or `restart` the machine's terminal core. |
| `GET /api/m/{id}/privacy` | – | macOS's Full Disk Access on the machine: `files` (the agent's process; on the local machine the core's, which the desktop app started) and `terminals` (the terminal core's, which its terminals' programs have), each `granted`, `denied` or `unknown` (not macOS, no terminal core running, no protected folder to try), and `hc`, the terminal core's executable. Starts no terminal core. |
| `GET /api/m/{id}/auth` | writes | Interactive ssh login of a machine that needs one (WebSocket, `?cols=&rows=`); `400 invalid_target` for a refused target, `501 ssh_login_unsupported` on a core without ssh control sockets (Windows). |
| `POST /api/m/{id}/bridge` | writes | (VS Code plugin; `404 plugin_disabled` while it is off for the requesting client) A command for a VS Code window (open a file at a line, diff, Git Graph): the one `window` names, else with `fresh` one that connects after the request, else the best one for `folder`; the reply names the window that took it. |
| `GET /api/m/{id}/file` | – | A file (`?path=`, `&download=1` as an attachment), with HTTP ranges; `404` only for a path that is not there, `403` for one the machine may not read, `502` when the machine did not answer or its stat failed otherwise. |
| `GET /api/m/{id}/download` | – | One file as an attachment, or several paths (folders included) as a zip (`?path=`…, `&dl=<id>` to follow it on `/ws`). |
| `POST /api/m/{id}/upload` | writes | Writes the request body to a file (`?name=`, `&dir=` absolute, else the upload directory). |
| `GET /api/m/{id}/list` | – | A directory's entries (`?path=`). |
| `POST /api/m/{id}/p/files/stat` | – | The file explorer's poll: size, modification time and kind of 1–200 paths (`{"paths"}`; a POST because 200 paths in a query make a URL proxies refuse, but it changes nothing and read-only mode allows it); `error` (`busy`, `timeout`, `denied`, `failed`) on a path whose state is not known ([28](features/28-file-explorer.md)). |
| `POST /api/m/{id}/p/files/{action}` | writes | The file explorer's changes (`{"path"}`, `{"path", "to"}`, `{"paths", "dir"}` or `{"paths"}`): `mkdir` (`"unique": true`: a taken name becomes `name-1`…), `mkdirs` (folders with the folders leading to them, those there kept), `create`, `rename` and `move` (never replacing), `copy`, `trash`, `remove` (for good); audited as `files.<action>` with the paths (`path`, `to`, `dir`, the first 50 `paths` and their `count`) and the outcome (`status`, `error`), as every plugin's change is once it ended. |
| `POST /api/m/{id}/p/files/write` | writes | Saves the body (at most 8 MiB) into `?path=` when the file still has `&mtime=&size=` (`&new=1`: is not there, `&force=1`: any); `409 conflict` with its state otherwise; audited as `files.write` with the path, `force` and the outcome. |
| `POST /api/m/{id}/p/files/upload` | writes | Writes the body (at most 4 GiB) into `?path=` under a free name (`name-1.ext`…), or over the file there with `&replace=1`, as a save writes it; a request that ends early leaves nothing; audited as `files.upload` with the path, the size, `replace` and the outcome ([28](features/28-file-explorer.md)). |
| `GET /api/m/{id}/p/git/{read}` | – | The Git plugin's reads ([31](features/31-git.md)) with their parameters in the query: `repo` (`?path=` a directory), `status`, `log` (`&skip=&limit=&branch=…&remotes=1`), `show` (`&rev=&parent=` or `&rev2=`), `blob` (`&path=&source=worktree\|index\|head\|<rev>&parent=`), `branches`, `tags`, `stashes`, `diffStat`, `watch` (tokens `token`, `refs`, `config`), each with `?repo=` the top level. |
| `POST /api/m/{id}/p/git/{change}` | writes | The Git plugin's changes with a JSON body (at most 5 MiB; `repo` and the action's fields): `stage`, `unstage`, `applyPatch`, `discard`, `commit`, `checkout`, `branchCreate`, `branchDelete`, `branchRename`, `merge`, `rebase`, `abort`, `continue`, `cherryPick`, `revert`, `reset`, `tagCreate`, `tagDelete`, `stashPush`, `stashApply`, `stashPop`, `stashDrop` (`index` and `hash`, the entry's commit), `fetch`, `pull`, `push`; at most 20 000 `paths`; audited as `git.<action>`; failures `git_missing`, `not_a_repo`, `bad_ref`, `auth_required`, `conflicts`, `diverged`, `stale`, `timeout`, `git_failed`. |
| `GET /api/m/{id}/code/status` | – | Whether the machine's code-server is installed and runs. While the VS Code plugin is off for the requesting client (`plugins.vscode.enabled` for the desktop app, `plugins.vscode.browser` for browsers), it, `code/start`, the proxy and the bridge answer `404 plugin_disabled`. |
| `POST /api/m/{id}/code/start` | writes | Installs and starts the machine's code-server. |
| `POST /api/m/{id}/code/stop` | – | Releases the machine's code-server (allowed read-only: it only stops). |
| `/m/{id}/code/` | writes | The machine's code-server behind the core's proxy (`/m/{id}/code` redirects here). |
| `GET /m/{id}/gui/{win}` | – | The page of a program window. |
| `GET /m/{id}/gui/{win}/ws` | – | A program window's frames and events, its input (WebSocket; `?video=` names the video streams the browser decodes). |
| `POST /m/{id}/gui/{win}/close` | writes | Asks a program window to close. |
| `POST /api/m/{id}/gui/enable` | writes | Gives open terminals the machine's display (`{"terminals": [...]}`, empty for all). |
| `GET /api/gui` | – | The program windows of every machine. |
| `GET /api/p/vault` | – | The variable vault ([30](features/30-variable-vault.md)): `status` (`mode` `""` or `passphrase`, `locked`, `setup` (no passphrase yet), `passphraseSet`), the `variables` (`name`, `description`, `machines` (`*`: all), `injectOnly`, `created`, `updated`), never values, `session`: whether the request's `X-Vault-Session` is open, `idle`: the seconds a session lasts unused (`vault.sessionIdle`), and `autoLock`: `after` (seconds without use before the vault locks, 0 never), `custom` (a page set it for this unlock), `setting` (`vault.autoLock`'s seconds) and, while unlocked, `lockAt` (when it locks if unused). `503` when the vault does not open, with why: `unavailable` (no settings file), `version` (a file of another version), `invalid` (a damaged or hand-edited file) or `failed` (not readable); it is opened again at the next request. The routes marked *gated* answer `401 vault_session` without an open session. |
| `PUT /api/p/vault/vars/{name}` | writes, gated | Creates or changes a variable (`{"to"?, "description"?, "machines"?, "injectOnly"?, "value"?}`; a new one needs `value`, absent keeps it; `to` renames it in the same write, its value sealed again under the new name, `404 not_found` for a variable that does not exist and `409 exists` for a taken name, so a refusal changes nothing); names `^[A-Za-z_][A-Za-z0-9_]*$` (≤ 128), values ≤ 64 KiB, descriptions ≤ 1 KiB; `409 no_passphrase` before the vault has a passphrase. Audited as `vault.saved` with the name (and `from`, the name before a rename), the machines, the flag and whether the value changed. |
| `DELETE /api/p/vault/vars/{name}` | writes, gated | Removes a variable. |
| `POST /api/p/vault/vars/{name}/reveal` | writes, gated | The value (`{"value"}`): the only way one reaches a browser; refused read-only; recorded in the access log (`revealed`, with the page's address and browser) and audited as `vault.revealed` before the value is sent, `500 log_failed` without it when the record cannot be written. |
| `POST /api/p/vault/export` | writes, gated | An export file of the variables named (`{"passphrase", "filePassphrase", "names"}`, or `"all": true`): the vault's passphrase again (checked and slowed down as a session's), a file passphrase of at least 12 characters (`400 weak_export_passphrase`); the response is the file (`application/json`): `{format: "<slug>-vault-export", version: 1, kdf: {alg: "argon2id", salt, time, memory, threads}, cipher: "aes-256-gcm", nonce, ciphertext}`, everything in the clear bound to the ciphertext as its additional data; the content holds each variable's name, value, description, machines, flag and times, and the machines' ids with their labels, kinds and ssh targets. Recorded in the access log (`exported`, the names) and audited as `vault.exported` before it is sent, `500 log_failed` without it; `404 not_found` (with `name`) for a variable that is not there, `409 vault_locked`, `413 too_large` past 16 MiB. |
| `POST /api/p/vault/import/preview` | writes, gated | What an export file holds (`{"file", "passphrase"}`: the file's text, at most 16 MiB, and its passphrase), never values: `{exported, variables: [{name, description, injectOnly, machines, unknown, exists, invalid}], machines: [{id, label, local, known}]}`; `machines` are those the variable maps to here (by id, an ssh machine only with the same kind and target as in the file; the local machine only when its label matches too), `unknown` those that will ask every time, `invalid` `invalid_name` (importable under another name) or `invalid`. `400 bad_file` (not an export file, damaged, derivation out of bounds), `400 file_version`, `400 file_passphrase` (wrong passphrase or a changed file), `413 too_large`. |
| `POST /api/p/vault/import` | writes, gated | Imports a file's variables as chosen (`{"file", "passphrase", "choices": [{"i", "action": "import"\|"overwrite"\|"rename"\|"skip", "as"?}]}`, `i` the variable's index in the file) in one write, machines mapped as the preview says: `{"imported": [names]}`; a refusal of any changes nothing (`409 exists` with `name` for a taken name without `overwrite`, `400 invalid_name`, `400 full` past 1000 variables, the file's errors as for the preview). Audited as `vault.imported` with the names, those overwritten and renamed, never values. |
| `POST /api/p/vault/session` | writes | Opens a vault session with `{"passphrase"}`, unlocking the vault: `{"session", "idle", "status"}`; the page sends the token as `X-Vault-Session`. A session ends unused for `vault.sessionIdle` minutes (30), `vault.sessionMax` hours after it began (12), when the vault is locked (also by `vault.autoLock`) or its passphrase changed; `idle` is the first, in seconds. `403 wrong_passphrase`; after 3 wrong ones in a row `429 wait` (`Retry-After`), doubling up to 5 minutes; `429 busy` while another passphrase is checked; `409 no_passphrase` before there is one. |
| `DELETE /api/p/vault/session` | writes | Ends the request's session. |
| `POST /api/p/vault/passphrase` | writes | Sets the first passphrase (`{"passphrase"}`, at least 8 characters) or changes it (`{"old", "passphrase"}`, slowed down as sessions are); every value is sealed again (a value that does not open fails the change with `400 corrupt` and leaves the vault as it was); opens a session (`{"session", "idle", "status"}`) and ends the others. |
| `POST /api/p/vault/lock` | writes | Forgets the key until unlocked and ends every session; one asked for while a passphrase is checked comes after the check and its session. |
| `POST /api/p/vault/autolock` | writes, gated | Sets the auto-lock's time for the current unlock, `{"minutes"}` (0: never, at most 1440; `null`: `vault.autoLock`'s), until the vault locks; counts as a use; audited with `minutes`. Answers the list's `autoLock`. |
| `GET /api/p/vault/requests` | – | The MCP requests waiting for an answer. |
| `POST /api/p/vault/requests/{id}` | writes, gated (but `deny`) | Answers one (`{"answer": "once"\|"always"\|"deny"}`), audited as `vault.answered`; the first answer wins, later ones and those after the request expired get `404`, so `200` means the requester gets this answer. |
| `GET /api/p/vault/log` | – | The access log, kept in `vault[-<instance>]-access.jsonl` across restarts: the last 1000 records that let values out and the last 500 others, newest first; never values. Each has `id`, `time`, `m` (the machine; `""` for a page), `tool` (`list`, `get`, `env`; a page's `reveal`, `export`), `names`, what the MCP server said of itself (`client`, `terminal`, `cwd`), the process that connected to `vault.sock` and its parents as the machine's agent saw them (`process`: `[{pid, name}]`), a page's `remote` and `userAgent`, and `result`: `allowed`, `approved`, `approved_always`, `revealed`, `exported` (values let out), `listed`, `denied`, `expired` (no answer in time), `cancelled` (the requester went away), `log_failed` (not released: its record could not be written) or a refusal's code such as `busy`, `not_found`, `vault_locked`, `inject_only` or `bad_request`; `count` for repeated list calls or refusals merged into one. |
| `GET /api/p/usage` | – | The AI usage plugin's snapshot: accounts (provider, id, email, plan, windows with pace, credits, balances, status and code, machines seen on), each machine's last poll, the providers' status pages, the alerts fired in the last hour; `?watch=1` marks the panel open for the adaptive refresh ([29](features/29-ai-usage.md)). |
| `GET /api/p/usage/cost` | – | The cost of the machines' AI CLI logs at API prices by day, provider, model, project and machine (`?days=` 1–90, `&tz=` the user's offset east of UTC in minutes). |
| `POST /api/p/usage/refresh` | writes | Asks every connected machine for its limits now, or 30 s after the last poll when that was sooner (202 `{queued, at}`: when the poll runs). |
| `PUT /api/m/{id}/p/usage/deepseek-key` | writes | Writes the machine's DeepSeek key file (`{"key"}`; `""` removes it); never read back, audited without the key. |
| `/` | – | The web UI (`/licenses.md`: the notices of its bundle); any other path gets the app shell for the UI's own routes, except `/api/…` paths no route takes, which are 404. |

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `HERDR_IDE_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `HERDR_IDE_CORE` | `pnpm -C web dev` | Core URL the Vite dev server proxies to (default `http://127.0.0.1:7780`; `make dev-web` sets the development core's, `DEV_LISTEN`). |
| `HERDR_IDE_DESKTOP_DEV` | Electron | Isolated development even in a packaged app: `1` runs instance `dev` (terminal core session `herdr-ide-dev`); another value names the instance (lowercase letters, digits and dashes, starting with a letter or digit, at most 32, not `desktop`; the app refuses to start otherwise), so a smoke test can run beside a development instance in use. Every development instance is local-only and has its own Electron profile and single-instance lock (`herdr-ide-desktop-<instance>`, `herdr-ide-desktop-dev` for `dev`). Unpackaged Electron always uses this mode. |
| `HERDR_IDE_DESKTOP_NO_OPEN` | Electron, development instances only | Set (to anything): the Full Disk Access buttons write `no-open: …` with what they would open (System Settings' URL, the terminal core's executable in Finder, the app's relaunch) to stderr instead of opening it, for smoke tests. |
| `HERDR_IDE_DESKTOP_PORT` | Electron | Loopback port (default `7781`, development `7791`); `0` chooses an ephemeral port, which gives a new browser storage origin. |
| `--user-data-dir=<dir>` | Electron command line | Replaces the Electron profile and its single-instance lock, so a copy launched by its executable (on macOS not with `open`, which activates a running copy of the same bundle identifier) runs beside another one; for isolated smoke tests with `HERDR_IDE_DESKTOP_DEV`. |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | core on Linux | The user configuration directory (settings, keybindings, machines; default `~/.config`) and the cache directory (code-server downloads; default `~/.cache`). |
| `XDG_STATE_HOME` | core | Where the SSH machines herdr saved are read from for the one-time import (`$XDG_STATE_HOME/herdr/client/endpoints.json`, default `~/.local/state/herdr/client/endpoints.json`). |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME` | agent (AI usage plugin) | Where the AI CLIs keep their credentials and logs when not in `~/.claude`, `~/.codex`, `~/.grok`, `~/.kimi-code`. |
| `KIMI_DISABLE_OAUTH_LOCK` | agent (AI usage plugin) | `1`: Kimi Code renews its sign-in without its lock, so the plugin does not renew it (`usage.kimiRefresh`). |
| `DEEPSEEK_API_KEY` | agent (AI usage plugin) | The DeepSeek key whose balance is shown; before Claude Code's DeepSeek settings and the key file. |
| `HTTPS_PROXY`, `NO_PROXY` | agent (AI usage plugin), core (status pages) | The proxy for the AI providers' hosts. |

Variables of the build scripts and tests:

| Variable | Where | Description |
| --- | --- | --- |
| `TARGETS` | `scripts/build.sh` | Core platforms to build and package (default the host's), e.g. `"linux/amd64 darwin/arm64"`; `windows/amd64` builds `dist/herdr-ide-windows-amd64.exe` for the desktop setup, without an archive. |
| `AGENT_PLATFORMS` | `scripts/build.sh` | Agent and herdr-core platforms to embed (default all four). |
| `SKIP_WEB`, `SKIP_EXT` | `scripts/build.sh` | `1` reuses `web/dist` or the built bridge extension. |
| `REQUIRE_ENCODER` | `scripts/build.sh` | `1` (release builds) fails when a Linux video encoder (`scripts/build-ffmpeg.sh`) is missing. |
| `VERSION` | `scripts/build.sh`, `scripts/desktop.sh` | The version the core and agents report (default `git describe`). Desktop builds take a semver for the app metadata and the installers' names (default `desktop/package.json`'s); a leading `v` (release tags such as `v0.2.0`) is kept for the core and dropped for the app metadata. |
| `FFMPEG_PLATFORMS` | `scripts/build-ffmpeg.sh` | Linux platforms to build the video encoder for (default both). |
| `GHOSTTY_SRC` | `make vt-wasm` | A Ghostty checkout to build libghostty-vt from instead of the pinned clone. |
| `ARCH` | `scripts/desktop.sh` (`make desktop-app`, `make desktop-dist`, `make desktop-install`) | `arm64` or `x64`; defaults to the host Node architecture; the Windows app is `x64` only. The Go core architecture is matched automatically (`x64` is `amd64`). |
| `DESKTOP_OS` | `scripts/desktop.sh` | `mac`, `win` or `linux` (default this system): packages another system's unpacked app (modes `build` and `app`) to check its packaging; installers (`dist`), `install` and `dev` run only on their own system. |
| `SKIP_BUILD` | `scripts/desktop.sh` | `1` runs electron-builder alone on what an earlier `scripts/desktop.sh build` made (the release workflow's Package step). |
| `INSTALL_DIR` | `make desktop-install` | macOS: where the Electron app is installed (default `/Applications`). |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | `scripts/desktop.sh` on macOS (electron-builder) | A Developer ID Application certificate (a `.p12`, base64-encoded or its path) and its password: the app is signed with it instead of ad hoc. |
| `CSC_NAME` | `scripts/desktop.sh` on macOS (electron-builder) | The name of a Developer ID identity in the keychain, instead of `CSC_LINK`. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `scripts/desktop.sh` on macOS (electron-builder) | With a Developer ID certificate: notarize the app with this Apple ID, its app-specific password and the team id. |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `make deps` | `1` installs the desktop packages without Electron's binary, which checks and the shell's tests do not need (CI's check jobs set it); running or packaging the app needs it. |
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
| `~/.herdr-ide[-<instance>]/run/` (0700) | `hc.sock` (the terminal core's API socket, 0600) and its holders' sockets; `cs.sock`, `cs.pid`, `bridge.sock`, `vault.sock` (0600, the vault's MCP servers); `gui.json` (reserved display and Xvfb pid), `xauth` (terminals' display cookie) and `xauth.server` (Xvfb's copy), both 0600 and replaced at each Xvfb start, `gui.lock`, `gui-keep.lock` (held by the display keeper) | Sockets while the agent (code-server, bridge) or the terminal core runs; the display files are kept so terminals keep a valid environment. |
| `~/.herdr-ide/xvfb/<version>/` | Xvfb unpacked from the distribution's package (shared by instances) | Versions unused for 14 days are removed when another is unpacked. |
| `~/.herdr-ide/video/<sha256 prefix>/encoder` | Video encoder pushed by the core (`gui-video`, shared by instances), run only while its SHA-256 matches | Builds unused for 14 days are removed when another is installed; unfinished installs after 1 h. |
| `~/.herdr-ide[-<instance>]/xvfb.log` | Output of the last Xvfb started | Replaced at each start. |
| `~/.herdr-ide[-<instance>]/gui-keep.log` | Output of the last display keeper | Replaced at each start. |
| `~/.herdr-ide[-<instance>]/cs-data/`, `cs-ext/` | VS Code settings, extensions | Kept; logs older than 7 days are pruned. |
| `~/.herdr-ide[-<instance>]/uploads/` | Pasted and dropped files | Files older than 7 days are pruned. |
| `~/.herdr-ide[-<instance>]/staging/` (0700) | The file explorer's uploads (0600) while they are received, before they are written to their files | Removed by the upload when it ended; what an agent that ended during one left is removed by the agent that starts more than 7 days later. |
| `~/.herdr-ide[-<instance>]/bin/herdr-ide-mcp` (0700 directory) | Link to the executable that serves the vault's MCP server (the agent's, or on the local machine the core's) | Pointed at the running executable whenever an agent starts; kept so MCP configurations stay valid. |
| `~/.herdr-ide[-<instance>]/usage/cost-cache.json` (0600) | The AI usage plugin's records of the AI CLIs' logs, per log file | Records and logs older than 90 days leave it at each scan. |
| `~/.herdr-ide[-<instance>]/usage/deepseek.key` (0600) | A DeepSeek API key set in the AI usage panel | Until removed in the panel or by hand. |

On the core host: ssh control sockets in `/tmp/herdr-ide-<uid>/s` on Linux
and macOS (must be owned by you, mode 0700; a core on Windows keeps none),
downloads in the user cache directory
(`~/Library/Caches/herdr-ide/code-server` on macOS, `~/.cache/herdr-ide/code-server`
on Linux, `%LocalAppData%\herdr-ide\code-server` on Windows) with `.sha256` sidecars (also recorded for releases that machines
downloaded themselves), the settings in `settings[-<instance>].json`, the
variable vault in `vault[-<instance>].json` (values encrypted under a key derived from its passphrase, which is kept nowhere, [30](features/30-variable-vault.md)) and its access log in `vault[-<instance>]-access.jsonl` (0600; names, never values; the last 1000 releases and 500 other records), the
AI usage plugin's history in `usage-history[-<instance>].json` (the last
accounts, 30 days of their windows' use and the periods its alerts fired
in, kept a day past them), the
keybindings in `keybindings[-<instance>].json` and the machines in
`machines[-<instance>].json` (`{"version": 1, "machines": [{id, label,
kind, target, enabled}], "order": [ids]}`: the SSH machines, the local machine's
enabled flag and name once they were changed, and the order the user put the machines
in once they were reordered; the SSH machines herdr saved
(`~/.local/state/herdr/client/endpoints.json`) are imported into it the
first time a core of the instance starts without one), all in the
user configuration directory (`~/Library/Application Support/herdr-ide/` on
macOS, `$XDG_CONFIG_HOME/herdr-ide/` (default `~/.config/herdr-ide/`) on
Linux, `%AppData%\herdr-ide\` on Windows; files replaced atomically, kept
until removed; on Linux and macOS the directory is 0700 and the files
0600, on Windows the profile's access control list keeps them the user's).
The settings and keybindings files can be
edited by hand: the core reads them again within two seconds, keeps entries
it does not know and reports values it cannot use. The machines file is
read when the core starts and written by it at every change, keeping the
entries and fields it does not use; a stored machine whose target the core
refuses is listed with the code `invalid_target` and never connected, and
so is the local machine of a core on Windows, with `local_unsupported`.

A release directory holds the core, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`licenses.md` and `licenses/` (`herdr-core/` (the terminal core the core
embeds for machines), `herdr-detect/` (herdr's agent detection rules, which
the agents carry), `encoder/`); they stay until the user removes the
directory and are not copied to SSH machines.

In the browser, in `localStorage` under `herdr-ide.*` (state of that
browser only; settings and keybindings are the core's, the workspaces,
tabs and splits, VS Code and preview panes included, the terminal core's):

- whether the sidebar is open (`sidebarOpen`) and its width
  (`sidebarWidth`)
- the selected machine (`machine`)
- the upload and download histories (`uploads`, `downloads`: the last 50
  finished transfers each, with file names, machines and paths, no
  contents)

Browser settings of earlier versions kept there (language, theme, font
sizes, …) are moved to the core's settings once, when a page of a writable
core loads, and then removed. What earlier versions kept there for the
VS Code panel (`docks`, `dockWidth`, `dockHeight`) is removed when a page
loads, and its position (`dockPosition`) with the settings above.

Desktop artifacts (`make desktop-app` writes the unpacked apps,
`make desktop-dist` the installers of the system it runs on), in
`dist/desktop/`:

- macOS: `mac-arm64/herdr-ide.app` (arm64), `mac/herdr-ide.app` (x64),
  `herdr-ide-<version>-mac-arm64.dmg`, `-mac-arm64.zip`, `-mac-x64.dmg`,
  `-mac-x64.zip`
- Windows: `win-unpacked/herdr-ide.exe`, `herdr-ide-<version>-win-x64.exe`
  (the setup)
- Linux: `linux-unpacked/herdr-ide` (x64), `linux-arm64-unpacked/herdr-ide`,
  `herdr-ide-<version>-linux-x86_64.AppImage`, `-linux-arm64.AppImage`,
  `-linux-amd64.deb`, `-linux-arm64.deb`

The core is `bin/herdr-ide` (`bin/herdr-ide.exe` on Windows) in the app's
resources, beside the licenses. Generated shell code lives in
`desktop/dist/`; `make clean` removes these build outputs. Icon sources and
the distributable PNG, ICNS and ICO are kept in `desktop/assets/`, with the
small SVG in `web/public/icon.svg`; `make desktop-icons` regenerates the
PNG, ICNS and ICO on macOS with librsvg and iconutil.
Electron's persistent profile is `herdr-ide-desktop` (`-dev` for
development, or the `--user-data-dir` given) in the system's application
data directory: `~/Library/Application Support/` on macOS, `%AppData%` on
Windows, `$XDG_CONFIG_HOME` (default `~/.config`) on Linux.
It holds browser preferences and Chromium data until manually removed;
uninstalling leaves it.
The core uses `settings-desktop.json` and `~/.herdr-ide-desktop/` state
(on Windows only on the SSH machines); development uses the existing `dev`
instance or the one `HERDR_IDE_DESKTOP_DEV` names. No desktop log files are
kept: stderr is streamed and the last 16 KiB is retained in memory for error
dialogs.
