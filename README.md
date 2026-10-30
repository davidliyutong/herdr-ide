# herdr-ide

English | [简体中文](README.zh-CN.md)

A terminal-first, multi-machine, agent-native web IDE for
[herdr](https://herdr.dev): your herdr workspaces on every machine in one
browser tab, with VS Code (code-server) one keystroke away.

## Features

- **Speaks herdr's protocol.** Workspaces, tabs, split layouts and agent
  states come from herdr's socket API; every pane is an xterm.js terminal fed
  by herdr's own renderer, with input, mouse, scrollback, IME and resizable
  splits. Keyboard shortcuts follow your herdr configuration (prefix
  `ctrl+b`).
- **Multi-machine.** Uses the SSH machines saved in herdr. One ssh connection
  per machine runs a small static agent (linux/macOS × amd64/arm64, uploaded
  automatically) that multiplexes everything; nothing listens on the
  machines.
- **Agent-native.** An inbox of agents that are blocked or done across all
  machines, browser notifications, starting agents from the command palette,
  sending code from VS Code to the focused agent, pasting images into agent
  prompts.
- **VS Code on demand.** code-server is installed per machine from the core
  host (no internet needed on machines), with Git Graph and a bridge
  extension: open a pane's folder, its diff or Git Graph with one key; jump
  from a `path:line` in the terminal to the editor. Idle instances are
  stopped.
- **Quick Look.** ⌘/Ctrl-click a path in a terminal to preview images, GIFs,
  videos (with seeking), audio, PDFs, text or directories.
- **Several browsers at once.** The active browser controls a pane; others
  watch at the same size and take over by typing.
- **English and Chinese UI.**

## Quick start

Requirements:

- [herdr](https://herdr.dev) on every machine you want to use, with remote
  machines saved through `herdr machine add`;
- an OpenSSH client with working access to those machines;
- to build: Go (version in `go.mod`), Node.js 22+ and pnpm (`corepack enable`
  picks the pinned version).

```bash
make deps && make build
./dist/herdr-ide-$(go env GOOS)-$(go env GOARCH)
```

Open <http://127.0.0.1:7780>. Press `ctrl+b space` for the command palette and
`ctrl+b ?` for shortcuts. All flags are listed in
[docs/reference.md](docs/reference.md).

## Remote access

herdr-ide has no login of its own: keep it on `127.0.0.1` and put an
authenticating reverse proxy with HTTPS in front (Tailscale, Caddy, nginx), then
pass its origin with `--allowed-origin`. Optional guardrails: a proxy secret
header, a read-only mode and an audit log. See
[docs/deployment.md](docs/deployment.md) and [SECURITY.md](SECURITY.md).

## Air-gapped networks

Machines never download anything. If the host running herdr-ide is offline
too, run `herdr-ide fetch-assets DIR` on a connected machine, carry `DIR` over
and start with `--offline --seed-dir DIR`. Downloads are verified against
pinned SHA-256 digests. Details in
[docs/deployment.md](docs/deployment.md#air-gapped-networks).

## Documentation

- [docs/reference.md](docs/reference.md) – flags, shortcuts, environment, files
- [docs/deployment.md](docs/deployment.md) – reverse proxies, air-gapped installs, remote resources, services
- [docs/architecture.md](docs/architecture.md) – components and protocols
- [docs/features/](docs/features/README.md) – one design document per feature, with the alternatives considered
- [SECURITY.md](SECURITY.md) – threat model and reporting

## Development

```bash
herdr --session herdr-ide-dev server &   # isolated herdr session
make dev-core                            # core on :7790 with --instance dev
make dev-web                             # UI with hot reload on :5173
make check test                          # before sending a PR
```

See [CONTRIBUTING.md](CONTRIBUTING.md); coding agents start with
[AGENTS.md](AGENTS.md).

## Contributing

Issues and pull requests are welcome, in English or Chinese. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first.

## License

[MIT](LICENSE). Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(Go modules) and `/licenses.md` served by the binary (web UI bundle).
code-server, Git Graph and herdr are separate projects under their own
licenses; Git Graph's license does not allow redistribution, so it is
downloaded by each installation rather than bundled.
