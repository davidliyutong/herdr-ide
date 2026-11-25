# 21 · herdr-core terminal core

## Context

herdr-core (`hc`, github.com/herdrdev/herdr-core) is a terminal server: it
keeps terminals and their programs alive, hands viewers a terminal's raw
output, and stores small JSON documents for its clients. It knows nothing
of workspaces, tabs or panes. One account can run several cores, one per
session name.

What the design relies on (herdr-core 0.1.21; checked against a running
core by the integration tests):

- **API.** JSON-RPC 2.0 over a unix socket. `hello` with `framed: true`
  switches to frames `[channel u32 LE][kind u8][length u32 LE][payload]`
  (at most 16 MiB). Channel 0 carries the calls.
- **Streams.** `terminal.attach` opens a channel: a first paint (the screen
  as escape sequences), then the program's output. The viewer sends input,
  its size, focus and display facts. The core encodes no keys.
- **First paint.** It starts with CAN at the start of a data frame and a
  soft reset, clears the screen but not the scrollback (no `ESC[3J`, no
  full reset), then sends the attach's `history` lines, the screen (and
  the alternate screen when a program is on it), the title and the
  program's win32-input-mode; it has no end marker. An observing attach is
  invisible to the program and the other viewers. A paint over 4 MiB is
  dropped (only output follows); a resize before the paint was sent, or a
  reader more than 4 MiB behind, gets a new paint without history. The
  history kept follows the user's `history_mb` (5 MB by default). An
  attach while the core starts a kept terminal's shell again answers
  `unavailable`.
- **`terminal.read`** returns the screen as plain text. With `lines` on a
  program on the alternate screen, the core scrolls the program with
  wheel input to collect history, which every viewer sees.
- **Size.** A terminal takes the size of the non-observing viewer active
  last; without one it gets the *headless* size from the user's own
  herdr-core `config.toml` (200x120 by default), which veldr never
  writes. No call sets a size outside a stream, so a terminal's last viewer
  stays attached while no client shows it ([22](22-terminal-protocol.md)).
- **Credit.** Output flows against credit: 256 KiB per channel, returned
  by the viewer as it passes bytes on. A viewer more than 4 MiB behind gets
  a new paint instead of the backlog. Input needs no credit.
- **Events.** `events.subscribe` returns a snapshot and a channel of JSON
  lines: events with rising sequence numbers, a heartbeat every 15 s, and
  `missed` with a new snapshot for a subscriber that fell behind.
- **Status** is what the program reported through OSC 7501; the core
  infers nothing from the screen.
- **Addresses** are never reused. A finished terminal's record stays 24 h
  with the reason it ended, unless removed (`terminal.rm`).
- **Kept terminals.** A terminal started with `keep: true` whose program
  was lost with the core gets a new shell at the same address, in its last
  directory, when the core runs again. The web UI starts terminals this way
  ([33](33-workspace-restore.md)). With the user's `restore_screen = true`
  in `config.toml` (read, never written, by veldr;
  [36](36-terminal-history.md)), the new shell shows the old screen above
  a dim separator line, except after a power loss.
- **Documents** (`doc.get`, `doc.set`) are versioned and persist across
  core and machine restarts.
- **Sessions.** `HC_SESSION` selects the core, its terminals and its state
  directory; `HC_SOCKET` moves the socket. `herdr-core server start` runs
  the core detached (systemd user service, launchd job on macOS). Holder
  processes own the terminals, so a core restart keeps programs running.
- **macOS responsibility.** The core and its holders disclaim the
  responsibility they inherited, so macOS privacy checks (Full Disk Access,
  folder prompts) treat a terminal's programs as herdr-core's, not the
  launching app's ([16](16-desktop-packaging.md)).
