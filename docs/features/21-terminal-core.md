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
  herdr-core `config.toml` (200x120 by default), which herdr-ide never
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
  in `config.toml` (read, never written, by herdr-ide;
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

Goals: a terminal core per machine owned by herdr-ide's instance, sharing
nothing with a herdr-core the user runs; its executable delivered through
the agent and verified; a Go client whose backpressure reaches the slowest
hop.

Non-goals: emulating terminals (the browser does,
[26](26-web-terminals.md)); the client-facing protocol
([22](22-terminal-protocol.md)); herdr-core's own machine links (machines
are reached through the agent, [02](02-multi-machine-transport.md));
running the core's agent on Windows.

## Design

**Client** (`internal/hc`). `Dial` says hello on any byte stream, checks
the generation and switches to frames. One goroutine reads frames; a reply
that opens a channel registers it before the next frame is read, because
the core sends the channel's first frames right behind the reply. `Call`
honors its context and sends `$/cancelRequest`.

`Stream.Ack` returns credit only when the caller has passed bytes on, so a
slow browser slows the core instead of filling memory along the way. A
channel buffers at most twice the credit window; a core exceeding its
credit ends the connection. `Events.Recv` joins lines across frames and
returns their credit itself.

**Delivery** (`internal/hcdist`, `scripts/fetch-hc`, `internal/embedded`).
`internal/hcdist` pins the version and the SHA-256 of the four release
archives (Linux and macOS, amd64 and arm64). `scripts/fetch-hc`, run by
`scripts/build.sh`, downloads and verifies each archive, takes only the
regular `herdr-core` file at the archive root (at most 64 MiB; never the
copy inside the macOS app bundle, links or duplicates), and writes it
gzip-compressed to `internal/embedded/hc/hc-<os>-<arch>.gz`, with the
release's licenses under `dist/hc/licenses/`. The executable is never run
during a build. `go run ./scripts/fetch-hc -exe <file> <os>/<arch>` writes
one verified executable for the integration tests (`HC_TEST_BIN`).
`embedded.HC` returns the compressed executable and the digest of the
uncompressed one.

**Agent** (`internal/agent/hc.go`). The session is `herdr-ide` or
`herdr-ide-<instance>`; the socket is `run/hc.sock` in the agent's data
directory (short, for macOS's socket path limit). Op `hc`:

- `install` checks the upload's SHA-256 and renames it over
  `hc/herdr-core`, as herdr-core's own updater does: a running core keeps
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
does ([02](02-multi-machine-transport.md)).

**Helpers as hidden terminals** (`internal/agent/hidden.go`). The chat host
([37](37-agent-chats.md)) must outlive the agent, so it runs as a terminal
of the instance's terminal core (`plugin.Env.RunHidden`): a reserved name,
the label `herdr-ide.hidden`, `no_parent`, `no_notify` and `rm`, in the
user's home with a minimal environment. It thereby has the lifetime, owner
and macOS privacy attribution of the user's terminals and ends with its
program or the core's stop. The core gives a name to one live terminal at
a time, so the name is the lock against a second chat host; when a user's
terminal holds it, the helper takes a numbered fallback name (at most 16).
`KillHidden` ends a helper only when label and arguments match. The name and label together
(`agentproto.Hidden`) hide it from the terminal protocol
([22](22-terminal-protocol.md)), agent detection and terminal history. No
terminal core is started for a helper: without one it answers
`no_terminal_core`.

**Environment of terminals.** The agent starts the core (and code-server
and the display) with `cleanEnv` (`internal/agent/procutil.go`): without
`HC_*`, `HERDR_*` (the product's own `HERDR_IDE_*` stay), `TMUX`,
`TMUX_PANE`, `STY`, `ZELLIJ` and `ZELLIJ_*`. Otherwise a core started from
a herdr pane or inside tmux would give its terminals the look of nested
sessions, and agents' hooks would report to the wrong pane. It also drops
the variables by which Claude Code and Codex mark a session's child
processes (`agentSessionVars`): a Claude Code started under them would take
itself for a child session and save no transcript
([35](35-agent-native-view.md)). Their configuration variables
(`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `CODEX_HOME`, `OPENAI_*`, …) stay. Where
herdr-core runs the terminal core as the core's child, the local machine's
programs inherit its core dump limit of 0
([30](30-variable-vault.md#security)).

New terminals of an ssh machine get `SSH_CONNECTION` and `SSH_CLIENT` of
the agent's ssh session (`internal/server/sshenv.go`), because a core
started by systemd has not inherited them and programs use them to know
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
- **Plain `go build` without `fetch-hc`** → `embedded.HC` returns an error
  naming the platform.
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

- `internal/hcdist/release_test.go`: archive extraction against malformed,
  oversized and linked members.
- `internal/embedded/embedded_test.go`: digest and damaged streams.
- `internal/hc/hc_test.go`: a scripted core — framing, hello, out-of-order
  replies, cancellation, credit violations, events across frames.
- `internal/agent/hc_test.go`: install, digest checks before start and
  restart, socket mode, session names, failure codes.
- `internal/server/term_test.go` (`TestSSHEnv`,
  `TestTermRunGetsTheSSHSession`) and `internal/agent/procutil_test.go`
  (`TestCleanEnv`, `TestCleanEnvAgentSessionMarkers`): terminal
  environment.
- `internal/agent/hidden_test.go`: hidden helpers' flags, a taken name, no
  terminal core, `KillHidden`; `TestIntegrationChatHost` (`make it`) the
  chat host started again after the terminal core restarted.
- `make it`: `TestIntegrationTerminal` (`internal/hc`) and
  `TestIntegrationHC` (`internal/agent`) against a real herdr-core in the
  session `herdr-ide-it`.
