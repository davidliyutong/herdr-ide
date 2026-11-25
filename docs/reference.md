# Reference

Single source for commands, flags, settings, keyboard shortcuts, endpoints,
environment variables and on-disk layout. `scripts/check.sh` fails when a
flag or a route of the hub is missing here
(`backend/scripts/reference.ts`); both READMEs link to this page instead of
repeating it.

## Commands

On Linux and macOS the hub's executable is the machine build of its own
platform too ([42](features/42-typescript-backend.md)): besides `serve`,
`fetch-assets` and `version` it runs the machine's commands (`node`, `mcp`,
`chat-host`), and each machine runs its platform's from
`~/.veldr/agent/<build>/veldr`, downloaded from the release or uploaded by
the hub. On Linux machines the GUI helper it carries (`veldr-gui`,
[14](features/14-gui-windows.md)) has the display's commands.

| Command | Description |
| --- | --- |
| `veldr [serve] [flags]` | Run the server (default command). |
| `veldr fetch-assets [flags] DIR` | Download and verify code-server releases and extensions into `DIR` for air-gapped installs. |
| `veldr mcp [--instance NAME] [--socket PATH]` | The variable vault's MCP server on stdio for coding agents' CLIs; asks the instance's agent through `vault.sock`, exits when stdin closes or on SIGTERM/SIGINT/SIGHUP, killing the commands it runs first ([30](features/30-variable-vault.md)). Exit 2: bad command line; 1: no home directory, or a line over 4 MiB. Served by every executable. |
| `veldr version` | Print the version. |
| `veldr node [--instance NAME] [--takeover]` | The machine's node: serves the hub's protocol on `<run>/node.sock` (the namespace's runtime directory on this host, see [files](#files-and-directories)) to any number of hubs; started by them, ends 15 s after its last client; `--takeover` takes the socket from the running node, which drains ([39](features/39-nodes.md)). Linux and macOS. |
| `veldr node dial [--instance NAME] [--client ID]` | Pipes stdio to the node, starting one (or one that takes over from an older build's) when none answers; what a hub runs over ssh, `--client` naming the hub. |
| `veldr node stop [--instance NAME] [--terminal-core]` | Asks the instance's nodes to stop; `--terminal-core` also stops the instance's terminal core on this host when one answers on its socket, ending its terminals. |
| `~/.veldr[-<instance>]/bin/veldr-mcp` | The MCP server on a machine: a shell script running `veldr-mcp-$(uname -s)-$(uname -m)` beside it, a link to the installed machine build of that platform (the hub's executable, started by that name as `mcp`); takes no arguments and asks the agent of its data directory on this host. |
| `veldr-gui gui-keep --socket S --pid P --xauth F --hc-socket H --lock L --display D` | The GUI helper's display keeper: holds a machine's virtual display while the instance's terminal core runs; started by the agent. |
| `veldr-gui gui-wl --device NODE [--nvidia]` | The GUI helper's compositor of a machine's GPU display: a Wayland server showing nothing, for the one Xwayland on file descriptor 3, drawing with the render node's GPU (`--nvidia`: NVIDIA's buffer layouts); started by the agent. |
| `veldr chat-host --base DIR --run DIR` | A machine's chat host ([37](features/37-agent-chats.md)), serving `chat.sock` in `--run` with its journal and log in `--base`; started by the agent as a hidden terminal of the terminal core. Ends on SIGHUP/SIGTERM/SIGINT, when asked to make way, or a minute after going idle. Exit 2: bad command line; 1: socket taken, directories not the user's alone, a newer host's journal, or not stopped within 30 s. Linux and macOS; with the ACP, Codex and Claude Code adapters, Claude Code's on Anthropic's Agent SDK, which the hub has the machine fetch before such a chat starts (a chat whose agent starts without it fails `sdk_unavailable`, [42](features/42-typescript-backend.md#claude-code)). |

## `serve` flags

A flag given on the command line sets its setting ([settings](#settings))
for every machine and locks it in the UI; without it the settings dialog
and file change the value at runtime.

### Network and security

| Flag | Default | Description |
| --- | --- | --- |
| `--listen` | `127.0.0.1:7780` | Address to listen on; on loopback also the same port on the other loopback address (`::1`) when free. Non-loopback needs `--proxy-secret-file` or `--insecure-listen`. |
| `--allowed-origin` | – | Public origin of the reverse proxy, e.g. `https://ide.example.com` (repeatable). Host must be loopback or one of these; Origin must be one of these or, on loopback, the request's own host and port. |
| `--proxy-secret-file` | – | File with a secret (≥ 16 characters) the proxy sends in `X-veldr-Proxy-Secret`; required for requests not from loopback. |
| `--insecure-listen` | `false` | Accept a non-loopback `--listen` without a proxy secret. Anyone reaching the port gets shell access to every machine. |
| `--read-only` | `false` | Watch only: no terminal input, writing terminal core calls, uploads, ssh login or VS Code; no terminal core installed or started; no Kimi Code sign-in renewal. |
| `--audit-log` | – | Append security-relevant events (connections, mutating calls, uploads, VS Code and bridge use, the Agent SDK's installs on machines, denials) as JSON lines. |
| `--user-header` | – | Header holding the authenticated user for the audit log. Default: `Tailscale-User-Login`, `X-Forwarded-User`, `X-Auth-Request-User`, `Remote-User`, `X-Forwarded-Email`. |

### Machines

| Flag | Default | Description |
| --- | --- | --- |
| `--local-only` | `false` | Do not connect the stored SSH machines (`--ssh` targets still are). |
| `--machine` | – | Connect only these machines, by id, label or ssh target (repeatable). |
| `--ssh` | – | Extra ssh target (`~/.ssh/config` alias or `user@host`) for this run, not stored (repeatable). At most 255 bytes, not starting with `-`, without whitespace, control characters or ``! " $ & ' ( ) * ; < > ? \ ` { \| }``; the hub refuses to start otherwise. |
| `--instance` | – | State instance: this hub's files (`settings-<instance>.json` and the rest of the configuration directory) and, unless `--node-instance` says otherwise, `~/.veldr-<instance>` on machines, with its own node, sockets, terminal core session `veldr-<instance>-<host id>` and code-server. |
| `--node-instance` | `--instance` | The namespace on machines: their `~/.veldr[-<instance>]` and terminal core session, shared with every hub of the same namespace; empty (`--node-instance=`) is the default one, which the desktop app uses ([39](features/39-nodes.md)). |

### code-server

| Flag | Default | Description |
| --- | --- | --- |
| `--code-server-version` | `4.144.0` | code-server release for machines; default versions have pinned SHA-256 digests. |
| `--code-server-idle` | `20m` | Stop a machine's code-server after this long without VS Code connections; `0` keeps it while the agent lives. |
| `--code-server-url` | GitHub releases | Download URL template (`{version}`, `{asset}`, `{file}`); point it at a mirror. An `http` or `https` URL without user information, query or fragment: machines get it on their command line (`--code-server-install=download`), so the hub refuses to start with credentials in it; serve a mirror that needs credentials through a `--seed-dir`. |
| `--extension-url` | Open VSX | Extension URL template (`{publisher}`, `{name}`, `{version}`, `{file}`). |
| `--seed-dir` | – | Directory of pre-downloaded tarballs and VSIXs (from `fetch-assets`), and of Anthropic's Agent SDK tarball (`claude-agent-sdk-0.3.322.tgz`, for Claude Code's chats on machines), searched before the cache (repeatable). |
| `--offline` | `false` | Never download; artifacts come from `--seed-dir` or the cache. Machines are not asked to download the Agent SDK either. |
| `--npm-registry` | `https://registry.npmjs.org` | npm registry or mirror from which the hub and the machines download Anthropic's Agent SDK when a Claude Code chat on a machine needs it; the tarball is checked against the pinned integrity whatever its source ([42](features/42-typescript-backend.md#claude-code)). An `http` or `https` URL without user information, query or fragment: machines get it on their command line, so the hub refuses to start with credentials in it; put the tarball of a mirror that needs credentials into a `--seed-dir`. |
| `--code-server-install` | `push` | `push` (the hub uploads), `download` (the machine fetches with curl or wget, same digest; off with `--offline`) or `existing`; the last two fall back to `push`. Setting `codeServer.install`. |
| `--code-server-path` | – | code-server on machines for `existing`; empty searches `PATH`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/snap/bin`. Setting `codeServer.path`. |

code-server settings apply from the next code-server start on each machine.

### Program windows

| Flag | Default | Description |
| --- | --- | --- |
| `--gui` | `true` | Give new panes on remote Linux machines a virtual display whose windows open in browser windows ([14](features/14-gui-windows.md)); Xvfb is fetched in user space when missing. Setting `gui.enabled`. |
| `--gui-display` | `auto` | `auto` (Xwayland drawing with the GPU where the machine allows, else Xvfb) or `xvfb`. Setting `gui.display`. |
| `--gui-gpu` | `vglrun` | VirtualGL: `vglrun` (programs started with `vglrun`) or `all` (every program in new panes, except on a GPU display). Setting `gui.gpu`. |
| `--gui-gpu-pick` | `false` | On machines with several NVIDIA GPUs, preload gpupick so `CUDA_VISIBLE_DEVICES` also selects the GPU a Vulkan window shows from. Setting `gui.gpuPick`. |
| `--gui-video` | `true` | Send changing windows as video (H.264 on NVIDIA, Intel or AMD GPUs, else VP8) to browsers with WebCodecs; pictures otherwise or in builds without the encoder. Setting `gui.video`. |

Boolean flags of settings also accept `on` and `off`. GUI settings apply to panes
created afterwards, video from the next frame; `gui.*` can be set per
remote machine.

### Terminal history

| Flag | Default | Description |
| --- | --- | --- |
| `--history-capture` | `false` | Keep snapshots of terminals' output on each machine's disk, shown after its terminal core starts again ([36](features/36-terminal-history.md)); the output can hold secrets. Setting `history.capture`, also per machine. |

### Development

| Flag | Default | Description |
| --- | --- | --- |
| `--agent-dir` | – | Directory of machine builds, the hub's first source of them: the release's `SHA256SUMS` with the archives (`veldr-<os>-<arch>[-musl].tar.gz`) or the executables in them (`veldr-<os>-<arch>[-musl]`), each checked against that `SHA256SUMS`, which must name the hub's own executable (offline sites, [deployment](deployment.md#air-gapped-networks)). |
| `--ext-dir` | – | Directory containing `veldr-bridge.vsix`, used instead of the embedded one. |
| `--web-dir` | – | Serve the UI from this directory instead of the embedded build. |
| `--parent-stdio` | `false` | Launcher lifecycle (the end-to-end tests): write `{"event":"ready","url":"…"}` to stdout after binding, clean up when stdin closes (what stdin carries is not read). Does not change HTTP guards; every client is a browser. |

## `fetch-assets` flags

`--platforms` (default `linux-amd64,linux-arm64,macos-amd64,macos-arm64`)
selects the code-server builds; `--code-server-version`, `--code-server-url`,
`--extension-url`, `--seed-dir` and `--offline` behave as above.

## Settings

Every setting is defined in the hub (`backend/kernel/config` and the
features' `settings`) and shown in the settings dialog
([13](features/13-settings-and-appearance.md)). Values live in
`settings[-<instance>].json` on the hub host, which can be edited by hand
(reread within two seconds). A setting with a scope can have a value per
machine under `"[machine:<id>]"`. The table is generated by
`backend/scripts/registry.ts` (`make tokens`; `make check` fails when
it is stale).

<!-- make tokens: settings -->

| Setting | Values | Default | Flag | Scope |
| --- | --- | --- | --- | --- |
| `appearance.theme` | `system`, `light`, `dark` | `"system"` | – | – |
| `appearance.colorTheme` | `blue`, `vscode`, `teal`, `violet`, `rose`, `amber`, `graphite` | `"blue"` | – | – |
| `appearance.language` | `auto`, `en`, `zh-CN` | `"auto"` | – | – |
| `appearance.uiFontSize` | integer, 11–20 | `13` | – | – |
| `window.zoom` | integer, 50–300 | `100` | – | – |
| `layout.undoClose` | integer, 3–120 | `5` | – | – |
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
| `terminal.sshEnv` | `true`, `false` | `true` | – | per remote machine |
| `terminal.copyOnSelect` | `true`, `false` | `false` | – | – |
| `terminal.programClipboard` | `auto`, `ask`, `off` | `"auto"` | – | – |
| `terminal.colorScheme.dark` | `default`, `dracula`, `gruvbox-dark`, `gruvbox-light`, `nord`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `tomorrow`, `tomorrow-night` | `"default"` | – | – |
| `terminal.colorScheme.light` | `default`, `dracula`, `gruvbox-dark`, `gruvbox-light`, `nord`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `tomorrow`, `tomorrow-night` | `"default"` | – | – |
| `terminal.boldIsBright` | `true`, `false` | `false` | – | – |
| `terminal.colors.dark.foreground` | color `#rrggbb` | `"#f0f0f0"` | – | – |
| `terminal.colors.dark.background` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.dark.cursor` | color `#rrggbb` | `"#f0f0f0"` | – | – |
| `terminal.colors.dark.selection` | color `#rrggbb` | `"#3b4a6b"` | – | – |
| `terminal.colors.dark.palette` | 16 colors | 16 colors of `spec/tokens.json` | – | – |
| `terminal.colors.light.foreground` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.light.background` | color `#rrggbb` | `"#ffffff"` | – | – |
| `terminal.colors.light.cursor` | color `#rrggbb` | `"#0a0a0a"` | – | – |
| `terminal.colors.light.selection` | color `#rrggbb` | `"#b6d4fe"` | – | – |
| `terminal.colors.light.palette` | 16 colors | 16 colors of `spec/tokens.json` | – | – |
| `notifications.sound` | `true`, `false` | `true` | – | – |
| `notifications.system` | `true`, `false` | `true` | – | – |
| `notifications.badge` | `true`, `false` | `true` | – | – |
| `notifications.mutedAgents` | list of strings | `["droid"]` | – | – |
| `codeServer.install` | `push`, `download`, `existing` | `"push"` | `--code-server-install` | per machine |
| `codeServer.path` | string | `""` | `--code-server-path` | per machine |
| `plugins.vscode.enabled` | `true`, `false` | `false` | – | – |
| `browser.openLinks` | `loopback`, `all`, `external` | `"loopback"` | – | – |
| `plugins.vscode.browser` | `true`, `false` | `false` | – | – |
| `plugins.browser.enabled` | `true`, `false` | `true` | – | – |
| `browser.forwardIdle` | integer, 0–1440 | `30` | – | – |
| `plugins.files.enabled` | `true`, `false` | `true` | – | – |
| `plugins.search.enabled` | `true`, `false` | `true` | – | – |
| `plugins.git.enabled` | `true`, `false` | `true` | – | – |
| `plugins.monitor.enabled` | `true`, `false` | `true` | – | – |
| `plugins.usage.enabled` | `true`, `false` | `true` | – | – |
| `plugins.vault.enabled` | `true`, `false` | `true` | – | – |
| `plugins.agents.enabled` | `true`, `false` | `true` | – | – |
| `plugins.chat.enabled` | `true`, `false` | `true` | – | – |
| `plugins.history.enabled` | `true`, `false` | `true` | – | – |
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
| `monitor.refreshSeconds` | integer, 1–30 | `2` | – | – |
| `usage.refresh` | `manual`, `1`, `2`, `5`, `15`, `30`, `60`, `adaptive` | `"adaptive"` | – | – |
| `usage.refreshOpen` | integer, 1–60 | `5` | – | – |
| `usage.refreshWorking` | integer, 1–120 | `10` | – | – |
| `usage.refreshIdle` | integer, 5–240 | `30` | – | – |
| `usage.costRefresh` | integer, 1–1440 | `15` | – | – |
| `usage.statusBar` | `true`, `false` | `true` | – | – |
| `usage.alerts` | `true`, `false` | `true` | – | – |
| `monitor.statusBar` | `true`, `false` | `true` | – | – |
| `usage.thresholds` | list of strings | `["80","95"]` | – | – |
| `usage.prices` | list of strings | `[]` | – | – |
| `monitor.confirmKill` | `true`, `false` | `true` | – | – |
| `usage.providers.claude` | `true`, `false` | `true` | – | – |
| `usage.claudeKeychain` | `true`, `false` | `true` | – | – |
| `usage.providers.codex` | `true`, `false` | `true` | – | – |
| `usage.codexHomes` | list of strings | `[]` | – | – |
| `usage.providers.grok` | `true`, `false` | `true` | – | – |
| `usage.providers.antigravity` | `true`, `false` | `true` | – | – |
| `usage.providers.kimi` | `true`, `false` | `true` | – | – |
| `usage.kimiRefresh` | `true`, `false` | `true` | – | – |
| `usage.providers.deepseek` | `true`, `false` | `true` | – | – |
| `usage.providers.opencode` | `true`, `false` | `true` | – | – |
| `vault.approvalTimeout` | integer, 10–600 | `60` | – | – |
| `vault.autoLock` | integer, 0–1440 | `60` | – | – |
| `vault.passphraseDays` | integer, 1–90 | `14` | – | – |
| `vault.sessionIdle` | integer, 1–240 | `30` | – | – |
| `vault.sessionMax` | integer, 1–24 | `12` | – | – |
| `vault.runTimeout` | integer, 5–3600 | `120` | – | – |
| `vault.runMaxTimeout` | integer, 5–3600 | `600` | – | – |
| `vault.runOutput` | integer, 4–1024 | `64` | – | – |
| `gui.enabled` | `true`, `false` | `true` | `--gui` | per remote machine |
| `gui.display` | `auto`, `xvfb` | `"auto"` | `--gui-display` | per remote machine |
| `gui.gpu` | `vglrun`, `all` | `"vglrun"` | `--gui-gpu` | per remote machine |
| `gui.gpuPick` | `true`, `false` | `false` | `--gui-gpu-pick` | per remote machine |
| `gui.video` | `true`, `false` | `true` | `--gui-video` | per remote machine |
| `history.capture` | `true`, `false` | `false` | `--history-capture` | per machine |
| `history.interval` | integer, 10–600 | `30` | – | per machine |
| `history.lines` | integer, 100–10000 | `2000` | – | per machine |
| `history.maxTerminals` | integer, 1–128 | `32` | – | per machine |
| `history.maxTotalMB` | integer, 1–512 | `64` | – | per machine |
| `history.days` | integer, 1–30 | `7` | – | per machine |
| `chat.permissionMode` | `default`, `acceptEdits`, `plan`, `full` | `"default"` | – | per machine |
| `chat.allowFullAccess` | `true`, `false` | `false` | – | per machine |
| `chat.idleStopMinutes` | integer, 5–1440 | `30` | – | per machine |
| `chat.maxLive` | integer, 1–32 | `8` | – | per machine |
| `chat.maxChats` | integer, 50–2000 | `500` | – | per machine |
| `chat.retentionDays` | integer, 1–365 | `30` | – | per machine |
| `chat.maxTotalMB` | integer, 64–2048 | `512` | – | per machine |
| `chat.maxChatMB` | integer, 8–256 | `64` | – | per machine |
| `performance.keptTerminals` | integer, 0–64 | `12` | – | – |
| `machines.download` | `true`, `false` | `true` | `--machine-download` | per machine |

<!-- end of make tokens: settings -->

```json
{
  "appearance.theme": "dark",
  "terminal.fontSize": 14,
  "terminal.colors.dark.palette": ["#484f58", "#ff7b72", "…14 more"],
  "[machine:gpu-box]": { "gui.video": false }
}
```

VS Code has two switches, both off by default
([05](features/05-vscode-panes.md)): `plugins.vscode.enabled` for the
desktop app and `plugins.vscode.browser` for browsers. VS Code runs on the
UI's origin, so its extensions can do whatever the page can; setting
`plugins.vscode.browser` (in the UI's dialog or by hand) accepts that risk.

## Keyboard shortcuts

Keys come from `backend/kernel/config/keybindings` and can be changed in **Settings →
Keyboard Shortcuts** or in `keybindings[-<instance>].json` on the hub host
([04](features/04-layout-and-keyboard.md)):

- A rule is `{"key", "command", "when"}`; `"command": "-<id>"` removes a
  key; `when` is `terminal` (the main window, terminals and VS Code panes
  included), `editor` (the main window except while a terminal has the
  keyboard), `vscode`, `dialog` or `always`.
- A key is modifiers (`cmd`, `ctrl`, `alt`, `shift`) and a key joined by
  `+`; a chord is strokes separated by spaces (`ctrl+k c`, the second within
  3 s). The first stroke needs `cmd`, `ctrl` or `alt`, or is a function
  key. A stroke that starts a bound chord waits for the next one; pressed
  twice it reaches the terminal. Keys follow the keyboard layout's
  characters.
- Platforms: `mac`, `windows`, `linux` (the desktop app) and
  `mac-browser`, `windows-browser`, `linux-browser`. Browsers keep `cmd+t`,
  `cmd+w` and the like for themselves; in browsers on Windows and Linux the
  status bar's **Command Palette…** opens the palette.
- `ctrl+b` (`pane.leave`, `editor`) moves focus between the active editor
  and its pane header; in a terminal it is the program's (tmux), unless a
  rule binds it there (`"when": "terminal"`). No other default is a chord, `ctrl`/`alt` with a letter alone or a
  function key, so every key not in the table reaches the terminal.
- A command without a key (–) runs from menus, buttons and the command
  palette. The desktop app's menu shows the keys; on Windows and Linux it
  takes none, so Ctrl keys reach terminals.
- While a VS Code pane has the keyboard, VS Code's keys come first, except
  `pane.close`.
- `app.fullDiskAccess` exists only in the desktop app on macOS.

The table is generated by `backend/scripts/registry.ts`.

<!-- make tokens: commands -->

| Command | When | `mac` | `mac-browser` | `windows` | `windows-browser` | `linux` | `linux-browser` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `app.commandPalette` | `terminal` | `cmd+shift+p` | `cmd+k` | `ctrl+shift+p` | – | `ctrl+shift+p` | – |
| `app.keyboardShortcuts` | `terminal` | `cmd+slash` | `cmd+slash` | `ctrl+shift+slash` | `ctrl+shift+slash` | `ctrl+shift+slash` | `ctrl+shift+slash` |
| `app.settings` | `terminal` | `cmd+comma` | – | `ctrl+comma` | – | `ctrl+comma` | – |
| `app.agentAttention` | `terminal` | `cmd+shift+a` | – | `ctrl+shift+a` | – | `ctrl+shift+a` | – |
| `app.addMachine` | `terminal` | – | – | – | – | – | – |
| `app.fullDiskAccess` | `terminal` | – | – | – | – | – | – |
| `workspace.switch` | `terminal` | `cmd+p` | – | `ctrl+shift+k` | – | `ctrl+shift+k` | – |
| `workspace.next` | `terminal` | `cmd+ctrl+down` | – | `ctrl+shift+pagedown` | – | `ctrl+alt+down` | – |
| `workspace.previous` | `terminal` | `cmd+ctrl+up` | – | `ctrl+shift+pageup` | – | `ctrl+alt+up` | – |
| `workspace.new` | `terminal` | `cmd+n` | – | `ctrl+shift+n` | – | `ctrl+shift+n` | – |
| `workspace.edit` | `terminal` | – | – | – | – | – | – |
| `workspace.mute` | `terminal` | – | – | – | – | – | – |
| `workspace.unmute` | `terminal` | – | – | – | – | – | – |
| `workspace.close` | `terminal` | – | – | – | – | – | – |
| `workspace.closeOthers` | `terminal` | – | – | – | – | – | – |
| `tab.new` | `terminal` | `cmd+t` | – | `ctrl+shift+t` | – | `ctrl+shift+t` | – |
| `tab.rename` | `terminal` | – | – | – | – | – | – |
| `tab.next` | `terminal` | `cmd+shift+bracketright`, `ctrl+tab` | – | `ctrl+tab` | – | `ctrl+tab`, `ctrl+pagedown` | – |
| `tab.previous` | `terminal` | `cmd+shift+bracketleft`, `ctrl+shift+tab` | – | `ctrl+shift+tab` | – | `ctrl+shift+tab`, `ctrl+pageup` | – |
| `tab.select1` | `terminal` | `cmd+1` | – | `alt+1` | – | `alt+1` | – |
| `tab.select2` | `terminal` | `cmd+2` | – | `alt+2` | – | `alt+2` | – |
| `tab.select3` | `terminal` | `cmd+3` | – | `alt+3` | – | `alt+3` | – |
| `tab.select4` | `terminal` | `cmd+4` | – | `alt+4` | – | `alt+4` | – |
| `tab.select5` | `terminal` | `cmd+5` | – | `alt+5` | – | `alt+5` | – |
| `tab.select6` | `terminal` | `cmd+6` | – | `alt+6` | – | `alt+6` | – |
| `tab.select7` | `terminal` | `cmd+7` | – | `alt+7` | – | `alt+7` | – |
| `tab.select8` | `terminal` | `cmd+8` | – | `alt+8` | – | `alt+8` | – |
| `tab.select9` | `terminal` | `cmd+9` | – | `alt+9` | – | `alt+9` | – |
| `tab.close` | `terminal` | `cmd+shift+w` | – | `ctrl+shift+w` | – | `ctrl+shift+w` | – |
| `tab.closeOthers` | `terminal` | – | – | – | – | – | – |
| `tab.closeRight` | `terminal` | – | – | – | – | – | – |
| `tab.pin` | `terminal` | – | – | – | – | – | – |
| `tab.unpin` | `terminal` | – | – | – | – | – | – |
| `tab.mute` | `terminal` | – | – | – | – | – | – |
| `tab.unmute` | `terminal` | – | – | – | – | – | – |
| `browser.open` | `terminal` | – | – | – | – | – | – |
| `browser.reload` | `terminal` | – | – | – | – | – | – |
| `chat.new` | `terminal` | – | – | – | – | – | – |
| `pane.splitRight` | `terminal` | `cmd+d` | – | `alt+shift+equal` | – | `ctrl+shift+d` | – |
| `pane.splitDown` | `terminal` | `cmd+shift+d` | – | `alt+shift+minus` | – | `ctrl+shift+o` | – |
| `pane.close` | `terminal` | `cmd+w` | – | – | – | – | – |
| `pane.zoom` | `terminal` | `cmd+shift+enter` | – | `ctrl+shift+enter` | – | `ctrl+shift+enter` | – |
| `pane.leave` | `editor` | `ctrl+b` | `ctrl+b` | `ctrl+b` | `ctrl+b` | `ctrl+b` | `ctrl+b` |
| `pane.rename` | `terminal` | – | – | – | – | – | – |
| `pane.actions` | `terminal` | – | – | – | – | – | – |
| `pane.focusLeft` | `terminal` | `cmd+alt+left` | – | `alt+shift+left` | – | `alt+shift+left` | – |
| `pane.focusDown` | `terminal` | `cmd+alt+down` | – | `alt+shift+down` | – | `alt+shift+down` | – |
| `pane.focusUp` | `terminal` | `cmd+alt+up` | – | `alt+shift+up` | – | `alt+shift+up` | – |
| `pane.focusRight` | `terminal` | `cmd+alt+right` | – | `alt+shift+right` | – | `alt+shift+right` | – |
| `pane.focusNext` | `terminal` | – | – | – | – | – | – |
| `pane.focusPrevious` | `terminal` | – | – | – | – | – | – |
| `pane.back` | `terminal` | `cmd+bracketleft` | – | `alt+left` | – | `alt+left` | – |
| `pane.forward` | `terminal` | `cmd+bracketright` | – | `alt+right` | – | `alt+right` | – |
| `pane.undoClose` | `terminal` | `cmd+z` | – | `ctrl+shift+z` | – | `ctrl+shift+z` | – |
| `view.toggleSidebar` | `terminal` | `cmd+b` | – | `ctrl+shift+b` | – | `ctrl+shift+b` | – |
| `view.togglePanel` | `terminal` | `cmd+alt+b` | – | `alt+shift+b` | – | `alt+shift+b` | – |
| `view.panel.files` | `terminal` | `cmd+shift+e` | – | `ctrl+shift+e` | – | `ctrl+shift+e` | – |
| `view.zoomIn` | `always` | `cmd+shift+equal`, `cmd+equal` | – | `ctrl+shift+equal`, `ctrl+equal` | – | `ctrl+shift+equal`, `ctrl+equal` | – |
| `view.zoomOut` | `always` | `cmd+minus` | – | `ctrl+minus` | – | `ctrl+minus` | – |
| `view.zoomReset` | `always` | `cmd+0` | – | `ctrl+0` | – | `ctrl+0` | – |
| `view.panel.vault` | `terminal` | – | – | – | – | – | – |
| `view.panel.usage` | `terminal` | – | – | – | – | – | – |
| `view.panel.git` | `terminal` | `ctrl+shift+g` | – | `ctrl+shift+g` | – | `ctrl+shift+g` | – |
| `view.panel.monitor` | `terminal` | – | – | – | – | – | – |
| `view.panel.search` | `terminal` | `cmd+shift+f` | – | – | – | – | – |
| `find.open` | `terminal` | `cmd+f` | `cmd+f` | `ctrl+shift+f` | `ctrl+shift+f` | `ctrl+shift+f` | `ctrl+shift+f` |
| `find.next` | `terminal` | `cmd+g` | – | – | – | – | – |
| `find.previous` | `terminal` | `cmd+shift+g` | – | – | – | – | – |
| `code.open` | `terminal` | `cmd+j` | – | `ctrl+shift+j` | – | `ctrl+shift+j` | – |
| `code.diff` | `terminal` | – | – | – | – | – | – |
| `code.gitGraph` | `terminal` | – | – | – | – | – | – |
| `git.graph` | `terminal` | – | – | – | – | – | – |

<!-- end of make tokens: commands -->

In terminals ([26](features/26-web-terminals.md)):

- Keys are encoded for the program's mode (legacy, application cursor and
  keypad, kitty keyboard protocol); the bytes are in
  [`vt-keys.json`](../web/src/__tests__/testdata/vt-keys.json).
  Shift+Enter is `CSI 13;2u` under the kitty protocol; Alt+Enter is
  `ESC CR`.
- Drag selects (double click a word, triple click a line; Shift-drag where
  the program takes the mouse); `terminal.copyOnSelect` copies on release.
  The wheel scrolls the scrollback (arrow keys on the alternate screen).
- ⌘/Ctrl-click opens paths (media in a preview pane, code in VS Code) and
  URLs.
- `find.open` searches the terminal and its scrollback (ASCII
  case-insensitive): Enter older, Shift+Enter newer, Escape closes.
- Pasting or dropping files uploads them to the terminal's machine and
  pastes their paths (dropped files go to the terminal's directory); the
  right-click menu downloads paths and chosen files (folders as zips). The
  downloads panel is in the status bar.

With the mouse: double-click a pane title, tab or workspace to rename it;
drag a pane by its header onto another pane (swap or split), a tab or `+`;
drag tabs, workspaces and machines to reorder; Escape cancels. Right-click
a pane header, tab, workspace or machine for its commands.

## HTTP and WebSocket endpoints

Every endpoint passes the same guards (Host, Origin, proxy secret,
[SECURITY.md](../SECURITY.md)); those marked *writes* are refused with
`--read-only`. Messages are in [architecture](architecture.md); `{id}` is a
machine's id. `make check` fails when a route of the hub is missing here
(`backend/scripts/reference.ts`).

### Hub

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /ws` | – | Event channel (WebSocket): machines, agents, settings, keybindings, program windows, downloads. |
| `GET /api/v1/term` | – | Terminal protocol (WebSocket) ([22](features/22-terminal-protocol.md)). |
| `GET /api/config` | – | Name, slug, version, `read_only`, `ssh_login` (false on Windows), `client` (`desktop` with the app's launch token cookie, else `browser`). |
| `GET /api/settings` | – | Setting definitions, values (per machine too), problems, and `client`. |
| `PUT /api/settings` | writes | Sets one value (`{"key", "value", "machine"?}`). |
| `DELETE /api/settings` | writes | Removes one value. |
| `GET /api/keybindings` | – | Commands, default keys per platform, user rules, bindings in effect, conflicts. |
| `PUT /api/keybindings` | writes | Replaces the user's rules. |
| `GET /api/perf` | – | The hub process's own use: `{"cpu_ms", "memory", "goroutines" (the event loop's active resources), "uptime_ms", "cpus"}` ([13](features/13-settings-and-appearance.md)). |
| `/` | – | The web UI (`/licenses.md`: its bundle's notices); other paths get the app shell, except unknown `/api/…` paths (404). |

### Machines

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /api/machines` | – | Every machine's state, agent info and terminal core state; never-connected machines carry `code` `invalid_target` or `local_unsupported`, machines whose build could not be deployed `failure` (`platform_unsupported`, `cpu_unsupported`, `libs_missing`, `build_unavailable`) with `error`. |
| `POST /api/machines` | writes | Adds and stores an SSH machine (`{"target", "label"}`). |
| `PUT /api/machines/order` | writes | Stores the machines' order (`{"order": [ids]}`, each once). |
| `GET /api/ssh/hosts` | writes | Host aliases of the hub host's ssh configuration not yet machines (`[{"alias", "hostname"?, "user"?}]`) ([02](features/02-multi-machine-transport.md)). |
| `DELETE /api/m/{id}` | writes | Removes a stored machine. |
| `PUT /api/m/{id}/label` | writes | Renames a machine. |
| `PUT /api/m/{id}/enabled` | writes | Enables or disables a machine. |
| `GET /api/m/{id}/auth` | writes | Interactive ssh login (WebSocket, `?cols=&rows=`); `501 ssh_login_unsupported` on Windows. |
| `GET /api/m/{id}/hc` | – | Terminal core: installed, running, version. |
| `POST /api/m/{id}/hc/{action}` | writes | `start`, `stop` or `restart` the terminal core. |
| `GET /api/m/{id}/privacy` | – | macOS Full Disk Access of the agent (`files`) and the terminal core (`terminals`): `granted`, `denied` or `unknown`; `hc` is the terminal core's executable. Starts no terminal core. |

### Files

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /api/m/{id}/file` | – | A file (`?path=`, `&download=1` as attachment) with HTTP ranges; `404` missing, `403` denied, `502` machine error. |
| `GET /api/m/{id}/list` | – | A directory's entries (`?path=`), at most 20 000. |
| `GET /api/m/{id}/download` | – | One file, or several paths as a zip (`?path=`…, `&dl=<id>` to follow on `/ws`). |
| `POST /api/m/{id}/upload` | writes | Writes the body to a file (`?name=`, `&dir=` absolute, else the upload directory). |

### VS Code and program windows

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /api/m/{id}/code/status` | – | Whether code-server is installed and runs. The VS Code routes answer `404 plugin_disabled` while VS Code is off for the client kind. |
| `POST /api/m/{id}/code/start` | writes | Installs and starts code-server. |
| `POST /api/m/{id}/code/stop` | – | Releases code-server (allowed read-only). |
| `/m/{id}/code/` | writes | code-server behind the hub's proxy (`/m/{id}/code` redirects here). |
| `POST /api/m/{id}/bridge` | writes | A command for a VS Code window (open, diff, Git Graph); the reply names the window that took it ([05](features/05-vscode-panes.md)). |
| `GET /api/gui` | – | Program windows of every machine. |
| `POST /api/m/{id}/gui/enable` | writes | Gives open terminals the display (`{"terminals": [...]}`, empty for all). |
| `GET /m/{id}/gui/{win}` | – | A program window's page. |
| `GET /m/{id}/gui/{win}/ws` | – | A window's frames, events and input (WebSocket; `?video=` the streams the browser decodes). |
| `POST /m/{id}/gui/{win}/close` | writes | Asks a window to close. |

### Plugins

Plugin routes answer `404 plugin_disabled` while their plugin is off;
changes are audited as `<plugin>.<action>` with their outcome
([27](features/27-plugins.md)). Errors are `{error, message}` codes.

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `POST /api/m/{id}/p/files/stat` | – | State of 1–200 paths (`{"paths"}`) for the explorer's poll; a POST only for size ([28](features/28-file-explorer.md)). |
| `POST /api/m/{id}/p/files/{action}` | writes | `mkdir` (`"unique"`), `mkdirs`, `create`, `rename`, `move`, `copy`, `trash`, `remove`; never replaces existing names. |
| `POST /api/m/{id}/p/files/write` | writes | Saves the body (≤ 8 MiB) to `?path=` if it still has `&mtime=&size=` (`&new=1`, `&force=1`); else `409 conflict`. |
| `POST /api/m/{id}/p/files/upload` | writes | Writes the body (≤ 4 GiB) to `?path=` under a free name, or over it with `&replace=1`. |
| `GET /api/m/{id}/p/files/reveal` | – | `{"available"}`: whether Reveal in Finder is offered (the hub's own machine, a client on the hub host). |
| `POST /api/m/{id}/p/files/reveal` | writes | Shows `{"path"}` in the hub host's file manager. |
| `GET /api/m/{id}/p/git/{read}` | – | Git reads ([31](features/31-git.md)): `repo`, `status`, `log`, `show`, `blob`, `branches`, `tags`, `stashes`, `diffStat`, `watch`. |
| `POST /api/m/{id}/p/git/{change}` | writes | Git changes (JSON ≤ 5 MiB): `stage`, `unstage`, `applyPatch`, `discard`, `commit`, `checkout`, `branchCreate`, `branchDelete`, `branchRename`, `merge`, `rebase`, `abort`, `continue`, `cherryPick`, `revert`, `reset`, `tagCreate`, `tagDelete`, `stashPush`, `stashApply`, `stashPop`, `stashDrop`, `fetch`, `pull`, `push`. |
| `GET /api/p/browser/forwards` | – | Port forwards and whether this client can use them ([32](features/32-browser-and-ports.md)). |
| `POST /api/m/{id}/p/browser/forwards` | writes | Makes or reuses the forward of `{"port"}`; hub-host clients only, at most 32. |
| `DELETE /api/m/{id}/p/browser/forwards/{port}` | writes | Stops a forward and its connections. |
| `GET /api/m/{id}/p/browser/listening` | – | TCP ports the user's programs listen on. |
| `GET /api/m/{id}/p/monitor/metrics` | – | Live CPU, memory, GPU, network and disk figures ([34](features/34-system-monitor.md)). |
| `GET /api/m/{id}/p/monitor/processes` | – | The machine's process table. |
| `POST /api/m/{id}/p/monitor/signal` | writes | Sends an allowlisted signal (`{"pid", "signal"}`, default `TERM`); `pid` > 1. |
| `POST /api/m/{id}/p/search/search` | – | Project Search: the files below `dir` whose contents match `query` (`regex`, `caseSensitive`, `wholeWord`, `include` and `exclude` comma-separated globs, `maxResults` up to 5000, 2000 by default; JSON of at most 16 KiB; reads only, allowed in read-only mode); answers `engine` (`rg` or `builtin`), `dir`, `files` (`path` relative to `dir`, `matches` with `line`, `col`, `preview`, `ranges`), `matchCount`, `truncated` and `reason` (`max_results`, `timeout`, `max_files`); failures `bad_regex`, `bad_glob`, `not_found`, `not_dir`, `denied`, `busy`, and 504 `timeout` after 45 s ([41](features/41-project-search.md)). |
| `GET /api/p/usage` | – | AI usage snapshot (accounts, windows, pace, status pages, alerts); `?watch=1` marks a panel open; `ETag` ([29](features/29-ai-usage.md)). |
| `GET /api/p/usage/cost` | – | Log cost at API prices by day, provider, model, project and machine (`?days=` 1–90, `&tz=`), and each machine's quarters of an hour with spend since `recentSince` (8 days back) by provider; `ETag`. |
| `POST /api/p/usage/refresh` | writes | Polls every machine now, at most every 30 s (`202 {queued, at}`). |
| `PUT /api/m/{id}/p/usage/deepseek-key` | writes | Writes the machine's DeepSeek key (`{"key"}`, `""` removes); never read back. |
| `GET /api/m/{id}/p/usage/session` | – | One agent session's use at API prices (`?kind=claude\|codex&session=`). |
| `GET /api/m/{id}/p/agents/resolve` | – | Whether a session's transcript exists and ran in a directory (`?kind=&session=&cwd=`): `{ok}` or `{ok: false, code}` ([33](features/33-workspace-restore.md)). |
| `GET /api/m/{id}/p/history` | – | The machine's terminal output snapshots and whether herdr-core restores screens itself ([36](features/36-terminal-history.md)). |
| `GET /api/m/{id}/p/history/read` | – | One generation's bytes (`?terminal=&generation=current\|previous`), ≤ 2 MiB, as a sandboxed attachment. |
| `DELETE /api/m/{id}/p/history` | writes | Removes one terminal's (`?terminal=`) or all snapshots. |
| `POST /api/m/{id}/p/history/adopt` | writes | Gives terminal `?to=` the newest snapshot of `&from=` (which it replaced) as its previous one, and removes `from`'s. |

### Agent chats

The chat plugin ([37](features/37-agent-chats.md)). GETs never start a
machine's chat host and answer `409 not_running` without one; changes start
it, except on a read-only hub, which refuses them.

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /api/m/{id}/p/chat/agents` | – | Agent kinds the chat host can start, with version or reason (`not_found`, `unsupported`). |
| `POST /api/m/{id}/p/chat/agents` | writes | The same, starting the host. |
| `GET /api/m/{id}/p/chat/chats` | – | The machine's chats, latest first. |
| `POST /api/m/{id}/p/chat/sessions` | writes | A page of an agent's sessions for a directory (`?kind=&cwd=&cursor=`); a change because listing may run the agent. |
| `POST /api/m/{id}/p/chat/new` | writes | A new chat (`{kind, cwd, resume?, import?, options?: {model?, effort?, mode?}}`). |
| `POST /api/m/{id}/p/chat/close` | writes | Ends a chat's agent, keeping the chat (`?chat=`). |
| `DELETE /api/m/{id}/p/chat/chat` | writes | Forgets a chat and its log; the agent's own session stays. |
| `POST /api/m/{id}/p/chat/archive` | writes | Ends the agent and keeps the chat archived. |
| `POST /api/m/{id}/p/chat/unarchive` | writes | Takes an archived chat back. |
| `POST /api/m/{id}/p/chat/seen` | writes | Marks a chat seen up to `&seq=`. |
| `POST /api/m/{id}/p/chat/handoff` | writes | Ends the agent so its session continues in a terminal; `409 busy` during a turn. |
| `POST /api/m/{id}/p/chat/trust` | writes | Trusts a directory and those below (`?cwd=`); unsafe folders get `403 unsafe_folder`. |
| `POST /api/m/{id}/p/chat/untrust` | writes | Takes back the trust covering a directory. |
| `GET /api/m/{id}/p/chat/trusted` | – | Trusted folders (`{trusted: [{cwd, at}]}`). |
| `POST /api/m/{id}/p/chat/trusted` | writes | The same, starting the host. |
| `POST /api/m/{id}/p/chat/host/stop` | writes | Stops the chat host; `409 busy` while a chat works. |
| `GET /api/p/chat/hosts` | – | Every machine's chat host and its active sessions, starting none. |
| `GET /api/p/chat/states` | – | Every machine's chat states as last read, with revisions continued on `/ws`. |
| `GET /api/p/chat/ws` | – | The chat WebSocket, one per page ([architecture](architecture.md#chats-backendsharedprotochatproto-backendfeatureschat)): subscriptions (≤ 32, 16 per machine) and commands; read-only hubs refuse commands. |

### Variable vault

Semantics (sessions, proofs, unlock entries, approvals, exemptions) are in
[30](features/30-variable-vault.md). *Gated* routes answer `401
vault_session` without an open `X-Vault-Session`; *passphrase* means a
session opened with the passphrase, not a proof or unlock. Values leave
only through `reveal` and `export`, each recorded in the access log first.

| Endpoint | Writes | Purpose |
| --- | --- | --- |
| `GET /api/p/vault` | – | Status, variables (never values), session, authenticators, guard rule, exemptions, idle and auto-lock times, unlock ways; `503` with `unavailable`, `version`, `invalid` or `failed` when the store does not open. |
| `PUT /api/p/vault/vars/{name}` | writes, gated | Creates, changes or renames (`to`) a variable. Names `^[A-Za-z_][A-Za-z0-9_]*$` (≤ 128), values ≤ 64 KiB. Widening access needs a proof or the passphrase under the verify-every-Allow rule. |
| `DELETE /api/p/vault/vars/{name}` | writes, gated | Removes a variable. |
| `POST /api/p/vault/vars/{name}/reveal` | writes, gated | Returns the value; logged as `revealed` before it is sent. |
| `POST /api/p/vault/export` | writes, passphrase | An encrypted export file (Argon2id, AES-256-GCM) of the named variables; file passphrase ≥ 12 characters; ≤ 16 MiB. |
| `POST /api/p/vault/import/preview` | writes, passphrase | What an export file holds and how its machines map here, never values. |
| `POST /api/p/vault/import` | writes, passphrase | Imports chosen variables (`import`, `overwrite`, `rename`, `skip`) in one write; any refusal changes nothing. |
| `POST /api/p/vault/session` | writes | Opens a session with `{"passphrase"}`, an authenticator's `{"proof"}` while unlocked, or `{"unlock"}` (an authenticator's unlock entry within `vault.passphraseDays`) while locked. Failures back off up to 5 min (`429 wait`). |
| `DELETE /api/p/vault/session` | writes | Ends the request's session. |
| `POST /api/p/vault/passphrase` | writes | Sets (≥ 8 characters) or changes the passphrase, resealing every value; ends other sessions. |
| `POST /api/p/vault/lock` | writes | Locks, forgetting the key and ending every session; `{"forget": true}` also ends the passphrase's window. |
| `POST /api/p/vault/proof` | writes | Issues a one-time nonce (120 s) for a WebAuthn or desktop proof: `session`, `answer`, `reveal`, `change`, `register`. |
| `GET /api/p/vault/proof/{nonce}` | – | What a nonce is for; answered only to the desktop app, for its system prompt. |
| `POST /api/p/vault/authenticators` | writes, passphrase | Adds a WebAuthn credential (bound to the request's origin, with PRF) or the desktop authenticator, with its unlock entry. |
| `DELETE /api/p/vault/authenticators/{id}` | writes, passphrase | Removes an authenticator and its unlock entries. |
| `POST /api/p/vault/guard` | writes, passphrase | Sets the rule that every Allow needs a proof or the passphrase; ending it needs the passphrase. |
| `POST /api/p/vault/exempt` | writes, passphrase | Exempts an app (a process name; shells and interpreters refused) on named machines; needs the passphrase; at most 64. |
| `DELETE /api/p/vault/exempt/{id}` | writes, passphrase | Ends an exemption. |
| `GET /api/p/vault/requests` | – | MCP requests waiting for an answer. |
| `POST /api/p/vault/requests/{id}` | writes, gated (but `deny`) | Answers `once`, `always` or `deny`; allowing needs a session, a proof or the passphrase (only the last two under the verify-every-Allow rule). First answer wins. |
| `GET /api/p/vault/log` | gated | The access log, newest first: who asked (machine, tool, client, process chain), names and the result; never values. |

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `VELDR_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `VELDR_HUB` | `pnpm -C web dev` | Hub URL the Vite dev server proxies to (default `http://127.0.0.1:7780`; `make dev-web` sets `DEV_LISTEN`'s). |
| `VELDR_DESKTOP_DEV` | Electron | Isolated development instance: `1` for `dev`, or a name (lowercase letters, digits, dashes, ≤ 32, not `desktop`). Local-only, own Electron profile and lock. Always on for unpackaged Electron. |
| `VELDR_DESKTOP_NO_OPEN` | Electron, development instances | Full Disk Access buttons print `no-open: …` to stderr instead of opening anything. |
| `VELDR_DESKTOP_PAYLOAD` | Electron, development instances | A directory laid out as `dist/payload` (machine builds, herdr-core, encoders, the extension) for the hub instead of the repository's (the desktop smoke test's). |
| `VELDR_AGENT_DIR` | Electron, development instances; `veldr node` | Machine builds searched first, as `--agent-dir`. |
| `VELDR_SEED_DIR` | Electron, development instances | A directory of code-server releases and extensions, as `--seed-dir`. |
| `--user-data-dir=<dir>` | Electron command line | Replaces the Electron profile and single-instance lock, for smoke tests beside another copy. |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | hub on Linux; agent | Configuration (default `~/.config`) and cache (default `~/.cache`) directories; on a machine also where herdr-core's `config.toml` is read for `restore_screen`. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME` | agent | AI CLIs' credential, log and session directories when not the defaults; on Linux read from a running agent's environment to find its session ([35](features/35-agent-native-view.md)). |
| `KIMI_DISABLE_OAUTH_LOCK` | agent (AI usage) | `1`: Kimi Code renews without its lock, so the plugin does not renew it. |
| `XDG_DATA_HOME`, `OPENCODE_DB` | agent (AI usage) | OpenCode's database location when not `~/.local/share/opencode/opencode.db`. |
| `DEEPSEEK_API_KEY` | agent (AI usage) | DeepSeek key for the balance: after the key file the panel writes, before Claude Code's settings. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | agent (AI usage), hub (status pages) | Proxy for the AI providers' hosts (the language server on loopback goes through none). |
| `SHELL` | chat host | Login shell run as `$SHELL -l -i -c env` for the chats' agents' environment; `/bin/sh -l` if not absolute ([37](features/37-agent-chats.md)). |

Build scripts and tests:

| Variable | Where | Description |
| --- | --- | --- |
| `TARGETS` | `scripts/build.sh` | Hub platforms (default the host's), e.g. `"linux/amd64 darwin/arm64"`, also `linux/amd64-musl` and `linux/arm64-musl`; `windows/amd64` builds only `dist/veldr-windows-amd64.exe`. |
| `RELEASE_URL` | `scripts/build.sh` | The release's download URL, from which machines get their platform's archive (none for a build of no release, whose machines get theirs from `--agent-dir` or the hub's own executable). |
| `HC_PLATFORMS` | `scripts/build.sh` | herdr-core platforms fetched (`backend/scripts/fetch-hc.ts`) whose digests the executables record (default all four). |
| `SKIP_WEB`, `SKIP_EXT` | `scripts/build.sh` | `1` reuses `web/dist` or the built bridge extension. |
| `REQUIRE_ENCODER` | `scripts/build.sh` | `1` fails when the Linux video encoder is missing. |
| `VERSION` | `scripts/build.sh`, `scripts/desktop.sh` | Reported version (default `git describe`); desktop metadata takes a semver and drops a leading `v`. |
| `FFMPEG_PLATFORMS` | `scripts/build-ffmpeg.sh` | Linux platforms for the video encoder (default both). |
| `GHOSTTY_SRC` | `make vt-wasm` | Ghostty checkout to build libghostty-vt from. |
| `ARCH` | `scripts/desktop.sh` | `arm64` or `x64` (default the host's); Windows is `x64` only. |
| `DESKTOP_OS` | `scripts/desktop.sh` | `mac`, `win` or `linux`: package another system's unpacked app to check it; installers need their own system. |
| `SKIP_BUILD` | `scripts/desktop.sh` | `1` runs electron-builder alone on an earlier build. |
| `INSTALL_DIR` | `make desktop-install` | macOS install folder (default `/Applications`). |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | `scripts/desktop.sh` on macOS | Developer ID certificate (`.p12`) and password; signs instead of ad hoc. |
| `CSC_NAME` | `scripts/desktop.sh` on macOS | Developer ID identity in the keychain, instead of `CSC_LINK`. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `scripts/desktop.sh` on macOS | Notarize with this Apple ID. |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | `make deps` | `1` skips Electron's binary (enough for checks and tests). |
| `DEV_LISTEN` | `make dev-hub`, `make dev-web` | Development hub address (default `127.0.0.1:7790`). |
| `HC_TEST_BIN` | `make it` | herdr-core for integration tests (else `hc` on `PATH`, else skipped). |
| `E2E_ARGS`, `E2E_DIR`, `SKIP_BUILD`, `SKIP_WEB` | `make e2e` | Playwright arguments; where the hub and fake agents under test are (default `dist/e2e`); `1` reuses an earlier build. |
| `E2E_REQUIRE_DOCKER` | `make e2e` | `1` fails instead of skipping the SSH machine tests without Docker (CI). |
| `GUI_TEST_XCLIENT` | `bun test features/gui/integration.test.ts` (`make it`, `scripts/gui-it.sh`) | The X program of the program windows' integration test (e2e/fakes/xclient.ts compiled for the machine); without it the test compiles one with bun build --compile. |

## Files and directories

On every machine (the agent's `$HOME`); `<data>` is
`~/.veldr[-<instance>]`, `<host>` the host's key: its name and a hash
of its machine id (data directories may be on a home several hosts share,
[40](features/40-shared-homes.md)); `<host id>` the hash alone (the host's
name without a machine id). `<run>` is the namespace's runtime directory
on this host: `/run/user/<uid>/veldr[-<instance>]-<hash of the data
directory's path>` when `/run/user/<uid>` exists, is the user's and 0700,
else `<data>/run-<host id>`. Retention is summarized in
[deployment](deployment.md#remote-resources).

| Path | Content | Lifetime |
| --- | --- | --- |
| `~/.veldr/agent/<build>/veldr` | The machine build: the executable (from its release archive, downloaded by the machine or uploaded by the hub), accepted only with the SHA-256 its release's `SHA256SUMS` names | Unused 14 days. |
| `~/.veldr/code-server/<version>-<os>-<arch>/` | code-server releases (shared by instances and by hosts of one platform) | Unused 14 days. |
| `~/.veldr/hosts/<host>/xvfb/<version>/` | Xvfb unpacked in user space (shared by this host's instances) | Unused 14 days, when another is unpacked. |
| `~/.veldr/video/<sha256 prefix>/encoder` | Video encoder (shared), run only while its digest matches | Unused 14 days, when another is installed; unfinished after 1 h. |
| `~/.veldr/gpupick/<sha256 prefix>/gpupick.so` | GPU selection library (0600, shared) | Unused 14 days, when another is installed. |
| `<data>/gui/<sha256 prefix>/veldr-gui` (0700 directory) | The GUI helper of the machine side (window manager and capture, compositor, keeper), run only while its digest is the build's | Another build's unused 14 days; unfinished after 1 h. |
| `<data>/hosts/<host>/` (0700) | This host's own files of the namespace (below) | Touched at each agent start and every 24 h; another host's unused 30 days loses all but `hc/`, and goes whole after 180 days. |
| `<data>/hosts/<host>/hc/herdr-core` (0700 directory) | Terminal core executable, accepted only with its SHA-256 | Replaced by the next build. |
| `~/.local/state/herdr-core/veldr[-<instance>]-<host id>/` (`$XDG_STATE_HOME`) | herdr-core's own state (records, saved screens, logs) | Until the user removes it. |
| `<run>/` (0700, the user's, never a link) | Sockets (0600): `node.sock` (with its lock `node.lock`), `hc.sock` and its holders', `cs.sock`, `bridge.sock`, `vault.sock`, `chat.sock`; `cs.pid`; display files `gui.json`, `xauth`, `xauth.server` (0600), `gui.lock`, `gui-keep.lock` | Sockets while their owner runs; display files kept so terminals keep a valid environment; in `/run/user/<uid>` until the user's last session ends (kept while lingering). |
| `<data>/hosts/<host>/xvfb.log`, `xwayland.log`, `gui-keep.log` | Output of the last display, compositor and keeper | Replaced at each start. |
| `<data>/hosts/<host>/node.log`, `node.old.log` (0600) | The nodes' log | Moved to `node.old.log` past 1 MiB when a node starts. |
| `<data>/hosts/<host>/code-server.log` | Output of the last code-server | Replaced at each start. |
| `<data>/hosts/<host>/cs-data/`, `cs-ext/` | VS Code settings and extensions | Kept; logs pruned after 7 days. |
| `<data>/uploads/` | Pasted files, and dropped files without a terminal directory | 7 days. |
| `<data>/staging/` (0700) | File explorer uploads in progress (0600) | Removed when the upload ends; leftovers after 7 days. |
| `<data>/bin/veldr-mcp`, `veldr-mcp-<uname -s>-<uname -m>` (0700 directory) | Shell script serving the vault's MCP server through the link of the host's platform, which points at that platform's machine build | Each agent rewrites the script if it differs and repoints its platform's link at start. |
| `<data>/usage/deepseek.key` (0600) | DeepSeek API key | Until removed. |
| `<data>/machine-<host>.db` (0600, with `-wal`, `-shm`) | The agent's SQLite database ([38](features/38-sqlite-state.md)): terminal output snapshots while `history.capture` is on ([36](features/36-terminal-history.md)) and the AI usage records per log file | Snapshots within the `history.*` limits and days, removed when their terminal is gone or capture is turned off; usage records after 90 days. Another host's file unopened for 30 days is removed. |
| `<data>/chat-<host>.db` (0600, with `-wal`, `-shm`) | The chat host's journal ([37](features/37-agent-chats.md)): chats, their events, trusted folders, settings; never secret answers or agents' stderr | Within `chat.maxChatMB`, `chat.maxTotalMB`, `chat.maxChats`, `chat.retentionDays`. Agents' own session files are never touched. Another host's unopened for 30 days is removed. |
| `<data>/chat-host-<host>.log`, `chat-host.old-<host>.log` (0600) | Chat host log (no prompts or answers) | Rotated at 1 MiB; another host's removed after 30 days unwritten. |

On the hub host, in the user configuration directory
(`~/Library/Application Support/veldr/` on macOS,
`$XDG_CONFIG_HOME/veldr/` on Linux, `%AppData%\veldr\` on Windows;
0700 with 0600 files on Linux and macOS, replaced atomically, kept until
removed):

| File | Content |
| --- | --- |
| `settings[-<instance>].json` | Settings; hand-editable, reread within two seconds, unknown entries kept. |
| `keybindings[-<instance>].json` | Keybinding rules; hand-editable. |
| `machines[-<instance>].json` | `{"version": 1, "machines": [{id, label, kind, target, enabled}], "order": [ids]}`: SSH machines, the local machine once changed, and the order. Written by the hub from the first change; unknown fields kept. |
| `vault[-<instance>].json` | Variable vault, values encrypted under a key derived from the passphrase ([30](features/30-variable-vault.md)). |
| `hub[-<instance>]-<host>[-<id>].db` (with `-wal`, `-shm`) | The hub's SQLite database ([38](features/38-sqlite-state.md)): the vault's access log (last 1000 releases, 500 other records; never values) and the AI usage history (30 days of windows' use, alert periods). Earlier releases named it `core[-<instance>]-<host>[-<id>].db`; the hub removes this host's of its instance when it starts, without reading it. |

Also on the hub host: ssh control sockets in `/tmp/veldr-<uid>/s`
(`s-<instance>` for another instance, `h-<hash>` for one longer than
16 characters; Linux and macOS; owned by you, 0700), and code-server downloads with
`.sha256` sidecars in the user cache directory
(`~/Library/Caches/veldr/code-server`, `~/.cache/veldr/code-server`,
`%LocalAppData%\veldr\code-server`), and what the hub
fetched from its release (`~/.veldr/cache/machine/`: `SHA256SUMS-<version>`
and the archives machines needed, `veldr-<platform>-<digest>.tar.gz`,
checked when read, removed unused for 14 days).

A release directory holds the hub, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`licenses.md` and `licenses/` (`herdr-core/`, `herdr-detect/`, `encoder/`).
These are not copied to SSH machines.

In the browser, `localStorage` under `veldr.*` holds only that
browser's state: the sidebar's state and width (`sidebarOpen`,
`sidebarWidth`), the selected machine (`machine`), and the last 50 uploads
and downloads (`uploads`, `downloads`; names and paths, no contents).
Settings and layouts are the hub's.

Desktop artifacts in `dist/desktop/` (`make desktop-app` unpacked,
`make desktop-dist` installers):

- macOS: `mac-arm64/veldr.app`, `mac/veldr.app` (x64),
  `veldr-<version>-mac-arm64.dmg`, `-mac-arm64.zip`, `-mac-x64.dmg`,
  `-mac-x64.zip`
- Windows: `win-unpacked/veldr.exe`, `veldr-<version>-win-x64.exe`
- Linux: `linux-unpacked/veldr`, `linux-arm64-unpacked/veldr`,
  `veldr-<version>-linux-x86_64.AppImage`, `-linux-arm64.AppImage`,
  `-linux-amd64.deb`, `-linux-arm64.deb`

The hub is `bin/veldr` (`.exe` on Windows) in the app's resources.
Shell code builds into `desktop/dist/`; `make clean` removes the outputs.
Icon sources are in `desktop/assets/` (`make desktop-icons` regenerates
them on macOS). Electron's profile is `veldr-desktop` (`-dev`, or
`--user-data-dir`) in the system's application data directory and survives
uninstalling; on macOS `veldr-desktop-keychain.json` beside it records
which build owns the safeStorage keychain item
([30](features/30-variable-vault.md)). The desktop hub uses
`settings-desktop.json` and, on machines, the default `~/.veldr/`. No desktop log files
are kept: the last 16 KiB of the hub's stderr stay in memory for error
dialogs.
