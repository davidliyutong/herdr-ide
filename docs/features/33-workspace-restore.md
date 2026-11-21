# 33 · Workspaces after the terminal core starts again

## Context

A machine's terminals live in its terminal core
([21](21-terminal-core.md)), which outlives the browser, the app and the
agent. It does not outlive the machine: a reboot, a logout where logind
ends the user's processes, or **Stop terminal core…** ends the core and
every program in it. The layout document ([22](22-terminal-protocol.md))
survives, since herdr-core keeps its documents on disk, but it names
terminals by their addresses, and a page drops terminals that no longer
run from it ([04](04-layout-and-keyboard.md)): after a reboot the user
found the machine's workspaces empty and the coding agents'
conversations gone from view, although Claude Code and Codex keep every
conversation on disk and can continue one.

What herdr-core 0.1.21 gives to build on:

- documents persist in the core's state directory (`docs.json`) with
  their versions;
- a terminal's address is never given twice;
- a terminal started with `keep: true` whose program was lost with the
  core gets a new shell from the core when it runs again, at the same
  address, in the directory it was last in (events `lost` and
  `restarted`); an exit with a code and an explicit kill stay final;
- a finished terminal's record stays for 24 h with a `reason`.

## Goals / non-goals

Goals: after the terminal core starts again, every workspace and tab is
there as it was arranged, each terminal a shell in its directory; an
agent that can continue the latest conversation of a directory is back in
its pane without the user typing; nothing a client wrote into the layout
document is run as a command; several pages open on one machine restore
it once.