- **Environment.** Programs get the core's environment with
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=ghostty`,
  `HC_*` variables naming their terminal, and what the starting client
  passes.
- The protocol is generation 1 and only grows within it.

## Goals / non-goals

Goals: a terminal core per machine owned by veldr's instance, sharing
nothing with a herdr-core the user runs; its executable delivered through
the agent and verified; a client whose backpressure reaches the slowest
hop.

Non-goals: emulating terminals (the browser does,
[26](26-web-terminals.md)); the client-facing protocol
([22](22-terminal-protocol.md)); herdr-core's own machine links (machines
are reached through the agent, [02](02-multi-machine-transport.md));
running the core's agent on Windows.

## Design

**Client** (`backend/shared/proto/hc`, in the hub and on the machine).
It says hello on any byte stream, checks the generation and
switches to frames. One reader takes the frames; a reply that opens a
channel registers it before the next frame is read, because the core
sends the channel's first frames right behind the reply. A call given up
(its abort signal) sends `$/cancelRequest`.

A stream's `ack` returns credit only when the caller has passed bytes on,
so a slow browser slows the core instead of filling memory along the way.
A channel buffers at most twice the credit window; a core exceeding its
credit ends the connection. An event subscription's `recv` joins lines
across frames and returns their credit itself.

**Delivery** (`backend/scripts/hcdist.ts`, `backend/scripts/fetch-hc.ts`,
`backend/kernel/payloads.ts`).
`hcdist.ts` pins the version and the SHA-256 of the four release
archives (Linux and macOS, amd64 and arm64). `fetch-hc.ts`, run by
`scripts/build.sh`, downloads and verifies each archive, takes only the
regular `herdr-core` file at the archive root (at most 64 MiB; never the
copy inside the macOS app bundle, links or duplicates), and writes it
gzip-compressed as `hc-<os>-<arch>.gz` into `dist/machines-hc/`, of which
each executable embeds its own platform's and records the digests of all
([42](42-typescript-backend.md#the-machine-side)); the release's licenses
go under `dist/hc/licenses/`.
The executable is never run during a build. `bun backend/scripts/fetch-hc.ts
--exe <file> <os>/<arch>` writes one verified executable for the
integration tests (`HC_TEST_BIN`).

**Agent** (`backend/machine/hc.ts`, `hcop.ts`). The session is
`veldr[-<instance>]-<host id>`, so hosts sharing a home keep their
cores and herdr-core's state apart ([40](40-shared-homes.md)); the socket
is `hc.sock` in the namespace's runtime directory on the host (short, for
macOS's socket path limit). Op `hc`:

- `install` checks the upload's SHA-256 and renames it over
  `<data>/hosts/<host>/hc/herdr-core`, as herdr-core's own updater does: a running core keeps
  the file it started from.
- `start` / `restart` run `herdr-core server start` / `restart` (the
  successor adopts the programs) and make the socket 0600. The core sends
  the digest of the executable this build carries; the agent re-hashes the
  installed file and answers `bad_digest` without running it if it
  differs.
- `stop` runs `server stop`, ending the session's programs; records and
  documents stay, and the UI restores workspaces from them
  ([33](33-workspace-restore.md)).
- `status` (and every reply) reports the installed digest and whether a
  core answers, with its version.

Actions run one at a time. Op `hc-api` pipes the socket; op `detect`
follows agents in the terminals ([25](25-agent-detection.md)). The agent
never stops the core on its own; only the user's "stop terminal core"
does ([02](02-multi-machine-transport.md)), or `veldr node stop
--terminal-core` on the machine, which runs `server stop` when a core
answers on the instance's socket.

**Helpers as hidden terminals** (`backend/machine/hidden.ts`). The chat host
([37](37-agent-chats.md)) must outlive the agent, so it runs as a terminal
of the instance's terminal core (`runHidden`): a reserved name,
the label `veldr.hidden`, `no_parent`, `no_notify` and `rm`, in the
user's home with a minimal environment. It thereby has the lifetime, owner
and macOS privacy attribution of the user's terminals and ends with its
program or the core's stop. The core gives a name to one live terminal at
a time, so the name is the lock against a second chat host; when a user's
terminal holds it, the helper takes a numbered fallback name (at most 16).
`killHidden` ends a helper only when label and arguments match. The name and label together
(`hidden` of agentproto) hide it from the terminal protocol
([22](22-terminal-protocol.md)), agent detection and terminal history. No
terminal core is started for a helper: without one it answers
`no_terminal_core`.

**Environment of terminals.** The agent starts the core (and code-server
and the display) with `cleanEnv` (`backend/machine/env.ts`): without
`HC_*`, `HERDR_*` (the product's own `VELDR_*` stay), `TMUX`,
`TMUX_PANE`, `STY`, `ZELLIJ` and `ZELLIJ_*`. Otherwise a core started from
a herdr pane or inside tmux would give its terminals the look of nested
sessions, and agents' hooks would report to the wrong pane. It also drops
the variables by which Claude Code and Codex mark a session's child
processes (`agentSessionVars`): a Claude Code started under them would take
itself for a child session and save no transcript
([35](35-agent-native-view.md)). Their configuration variables
(`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `CODEX_HOME`, `OPENAI_*`, …) stay.

