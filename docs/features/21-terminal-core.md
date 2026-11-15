# 21 · herdr-core terminal core

## Context

herdr-core (`hc`, github.com/herdrdev/herdr-core) is a terminal server: it
keeps terminals and their programs alive, hands a viewer a terminal's raw
output, and stores small JSON documents for its clients. It knows no workspaces,
tabs or panes. One account can run several cores side by side, one per
session name.

Facts the design relies on (herdr-core 0.1.21, `schema/README.md`,
`src/wire.rs`, `src/server.rs`, `src/paths.rs`, `src/client.rs`, checked
against a running core by the integration tests):

- The API is JSON-RPC 2.0, one message per line, on a unix socket. `hello`
  with `framed: true` switches the connection to frames
  `[channel u32 LE][kind u8][length u32 LE][payload]` of at most 16 MiB.
  Channel 0 carries the calls, which run side by side.
- `terminal.attach` answers with a channel. On it the core sends a first
  paint (the screen as escape sequences, starting with CAN and a reset) and
  then the program's output; the viewer sends input bytes, its size, focus
  and display facts. The core encodes no keys. The viewer that was active
  last sets the terminal's size; an `observe` viewer never does.
- Output is sent against credit: 256 KiB per channel at first, returned by
  the viewer as it passes bytes on. A viewer more than 4 MiB behind gets a
  new paint instead of the backlog. Event channels use credit too; input
  does not.
- `events.subscribe` answers with a snapshot of terminals and a channel of
  JSON lines (split anywhere across frames): events with a rising sequence
  number, a heartbeat every 15 s, and `missed` with a new snapshot for a
  subscriber that fell behind.
- A terminal's status is what its program reported through OSC 7501; the
  core infers nothing from the screen.
- `HC_SESSION` selects the core, its terminals and its state directory
  (`~/.local/state/herdr-core/<session>/`); `HC_SOCKET` moves the API
  socket, with the holders' sockets beside it. `herdr-core server start`
  starts the core detached from its caller (a systemd user service on
  Linux, a launchd job on macOS) and returns when it answers. Holder
  processes own the terminals, so a core restart keeps programs running.
- Programs inherit the core's environment plus `HC_TERMINAL_ID`,
  `HC_TERMINAL_SOCKET`, `TERM=xterm-256color` and `COLORTERM`. The agent
  starts the core (and code-server and the display) with its own
  environment without the variables of a terminal or multiplexer it was
  started in (`cleanEnv` in `internal/agent/procutil.go`): herdr-core's
  `HC_*`, herdr's `HERDR_*` (the product's own `HERDR_IDE_*` stay),
  tmux's `TMUX` and `TMUX_PANE`, GNU screen's `STY` and zellij's `ZELLIJ`
  and `ZELLIJ_*`. A core started from a herdr pane or inside tmux runs the
  local machine's agent in its own process, so without this its terminals
  would take themselves for nested sessions, and an agent's hooks would
  report to the herdr pane the core was started from.
- The protocol is generation 1 and only grows within it.

## Goals / non-goals

Goals: a terminal core per machine that belongs to herdr-ide's instance and
shares nothing with a herdr-core the user runs; its executable
delivered through the agent, verified; a Go client of the API whose
backpressure reaches the slowest hop.

Non-goals: emulating terminals (each client does: the browser UI with
[26](26-web-terminals.md), the macOS application with Ghostty); clients
reach these terminals through [22](22-terminal-protocol.md); herdr-core's own machine links
(`machine.add`): machines are reached through the agent
([02](02-multi-machine-transport.md)); Windows.

## Design

**Client** (`internal/hc`). `Dial` says hello on any byte stream, checks
the generation and switches to frames; `Probe` asks a plain hello and
closes. One goroutine reads frames. A reply that opens a channel
(`terminal.attach`, `events.subscribe`) registers the channel before the
next frame is read, because the core sends the channel's first frames right
behind the reply. `Call` gives up with its context and tells the core
(`$/cancelRequest`); a channel that a late reply still opens is closed.

