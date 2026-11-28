# 21 · herdr-core terminal core

## Context

herdr-core (`hc`, github.com/herdrdev/herdr-core) is a terminal server: it keeps terminals and their programs alive, hands viewers a terminal's raw output and stores small JSON documents; it knows nothing of workspaces, tabs or panes. What the design relies on (the release pinned in `backend/scripts/hcdist.ts`, checked by the integration tests):

- JSON-RPC 2.0 on a unix socket, switched to frames by `hello`; protocol generation 1, which only grows.
- `terminal.attach` sends a first paint (clearing the screen, not the scrollback; no end marker), then the program's output, against 256 KiB of credit per channel that the viewer returns as it passes bytes on; a viewer 4 MiB behind gets a new paint. Viewers encode their own input; an observing attach is invisible.
- `terminal.read` with `lines` on a program on the alternate screen scrolls the program, which every viewer sees.
- A terminal takes the size of the non-observing viewer active last, else the headless size of the user's own `config.toml`, which the product never writes.
- `events.subscribe` gives a snapshot, then events; `missed` carries a new complete snapshot for a subscriber that fell behind.
- Terminals started with `keep: true` get a new shell at the same address when the core runs again ([33](33-workspace-restore.md)); documents persist.
- `HC_SESSION` selects the core and its state; the core runs detached (systemd user service, launchd job), and holder processes keep programs running across its restart.

## Goals / non-goals

Goals: a terminal core per machine owned by the instance, sharing nothing with a herdr-core the user runs; its executable delivered with the machine build and verified; backpressure from the slowest hop to the program.

Non-goals: emulating terminals ([26](26-web-terminals.md)); the client protocol ([22](22-terminal-protocol.md)); herdr-core's own machine links ([02](02-multi-machine-transport.md)); the core on Windows.

## Design

**Client** (`backend/shared/proto/hc`). A reply that opens a channel registers it before the next frame is read, since the channel's frames follow at once. A stream's `ack` returns credit only when the caller has passed bytes on, so a slow browser slows the core instead of filling memory along the way.

**Delivery** (`backend/scripts/hcdist.ts`, `fetch-hc.ts`, `backend/kernel/payloads.ts`). The build verifies the pinned archives (Linux and macOS, amd64 and arm64) and never runs them; each executable embeds its platform's herdr-core and records the digests of all ([42](42-typescript-backend.md#the-machine-side)).

**Agent** (`backend/machine/hc.ts`, `hcop.ts`). The session is `veldr[-<instance>]-<host id>`, so hosts sharing a home keep their cores apart ([40](40-shared-homes.md)); the socket `hc.sock` is 0600. Op `hc`'s `ensure` holds one lock through status, install and start: the node installs its own copy only when its digest is the one the hub's release recorded, renaming it over the installed file as herdr-core's updater does, restarts a running core after an install (the successor adopts the programs), and hashes the file again before every start. Only the UI's "stop terminal core" ([02](02-multi-machine-transport.md)) or `veldr node stop --terminal-core` stops a core.

**Hidden terminals** (`backend/machine/hidden.ts`). The chat host ([37](37-agent-chats.md)) runs as a terminal of the instance's core, so it outlives the agent. Its reserved name and the label `veldr.hidden` together (`hidden` of `backend/shared/proto/agentproto`) hide it from clients, agent detection and history; a label alone hides nothing.

**Environment** (`backend/machine/env.ts`). The core starts without `HC_*`, `HERDR_*`, multiplexers' variables and coding agents' session markers (`cleanEnv`), so shells do not take themselves for nested sessions and Claude Code saves its transcripts ([35](35-agent-native-view.md)). Terminals of ssh machines get `SSH_CONNECTION` and `SSH_CLIENT` (`terminal.sshEnv`): programs then know the clipboard and browser are elsewhere.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A multiplexer that renders panes (tmux) | Must be installed everywhere; renders for one client. |
| herdr-core's default session | Would share terminals and restarts with the user's own herdr-core. |
| Downloading herdr-core on the machine | Machines often have no internet ([09](09-air-gapped-installs.md)). |
| Acknowledging output as soon as read | A slow browser's backlog would grow inside the core. |

## Failure modes

- **Archive missing or digest mismatch** → the build fails.
- **No herdr-core in the machine build and none installed** → `not_bundled`; another one than the release recorded → `install_failed`; an executable changed after install → `bad_digest`.
- **Core does not start** → `start_failed` with herdr-core's output.
- **Connection lost** → clients resubscribe and take the new snapshot; after a reboot kept terminals come back as shells ([33](33-workspace-restore.md)).

## Security

Whoever reaches the core's socket gets the user's shell: the socket is 0600 in a private directory, and the executable is verified against the build's digest before every start. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/scripts/fetch-hc.test.ts`, `backend/kernel/payloads.test.ts`: archive extraction and recorded digests; `backend/shared/proto/hc/hc.test.ts`: the client against a scripted core.
- `backend/machine/agent.test.ts`, `hidden.test.ts`, `housekeeping.test.ts`: install and digest checks, hidden helpers, the environment.
- `make it`: `backend/machine/integration.test.ts`, `backend/features/terminals/integration.test.ts` against a real herdr-core.
