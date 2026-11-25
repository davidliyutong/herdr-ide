# 36 · Terminal history

## Context

A terminal's output lives in its terminal core's memory
([21](21-terminal-core.md)). When the core ends with the machine (a
reboot, a power loss) or is stopped, the page brings the workspaces back
as new shells ([33](33-workspace-restore.md)), but what the terminals
showed is gone.

What herdr-core 0.1.21 offers:

- An observing attach with `history: N` is invisible to the program and
  other viewers; its first paint carries N lines of styled scrollback and
  the screen, starts with CAN and is followed by `ESC[?9001h`/`l`. A paint
  over 4 MiB is dropped silently; a resize during it, or a reader far
  behind, gets a paint without history.
- `terminal.read` returns the screen's text cheaply; with history lines it
  scrolls a program on the alternate screen, which every viewer sees.
- herdr-core's own `restore_screen = true` (the user's `config.toml`,
  never written by this app) shows a kept terminal's old screen above its
  new shell after a stop of the core, below the line `-- the program above
  ended; this is a new shell --`, but nothing after a power loss.

## Goals / non-goals

Goals: what a terminal showed before its terminal core started again,
shown above the new shell in the same scrollback; nothing on disk unless
the user turns it on for a machine; hard limits the machine enforces;
nothing that types into, resizes or redraws a terminal; snapshots removed
when no longer wanted.

Non-goals: a continuous record of every byte; snapshots while no core is
connected; the output after the last snapshot; a separate viewer;
changing herdr-core's configuration.

## Design

### Capture (`backend/features/history/machine`)

