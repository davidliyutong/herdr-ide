# 21 · herdr-core terminal core

## Context

herdr-core (`hc`, github.com/herdrdev/herdr-core) is a terminal server: it
keeps terminals and their programs alive, hands a viewer a terminal's raw
output, and stores small JSON documents for its clients. It knows no workspaces,
tabs or panes. One account can run several cores side by side, one per
session name.

Facts the design relies on (herdr-core 0.1.21, `schema/README.md` and,
below `crates/herdr-core/src/`, `wire.rs`, `server.rs`, `paths.rs`,
`client.rs`, `viewers.rs` and `api/run.rs`, checked against a running core
by the integration tests):

- The API is JSON-RPC 2.0, one message per line, on a unix socket. `hello`
  with `framed: true` switches the connection to frames
  `[channel u32 LE][kind u8][length u32 LE][payload]` of at most 16 MiB.
  Channel 0 carries the calls, which run side by side.
- `terminal.attach` answers with a channel. On it the core sends a first
  paint (the screen as escape sequences, starting with CAN and a reset) and
  then the program's output; the viewer sends input bytes, its size, focus
  and display facts. The core encodes no keys.
- The first paint, measured against a running core: CAN, a soft reset
  (DECSTR), mode resets, `ESC[?1049l`, `ESC[H ESC[2J`, the attach's
  `history` lines of scrollback with their styles (each ending `\r\n`),
  as many newlines as the screen has rows, `ESC[H ESC[2J` and the screen;
  a program on the alternate screen adds `ESC[?1049h ESC[!p` and that
  screen. Then come the title (OSC 2, twice on the alternate screen), the
  program's win32-input-mode (`ESC[?9001h` or `ESC[?9001l`), which the
  core keeps out of the program's output, and from then on only the
  program's status reports (OSC 7501) and its output. The paint has no
  `ESC[3J` and no full reset, so it clears the screen and not the
  scrollback, and no mark of its end. Every paint starts with CAN at the
  start of a data frame. An observing attach with `history` is not seen by
  the program or the other viewers (no resize, focus or redraw). A first
  paint over 4 MiB is dropped without a word: the attach succeeds and only
  the program's output comes. A resize before the first paint was sent
  whole brings the new grid and a paint without history, and so does a
  reader more than 4 MiB behind, whose backlog that paint replaces. How much history the core keeps
  depends on the user's `history_mb` (5 MB by default) and the width:
  about 2600 to 6800 plain lines. An attach to a terminal whose shell the
  core is starting again answers `unavailable`.
- `terminal.read` returns the screen as plain text (its last rows, without
  trailing blanks). With `lines` (history lines above the screen; 0 is as
  none) on a program on the alternate screen, the core scrolls the program
  with mouse-wheel input to stitch its history, which every viewer sees.
- A terminal's size is that of its viewer active last among those not
  observing (`apply_size` in `viewers.rs`); an `observe` viewer never
  holds it. A terminal without such a viewer gets the *headless* size:
  `headless` in herdr-core's `config.toml`, 200x120 by default. That file
  is the user's own (`$XDG_CONFIG_HOME/herdr-core/config.toml`), shared by
  their other herdr-core sessions, and herdr-ide never writes it. The
  `size` of `terminal.run` is only the size a terminal has before its
  first viewer. An attach of the size the terminal has causes no resize
  and gets an exact first paint. No call sets a terminal's size outside a
  stream, so the core keeps a terminal's last viewer attached while no
  client shows it ([22](22-terminal-protocol.md)).
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
- A terminal's address is never given twice. A finished terminal's record
  stays for 24 h, with the `reason` it ended for (`exited`, `killed`, or
  the core's own end: `stopped_by_restart`, `holder_lost`, `server_stop`,
  `host_shutdown`), unless a client removes it (`terminal.rm`).
- A terminal started with `keep: true` whose program was lost with the
  core gets a new shell from the core when it runs again, at the same
  address, in the directory it was last in (events `lost` and
  `restarted`); an exit with a code and an explicit kill stay final. The
  web UI starts its terminals this way
  ([33](33-workspace-restore.md)). Such a terminal's live record has its
  `reason` cleared once it restarted.
