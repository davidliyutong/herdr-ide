# 07 · Agent-native workflow

## Context

The user runs several coding agents across machines at once. The scarce resource is attention: knowing which agent waits for a confirmation or has finished, reaching it quickly, and moving context to it.

## Goals / non-goals

Goals: a cross-machine view of agents, in terminals and chats alike, ordered by how much they need the user; notifications when one blocks or finishes; starting agents and feeding them code from the IDE.

Non-goals: interpreting agent output, answering approval prompts automatically, scheduling agents.

## Design

**States.** A terminal's agent is `idle`, `working`, `blocked`, `done` or `unknown`, read from its screen or reported by the program ([25](25-agent-detection.md)); a `done` turn becomes seen (`idle`) when its terminal gets the focus in a client. A chat's status comes from its chat host (`blocked` while a permission, question or plan waits, [37](37-agent-chats.md)), and the page maps the hub's `agent` message naming a chat to its pane (`ViewStatusDef.paneOf`, [27](27-plugins.md)); chats count like terminals, after terminals of the same status.

**Attention.** The sidebar's **Agents** section lists the blocked and done agents of the followed machines, blocked first (`attentionList`, `web/src/actions.ts`); workspaces, tabs and pane headers show their most urgent status; **Go to Agent Needing Attention** (`app.agentAttention`) focuses the most urgent agent.

**Notifications** (`web/src/notify.ts`, `web/src/sound.ts`; settings `notifications.*`, [13](13-settings-and-appearance.md)): on a change to `blocked` or `done`, a system notification while the page is hidden or unfocused (native in the desktop app, [16](16-desktop-packaging.md)), a chime synthesized with Web Audio unless the terminal is on screen in a focused page, and a badge counting blocked agents. A muted tab or workspace ([04](04-layout-and-keyboard.md)) makes none of them. A blocked agent is announced once until the user looks at it, so one that keeps failing and retrying does not chime on and on. Only the most recently used page sounds: the hub marks its `agent` messages `sound: true` (`backend/kernel/pages.ts`).

**Starting agents and sending code.** The palette runs one of the registry's agent kinds ([35](35-agent-native-view.md)) in a split beside the focused pane; the new-tab menu and `chat.new` start a chat ([37](37-agent-chats.md)). VS Code's *Send to Agent* (`web/src/lib/bridge.ts`, [05](05-vscode-panes.md)) pastes `@file:lines` and the selection, without submitting, into an agent of the VS Code pane's tab, else of its workspace, never another workspace's; pasted or dropped images are uploaded and their paths typed ([06](06-quick-look-and-files.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| A prompt box sending text to an agent in a terminal | The terminal is the prompt; a second input hides the agent's own UI. A chat has a composer because its agent runs headless. |
| Sound files | Need an asset and its license notice; synthesized chimes need neither. |
| Every browser plays | Several open browsers or tabs would all sound at once. |
| Web Push for closed tabs | Needs a push service and subscription storage; there are no user accounts. |

## Failure modes

- Agents the rules cannot classify show `unknown` and never notify.
- Browser notifications need permission and a secure context, and sounds a gesture first; the desktop app's are native.
- The sounding browser may be one the user walked away from.

## Testing

- `backend/features/terminals/terminals.test.ts` (`agents`), `backend/kernel/pages.test.ts` (`sound page`).
- `web/src/__tests__`: `terms.test.ts`, `sidebarMachines.test.ts`, `codePanes.test.ts` (*Send to Agent*), `sound.test.ts`, `notify*.test.ts(x)`, `attention.test.tsx`.
