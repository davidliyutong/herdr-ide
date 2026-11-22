# 36 · Terminal history

## Context

A terminal's output lives in its terminal core's memory
([21](21-terminal-core.md)). When the core ends with the machine (a
reboot, a power loss) or is stopped, the page brings the workspaces back
as new shells ([33](33-workspace-restore.md)), but what the terminals
showed is gone: the build log, the test failures, the conversation an
agent printed.

What herdr-core 0.1.21 gives to build on (measured against a running
core, [21](21-terminal-core.md)):

- An observing attach with `history: N` is invisible to the program and to
  the other viewers, and its first paint carries N lines of scrollback
  with their styles, then the screen (and a program's alternate screen):
  the terminal as an emulator would rebuild it. Every paint starts with
  CAN at the start of a data frame. The paint clears the screen, not the
  scrollback, has no mark of its end, and is followed by the title,
  `ESC[?9001h` or `ESC[?9001l`, the status reports and the program's
  output. A first paint over 4 MiB is dropped without a word; a
  resize during it, or a reader more than 4 MiB behind, gets a new grid
  and a paint without history.
- `terminal.read` returns the screen's text cheaply; with history lines it
  scrolls a program on the alternate screen, which every viewer sees.
- herdr-core's own `restore_screen = true` (the user's `config.toml`,
  shared with their other herdr-core sessions, which herdr-ide never
  writes) shows a kept terminal's old screen and history above its new
  shell after a stop of the core or the loss of its holder, below a dim
  line, `-- the program above ended; this is a new shell --`; after a power
  loss it shows nothing. A kept terminal's live record does not say why its
  program was replaced.

## Goals / non-goals

Goals: what a terminal showed before its terminal core started again,
shown above the new shell in the same scrollback; nothing on disk unless
the user turns it on for a machine; hard limits of lines, bytes,
terminals, space and days that the machine enforces whatever it is asked;
nothing that types into, resizes or redraws a terminal; snapshots removed
when they are no longer wanted.