- With `restore_screen = true` in the user's `config.toml` (false by
  default; herdr-ide only reads it, [36](36-terminal-history.md)), the new
  shell of a kept terminal shows the old program's screen and history
  above a dim line, `-- the program above ended; this is a new shell --`,
  after `server stop` or the loss of its holder; after a power loss (the
  core and the holders killed, the reason `stopped_by_restart`) nothing is
  shown. A configuration file the core cannot read leaves kept terminals
  waiting for their new shell.
- Documents (`doc.get`, `doc.set`) are kept with their versions in the
  core's state directory (`docs.json`), across restarts of the core and
  of the machine.
- `HC_SESSION` selects the core, its terminals and its state directory
  (`~/.local/state/herdr-core/<session>/`); `HC_SOCKET` moves the API
  socket, with the holders' sockets beside it. `herdr-core server start`
  starts the core detached from its caller (a systemd user service on
  Linux, a launchd job on macOS) and returns when it answers. Holder
  processes own the terminals, so a core restart keeps programs running.
- On macOS (`platform/macos_launchd.rs`, `macos_responsibility.rs`) the
  launchd job is a one-shot job of the user's session (none when
  `SSH_CONNECTION` is set), and the core and each holder execute
  themselves again disclaiming the responsibility they inherited; programs
  keep their holder's. macOS's privacy checks (Full Disk Access, the
  prompts for Desktop, Documents and Downloads) therefore treat a
  terminal's programs as herdr-core's, not as those of the app that
  started the core ([16](16-desktop-packaging.md)).
- Programs get the core's environment without the variables that name a
  terminal (`TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `COLORTERM`),
  which herdr-core sets itself: `TERM=xterm-256color`,
  `COLORTERM=truecolor` and `TERM_PROGRAM=ghostty`, with no version. To
  that it adds `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE` (by
  which it finds a terminal's programs again), `HC_SESSION` when the core
  has one, `PWD`, and what the client that runs the terminal passes. The agent
  starts the core (and code-server and the display) with its own
  environment without the variables of a terminal or multiplexer it was
  started in (`cleanEnv` in `internal/agent/procutil.go`): herdr-core's
  `HC_*`, herdr's `HERDR_*` (the product's own `HERDR_IDE_*` stay),
  tmux's `TMUX` and `TMUX_PANE`, GNU screen's `STY` and zellij's `ZELLIJ`
  and `ZELLIJ_*`. A core started from a herdr pane or inside tmux runs the
  local machine's agent in its own process, so without this its terminals
  would take themselves for nested sessions, and an agent's hooks would
  report to the herdr pane the core was started from. It also leaves out
  the variables by which Claude Code and Codex mark the programs of one of
  their sessions, named one by one (`agentSessionVars`: `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`,
  `CODEX_THREAD_ID`, `CODEX_SESSION_ID` and the others of the list): a
  Claude Code started in a terminal of a core launched from inside a Claude
  Code session would take itself for a child session, which saves no
  transcript and no record of its process
  ([35](35-agent-native-view.md)). The variables that configure the
  agents (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_*`,
  `CODEX_HOME`, `OPENAI_*`) stay.
