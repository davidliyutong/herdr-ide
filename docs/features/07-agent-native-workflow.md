# 07 · Agent-native workflow

## Context

The user runs several coding agents (Claude Code, Codex, Kimi, …) across
machines at once. The scarce resource is attention: knowing which agent is
waiting for a confirmation or has finished, reaching it quickly, and moving
context (code, images) to it.

## Goals / non-goals

Goals: a cross-machine view of agents ordered by how much they need the
user, those in terminals and those of chats alike; notifications when an
agent blocks or finishes; starting agents and feeding them context from
the IDE.

Non-goals: interpreting agent output, answering approval prompts
automatically, scheduling agents.

## Design

### States

The machine's agent identifies the coding agent in each terminal and reads
its state from the screen with herdr's rules: `idle`, `working`, `blocked`,
`done`, `unknown` ([25](25-agent-detection.md)). A status the program
reports itself (OSC 7501) counts too. Terminal records carry `agent` and
`agent_status`; the core sends `agent` messages on `/ws`.

A `done` turn becomes seen (`idle`) when its terminal gets the focus in a
client: the page reports focus on the terminal's stream
([22](22-terminal-protocol.md)).

A chat pane ([37](37-agent-chats.md)) has its chat's status, which the chat
host computes (`blocked`: a permission, question or plan waits). The core
publishes a chat's change to `blocked` or `done` as an `agent` message with
`chat` in place of the terminal; the page finds the pane that shows it
(`ViewStatusDef.paneOf`, [27](27-plugins.md)). Chats count in everything
below like terminals, after terminals of the same status; a chat becomes
seen when its pane is shown and focused while done.

### Inbox and jumping

- The sidebar's **Agents** section lists agents in `blocked` or `done`
  across the followed machines, blocked first, with workspace, tab, terminal
  title and machine, and a count of working agents.
- Workspaces, tabs and pane headers show the most urgent status of their
  agents.
- **Go to Agent Needing Attention** (`app.agentAttention`; `cmd+shift+a` in
  the desktop app on macOS, `ctrl+shift+a` elsewhere) shows and focuses the
  most urgent agent. Opening an agent from the inbox or a notification does
  the same.

### Notifications, badge and sounds

`web/src/notify.ts`, `web/src/sound.ts`. Four settings of the core
([13](13-settings-and-appearance.md)); the three switches are on by
default:

- `notifications.system`: a system notification on a change to `blocked`
  or `done`, one per terminal or chat, while the page is hidden or
  unfocused. It says where the agent is; clicking it focuses the pane (or
  opens the chat or panel it names). The desktop app shows native
  notifications through its validated bridge
  (`desktop/src/notifications.ts`, [16](16-desktop-packaging.md));
  browsers use the Web Notification API, asking permission on the first
  gesture or from Settings. A visible page shows a toast for `blocked`
  unless that pane has the focus.
- `notifications.badge`: the title and the app badge (`navigator.setAppBadge`)
  count blocked agents, unopened chats included. In the desktop app this is the Dock, taskbar overlay
  or Unity launcher badge ([16](16-desktop-packaging.md)).
- `notifications.sound`: a request chime on `blocked`, a done chime on
  `done`, unless the terminal is on screen in a focused page. The chimes are
  synthesized with Web Audio, so no audio files ship.
- `notifications.mutedAgents`: agents that never sound (default `droid`).
  Their notifications and badge count still follow the other settings.
- A muted tab or workspace ([04](04-layout-and-keyboard.md)) makes no sound
  and no notification; the badge still counts its blocked agents.
- An agent is announced blocked once until the user looks at its pane:
  blocked again within 10 minutes of the last announcement, it makes no
  sound or notification. An agent that fails and retries keeps reporting
  `error`, which counts as `blocked` (Antigravity at a quota reports it at
  every retry), and announced every time it would chime on and on.

Only one browser sounds. Each page reports when it is used (`active` on the
WebSocket, as durations so browser clocks do not matter). The core marks
`agent` messages with `sound: true` only for the most recently used page,
which then applies its own settings. Browsers start audio only after a
gesture, so a page never clicked may stay silent; the desktop app's main
window allows autoplay.

### Starting agents

The palette offers the agent kinds of the registry (`backend/shared/agents/kinds.ts`,
[35](35-agent-native-view.md)). The focused pane is split to the right and
the kind's command line runs there (`terminal.run`) in the focused
terminal's directory, or in a new tab when no pane has the focus. The
new-tab menu and `chat.new` start a chat instead ([37](37-agent-chats.md)).

### Context to agents

VS Code's *Send to Agent* pastes `@file:lines` and the selection into a
terminal without submitting (`web/src/lib/bridge.ts`):

- It goes to an agent of the VS Code pane's tab, else of its workspace
  (those waiting for input first), else the workspace's terminal focused
  last. It never crosses into another workspace; without a target a note
  names the workspace.
- The page that shows the sending VS Code window handles it
  ([05](05-vscode-panes.md)). A window no page shows is handled by the page
  with the keyboard.
- The paste goes through the terminal's stream, bracketed when the program
  asked. Pasted or dropped images are uploaded and their paths typed
  ([06](06-quick-look-and-files.md)).

### Review

A pane header's buttons (and the palette's `code.diff`, `code.gitGraph`)
open the repository's multi-file diff and Git Graph in VS Code, split to
the right ([05](05-vscode-panes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A prompt box sending text to an agent in a terminal | The terminal is the prompt; a second input hides the agent's own UI. A chat has a composer because its agent runs headless ([37](37-agent-chats.md)). |
| Sound files | Need an asset and its license notice; synthesized chimes need neither. |
| Every browser plays | Several open browsers or tabs would all sound at once. |
| Web Push for closed tabs | Needs a push service and subscription storage; there are no user accounts. |

## Failure modes

- Agents the rules cannot classify show `unknown` and never notify.
- Browser notifications need permission and a secure context; the desktop
  app's are native.
- The chosen browser may be one the user walked away from; its sounds play
  there.

## Testing

- `backend/features/terminals/terminals.test.ts` (`agents`) and
  `integration.test.ts` (`agent detection`): agent messages, seen by focus;
  `backend/kernel/pages.test.ts` (`sound page`): the sounding browser.
- `web/src/__tests__`: `terms.test.ts` (attention order),
  `sidebarMachines.test.ts` (inbox, workspace dots), `codePanes.test.ts`
  (*Send to Agent* targets), `sound.test.ts`, `notify.test.ts` (the
  switches, permission, badge clearing), `viewStatus.test.tsx`,
  `notifyViews.test.ts`, `notifyDispatch.test.tsx`, `attention.test.tsx`
  (chats in dots, badge and attention; notification dispatch and
  click-to-focus).
