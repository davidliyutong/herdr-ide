# 33 · Workspaces after the terminal core starts again

## Context

A machine's terminal core ([21](21-terminal-core.md)) does not outlive a reboot, a logout that ends the user's processes, or **Stop terminal core…**. The layout document ([22](22-terminal-protocol.md)) survives but names terminals by address, and a page drops terminals that no longer run ([04](04-layout-and-keyboard.md)). herdr-core never reuses an address, gives a `keep: true` terminal whose program was lost with the core a new shell at its address and directory, and keeps a finished terminal's record with its `reason` for a day. Claude Code, Codex and Antigravity (`agy`) can continue their conversations.

## Goals / non-goals

Goals: every workspace and tab back, each terminal a shell in its directory; a resumable agent back in its pane and session; nothing from the layout document run as a command; several pages restore a machine once.

Non-goals: restarting other programs, shell history or environment; restoring from a read-only page; the screen's output ([36](36-terminal-history.md)).

## Design

`web/src/restore.ts` holds the rules over the layout; `TermModel` (`web/src/state/terms.ts`) applies them. Read-only pages restore nothing.

**Terminals.** The page starts every terminal with `keep: true`, so herdr-core itself restarts its shell; the leaf is kept meanwhile (`keptWhileRestarting`) and open panes reattach ([26](26-web-terminals.md)). A terminal that finished because its core or machine ended (`endedWithCore`), or has no record because the core started empty (`missingOnEmptyCore`), keeps its pane: a writing page starts a replacement shell in its directory, puts its address in the leaf (`replaceTerminal`) with a versioned `doc.set`, then removes the old record; a page whose write lost ends its replacement, so pages converge on one. A disabled machine keeps its layout; re-enabling it starts its terminal core again (`Backend.resetStopped`).

**Agents.** The layout never starts a program. While a terminal runs a resumable agent ([25](25-agent-detection.md)), its leaf remembers `agent`, `pid` and the `session` the machine found from the agent's own process (never a guess). An agent no longer seen is forgotten after `AGENT_FORGET_MS`, longer than a machine takes to go down, so a quit agent is not resumed. A terminal with another pid than remembered gets `resume: <agent>` in its leaf, which a replacement inherits. A writing page with the terminal attached asks the machine whether the session ran in that directory (`confirmSession`, `…/p/agents/resolve`), takes `resume` out of the layout and, once that write is accepted, types the kind's command from the registry ([35](35-agent-native-view.md); `resumeCommand` in `web/src/conversation/kinds.ts`): by session id when confirmed (`claude --resume <id>`), else the directory's latest (`claude --continue`). The versioned write makes one page type it, only while the terminal still runs its shell; a page closed before the write loses nothing.

**Chats** ([37](37-agent-chats.md)). **Continue in Terminal** opens a shell tab whose leaf carries the chat's `session` and `resume` (`resumeInTerminal`, `web/src/agentTerminal.ts`); a leaf remembering a quit agent's session offers **Continue in Chat**.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Restoring in the hub | The layout document belongs to the clients ([22](22-terminal-protocol.md)); the hub passes it on unread. |
| Storing the command in the leaf | Any writing client writes the document; its command would be typed into another page's shell. |
| Starting the agent as the terminal's program | The pane would close when the agent exits. |
| Resuming the leaf's session unconfirmed | A session another client wrote, or from another directory, would bring back a conversation this pane never had. |
| Restarting every program | Rerunning a build, migration or server unasked is not safe. |

## Failure modes

- **No writing page open when the core restarts**: kept terminals have shells; the others are replaced when a writing page next reads the layout.
- **The machine does not confirm the session in time**: the directory's latest is continued.

## Security

Any writing client of the machine can write the layout document. The page takes from it only an agent id, which selects the registry's fixed commands, and a session id, which reaches a command only as a lower-case UUID the machine confirmed for the terminal's directory. A replacement starts the machine's shell (no `argv`) in the directory the core recorded. Read-only pages are refused the methods involved ([SECURITY.md](../../SECURITY.md), terminals restored from the layout).

## Testing

- `web/src/__tests__/restore.test.ts` (with a scripted core: replacements, agent memory, `resume` consumed once, disable and re-enable, an empty core), `restoreSession.test.ts` (confirmation), `remoteRecovery.test.tsx`, `chatHandoff.test.ts`, `terms.test.ts` (`keep: true`).
- `backend/features/terminals/terminals.test.ts`: re-enabling a machine starts its core again.