- The programs of the local machine's terminals inherit the core's core
  dump limit of 0 (memguard's, [30](30-variable-vault.md#security)) where
  herdr-core runs the terminal core as a child of the core; one it starts
  as a systemd user service or a launchd job has the service manager's
  limits.
- The new terminals of an ssh machine get `SSH_CONNECTION` and `SSH_CLIENT`
  from the core (`internal/server/sshenv.go`), with the values of the ssh
  session its agent runs in, which the agent tells in its hello apart from
  the information clients see. A terminal core that systemd started as a
  service of the user has not inherited them, and programs take them as the
  sign that the user's clipboard and browser are on another computer: Codex
  then also copies through the terminal (OSC 52), takes pastes from it and
  logs in with a device code; prompts show the host name. Only an
  `SSH_CONNECTION` of two addresses and two ports is passed on; a value the
  client gave stays; the local machine gets none, since there they would
  not be true. `terminal.sshEnv` (on by default, per machine) turns them
  off. Terminals that already run keep their environment.
- The protocol is generation 1 and only grows within it.

## Goals / non-goals

Goals: a terminal core per machine that belongs to herdr-ide's instance and
shares nothing with a herdr-core the user runs; its executable
delivered through the agent, verified; a Go client of the API whose
backpressure reaches the slowest hop.

Non-goals: emulating terminals (the browser UI does,
[26](26-web-terminals.md)); clients
reach these terminals through [22](22-terminal-protocol.md); herdr-core's own machine links
(`machine.add`): machines are reached through the agent
([02](02-multi-machine-transport.md)); Windows (a core on Windows has no
local machine and reaches the terminal cores of SSH machines,
[02](02-multi-machine-transport.md)).

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
macOS release's own application bundle (`Herdr Core.app`), a link or a
second entry of that name is never used. It writes the executable gzip-compressed, without a name or time in
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
  runs `server stop`, which ends the session's programs; the terminals'
  records and the documents stay in the state directory, from which the
  web UI brings the workspaces back when the core runs again
  ([33](33-workspace-restore.md)).
- `status`, and the reply of every action, report the installed digest and
  whether a core answers on the socket, with its version.

Installs, starts and stops run one at a time. Op `hc-api` pipes the socket
and starts nothing; op `detect` connects to it to follow the agents in its
terminals ([25](25-agent-detection.md)).

**Helpers as hidden terminals** (`internal/agent/hidden.go`). A helper of
the product's own that must outlive the agent, the chat host
([37](37-agent-chats.md)), runs as a terminal of the instance's terminal
core (`plugin.Env.RunHidden`): `terminal.run` with a reserved name
(`herdr-ide-chat-host`), the label `herdr-ide.hidden` (`chat-host`),
`no_parent`, `no_notify` and `rm`, in the user's home, with only the
user's name, home, shell, `PATH`, locale, `TMPDIR` and `XDG_*` variables
of the agent's environment on top of the terminal core's. Its parent is
the terminal core, so it has the lifetime, owner and, on macOS, the
privacy attribution of the user's terminals, and it ends with its program
or with the terminal core's stop (SIGHUP, SIGTERM half a second later,
then SIGKILL). The terminal core gives a name to one live terminal at a
time, so a run that finds the name taken leaves the running helper be.
`plugin.Env.KillHidden` ends a helper's terminal that holds the name
without doing its work, only when it carries the label and runs the
helper's arguments. Clients never see these terminals: the name and the
label together hide one (`agentproto.Hidden`) from the core's terminal
protocol ([22](22-terminal-protocol.md)), from agent detection and from
terminal history. No agent starts a terminal core for a helper: without
one the helper does not run (`no_terminal_core`). The agent never stops the core on its own: the core
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
  enabled. When the core runs again, terminals started with `keep: true`
  have a new shell in their last directory, the others are finished
  records with the core's end as the reason, and the documents are as they
  were written; the web UI restores its layout from that
  ([33](33-workspace-restore.md)).

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
`internal/server/term_test.go` (`TestTermRunGetsTheSSHSession`,
`TestSSHEnv`): the ssh session's variables in a new terminal of an ssh
machine, a client's own value kept, the setting off, nothing but addresses
and ports passed on, none for the local machine, none in the state clients
see; `internal/agent/agent_test.go` the hello telling the session.
`internal/agent/procutil_test.go` (`TestCleanEnv`): the variables of
terminals and multiplexers removed (every `HC_*`), `TMUX_TMPDIR`,
`TERM_PROGRAM` and the product's own kept; `TestCleanEnvAgentSessionMarkers`:
the agents' session markers removed, their configuration kept.
`internal/agent/hidden_test.go`: a helper run as a hidden terminal with
its name, label, flags and variables, a name taken, no terminal core, and
`KillHidden` ending only the helper's terminal; `TestIntegrationChatHost`
(`make it`): the chat host as such a terminal of a real herdr-core,
started again after the terminal core restarted. `TestIntegrationTerminal` (`internal/hc`) and `TestIntegrationHC`
(`internal/agent`) run with `make it` against a real herdr-core
(`HC_TEST_BIN`, else `hc` on `PATH`) in the sessions `herdr-ide-it` with
temporary state: first paint, input and output, sizes of two viewers,
documents and their conflicts, how a killed program's stream ends; install
through the agent, start, the socket's mode, a program's environment, stop.
Both passed against the pinned herdr-core 0.1.21 for linux/arm64 in an
isolated Linux container (Debian, an unprivileged user, no network).