Non-goals: starting any other program again (a build, an editor, a
server, a shell's history or environment); restoring the output that was
on the screen; choosing which conversation an agent continues; restoring
from a read-only page.

## Design

`web/src/restore.ts` holds the rules as pure functions over the layout;
`web/src/state/terms.ts` (`TermModel`) applies them.

**Kept terminals.** The page starts every terminal with `keep: true`
(`TermModel.run`). When the core runs again without such a terminal's
program, herdr-core itself gives the terminal a new shell at its address
in its last directory. The address in the layout's leaf still names it,
so the pane is there again and nothing is started in its place. A page
that stayed open while the machine was away lost the machine's streams,
not its connection to the core: its panes attach again when the
machine's terminals are back, and an attach refused while herdr-core is
still starting the shell is tried again
([26](26-web-terminals.md)).

**Terminals that ended with their core.** A terminal the core reports
finished with the reason `stopped_by_restart`, `holder_lost`,
`server_stop` or `host_shutdown` ended because its core or its machine
did, not its program (`endedWithCore`). For such a terminal:

- its pane is not closed by the `finished` event, and its record is not
  removed (a program that ends by itself still closes its pane, and its
  record is removed, [04](04-layout-and-keyboard.md));
- a page that reads the layout keeps the leaf instead of pruning it and
  starts a replacement (`TermModel.restore`): `terminal.run` with
  `keep: true` in the directory the old terminal started in (the record's
  `cwd`);
- when the replacement runs, the leaf takes its address
  (`replaceTerminal`: the pane keeps its place, its splits and, if it had
  it, the focus), the layout is written through `doc.set` with the
  version last read, and once that write succeeded (or a read shows a
  layout naming the replacement) the old record is removed
  (`terminal.rm`); a write that lost keeps it, so that the layout that
  won can start it again;
- a page whose layout no longer names the old terminal by then (another
  page's replacement took the place) ends its own replacement
  (`terminal.kill`). A page starts one replacement per terminal at a
  time.

**Agents.** A program is never started again by the layout. For an agent
that can continue its last conversation of a directory, the page types
the agent's own command for that into the new shell:

| Agent | Command typed |
| --- | --- |
| `claude` | `claude --continue` |
| `codex` | `codex resume --last` |

- While a live terminal runs one of these agents
  ([25](25-agent-detection.md)), its leaf remembers `agent` (the agent's
  id) and `pid` (the pid of the terminal's program then), written with
  every change of the terminals (`rememberAgents`, `TermModel.remember`).
- A terminal seen without its agent keeps the leaf's `agent` for 30 s
  (`AGENT_FORGET_MS`) and loses it then: an agent the user quit is not
  resumed, while a machine going down, whose programs end before the
  connection does, takes less than that and leaves the leaf as it was.
- A live terminal whose program has another pid than the leaf remembers
  has lost the agent with its program (the core gave it a new shell): the
  leaf drops `agent` and `pid` and says `resume: <agent>`. A replacement
  for a terminal that ended with its core gets `resume` from the old
  leaf's `agent` the same way.
- A writing page that has a pane of the terminal, shown or kept hidden
  ([26](26-web-terminals.md)), takes `resume` out of the leaf and, once
  the core took that layout, types the command with a return into the
  shell (`TermModel.resumeAgent`). The versioned `doc.set` takes one
  page's write: of several pages that have the terminal, that one types,
  and the others read a layout that asks for nothing. A pane that is attached when its leaf gets
  `resume` types then (`TerminalView`'s effect on the leaf's `resume`,
  `TermPane.attached`), and one that attaches later types when it is
  attached (`onAttached`). A page left open while the machine was away
  thus types into the terminals it shows or keeps as soon as they are
  back, and a page loaded afterwards into each terminal when it first
  shows it. The command comes from the table in `restore.ts`
  (`RESUME_COMMANDS`); a `resume` that names no agent of the table is
  removed and nothing is typed.
- The conversation continued is the agent's latest of the directory. Two
  agents of one kind that ran in one directory both continue that one.

**Read-only pages** restore nothing: they start no replacement, write no
leaf and type nothing; a terminal that ended with its core is back there
once a writing page restored it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Restoring in the core (Go) when a backend connects | The layout document is the clients' ([22](22-terminal-protocol.md)): the core passes it on without reading it, and other clients of the protocol arrange terminals their own way. |
| Storing the command to run in the leaf | Every writing client of the machine writes the document; a command taken from it would be typed into a shell by another page. The leaf names an agent, and the page's table has the command. |
| Starting the agent as the terminal's program (`argv`) | The pane would close when the agent exits; typed into the shell, the agent runs as when the user started it there, and the shell stays when it ends. |
| Remembering the conversation's id | The agents' session files are theirs, in formats that change; `--continue` and `resume --last` are their own commands for the directory's latest. |
| Starting every program that ran again | A command line says nothing about what the program had done; running a build, a migration or a server again unasked is not safe. |
| Forgetting an agent as soon as it is no longer detected | A machine going down ends its programs before its connection: the leaf would forget the agent seconds before the reboot it is remembered for. |
| Knowing a new shell by the `restarted` event alone | A page that was not open when the core came back never sees the event; the pid in the leaf says the same to whichever page reads the layout next. |
| Leaving terminals without `keep` and replacing all of them from the page | Needs a page open to bring anything back, and gives every terminal a new address; kept terminals come back at their addresses without a page. |

## Failure modes

- **No writing page is open when the core starts again** → kept terminals
  have their shells; terminals that ended with the core are replaced when
  a writing page next reads the machine's layout, and an agent is resumed
  when such a page has its terminal in a pane. A finished record
  older than 24 h is gone, and its pane is then closed as an ended
  program's.
- **Two pages read the layout at once** → both start a replacement. The
  page that finds the old terminal already replaced ends its own. When
  both wrote before reading the other's, one `doc.set` wins and the other
  page reads that layout and ends its replacement, which no leaf names
  (a page remembers its replacements until its layout naming them is
  written), and starts the old terminal again if that layout still names
  it. A read answered while the page's own write is on its way may be
  from before that write: it is made again once the write is done, so it
  never ends the replacement the write names.
- **The replacement cannot be started** (the call fails) → the pane
  stays, on the finished terminal; the next read of the layout tries
  again.
- **The agent's command is not on the shell's `PATH`, or the directory
  has no conversation** → the shell or the agent says so in the pane;
  nothing is typed again.
- **The agent was quit less than 30 s before the core ended** → the leaf
  still remembers it, and it is resumed.
- **The page is read-only** → nothing is restored (above).

## Security

The layout document is written by every writing client of the machine.
From it the page takes only an agent's id, which selects a command of a
fixed table in the page; no text of the document is typed into a shell or
passed as a program. A replacement starts the machine's shell (no `argv`)
in the directory the terminal core recorded for the old terminal, not in
one the document names. Read-only pages restore nothing, and the calls
involved (`terminal.run`, `terminal.rm`, `terminal.kill`, `doc.set`) are
writing methods refused to them. See the row for terminals restored from
the layout in [SECURITY.md](../../SECURITY.md).

## Testing

`web/src/__tests__/restore.test.ts`: a terminal that ended with its core
told from one whose program ended; an agent remembered with its pid and
forgotten only after the time without it; `resume` asked for once the
terminal runs another program, and taken once; a new terminal put in an
ended one's place, with the focus; and, with a scripted core, terminals
that ended with the core started again in their directory when the layout
is read, the pane of one whose program exited closed, and the resume
command typed once. `terms.test.ts`, `menus.test.ts`, `codePanes.test.ts`
and `paneHeader.test.ts` pin `keep: true` in the page's `terminal.run`.

Checked by hand with real reboots: a Debian 12 arm64 virtual machine
(QEMU in Docker, systemd, no lingering for the user) as an ssh machine of
a dev core, rebooted three times with `systemctl reboot`. Each time the
layout document was there as written, the three kept terminals were live
again at their addresses in the directories they were last in
(`/var/log`, `~/proj-a`, `~/proj-b`), and the leaves that remembered
`claude` and `codex` had `claude --continue` and `codex resume --last`
typed once each (stand-in programs of those names took them), with the
page loaded again after the reboot and with the page left open across
it.