`Stream.Recv` returns output and, for an attach with resize notifications,
the terminal's new grid in order with the output. `Stream.Ack` returns
credit: the caller acknowledges bytes when it has passed them on, so a slow
viewer slows the core instead of filling memory on the way. A channel holds
at most 512 KiB; a core sending more than its credit ends the connection.
`WriteAutomatic` sends a viewer's automatic answers as their own frame kind
when the attach confirmed it, else as input. `Events.Recv` joins lines
across frames and returns their credit itself.

**Delivery** (`internal/hcdist`, `scripts/fetch-hc`, `internal/embedded`).
`internal/hcdist` pins herdr-core 0.1.21 and the SHA-256 digests of its
four release archives (Linux and macOS on amd64 and arm64).
`scripts/fetch-hc`, run by `scripts/build.sh` for every agent platform,
downloads an archive unless a verified copy is in `dist/hc/`, and takes the
`herdr-core` member at the archive's root from the bytes whose digest it
just checked: one regular file of at most 64 MiB, so the copy inside the
macOS application bundle, a link or a second entry of that name is never
used. It writes the executable gzip-compressed, without a name or time in
the header, to `internal/embedded/hc/hc-<os>-<arch>.gz`, and the release's
`LICENSE` and `THIRD-PARTY-NOTICES` to `dist/hc/licenses/`, which archives
and the desktop app ship as `licenses/herdr-core/`. The executable is never
run during a build. `go run ./scripts/fetch-hc -exe <file> <os>/<arch>`
writes one platform's verified executable to a file instead, for the
integration tests (`HC_TEST_BIN`; CI's `integration` job). `embedded.HC` returns the compressed executable of a
platform and the SHA-256 of the uncompressed one, computed once per
platform: the two things the agent's `install` takes. The four executables
add about 12 MB to the core.

**Agent** (`internal/agent/hc.go`). The session is `herdr-ide` or
`herdr-ide-<instance>` and the socket `run/hc.sock` in the agent's data
directory, short enough for the holders' sockets beside it. Op `hc`:

- `install` reads the gzip-compressed executable, compares its SHA-256
  with the header's digest and renames it over `hc/herdr-core`, as
  herdr-core's own update replaces its executable: a running core and its
  holders keep the file they started from. The same digest installs
  nothing.
- `start` runs `herdr-core server start`, which returns at once when the
  core runs, and makes the socket 0600. `restart` runs `server restart`:
  the core's successor adopts the programs, and makes the socket 0600 too.
  The core sends both with the digest of the executable this build
  carries; the agent hashes `hc/herdr-core` again (not from its cache)
  and answers `bad_digest` without running it when it differs. A build
  without an executable sends none, and the installed one runs. `stop`
  runs `server stop`, which ends the session's programs.
- `status`, and the reply of every action, report the installed digest and
  whether a core answers on the socket, with its version.

Installs, starts and stops run one at a time. Op `hc-api` pipes the socket
and starts nothing; op `detect` connects to it to follow the agents in its
terminals ([25](25-agent-detection.md)). The agent never stops the core on its own: the core
asks for `stop` only when the user stops the terminal core from the
machine's menu ([02](02-multi-machine-transport.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A terminal multiplexer that renders panes itself (tmux and the like) | Needs it installed on every machine, and it renders a tab's grid for one foreground client: several viewers of a terminal and client-side rendering are not possible. |
| herdr-core's default session | Its terminals, documents and restarts would be shared with the user's own herdr-core clients and `hc` commands. |
| Private XDG directories for the core | Programs inherit the core's environment, so the directories would reach the user's shells and tools. A session name moves the state without them. |
| herdr-core's default socket path | Depends on `XDG_RUNTIME_DIR` and the state directory, which the agent would have to mirror; the run directory is already private and short. |
| A versioned install directory per digest | The core starts its holders and its successor from its own path; a fixed path replaced by rename is what herdr-core's updater does. |
| Reaching machines through `hc connect` over ssh | A second ssh session and installation path per machine beside the agent's; the agent already multiplexes one session. |
| Downloading herdr-core on the machine | Machines often have no route to the internet ([09](09-air-gapped-installs.md)), and the agent already receives its own executable and the video encoder from the core. |
| Committing the executables or their notices to the repository | About 30 MB of binaries and 1 MB of generated text per release; pinned digests give the same content from upstream's archives. |
| Acknowledging output as soon as it is read | The core would send at the speed of the agent link, and the backlog of a slow browser would grow in the core process. |

## Failure modes

- **Archive not downloadable, or its digest differs from the pin** → the
  build fails; a cached archive that fails verification is downloaded again.
- **Build without `scripts/fetch-hc`** (plain `go build`) → `embedded.HC`
  returns an error naming the platform.
- **No executable installed** → `start` and `stop` answer `not_installed`.
- **Upload damaged or cut off** → `bad_digest`; the temporary file is
  removed and the installed executable stays.
- **Executable changed after its install** → `start` and `restart` answer
  `bad_digest` (the terminal backend reports `start_failed`); its next
  attempt finds the new digest in `status` and installs this build's
  executable again.
- **Core does not start** (unsupported system, socket path too long) →
  `start_failed` with herdr-core's output.
- **Nothing listens** → `hc-api` fails; `status` reports `running: false`.
- **Core of another generation** → `Dial` fails with both generations.
- **Connection lost** → calls, streams and subscriptions end with its
  error. Sequence numbers restart with the core: subscribe again and use
  the new snapshot.
- **Program ends** → the stream returns the output before it, then EOF;
  `Stream.Exit` has the reason (`exited`, `killed`, `server_stop`, …).
- **Machine reboot or logout where logind ends user processes** → the core
  and its programs end; herdr-core reports in `hello` whether lingering is
  enabled.

## Security

The core's API gives whoever reaches its socket the user's shell. See the
row for the agent's herdr-core in [SECURITY.md](../../SECURITY.md).

## Testing

`internal/hcdist/release_test.go` with archives built in the test: platform
names and URLs, a corrupt archive, the member at the root beside a bundle's
copy, an oversized member, a symlink, a hard link, a directory, a repeated
or missing name, an empty member, a truncated archive.
`internal/embedded/embedded_test.go` with a file system in memory: the
digest of the uncompressed executable, its caching, a platform without one,
a damaged and a truncated stream. `internal/hc/hc_test.go` against a scripted core over a pipe: frame
encoding and bounds, hello (wrong generation, plain reply, error,
oversized), calls answered out of order, errors with their kind, cancelled
calls, a channel's frames in the same write as its reply, every viewer
frame kind, automatic input on an older path, detaching, an attach given up
before its reply, a core ignoring credit, events split across frames with
their credit, a cancelled dial. `internal/agent/hc_test.go` with a script as
the executable: digest checks, replacement, the session and socket of
default and named instances, the environment of commands, failure codes,
the status of a core on the socket and the API pipe;
`TestHCVerifiedBeforeStartAndSocketPrivate` an executable of another
digest or changed in place (same size and time) refused by `start` and
`restart`, and the socket made 0600 after both.
`internal/agent/procutil_test.go` (`TestCleanEnv`): the variables of
terminals and multiplexers removed (every `HC_*`), `TMUX_TMPDIR`,
`TERM_PROGRAM` and the product's own kept. `TestIntegrationTerminal` (`internal/hc`) and `TestIntegrationHC`
(`internal/agent`) run with `make it` against a real herdr-core
(`HC_TEST_BIN`, else `hc` on `PATH`) in the sessions `herdr-ide-it` with
temporary state: first paint, input and output, sizes of two viewers,
documents and their conflicts, how a killed program's stream ends; install
through the agent, start, the socket's mode, a program's environment, stop.