Non-goals: a continuous record of every byte; snapshots of a machine while
no core is connected to it; the output written after the last snapshot (a
terminal's last seconds before a power loss); a viewer of
its own for saved output; changing herdr-core's configuration.

## Design

### Capture (`internal/agent/plugin/history`)

The machine's agent snapshots the live terminals of its instance's
terminal core (`run/hc.sock`, never the user's own herdr-core) when the
core asks (`capture {lines, maxTerminals, maxTotalBytes, days}`), within
25 s:

1. It takes the snapshots' lease (waiting up to 2 s; another writer,
   such as a second core's agent of the instance, makes the capture answer
   `busy` and do nothing), removes generations that are not whole, and the
   generations older than `days`.
2. It lists the terminal core's terminals (`terminal.list` with `all`) and
   removes the snapshots of terminals that finished with their program (an
   exit, a kill: any reason but the core's own end, `stopped_by_restart`,
   `holder_lost`, `server_stop`, `host_shutdown`). A terminal that is no
   longer in the records loses its snapshots only once the agent has seen
   it gone for 2 minutes (`goneGrace`, kept in the agent's memory: an
   agent that starts again starts that time again), so that a page can
   give them to the terminal that took its place (adopt, below). Then the
   terminals captured longest ago go until the limits hold.
3. For each live terminal with a program and an address of 1–64 letters,
   digits, `_` and `-` starting with a letter or digit, those captured or
   tried longest ago first:
   - A terminal whose program (pid) is another than its current
     generation's has its current generation made the previous one.
   - Its screen is read (`terminal.read` without `lines`), and a hash of
     its grid and text compared with the current generation's: the same
     screen of the same program is skipped, and so is a terminal the
     limits evicted, while its screen is the same; one refused before (no
     room, a paint too large) fails again with the same code without an
     attach while its screen and the limits are the same. The agent keeps
     these in memory, so terminals beyond the limits do not take each
     other's place at every capture.
   - Whether the limits leave room for it at all (the terminals that may
     go, the bytes of those that stay) is decided before the attach;
     how much room its bytes take, once they are read.
   - It attaches as an observer with `lines` of history and its grid, and
     reads the first paint, returning credit as the bytes arrive, within
     5 s. herdr-core starts every paint with CAN at the start of a data
     frame, so the first frame tells: one that starts with CAN begins the
     paint, which is read up to the first `ESC[?9001h` or `ESC[?9001l`
     after it, with no wait after that; a first frame of other bytes is
     the program's output, the paint having been dropped (over 4 MiB), as
     is nothing within 2 s for a quiet terminal (`no_paint`). A dropped
     paint, and one over 2 MiB, are asked again with half the lines, down
     to 100. A grid other than the one attached with, or a second frame
     starting with CAN before the end, means the core replaced the paint by
     one without history (a resize, a reader behind): it is asked again
     with the new grid, at most 3 times, then fails as `repainted`. A
     terminal whose shell the core is starting again (`unavailable`) or
     that ended is skipped.
   - The window titles (OSC 0, 1, 2) are taken out, room is made (the
     terminals captured longest ago go, never one captured in this
     capture; the terminal's own previous generation only when it alone
     would not fit), and the bytes and their description are written. When
     the paint shows herdr-core's line under a restored screen, the
     generation is marked `restored`, and stays so for the same program.

The answer counts the terminals captured, skipped, failed (with a code
each: `no_paint`, `too_large`, `incomplete`, `repainted`, `probe`,
`attach`, `limit`, `write`, `timeout` for those the time did not reach),
evicted and removed, and the bytes kept. One terminal failing keeps its
generations and does not stop the others.

### Generations

A terminal's snapshot has a current generation, of the program running
when it was taken, and at most one previous generation, of the program
before: when a kept terminal gets a new shell (the core started again),
its first capture makes the old program's snapshot the previous one. A
terminal the page started in place of another (a new address,
[33](33-workspace-restore.md)) gets that one's newest generation as its
previous one when the page adopts it. A terminal that has only a previous
generation lists `at: 0`.

### Storage and limits

The snapshots live in the machine's database, `machine-<host>.db` in the
agent's data directory `~/.herdr-ide[-<instance>]/` (0600 in the 0700
directory, neither a link; named after the host, since the directory may
be on a home several hosts share; [38](38-sqlite-state.md)), table
`history_snapshots`: a row per generation of a terminal (the current one
and the previous one) with what describes it (pid, time, lines, bytes,
grid, the screen's hash, the days it was written under, `restored`) and
its bytes. Every change is a transaction of its own, on disk before it
returns (`store.Durable`), so readers take no lock and see each
generation whole. Writers (capture, clear, adopt, housekeeping) hold the
snapshots' lease (`history_lease`: the writer, its process and host, and
until when), which two agents of an instance share: taken in a
transaction, renewed by each of the writer's changes, which fail once
another writer took it; it ends when the writer closes, when its process
is gone (on the same host: no process of its pid, or this process
while the writer's process id is another's, an agent of a container
started again with the same pid), or a minute after its last renewal. A
capture that does not get it within 2 s answers `busy` and writes
nothing, a clear or an adopt waits for it up to 40 s, and the
housekeeping of a list or a read runs only when it is free. Memory
follows the database: a change that fails leaves what describes the
snapshots as it was (a clear whose removal fails says so and removes
nothing). The
snapshots were kept before in `<data dir>/history/` as files; their whole
generations are imported once when the database is opened, and the
directory is removed then (also one an agent of an older version left
again later).

| Limit | Setting (per machine) | Default | Hard bounds |
| --- | --- | --- | --- |
| Lines of history above the screen per snapshot | `history.lines` | 2000 | 100–10000 |
| Bytes per generation | – | – | 2 MiB |
| Generations per terminal | – | – | 2 |
| Terminals with snapshots | `history.maxTerminals` | 32 | 1–128 |
| Space of all snapshots | `history.maxTotalMB` | 64 | 1–512 MB |
| Days a snapshot is kept | `history.days` | 7 | 1–30 |
| Seconds between captures | `history.interval` | 30 | 10–600 |

The agent clamps what the core asks to the bounds
(`agentproto.History*`); the terminals captured longest ago go first.

### The scheduler (`internal/plugins/history`)

Every 5 s the core looks at each connected machine: one keeps snapshots
while `history.capture` (off by default, per machine; `--history-capture`)
and the plugin are on. A capture is asked `history.interval` seconds after
the last one ended, one at a time per machine, waiting at most 30 s; it is
not audited (it changes only what the setting asked for), and a failing
machine's code is logged when it changes. A machine that no longer keeps
snapshots (the setting or the plugin turned off, or a machine seen for the
first time without them) is asked to clear all of its snapshots instead;
a clear that fails is asked again after 30 s, doubling up to an hour, and
at once when the machine connects again. A clear is audited as
`history.clear` (`reason: capture_off`, the count removed) when the user
turned the snapshots off or it removed some. A `--read-only` core asks its
machines for nothing.

