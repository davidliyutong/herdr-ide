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
agent that can continue a conversation is back in its pane, in the
session it ran when the machine confirms it, else in the directory's
latest, without the user typing; nothing a client wrote into the layout
document is run as a command; several pages open on one machine restore
it once.

Non-goals: starting any other program again (a build, an editor, a
server, a shell's history or environment); restoring a session the
machine does not confirm for the terminal's directory; restoring from a
read-only page. The output that was on the screen is the terminal
history plugin's ([36](36-terminal-history.md)).

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
([26](26-web-terminals.md)). A stop of the terminal core ends the
programs, and their panes show that the program ended; once the core
started a new shell at a kept terminal's address (its record live with
another pid), the pane attaches again by itself, so the agent is resumed,
and the saved output shown ([36](36-terminal-history.md)), without
reloading the page.

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
  (`replaceTerminal`: the pane keeps its place, its splits, its
  `session` and, if it had it, the focus, and says
  `before: <old address>`), the layout is written through `doc.set` with the
  version last read, and once that write succeeded (or a read shows a
  layout naming the replacement) the old record is removed
  (`terminal.rm`); a write that lost keeps it, so that the layout that
  won can start it again;
- a page whose layout no longer names the old terminal by then (another
  page's replacement took the place) ends its own replacement
  (`terminal.kill`). A page starts one replacement per terminal at a
  time.

**Agents.** A program is never started again by the layout. For an agent
that can continue a conversation, the page types the agent's own command
into the new shell, from the agent kind registry
([35](35-agent-native-view.md); `web/src/conversation/kinds.ts`,
`resumeCommand`): the kinds that can be brought back are those with a
command that continues the directory's latest conversation.

| Agent | Session confirmed | Otherwise |
| --- | --- | --- |
| `claude` | `claude --resume <id>` | `claude --continue` |
| `codex` | `codex resume <id>` | `codex resume --last` |

- While a live terminal runs one of these agents
  ([25](25-agent-detection.md)), its leaf remembers `agent` (the agent's
  id) and `pid` (the pid of the terminal's program then), written with
  every change of the terminals (`rememberAgents`, `TermModel.remember`).
  When the machine found the agent's session from its own process (its
  command line, its record of the process, the transcript it holds open,
  the only session made in its directory since it started, or a hook;
  never `guess`, the directory's newest transcript, which may be another
  terminal's; `rememberedSession`), the leaf also remembers `session`. It
  follows the record when the agent starts another session (`/clear`). A
  record that names no session, or only a guess, leaves the leaf's as it
  is until a record names another; the session is dropped when another kind
  of agent runs in the terminal, and forgotten with `agent`.
- A terminal seen without its agent keeps the leaf's `agent` (and
  `session`) for 30 s (`AGENT_FORGET_MS`) and loses them then: an agent
  the user quit is not resumed, while a machine going down, whose
  programs end before the connection does, takes less than that and
  leaves the leaf as it was.
- A live terminal whose program has another pid than the leaf remembers
  has lost the agent with its program (the core gave it a new shell): the
  leaf drops `agent` and `pid`, keeps `session` and says
  `resume: <agent>`. A replacement for a terminal that ended with its
  core gets `resume` from the old leaf's `agent` the same way, and keeps
  its `session`.
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
  shows it. A `resume` that names no kind that can be brought back is
  removed and nothing is typed. The request is taken from the layout only
  while the terminal's pane is attached at that moment (not while it
  attaches again for a prelude, [26](26-web-terminals.md), not after it
  was unmounted) and the terminal runs what it ran when the request was
  made: the same program, with the same program, or its shell, in the
  foreground (`sameProgram`). Otherwise the request stays for the pane's
  next attach. Once taken, the command is typed only if that still holds
  when the layout is written; otherwise nothing is typed. Text typed
  while the pane attaches again for a prelude waits for the new stream.
- Before taking a `resume` whose leaf names a session (`resumeSession`),
  the page asks the machine `GET /api/m/{id}/p/agents/resolve` with the
  agent, the session and the terminal's directory (`confirmSession`). With
  `ok` it types the kind's command that resumes the session by its id;
  with any other answer, the agents plugin off, a failed request, or no
  answer within 3 s (`RESOLVE_TIMEOUT_MS`), it types the command that
  continues the directory's latest, as for a leaf without a session. The
  question comes before the request is taken out of the layout: the
  answer only chooses between the kind's two commands, the versioned
  write still decides whether anything is typed, and the layout never says
  the agent is back while the page waits. The command is made from the
  layout as it is when the answer came, by the id only while the leaf
  still names the agent and the session that were confirmed. While a
  question is on its way for a terminal, other calls for it only give the
  newest pane to type into. Two agents of one kind that ran in one
  directory thus each come back in their own conversation.

**A chat's session continued in a terminal** ([37](37-agent-chats.md)).
**Continue in Terminal** of a chat pane uses the same request: once the
chat host ended the chat's headless agent, the page starts the machine's
shell in a new tab in the chat's workspace and directory (`terminal.run`
with `keep: true` and no `argv`, `web/src/agentTerminal.ts`
`resumeInTerminal`), whose leaf gets, in the write that places it, the
chat's `session` and `resume: <agent>`. Its pane then types the kind's
command that resumes the session by its id, after the machine confirmed
it for the directory as above, else the directory's latest. The shell
stays when the agent exits. Until the machine detects an agent in that
terminal, the leaf's session marks it as the terminal about to run the
session (`sessionTerminal`): another handoff or an import of that
session shows it instead of starting a second process on the session,
and the page's handoff stays under way until the agent is detected, the
terminal ends or 15 s pass.

