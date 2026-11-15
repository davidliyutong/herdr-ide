# 07 · Agent-native workflow

## Context

The user runs several coding agents (Claude Code, Codex, Kimi, …) across
machines at once. The scarce resource is attention: knowing which agent is
waiting for a confirmation or has finished, reaching it quickly, and moving
context (code, images) to it.

## Goals / non-goals

Goals: a cross-machine view of agents ordered by how much they need the
user; notifications when an agent blocks or finishes; starting agents and
feeding them context from the IDE.

Non-goals: interpreting agent output, answering approval prompts
automatically, scheduling agents.

## Design

- **States**: the machine's agent identifies the coding agent in each
  terminal of its terminal core and reads its state from the screen with
  herdr's rules (`idle`, `working`, `blocked`, `done`, `unknown`;
  [25](25-agent-detection.md)); a status the program reports itself (OSC
  7501) counts too. The terminal records carry `agent` and `agent_status`,
  and the core sends `agent` messages on `/ws` with the terminal's address.
- **Inbox** (the sidebar's **Agents** section, at its top, translated as
  the rest of the UI: 智能体 in Chinese): agents in `blocked` or `done`
  across the machines the page follows, blocked first, with machine,
  terminal title and directory; counts of working agents. Workspaces, tabs and pane headers show the most
  urgent status of their agents. **Jump to the agent that needs
  attention** (`app.agentAttention`, in the palette and the View menu;
  `cmd+shift+a` in the desktop app on macOS, `ctrl+shift+a` elsewhere) jumps
  to the most urgent agent: its machine, workspace and tab are shown and
  its terminal focused.
- **Seen**: a turn that ended (`done`) is seen when its terminal has the
  focus in a client: the page tells the core when a terminal's input gets or
  loses the focus (`focus` on its stream), and the core reports the agent
  idle ([22](22-terminal-protocol.md)). Opening an agent from the inbox or a
  notification focuses its terminal.
- **Notifications** (`web/src/notify.ts`): a status change to `blocked` or
  `done` raises a desktop notification, one per terminal, when the page is
  hidden or not focused and the browser allows notifications (a toast when
  visible for `blocked`); clicking it focuses the agent. The title and the
  app badge (the Badging API, `navigator.setAppBadge`) count blocked
  agents: an installed PWA's icon, and in the desktop app the Dock icon on
  macOS, an overlay on the taskbar button on Windows, and the launcher icon
  on Linux in docks that implement the Unity launcher API. The desktop app
  grants the page notifications; Windows shows those of the installed app
  (its Start menu shortcut carries the app's id), and Linux needs a
  notification daemon ([16](16-desktop-packaging.md)).
- **Sounds** (`web/src/sound.ts`): the page plays a sound on the same
  transitions: `blocked` plays the request chime, `done` the done chime,
  except when the terminal is on screen (selected workspace and tab) and
  the page is visible and focused. The two chimes are synthesized with the
  Web Audio API, so no audio files are shipped. The setting **Notification
  sounds** (`notifications.sound`) is on by default; **Silent agents**
  (`notifications.mutedAgents`, a list: every agent the terminals
  recognize as a checkbox, others added by name) lists agents (matched by
  the detected agent's name or display name) that never sound and starts
  with `droid`.
  Both are settings of the core ([13](13-settings-and-appearance.md)).
- **One browser sounds**: each page tells the core when it is used
  (`active` on the WebSocket: on connect with the time since its last input,
  then on pointer, key or focus events at most every 2 s; durations, so
  browser clocks do not matter). The core marks each `agent` message with
  `sound: true` only for the page used most recently, so several open
  browsers or tabs do not all sound. That page applies its own settings; it
  stays chosen even if its sounds are off. Browsers start audio only after a
  user gesture on the page, so a page not clicked since it was loaded can
  stay silent; the desktop app's main window allows autoplay
  ([16](16-desktop-packaging.md)).
- **Starting agents**: the palette offers common agent kinds (`claude`,
  `codex`, `gemini`, `opencode`, `kimi`, `grok`, `cursor`, `copilot`,
  `qwen`, `amp`); the focused pane is split to the right and the agent runs
  in the new terminal (`terminal.run` with the agent's name as the program)
  in the focused terminal's directory, or in a new tab when no pane has the
  focus.
- **Context to agents**: VS Code's *Send to Agent* pastes `@file:lines` and
  the selection into a terminal without submitting (`web/src/lib/bridge.ts`):
  the focused terminal when the selected workspace's panel shows the sending
  window, else the agent of the workspace whose panel shows it that waits for
  input (idle or done), never another workspace's; the paste goes through
  the terminal's stream, bracketed when the program asked; pasted or
  dropped images are uploaded and their paths typed
  ([06](06-quick-look-and-files.md)).
- **Review**: from a pane, its header's buttons (and the palette's
  `code.diff` and `code.gitGraph`) open the multi-file diff and Git Graph
  of its repository ([05](05-vscode-panel.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A prompt box sending text to the agent | The terminal itself is the prompt; a second input duplicates it and hides the agent's own UI (approvals, slash commands). |
| Sound files | Shipped audio needs an asset and its license notice; synthesized chimes need neither. |
| Every browser plays | With several browsers or tabs open, each would sound at once. |
| Web Push for closed tabs | Requires a push service and subscription storage; the reverse-proxy model has no user accounts. |

## Failure modes

- Agents the rules cannot classify show `unknown` and never notify.
- Notifications need permission (asked on the first click) and a secure
  context.
- The chosen browser may be one the user has walked away from (another
  browser was opened earlier and not used since); its sounds play there.

## Testing

`TestTermAgents` (`internal/server`) and `TestIntegrationDetect` cover the
agent messages and the seen marking by focus ([25](25-agent-detection.md)).
`web/src/__tests__/terms.test.ts` covers the attention order,
`sidebarMachines.test.ts` the inbox and the workspaces' dots,
`workspaceDock.test.ts` where *Send to Agent* goes, and
`web/src/__tests__/sound.test.ts` which sound a status change plays
(suppression, muted agents, the chosen browser);
`TestSoundClientMostRecentlyActive` (`internal/server`) the choice of the
browser. An agent's
working, blocked and done states in the sidebar, a tab,
a pane header and a toast were checked in headless Chromium against a dev
core with a script named like Claude Code.