### Routes

- `GET /api/m/{id}/p/history`: the machine's snapshots (`terminal`, the
  current generation's `pid`, `at`, `lines`, `bytes`, `cols`, `rows`,
  `restored`, and `previous`) and `restoreScreen`, whether the user's
  herdr-core configuration (`$XDG_CONFIG_HOME/herdr-core/config.toml` of
  the environment the agent starts the core with, else
  `~/.config/herdr-core/`; a regular file of at most 64 KiB, read, never
  written) has `restore_screen = true`.
- `GET /api/m/{id}/p/history/read?terminal=&generation=current|previous`:
  one generation's bytes, at most 2 MiB, as an `application/octet-stream`
  attachment with `nosniff`, a sandboxing CSP and `no-store`, described by
  `X-History-Pid`, `X-History-At`, `X-History-Cols`, `X-History-Rows` and
  `X-History-Lines`. A generation replaced while it is read is read again,
  up to 3 times (`busy`).
- `DELETE /api/m/{id}/p/history[?terminal=]`: removes one terminal's
  snapshots or all, refused read-only, audited as `history.clear` with the
  terminal and the count.
- `POST /api/m/{id}/p/history/adopt?from=&to=`: terminal `to` (the address
  the terminal core gave the pane's new terminal; it must be a terminal of
  the machine's terminal core's records, else `not_found`) gets `from`'s
  newest generation (its current, else its previous) as its own previous
  generation, unless `to` has a previous one captured later; `from`'s
  snapshots are removed either way: `{adopted}`. The generation keeps its
  time and the days it was written under, and nothing grows, so the limits
  hold. Refused read-only, audited as `history.adopt` with `from`, `to` and
  `adopted`; both addresses are checked on the core first, and `from`
  equal to `to` is refused. Like a clear it waits up to 40 s for the
  lease.

Listing and reading remove the generations older than the days they were
written under first. Every address is checked on the core and again on
the machine; errors carry codes and fixed words, never a path of the
machine.

### Showing a snapshot (`web/src/plugins/history`)

While the plugin is on, the page follows each machine whose
`history.capture` is on and whose terminals are known (`follow.ts`). It
lists the machine's snapshots soon after that, and again after a terminal
got a new program (its pid changed) or a new terminal appeared: the first
list 250 ms later, the next ones at least 5 s apart, none while the page
is hidden (owed until it is shown). For each terminal leaf of the layout
it chooses the snapshot of what that terminal showed before
(`chooseSnapshot`):

- its own terminal's generation of another program than the one running:
  the current generation while the machine has not captured the new
  program yet, the previous one once it has. None where herdr-core showed
  the old screen itself: once the new program was captured, its current
  generation's `restored` says so; until then `restoreScreen` stands in
  (herdr-core restores nothing after a power loss), and the page lists the
  snapshots again a capture interval and 5 s later, at most 3 times; the
  record's `reason` is not used, herdr-core clearing it when the new shell
  starts. Neither counts for a generation the page moved to the terminal
  from the one it replaced (below): herdr-core never shows another
  terminal's screen;
- else, for a leaf that took another terminal's place (`before`,
  [33](33-workspace-restore.md)), that terminal's current generation, else
  its previous one; herdr-core never shows another terminal's screen.

When a leaf's terminal took the place of another (`before`) and the list
has snapshots of that one, the page asks the machine once, after it read
their bytes (or the read failed) and not from a read-only page, to move
the newest to the leaf's terminal (`POST …/p/history/adopt`, while that
terminal is live), and lists the snapshots again once it answered. Until
then, and on a read-only page, the leaf shows the snapshot where it is;
afterwards it is the terminal's own previous generation, shown by the
rule above. A failure of the machine or the network is tried again after
a back-off; a refusal is not. The page remembers what it moved in its
memory only.