**A terminal's session continued in a chat.** While a leaf remembers its
agent and session after the agent quit (the 30 s of `AGENT_FORGET_MS`)
and no agent runs in the terminal, the pane's header offers **Continue in
Chat** for a kind with chats: the session is opened as a chat, its
earlier conversation imported ([37](37-agent-chats.md)).

**Read-only pages** restore nothing: they start no replacement, write no
leaf and type nothing; a terminal that ended with its core is back there
once a writing page restored it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Restoring in the core (Go) when a backend connects | The layout document is the clients' ([22](22-terminal-protocol.md)): the core passes it on without reading it, and other clients of the protocol arrange terminals their own way. |
| Storing the command to run in the leaf | Every writing client of the machine writes the document; a command taken from it would be typed into a shell by another page. The leaf names an agent kind and a session id, and the registry has the commands. |
| Starting the agent as the terminal's program (`argv`) | The pane would close when the agent exits; typed into the shell, the agent runs as when the user started it there, and the shell stays when it ends. |
| Continuing only the directory's latest conversation | Two agents of one kind that ran in one directory both continued the same conversation. The session the machine found from the agent's process names the right one; the directory's latest stays the fallback when the machine does not confirm it. |
| Resuming the leaf's session without asking the machine | Every writing client writes the document: a session the agent never kept, or one that ran in another directory, would bring back a conversation this pane never had. The machine confirms that the transcript exists and ran in the terminal's directory, and only a lower-case UUID is put into the kind's own command. |
| Remembering a session the machine guessed | A guess is the directory's newest transcript, which may be another terminal's. |
| Asking the machine after the request is taken out of the layout | For as long as the machine takes to answer, the layout would say nothing is to be brought back while nothing was typed yet, and a page closed meanwhile would lose the resume. |
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
- **The machine does not confirm the session** (no transcript of it, a
  compressed one, another directory, the agents plugin off, no answer
  within 3 s) → the directory's latest conversation is continued. A
  replacement for a terminal that ended with its core starts in the
  directory the old terminal started in: when the agent ran elsewhere
  (the user changed directory first), the machine answers `other_cwd`
  and the latest of the start directory is continued.
- **The command fails** (a session the agent can no longer resume) → the
  agent says so in the pane; the leaf keeps `session`, nothing is typed
  again.
- **No session was found while the agent ran** (Codex before its first
  prompt, a guess, the agents plugin off) → the leaf has none, and the
  directory's latest is continued.
- **The user started a program in the new shell before the pane first
  attached** → the terminal ran that program when the request was made,
  so the command is still typed, into that program.
- **The user starts a program while the machine's answer is on its way**
  → the request stays in the layout, and is taken at the pane's next
  attach while the shell waits again.
- **The page is read-only** → nothing is restored (above).

## Security

The layout document is written by every writing client of the machine.
From it the page takes only an agent's id, which selects a kind of the
registry and its fixed commands, and a session id, which reaches a
command only as a lower-case UUID (checked when the document is read and
again when the command is made) and only after the machine confirmed it
for the terminal's directory; the machine only compares the directory with
the one the transcript records and opens no path the request names. No
other text of the document is typed into a shell or passed as a program. A replacement starts the machine's shell (no `argv`)
in the directory the terminal core recorded for the old terminal, not in
one the document names. Read-only pages restore nothing, and the calls
involved (`terminal.run`, `terminal.rm`, `terminal.kill`, `doc.set`) are
writing methods refused to them. See the row for terminals restored from
the layout in [SECURITY.md](../../SECURITY.md).

## Testing

`web/src/__tests__/chatHandoff.test.ts`: the handoff's shell tab with the
session and the request in its leaf, the terminal about to run the
session shown instead of a second one, the handoff kept under way until
the agent is detected or 15 s pass; `chatImport.test.tsx`: **Continue in
Chat**.

`web/src/__tests__/restore.test.ts`: a terminal that ended with its core
told from one whose program ended; an agent remembered with its pid and
forgotten only after the time without it; `resume` asked for once the
terminal runs another program, and taken once; a new terminal put in an
ended one's place, with the focus; and, with a scripted core, terminals
that ended with the core started again in their directory when the layout
is read, the pane of one whose program exited closed, and the resume
command typed once. `restoreSession.test.ts`: the session a leaf
remembers (the machine's from the agent's process, following the record,
never a guess or a value that is no session id, one the leaf named before
any record kept, another agent's dropped, kept for the resume), `before`
and the leaf's fields in a replacement, the confirmation (the question
asked, any other answer, no request for what the route would refuse, the
time limit and a later answer ignored), and with a scripted core two agents of one kind in
one directory brought back in their own sessions, Codex resumed by its
id, the latest continued without a confirmation or for a hostile session,
one question while an answer is on its way, nothing typed when the write
lost or another page took the request meanwhile, the id only while the
leaf still names the session confirmed, the request left for the next
attach when the pane is not attached or gone once the answer came, when
the terminal got another program or the user started one meanwhile, and
nothing typed when the terminal runs something else by the time the
layout is written, nothing on a read-only page. `termPane.test.ts` and
`terminalViewProgram.test.tsx`: a pane whose program ended attaching
again when its terminal has another program, and input kept while a
pane attaches again for a prelude ([26](26-web-terminals.md)).
`terms.test.ts`, `menus.test.ts`, `codePanes.test.ts` and
`paneHeader.test.ts` pin `keep: true` in the page's `terminal.run`.

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

Run in a browser against the `dev` instance on macOS with Claude Code
2.1.330: after the terminal core was stopped and started, the agent's
pane resumed its session by its id (`claude --resume <id>`). The page was
reloaded for it then, as panes did not yet attach again by themselves
after their program ended; that they do is covered by the tests above,
not by a browser run.