New terminals of an ssh machine get `SSH_CONNECTION` and `SSH_CLIENT` of
the agent's ssh session (`backend/features/terminals/sshenv.ts`), because
a core started by systemd has not inherited them and programs use them to know
the user's clipboard and browser are elsewhere (Codex then copies via OSC
52 and logs in with a device code). Only well-formed values are passed, a
client's own value wins, the local machine gets none, and
`terminal.sshEnv` (per machine) turns it off.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A multiplexer that renders panes itself (tmux and the like) | Must be installed everywhere; renders for one foreground client, so no several viewers or client-side rendering. |
| herdr-core's default session | Would share terminals, documents and restarts with the user's own herdr-core. |
| Private XDG directories for the core | Programs inherit them; a session name moves the state without leaking into shells. |
| herdr-core's default socket path | Depends on `XDG_RUNTIME_DIR`; the agent's run directory is already private and short. |
| A versioned install directory per digest | The core starts holders and successor from its own path; rename over a fixed path matches herdr-core's updater. |
| `hc connect` over ssh | A second ssh session and install path beside the agent's multiplexed one. |
| Downloading herdr-core on the machine | Machines often have no internet ([09](09-air-gapped-installs.md)). |
| Committing the executables | About 30 MB per release; pinned digests give the same bytes from upstream. |
| Acknowledging output as soon as read | The backlog of a slow browser would grow inside the core process. |

## Failure modes

- **Archive missing or digest mismatch** → the build fails.
- **A hub built without `fetch-hc`'s payload** (or run from its sources
  before `dist/payload` holds it) → `hc(os, arch)` fails naming the
  platform, and the machine's terminal core is `not_bundled`.
- **Not installed** → `start`/`stop` answer `not_installed`.
- **Damaged upload or executable changed after install** → `bad_digest`;
  the next attempt reinstalls this build's executable.
- **Core does not start** → `start_failed` with herdr-core's output.
- **Other protocol generation** → `Dial` fails naming both.
- **Connection lost** → calls and streams end; sequence numbers restart
  with the core, so clients resubscribe and take the new snapshot.
- **Reboot or logout ending user processes** → kept terminals come back as
  shells, the others as finished records; the UI restores its layout
  ([33](33-workspace-restore.md)).

## Security

Whoever reaches the core's socket gets the user's shell: the socket is
0600 in a private directory, and the executable is verified against the
build's digest before every start. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/scripts/fetch-hc.test.ts`: archive extraction against malformed,
  oversized and linked members.
- `backend/kernel/payloads.test.ts`: the herdr-core digests the build
  records.
- `backend/shared/proto/hc/hc.test.ts`: a
  scripted core — framing, hello, out-of-order replies, cancellation,
  credit violations, events across frames.
- `backend/machine/agent.test.ts`: install, digest checks before start and
  restart, socket mode, session names, failure codes.
- `backend/features/terminals/units.test.ts` (`sshEnv`, `the local
  machine gets no ssh session`), `terminals.test.ts` (`terminal.run gets
  the ssh session`) and `backend/machine/hidden.test.ts`,
  `housekeeping.test.ts` (`cleanEnv`): terminal environment.
- `backend/machine/hidden.test.ts`: hidden helpers' flags, a taken name, no
  terminal core, killing a helper by name.
- `make it`: `backend/machine/integration.test.ts` and
  `backend/features/terminals/integration.test.ts` against a real
  herdr-core in the session `veldr-it-<host id>` and the instance
  `ts-term`'s.
