# 33 · Workspaces after the terminal core starts again

## Context

A machine's terminals live in its terminal core ([21](21-terminal-core.md)), which outlives the browser, the app and the agent, but not a reboot, a logout that ends the user's processes, or **Stop terminal core…**. The layout document ([22](22-terminal-protocol.md)) survives on disk, but it names terminals by address, and a page drops terminals that no longer run ([04](04-layout-and-keyboard.md)). Without restore, the workspaces came back empty and the coding agents' conversations out of view, although Claude Code and Codex keep them on disk and can continue them.

herdr-core gives the building blocks:

- documents persist in its state directory with their versions;
- an address is never reused;
- a terminal started with `keep: true` whose program was lost with the core gets a new shell at the same address, in its last directory (events `lost`, `restarted`); an exit with a code or a kill stays final;
- a finished terminal's record stays for 24 h with a `reason`.

## Goals / non-goals

Goals: after the terminal core starts again, every workspace and tab is as it was, each terminal a shell in its directory; a resumable agent is back in its pane, in its own session when the machine confirms it, else in the directory's latest; nothing from the layout document is run as a command; several pages on one machine restore it once.

Non-goals: restarting other programs (builds, editors, servers), shell history or environment; restoring from a read-only page. The output that was on the screen is the terminal history's ([36](36-terminal-history.md)).

## Design

`web/src/restore.ts` holds the rules as pure functions over the layout; `web/src/state/terms.ts` (`TermModel`) applies them.

**Kept terminals.** The page starts every terminal with `keep: true`, so herdr-core itself restarts a shell at the same address. The leaf still names it; while a kept terminal is restarting (`keptWhileRestarting`, non-`finished` state such as `lost`), it is never pruned from the layout. An open page reattaches when the machine is back, a pane whose stream closed because the core or host ended reopens even if the restarted shell reuses the same pid, and a pane that exhausted attach retries while waiting for a restarted shell reattaches when the new program arrives or the tab is shown again ([26](26-web-terminals.md)).

**Terminals that ended with their core, or an empty core.** A finished terminal whose `reason` is `stopped_by_restart`, `holder_lost`, `server_stop` or `host_shutdown` ended because its core or machine did (`endedWithCore`). Its pane is not closed. Likewise, if a machine was powered off or disabled longer than herdr-core retains finished records and the core starts with no terminal records at all (`missingOnEmptyCore`), the layout's terminals stay rather than being pruned; if the core also starts without a layout document after an open page already loaded one, the page recovers the workspaces from memory. A writing page that reads the layout (`TermModel.restore`):

1. starts a replacement with `terminal.run`, `keep: true`, in the directory the terminal core recorded for the old terminal (or its workspace's directory when the old record is gone);
2. puts the replacement's address in the leaf (`replaceTerminal`: same place, splits, focus and `session`) and writes the layout with `doc.set` at the version last read;
3. once that write succeeded, removes the old record (`terminal.rm`).

A page whose layout no longer names the old terminal by then (another page won) ends its own replacement (`terminal.kill`). Versioned `doc.set` is what makes several pages converge on one replacement.

**Disabling and re-enabling a remote machine.** Disabling a machine (even while it is offline or after stopping its terminal core) preserves its layout, terminal history snapshots, open file tabs, editor view states and unsaved edits. On the hub, the machine's terminal backend rests while disabled without retry churn; re-enabling the machine clears any prior stopped-core flag (`Backend.resetStopped`) so the terminal core starts automatically once the machine connects. In the page, `TermModel` keeps the loaded layout while clearing per-connection sync state, pending `AGENT_FORGET_MS` timers and in-flight writes until the reconnected core's layout is loaded again (retrying transient `doc.get` failures with bounded back-off), so stale timers or pre-sync snapshots never wipe remembered agents or close tabs. Open file editors, previews, media panes, the file explorer and chat panes automatically reload or wake as soon as the machine and its terminal core return to `ready`.

**Agents.** The layout never starts a program. For an agent kind that can be resumed, the page types the kind's own command into the new shell, from the agent kind registry ([35](35-agent-native-view.md); `resumeCommand` in `web/src/conversation/kinds.ts`):

| Agent    | Session confirmed      | Otherwise             |
| -------- | ---------------------- | --------------------- |
| `claude` | `claude --resume <id>` | `claude --continue`   |
| `codex`  | `codex resume <id>`    | `codex resume --last` |

- While a terminal runs one of these agents ([25](25-agent-detection.md)), its leaf remembers `agent`, `pid` and, when the machine found the agent's session from its own process (never a guess from the directory's newest transcript), `session` (`rememberAgents`, `rememberedSession`).
- An agent no longer seen is forgotten after 30 s (`AGENT_FORGET_MS`): a quit agent is not resumed, while a machine going down, whose programs end before its connection does, keeps the memory.
- A live terminal with another pid than remembered lost its agent with its program: the leaf gets `resume: <agent>`. A replacement inherits `resume` from the old leaf's `agent`. The pid check, rather than the `restarted` event, lets a page opened later see it too.
- A writing page with an attached pane of that terminal (shown or kept hidden) first asks the machine `GET /api/m/{id}/p/agents/resolve` whether the leaf's session exists and ran in the terminal's directory (`confirmSession`, retrying transient `429`/`502`/`503`/`504` responses within its 3 s limit so restoring many agent tabs at once does not drop session IDs). It then takes `resume` out of the leaf and, once the terminal core accepted that layout, types the command with a return (`TermModel.resumeAgent`): by the session's id when confirmed, else the directory's latest. The versioned write ensures one page types it, and only while the terminal still runs what it ran when asked (its shell); if startup commands ran in the foreground during attach, `TerminalView` retries automatically once the foreground returns to the shell prompt.