It reads the chosen generation's bytes once (at most 2 MiB) and gives
them, with the grid they were painted at (from the read's headers, else
the list's), to the terminal's pane as its prelude (`state/preludes.ts`,
[26](26-web-terminals.md)), with the note
`-- output saved <time>; the program above has ended --` (the time in the
user's locale). A generation the machine moved or removed since it was
listed, or a read it refused (not found, too large), counts as failed
until the next list; a list or a read that failed for the machine or the
network is tried again after 2 s, doubling up to 60 s. While a machine,
or the connection to the core, comes back, its preludes stay until the
list read once its terminals are known again says otherwise: they are
neither withdrawn nor read again.

The pane writes the prelude into each new emulator before the first byte
of its stream, at the grid of its snapshot (at most 1000 by 500): its
bytes; a complete reset of every state they may have set (the main
screen, so an alternate screen's last frame is not kept while the main
screen's history is; [26](26-web-terminals.md)); the note dim below the
last row with something on it; and as many newlines as that grid has
rows, with the cursor left at the top of the blank screen. The emulator
then goes back to the pane's grid, so every saved line stays in the
scrollback above the terminal's own history: found by find, selected and
copied as the rest. Its answers to queries, titles, clipboard writes,
bells and synchronized-output holds are dropped. A prelude that appears,
changes or goes while the pane is attached makes it attach again once
(the program sees nothing; what is typed meanwhile waits for the new
stream). A prelude goes when its snapshot leaves the list, its leaf
leaves the layout, the setting or the plugin is turned off, or the
snapshots are cleared.

The plugin's settings page (section `history`) ends with what the machine
shown keeps (the generations and their size), whether its terminal core's
own `restore_screen` is on, and **Clear Saved Output**, which asks first
and is disabled on a read-only page (`SettingsExtra.tsx`).

### Retention

Snapshots go when they are older than `history.days` (at a capture, when
an agent starts, when they are listed or read), when their terminal ended
with its program or has been gone from the terminal core's records for
two minutes (both at a capture), when the page moved them to the
terminal that took their terminal's place (adopt), to make room, when the
machine no longer keeps snapshots, and with **Clear Saved Output**. They
outlive the setting:

- with a `--read-only` core, which asks for no clear: they go by their age,
  when an agent starts or they are listed or read;
- on a machine removed from the core, disabled, or never connected again:
  until an agent starts there again and removes those past their days;
- with another core of the same instance whose setting is on for the
  machine: it keeps writing the same database (and a core whose setting
  is off clears what the other wrote when it first finds the machine
  connected);
- while a clear keeps failing: until one succeeds (asked again after 30 s,
  doubling up to an hour, and at once when the machine connects again) or
  they age out;
- in backups of the agent's data directory, which are outside the app.

## Alternatives considered

| Option | Why not |
| --- | --- |
| herdr-core's `restore_screen` alone | It is the user's setting in a file shared with their other herdr-core sessions, which herdr-ide does not write; it is off by default and shows nothing after a power loss, the case a reboot of a machine often is. The plugin reads it, and leaves the terminals it restored to it. |
| `terminal.read` text as the snapshot | Plain text without styles; with history lines it scrolls programs on the alternate screen, which every viewer sees. It serves only as a cheap check whether a screen changed. |
| Recording every byte of output continuously | A stream per terminal on every machine, at the speed of the busiest program, and a file that grows with it; a snapshot every interval is what the emulator would rebuild anyway, bounded by its lines. |
| A separate read-only viewer of saved output (a banner and a replay) | The output would sit apart from the terminal's own scrollback, with its own find and selection; replayed into the same emulator before the first paint, it is the terminal's history. |
| Snapshots kept by the core on its host | Only the output of machines the core is connected to while they run, sent over the connection at every capture; a machine keeps its own terminals' output beside the terminal core, as the user's other files there. |
| Snapshots on by default | Terminal output holds secrets (keys, tokens, passwords printed in a terminal); writing them to disk is the user's choice, per machine. |
| Waiting for output to pause after the paint's end | The paint ends at the first `ESC[?9001` after its start; waiting for a quiet moment made a capture of 20 terminals take seconds. |

## Failure modes

- **The terminal core does not run** → the capture answers `not_running`,
  logged once; the next interval tries again.
- **A paint the core drops** (over 4 MiB) → asked again with half the
  lines, down to 100; `no_paint` when even that does not come.
- **A paint over 2 MiB with 100 lines** → `too_large`, remembered for that
  screen and those limits.
- **A resize or a slow read during the paint** → asked again with the new
  grid, at most 3 times; `repainted` after that.
- **The limits have no room** → `limit`, remembered for that screen; the
  terminals captured longest ago go first otherwise.
- **The capture's time runs out** (many terminals) → the terminals not
  reached are `timeout`; the next capture starts with those tried longest
  ago.
- **Another agent of the instance captures** (two cores reaching the
  machine) → `busy`; that agent's capture stands.
- **A snapshot of another grid than the pane's** → written at its own
  grid and then brought to the pane's, every saved line kept. A grid the
  page does not take (beyond 1000 by 500, or none known) makes it write
  the snapshot at the pane's grid, where on a taller pane the lines right
  above the saved screen are lost.
- **A quiet terminal whose paint the core dropped** → each attempt waits
  2 s for a paint before asking with fewer lines.
- **A grid that changes and changes back during the attach** → cannot be
  told from no change: the snapshot may then lack its history.
- **The machine lost its power** → the snapshot is the last one taken:
  the output of the last interval may be missing.
- **`restore_screen` on, and the terminal's new program not captured
  yet** → the page takes the setting for what herdr-core did; the next
  capture tells, and the prelude comes or goes with the pane's next
  attach. A configuration file herdr-core cannot read leaves kept
  terminals waiting for their shell, while the plugin reads the setting as
  off, or, for some damaged files, as on.
- **A terminal the page replaced** ([33](33-workspace-restore.md)) → the
  page removes the old terminal's record once the replacement is in the
  layout; its snapshots stay for two minutes after a capture first saw it
  gone, in which a writing page moves the newest to the replacement
  (adopt). When no writing page follows the machine's snapshots in that
  time (only read-only pages, or none, are open), they are removed and the
  replacement shows none.
- **The page is loaded again after an adoption** → it no longer knows
  that the replacement's previous generation came from another terminal,
  and shows it by the rule of the terminal's own generations: with
  herdr-core's `restore_screen` on, not until the machine captured the
  replacement's program.
- **A list or a read fails** (the machine away, the network) → tried again
  after 2 s, doubling up to 60 s; what is shown stays.
- **The machine is not connected** → no capture; snapshots taken before
  stay and are shown once it is.

## Security

Terminal output can hold secrets, so nothing is written unless the user
turns `history.capture` on for a machine; the setting's description says
so. The snapshots stay on that machine, in the agent's database (0600 in
its private data directory, 0700), within the hard limits the agent
enforces;
the core reads them only for a page that passed its guards, as bytes that
are never a document of the UI's origin. Capturing never types into,
resizes or redraws a terminal, and reads only the instance's own terminal
core. What is stored is what the terminal core sent as the first paint;
when the core dropped that paint (over 4 MiB) and the program's own output
begins with CAN and carries `ESC[?9001h` or `ESC[?9001l`, that output is
stored in its place. A snapshot's bytes are thus a program's, and the page
replays them as untrusted output: nothing the emulator answers while it
writes them reaches the program, their titles, clipboard writes, bells
and synchronized-output holds are dropped, and the complete reset after
them leaves none of their modes, colors or links to the live terminal
([26](26-web-terminals.md)). Whether a page shows a terminal's previous
snapshot follows a line of text in its current one (herdr-core's "the
program above ended; this is a new shell"): a program that prints that
line keeps its predecessor's snapshot from being shown above it, which
stays on disk and can still be read. The adopt route changes snapshots and is
refused read-only and audited. See the row on terminal history in
[SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agent/plugin/history/history_test.go`, with a scripted
  terminal core (`fakecore_test.go`): a capture (the lines asked for, the
  paint from its CAN to before its end, titles out, a second capture
  without a change attaching nothing), the paint's end, a resize during
  the paint, a reader behind, output before a dropped paint, a terminal
  waiting for its shell, a failure keeping the files, titles stripped,
  dropped and too large paints asked with fewer lines, a new program
  rotating once, the limits clamped (`TestLimitsClamped`), terminals and
  bytes (`TestMaxTerminals`, `TestMaxTotalBytes`), age (`TestAge`),
  finished terminals, addresses (`TestAddresses`), the database private
  and never through a link (`TestDatabasePrivate`), the files of before
  imported, kept when the import fails, a newer generation kept
  (`TestImportFiles`, `TestImportFailureLeavesFiles`,
  `TestImportKeepsNewer`), what is not whole (`TestNotWholeRemoved`), two
  agents capturing and the lease, also of an earlier process of the same
  pid (`TestTwoAgentsCapture`, `TestLease`, `TestLeaseOfAnEarlierProcess`),
  a newer version (`TestNewerVersion`), one database per host
  (`TestPerHostDatabase`), failures that change nothing
  (`TestClearFailure`, `TestEvictionFailure`,
  `TestAdoptFailureKeepsSource`), list, read and clear, busy and not
  running, a capture
  waiting for a prune, errors without paths, `restore_screen`, `restored`
  and the core's line, the order and the time budget, performance, a
  refusal remembered, list and read applying the age; the adoption (the
  newest generation moved as the previous one with its bytes, time and
  days, a later previous one of `to` kept, an earlier one replaced, the
  space not grown; `TestAdopt`), its refusals and empty cases (bad or
  equal addresses, `to` not in the records, `from` without snapshots, a
  machine without the directory, no terminal core; `TestAdoptRefused`),
  and the two minutes a vanished terminal's snapshots are kept, counted
  anew when its record comes back or an agent starts again, an adoption
  within them (`TestVanishedGrace`). `hidden_test.go`
  (`TestHiddenTerminalsNotCaptured`): the chat host's terminal is never
  captured, one that only carries its label is.
- `internal/agent/plugin/history/integration_test.go`
  (`TestIntegrationCapture`, build tag `integration`, part of `make it`):
  against a real herdr-core in a session of its own (`HC_TEST_BIN`), a
  shell that printed 1500 lines and a title is captured with 500 lines:
  the stored bytes start with CAN, hold no OSC 0, 1 or 2 and no
  `ESC[?9001`, carry exactly the 500 history lines at the terminal's own
  grid (herdr-core's headless size, as no viewer that types is attached)
  and are not marked `restored`; a second capture without a change
  rewrites nothing. It passed against the pinned herdr-core 0.1.21 for
  linux/arm64 in an isolated Linux container (Debian, an unprivileged
  user, no network). The package's unit tests also ran on Linux x86_64.
- `internal/plugins/history/history_test.go`: routes and their guards
  (`TestRouteGuards`), settings, captures scheduled, a clear at first
  sight, one at a time, a clear when turned off
  (`TestSchedulerClearsWhenTurnedOff`), retries; the adopt route's
  parameters, audit fields and answers (`TestAdoptRoute`).
  `internal/agentproto/history_test.go`: addresses, the adoption's
  parameters (`TestHistoryAdopt`).
- `web/src/__tests__/history.test.ts`: the snapshot a leaf shows (the
  previous generation, the current one before the capture, none for the
  program running, the replaced terminal's, `restored` and
  `restoreScreen`), the list parsed, the note; the follower (machines by
  their setting, a snapshot read once, the replaced terminal's, bytes
  beyond a generation's size, a moved snapshot, preludes taken away, the
  list's schedule, hidden pages, the list read again a capture later while
  a choice waits for it and a bounded number of times, a machine that does
  not answer, the grid the read or the list gives within bounds, a list
  and a read tried again after a back-off and a refused read not before
  the next list, a prelude kept while the machine comes back, the replaced
  terminal's snapshot moved once and shown all along, nothing moved from a
  read-only page nor again once refused, a move tried again after the
  machine failed).
  `historySettings.test.tsx`: the settings page's counts, the
  `restore_screen` sentence, read-only, clearing.
  `termPane.test.ts`: preludes in the pane ([26](26-web-terminals.md)).
- Run against a real herdr-core 0.1.21: the paint's shape and end, a
  dropped paint over 4 MiB, a resize during the paint, an attach to a
  terminal waiting for its shell (`unavailable`), a kept terminal's record
  without its reason after a restart, `restore_screen` and its line; the
  limits on real data (5 lines asked became 100, a million 10 000, 2 MiB a
  generation, terminals and total bytes); generations rotated across a
  `server stop` and start, a `kill -9` of the core and the holders, and a
  `kill -9` of a kept terminal's shell; a first paint about 1.8 ms after
  the attach, a capture of 20 changed terminals in 428 ms and of none in
  2 ms; snapshots of the main and of the alternate screen replayed into
  the page's emulator.
- Run in a browser against the `dev` instance on macOS, before panes
  attached again by themselves after their terminal core started again,
  and before the snapshot's own grid, the complete reset after it and the
  adoption by a replacement took the form described above (the tests
  above cover those): after the terminal core was stopped and started,
  and the page reloaded then, a shell's saved output, its colors kept,
  stood above the new shell over the line "output saved <time>".
