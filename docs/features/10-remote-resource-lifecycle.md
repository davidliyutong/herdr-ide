# 10 · Remote resource lifecycle

## Context

herdr-ide starts processes and writes files on shared machines it does not
otherwise manage. Several cores may connect to the same machine, agents can
be killed abruptly, browsers keep hidden iframes open, and code-server holds
hundreds of megabytes per instance. Left alone, this exhausts memory and
disk on machines the user shares with others.

## Goals / non-goals

Goals:

- every process has an owner and an end;
- every file has a retention rule;
- nothing depends on the core shutting down cleanly;
- two cores never destroy each other's state.

Non-goals: CPU or memory quotas; managing the programs users start in
terminals (they belong to the user and run in the terminal core).

## Design

The per-resource table (what starts each process or file, its limits and
how it is reclaimed) is in
[deployment](../deployment.md#remote-resources); the paths are in
[reference](../reference.md#files-and-directories). This section gives the
rules behind it.

**Every process has an owner that ends it.**

- The agent belongs to its ssh session: it exits when stdin closes or the
  yamux keepalive fails ([02](02-multi-machine-transport.md)).
- The desktop core belongs to the Electron shell and stops when its stdin
  closes ([16](16-desktop-packaging.md)).
- Downloads (curl/wget, `apt-get download`) belong to the request that
  started them and have a time limit.
- The core's connection to a terminal core, and agent detection over it,
  last while a client is subscribed, plus a short grace period.
- The video encoder belongs to the agent's window manager and ends when its
  window is no longer watched or stops changing.

**What the user's programs depend on outlives the agent.** The terminal
core (herdr-core, session `herdr-ide[-<instance>]`) runs detached from the
agent as a user service, so programs survive disconnects and core restarts.
The user ends it from the machine's menu ([21](21-terminal-core.md)).
Terminals of the layout are kept by the layout document and end when their
pane closes ([33](33-workspace-restore.md)). The virtual display (Xvfb or
Xwayland, [14](14-gui-windows.md)) also runs in its own session; a display
keeper (`herdr-ide gui-keep`, one per instance) holds it while the terminal
core runs, and the display exits about a minute after its last client, so
it ends soon after the terminal core and its programs.

**The chat host is a hidden terminal of the terminal core**
(`herdr-ide chat-host`, [37](37-agent-chats.md)). The agent starts it when
the core opens a connection to it and none serves, so it ends with the
terminal core and its signals. It exits 60 s after its last agent process
and connection, and at most 30 s after it began to stop; a core of a newer
build replaces it only while no chat works or waits. The coding agents it
runs each have a process group of their own and stop when idle
(`chat.idleStopMinutes`), beyond `chat.maxLive`, or when their chat
closes: input closed, SIGTERM, then SIGKILL after a grace.

**code-server has an owner and several ends** (`internal/agent/codeserver.go`).

- `run/cs.pid` holds the process id and the owning agent's pid.
- An agent stops only the process it owns on exit.
- An agent adopts a running process whose owner died, and at startup stops
  an orphan whose owner is gone.
- The core's proxy stops it after `--code-server-idle` (20 min by default)
  without an open WebSocket; code-server's own idle timeout (1 h) covers a
  killed agent.

**Hidden VS Code windows let go.** Each VS Code pane on screen is its own
iframe in a layer over the panes, so moving panes or switching tabs never
reloads it. A window off screen stays loaded for 10 min, and at most 3 such
windows stay; then it is unmounted, closing its WebSocket so the idle timer
can run. A closed pane, or a disabled or removed machine, unmounts its
windows at once (`web/src/codeFrames.ts`, `web/src/components/CodeLayer.tsx`).

**Files.** Retention is by age (`internal/agent/housekeeping.go` prunes at
agent start; Xvfb packages, gpupick libraries and video encoders when
another build is installed):

- uploads, staging files and logs: 7 days;
- shared versioned directories (`agent/`, `code-server/`, `xvfb/`,
  `gpupick/`, `video/`): 14 days unused; running agents and starts touch
  their directory, so a version another core uses is not deleted;
- partial downloads and installs left by a killed agent: removed after 1 h;
- `hc/herdr-core`: one file per instance, replaced whole by the next
  install;
- the chat host's journal (`chat-<host>.db`): within the `chat.*` limits
  per chat, in total and in days after a chat closed; its log restarts at
  1 MiB with one old file kept;
- databases and logs are named per host (`machine-<host>.db`,
  [38](38-sqlite-state.md)), since a data directory may be on a home
  shared by several hosts; other hosts' go after 30 days unused;
- herdr-core's own state, the display's reserved files and the core host's
  files (settings, keybindings, machines, download cache): kept, replaced
  whole on change.

Directories are per instance except the shared versioned ones above.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Delete other versions immediately | Two cores with different builds would delete each other's files on every connect. |
| One code-server per browser window | Multiplies memory use. |
| Keep code-server until the agent exits | Agents live as long as the core is connected, often days. |
| Rely on the core's clean shutdown | Cores crash, laptops sleep, networks drop. |
| Terminal core owned by the agent | Every network drop or core restart would end the user's programs. |
| Xvfb kept for hours after its last client | Holds memory long after the terminal core ended; the keeper ties it to the terminal core instead. |

## Failure modes

- **Agent killed with SIGKILL**: its code-server survives until the next
  agent reaps it or its own 1 h idle timeout.
- **Core stopped**: its agent sessions end with their ssh sessions or
  socket connections, and each stops the code-server it started; a node
  without clients ends 15 s later ([39](39-nodes.md)).
  Terminal cores and their programs keep running; the next core of the
  instance finds them.
- **A terminal core nobody uses any more** (machine removed, instance no
  longer run): it runs until the user stops it from the machine's menu or
  with herdr-core's `server stop`
  ([deployment](../deployment.md#remote-resources)).
- **An untracked code-server answers on the socket** (pid file lost):
  replaced when VS Code is next opened ([05](05-vscode-panes.md)).
- **Two cores, same instance**: they share one code-server; either core's
  idle stop affects both, and the other restarts it on its next request.
  They share one chat host too, which an older build never replaces.
- **A chat host nobody uses** (machine removed, core gone): its agents
  stop when idle and it exits a minute after the last.

## Testing

- `internal/agent/lifecycle_test.go`: orphan reaping, owner-only stop,
  upload pruning and legacy directory migration.
- `internal/server/server_test.go` (`TestCodeServerIdleTracking`): idle
  detection with open connections.
- `web/src/__tests__/codePanes.test.ts`: VS Code windows kept off screen
  until they expire or exceed 3, gone when their pane closes.
- `internal/agent/hc_test.go` (`TestHCInstallStartAndPipe`) and
  `internal/server/term_test.go` (`TestHCLifecycle`): herdr-core installs
  and a stopped terminal core staying stopped.
- `internal/agent/guikeep_test.go`, `gui_test.go`, `guivideo_test.go`: the
  display keeper, unfinished Xvfb installs, old encoder builds.
- `internal/chathost` (idle exit and stop, `TestMaxLive`, shutdown, agents'
  groups ended on the terminal core's signals), `internal/agent/plugin/chat`
  (`TestHandover`, `TestNeverDowngrade`, `TestStuckHostKilled`),
  `TestIntegrationChatHost` (`make it`), `internal/store`
  (`TestPruneHostFiles`).