The machine is asked before the request leaves the layout, so a page closed while waiting loses nothing. Two agents of one kind in one directory thus come back in their own conversations.

**Chats and terminals** ([37](37-agent-chats.md)). **Continue in Terminal** of a chat pane opens a shell tab in the chat's directory whose leaf carries the chat's `session` and `resume` (`resumeInTerminal`, `web/src/agentTerminal.ts`); the same mechanism types the command. Until the agent is detected there, that leaf marks the terminal as the one about to run the session (`sessionTerminal`), so a second handoff shows it instead of starting another process. In the other direction, while a leaf still remembers a quit agent's session, the pane's header offers **Continue in Chat**.

**Read-only pages** restore nothing: no replacement, no layout write, no typing.

## Alternatives considered

| Option                                            | Why not                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Restoring in the hub                              | The layout document belongs to the clients ([22](22-terminal-protocol.md)); the hub passes it on unread.            |
| Storing the command in the leaf                   | Any writing client writes the document; a command taken from it would be typed into another page's shell.           |
| Starting the agent as the terminal's program      | The pane would close when the agent exits; typed into a shell, it behaves as if the user started it.                |
| Only the directory's latest conversation          | Two agents of one kind in one directory continued the same conversation.                                            |
| Resuming the leaf's session unconfirmed           | A session another client wrote, or one from another directory, would bring back a conversation this pane never had. |
| Restarting every program                          | A command line says nothing of what it had done; rerunning a build, migration or server unasked is not safe.        |
| Forgetting an agent as soon as it is not detected | A shutdown ends programs before the connection; the memory would be lost seconds before it is needed.               |
| No `keep`, the page replaces every terminal       | Needs an open page and changes every address; kept terminals come back without one.                                 |

## Failure modes

- **No writing page open when the terminal core restarts:** kept terminals have shells; terminals that ended with the core are replaced when a writing page next reads the layout. After 24 h, if no terminal records remain on the core (`missingOnEmptyCore`), a writing page still restores the layout's terminals in their workspace directories rather than pruning them.
- **Two pages restore at once:** one `doc.set` wins; the other page ends its replacement, which no leaf names.
- **`terminal.run` fails:** the pane stays on the finished terminal; the next layout read retries.
- **The machine does not confirm the session** (no transcript, another directory, plugin off, no answer in 3 s): the directory's latest is continued.
- **The agent is not on `PATH`, or cannot resume:** the shell or agent says so; nothing is retyped.
- **The agent was quit less than 30 s before the terminal core ended:** it is resumed.

## Security

The layout document is writable by every writing client of the machine. From it the page takes only an agent id, which selects the registry's fixed commands, and a session id, which reaches a command only as a lower-case UUID and only after the machine confirmed it for the terminal's directory (the machine opens no path the request names). No other text of the document is typed or run. A replacement starts the machine's shell (no `argv`) in the directory the terminal core recorded. Read-only pages restore nothing, and the methods involved (`terminal.run`, `terminal.rm`, `terminal.kill`, `doc.set`) are refused to them. See the row for terminals restored from the layout in [SECURITY.md](../../SECURITY.md).

## Testing

- `web/src/__tests__/restore.test.ts`: ended-with-core vs. ended program; agent memory and its 30 s timeout; `resume` set and consumed once; leaf replacement keeping focus; offline -> disable -> re-enable -> reboot preserving kept/restarting terminals, empty-core recovery, `doc.get` retries, agent sessions and file tabs; with a scripted core, replacements in their directories and the resume command typed once.
- `restoreSession.test.ts`: the remembered session, the confirmation and its time limit (with transient `429`/`503` retries), two agents of one kind resumed in their own sessions, nothing typed when the write lost or the terminal runs something else.
- `remoteRecovery.test.tsx`: `EditorPane` (error auto-reload, saved view state, unsaved drafts), `PreviewPane`, `MediaView`, gone-file polling and `ChatSourceImpl` across remote offline/disable/re-enable cycles.
- `chatHandoff.test.ts`, `chatImport.test.tsx`: Continue in Terminal and Continue in Chat.
- `termPane.test.ts`, `terminalViewProgram.test.tsx`: a pane reattaching when its terminal has a new program, prelude replay across grids, slow-attach paint timing, exhausted-retry and core-ended same-pid recovery, and automatic agent resume when shell startup foreground finishes.
- `backend/features/terminals/terminals.test.ts`: disabling a machine with a stopped terminal core rests quietly and re-enabling starts the core again automatically.
- `terms.test.ts`, `menus.test.ts`, `codePanes.test.ts`, `paneHeader.test.ts` pin `keep: true` on `terminal.run`.
- Checked by hand with real reboots of a Debian 12 VM as an ssh machine of a dev hub: layout intact, kept terminals live at their addresses and directories, the agents' commands typed once, with the page reloaded after the reboot and left open across it.
