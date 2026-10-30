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

## `serve` flags

### Network and security

| Flag | Default | Description |
| --- | --- | --- |
| `--listen` | `127.0.0.1:7780` | Address to listen on. Non-loopback addresses are refused unless `--proxy-secret-file` or `--insecure-listen` is given. |
| `--allowed-origin` | – | Public origin of the reverse proxy, e.g. `https://ide.example.com` (repeatable). Host and Origin headers are checked against loopback plus these. |
| `--proxy-secret-file` | – | File with a secret (≥ 16 characters) that the reverse proxy sends in `X-herdr-ide-Proxy-Secret`. Required for requests not coming from loopback. |
| `--insecure-listen` | `false` | Accept a non-loopback `--listen` without a proxy secret. Anyone reaching the port gets shell access to every machine. |
| `--read-only` | `false` | Watch only: panes are observed, mutating herdr calls, uploads, ssh authentication and VS Code are refused. |
| `--audit-log` | – | Append security-relevant events (connections, mutating API calls, uploads, VS Code and bridge use, denials) as JSON lines. |
| `--user-header` | – | Header holding the authenticated user for the audit log. Without it, `Tailscale-User-Login`, `X-Forwarded-User`, `X-Auth-Request-User`, `Remote-User` and `X-Forwarded-Email` are tried. |

### Machines

| Flag | Default | Description |
| --- | --- | --- |
| `--local-session` | `default` | herdr session used on the local machine. |
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

### Development

| Flag | Default | Description |
| --- | --- | --- |
| `--agent-dir` | – | Directory with uncompressed `herdr-ide-agent-<os>-<arch>` builds, used instead of the embedded ones. |
| `--ext-dir` | – | Directory containing `herdr-ide-bridge.vsix`, used instead of the embedded one. |
| `--web-dir` | – | Serve the UI from this directory instead of the embedded build. |

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
| `prefix prefix` | Send the prefix key itself | | |

Default prefix: `ctrl+b`. In panes: Shift+Enter sends `ESC CR` (newline in
Claude Code and similar prompts; the bytes of every key are listed in
[`keys.json`](../web/src/__tests__/testdata/keys.json)); Option/Alt-drag selects text locally;
⌘/Ctrl-click opens paths (media in the preview panel, code in VS Code) and
URLs. Pasting or dropping files uploads them to the machine and types their
paths.

## Environment variables

| Variable | Where | Description |
| --- | --- | --- |
| `HERDR_IDE_BRIDGE_SOCKET` | set by the agent for code-server | Socket of the VS Code bridge extension. |
| `HERDR_IDE_CORE` | `pnpm -C web dev` | Core URL the Vite dev server proxies to (default `http://127.0.0.1:7780`). |
| `HERDR_BIN` | agent | herdr binary to use on a machine. |
| `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH` | core, agent | Honoured like herdr does when locating its state, configuration and sockets. |

## Files and directories

On every machine (the agent's `$HOME`):

| Path | Content | Lifetime |
| --- | --- | --- |
| `~/.herdr-ide/agent/<build>/` | Uploaded agent binaries | Builds unused for 14 days are removed. |
| `~/.herdr-ide/code-server/<version>/` | code-server releases (shared by instances) | Versions unused for 14 days are removed. |
| `~/.herdr-ide[-<instance>]/run/` (0700) | `cs.sock`, `cs.pid`, `bridge.sock` | While the agent runs. |
| `~/.herdr-ide[-<instance>]/cs-data/`, `cs-ext/` | VS Code settings, extensions | Kept; logs older than 7 days are pruned. |
| `~/.herdr-ide[-<instance>]/uploads/` | Pasted and dropped files | Files older than 7 days are pruned. |

On the core host: ssh control sockets in `/tmp/herdr-ide-<uid>/s` (must be
owned by you, mode 0700), downloads in the user cache directory
(`~/Library/Caches/herdr-ide/code-server` on macOS, `~/.cache/herdr-ide/code-server`
on Linux) with `.sha256` sidecars.

In the browser: preferences in `localStorage` under `herdr-ide.*`.