The core asks the machine's agent to `capture {lines, maxTerminals,
maxTotalBytes, days}` (within 25 s); the agent snapshots the live
terminals of its instance's own terminal core, never the user's:

1. It takes the snapshots' lease (another writer makes it answer `busy`)
   and prunes incomplete and expired generations.
2. It drops snapshots of terminals that ended with their program (any
   reason but the core's own end). A terminal gone from the records keeps
   its snapshots for 2 minutes, so a page can hand them to the terminal
   that replaced it (adopt). Then the oldest-captured terminals go until
   the limits hold.
3. For each live terminal, oldest-captured first: a new program (pid)
   turns the current generation into the previous one; an unchanged screen
   (a hash of `terminal.read` without lines) is skipped, as is one refused
   before with the same screen and limits; otherwise it attaches as an
   observer, reads the first paint (CAN up to `ESC[?9001`), asks again with
   half the lines (down to 100) when the paint was dropped or exceeds
   2 MiB, and again with the new grid (at most 3 times) when the core
   repainted. Window titles are stripped and the generation written,
   marked `restored` when the paint shows herdr-core's restored-screen
   line.

The answer counts captured, skipped, failed (with codes such as
`no_paint`, `too_large`, `repainted`, `limit`, `timeout`), evicted and
removed terminals. One failure does not stop the others.

### Generations

A terminal has a current generation (the running program's) and at most
one previous (the program before). A terminal the page started in place
of another ([33](33-workspace-restore.md)) receives that one's newest
generation as its previous one when the page adopts it.

### Storage and limits

Snapshots live in the machine's database ([38](38-sqlite-state.md)),
table `history_snapshots`, one row per generation with its description
and bytes. Each change is its own durable transaction, so readers take no
lock. Writers hold a lease (`history_lease`) shared by the agents of an
instance; it ends when the writer closes, its process is gone, or a minute
after its last renewal.

| Limit | Setting (per machine) | Default | Hard bounds |
| --- | --- | --- | --- |
| Lines of history above the screen per snapshot | `history.lines` | 2000 | 100–10000 |
| Bytes per generation | – | – | 2 MiB |
| Generations per terminal | – | – | 2 |
| Terminals with snapshots | `history.maxTerminals` | 32 | 1–128 |
| Space of all snapshots | `history.maxTotalMB` | 64 | 1–512 MB |
| Days a snapshot is kept | `history.days` | 7 | 1–30 |
| Seconds between captures | `history.interval` | 30 | 10–600 |

The agent clamps what the core asks to these bounds
(`agentproto.History*`).

### The scheduler (`backend/features/history/scheduler.ts`)

A machine keeps snapshots while `history.capture` (off by default, per
machine; `--history-capture`) and the plugin are on. The core asks for a
capture `history.interval` seconds after the last one ended, one at a
time per machine. A machine that no longer keeps snapshots is asked to
clear them, retried with back-off up to an hour and on reconnect; the
clear is audited as `history.clear`. A `--read-only` core asks its
machines for nothing.

### Routes

- `GET /api/m/{id}/p/history`: the snapshots (current and previous
  generation's description) and `restoreScreen`, whether the user's
  herdr-core configuration has `restore_screen = true` (read, never
  written).
- `GET /api/m/{id}/p/history/read?terminal=&generation=current|previous`:
  one generation's bytes (at most 2 MiB) as an `application/octet-stream`
  attachment with `nosniff`, a sandboxing CSP and `no-store`, its grid,
  pid, time and lines in `X-History-*` headers.
- `DELETE /api/m/{id}/p/history[?terminal=]`: removes one terminal's
  snapshots or all; refused read-only, audited.
- `POST /api/m/{id}/p/history/adopt?from=&to=`: `to` (a terminal in the
  core's records) gets `from`'s newest generation as its previous one,
  unless it has a later one; `from`'s snapshots go either way. Nothing
  grows, so the limits hold. Refused read-only, audited as
  `history.adopt`.

Listing and reading prune expired generations first. Addresses are
checked on the core and on the machine; errors carry codes, never paths.

### Showing a snapshot (`web/src/plugins/history`)

The page lists the snapshots of each machine with `history.capture` on
(`follow.ts`), again after a terminal got a new program or appeared
(throttled, not while hidden). For each terminal leaf `chooseSnapshot`
picks what it showed before:

- its own generation of the previous program (the current one until the
  new program is captured, then the previous one), except where
  herdr-core restored the screen itself (`restored`, or `restoreScreen`
  until the new program is captured);
- else, for a leaf that replaced another terminal (`before`), that
  terminal's newest generation. A writable page then adopts it into the
  leaf's terminal once.

The page reads the bytes once and hands them to the pane as its prelude
(`state/preludes.ts`, [26](26-web-terminals.md)), with the note
`-- output saved <time>; the program above has ended --`. The pane
writes the prelude into each new emulator at the snapshot's grid, then a
complete reset, the dim note and a blank screen, before the first byte of
the stream; the emulator then returns to the pane's grid, so the saved
lines are ordinary scrollback (find, selection, copy). The emulator's
answers, titles, clipboard writes, bells and synchronized-output holds
from the prelude are dropped. A prelude that changes re-attaches the pane
once. Failed lists and reads retry with back-off; preludes stay while a
machine reconnects.

The plugin's settings page shows what the machine keeps, whether
`restore_screen` is on, and **Clear Saved Output** (`SettingsExtra.tsx`).

### Retention

Snapshots go when older than `history.days`, when their terminal ended
with its program or has been gone for 2 minutes, when adopted, to make
room, when the machine no longer keeps snapshots, and with **Clear Saved
Output**. They outlive the setting with a `--read-only` core (they age
out), on a machine no longer connected (until an agent starts there
again), while a clear keeps failing, and in backups of the agent's data
directory. Another core of the same instance whose setting is on keeps
writing the same database.

## Alternatives considered

| Option | Why not |
| --- | --- |
| herdr-core's `restore_screen` alone | The user's setting in a shared file this app does not write; off by default and empty after a power loss. The plugin reads it and leaves the terminals it restored to it. |
| `terminal.read` text as the snapshot | No styles, and with history it scrolls alternate-screen programs for every viewer. It serves only to detect a changed screen. |
| Recording every byte continuously | A stream per terminal at the busiest program's speed and an ever-growing file; a periodic snapshot is what an emulator would rebuild anyway. |
| A separate viewer of saved output | It would sit apart from the terminal's scrollback, find and selection. |
| Snapshots kept by the core | Only machines connected while they run, sent at every capture; the machine keeps its own output. |
| Snapshots on by default | Terminal output holds secrets; writing it to disk is the user's choice per machine. |
| Waiting for output to pause after the paint | Made a capture of 20 terminals take seconds. |

## Failure modes

- **The terminal core does not run** → `not_running`, logged once.
- **A paint dropped or too large** → retried with fewer lines;
  `no_paint` or `too_large` (remembered for that screen).
- **A resize during the paint** → retried with the new grid; `repainted`
  after 3 times. A grid that changes and changes back cannot be told and
  may lose the history.
- **No room in the limits** → `limit`; otherwise the oldest-captured go.
- **Too many terminals for the time budget** → the rest `timeout`; the
  next capture starts with them.
- **Another agent of the instance captures** → `busy`; so does another
  core's capture through the same node that ended less than 10 s ago, so
  the cores of a machine capture it about once per interval between them
  ([39](39-nodes.md)).
- **A snapshot at another grid** → written at its own grid, then resized
  with every line kept; beyond 1000 by 500 or unknown, at the pane's
  grid.
- **Power loss** → the last snapshot; the last interval may be missing.
- **`restore_screen` on, new program not yet captured** → the page trusts
  the setting until the next capture tells.
- **No writable page within 2 minutes of a replacement** → the old
  terminal's snapshots are removed and the replacement shows none.
- **The page reloaded after an adoption** → the adopted generation is
  shown by the rule of the terminal's own generations.

## Security

Terminal output can hold secrets, so nothing is written unless the user
turns `history.capture` on for a machine. Snapshots stay on that machine
in the agent's private database within limits the agent enforces; the
core reads them only for a page that passed its guards, served as bytes
that are never a document of the UI's origin. Capturing never types into,
resizes or redraws a terminal, and reads only the instance's own core. A
snapshot's bytes are a program's output and are replayed as untrusted:
nothing the emulator answers reaches the program, titles, clipboard
writes and bells are dropped, and a complete reset leaves none of their
state in the live terminal ([26](26-web-terminals.md)). A program that
prints herdr-core's restored-screen line can hide its predecessor's
snapshot from view (not from disk). The adopt and clear routes are
refused read-only and audited. See [SECURITY.md](../../SECURITY.md)
(terminal history).

## Testing

- `backend/features/history/machine.test.ts` with a scripted core
  (`testdata/fakecore.ts`): capture, paint end, dropped and oversized
  paints, rotation, the limits (clamped, `maxTerminals`, `maxTotalBytes`,
  days), the database (private, newer versions), the lease (two captures
  at once), failures that change nothing, adoption and the grace of a
  terminal gone; the chat host's terminal is never captured.
- `backend/features/history/integration.test.ts` (`make it`): a real
  herdr-core; the stored bytes start with CAN, hold no titles or
  `ESC[?9001`, and carry exactly the history asked for.
- `backend/features/history/history.test.ts`: route guards, scheduling,
  clears (`clears when turned off`), the adopt route (`adopt`);
  `backend/shared/proto/agentproto/agentproto.test.ts` (the History
  messages).
- `web/src/__tests__/history.test.ts` (choice, follower, schedule,
  adoption, retries), `historySettings.test.tsx`, `termPane.test.ts`
  (preludes).
