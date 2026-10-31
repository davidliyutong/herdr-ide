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

- **States** come from herdr (`idle`, `working`, `blocked`, `done`,
  `unknown`), per pane, through the agent-status subscription
  ([01](01-herdr-integration.md)).
- **Inbox** (sidebar): agents in `blocked` or `done` across all machines,
  blocked first, with machine, pane title and cwd; counts of working agents.
  Workspaces and tabs show the most urgent status of their agents.
  `prefix o` jumps to the most urgent agent.
- **Seen** (`web/src/seen.ts`): herdr reports `done` for an agent that
  finished outside its active workspace and clears it only when the pane is
  focused in herdr (`pane.focus`; verified with herdr 0.9.5). Selection in
  the web UI is local, so when the pane focused in the UI is `done`, on
  screen and the page visible — opened from the inbox, from a notification
  or by hand, or finishing while looked at — the UI focuses it in herdr.
  Showing a tab focuses one of its panes (herdr's focused pane of the tab).
- **Notifications**: a status change to `blocked` or `done` raises a desktop
  notification when the page is hidden (a toast when visible for `blocked`);
  clicking it focuses the agent. The title and the PWA badge count blocked
  agents.
- **Sounds** (`web/src/sound.ts`): herdr plays its sounds only in the herdr
  TUI client, which the IDE does not run, so the browser plays them on the
  same transitions: `blocked` plays the request chime, `done` the done chime,
  except — as in herdr — when the pane is on screen (selected workspace and
  tab) and the page is visible and focused. The two chimes are synthesized
  with the Web Audio API, so no audio files are shipped. The setting
  **Notification sounds** is on by default, like herdr's `[ui.sound]`;
  **Silent agents** lists agents (matched by herdr's agent name or display
  name) that never sound and starts with `droid`, which herdr mutes by
  default. Both are browser settings
  ([13](13-settings-and-appearance.md)).
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
- **Starting agents**: the palette offers common agent kinds; the focused pane
  is split to the right in the same cwd and `agent.start` launches the agent
  with a unique name.
- **Context to agents**: VS Code's *Send to Agent* pastes `@file:lines` and
  the selection into the focused agent pane without submitting; pasted or
  dropped images are uploaded and their paths typed
  ([06](06-quick-look-and-files.md)).
- **Review**: from a pane, `prefix d` opens the multi-file diff and
  `prefix shift+g` Git Graph of its repository ([05](05-vscode-panel.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Agent prompt box calling `agent.prompt` | The pane itself is the prompt; a second input duplicates it and hides the agent's own UI (approvals, slash commands). |
| herdr's own sound files | They carry no separate attribution in herdr's repository; synthesized chimes need no asset or license notice. |
| Every browser plays | With several browsers or tabs open, each would sound at once. |
| Web Push for closed tabs | Requires a push service and subscription storage; the reverse-proxy model has no user accounts. |

## Failure modes

- Agents herdr cannot classify show `unknown` and never notify.
- Notifications need permission (asked on the first click) and a secure
  context.
- The chosen browser may be one the user has walked away from (another
  browser was opened earlier and not used since); its sounds play there.
- herdr's `[ui.sound]` configuration on the core host (custom sound files,
  per-agent overrides, `HERDR_DISABLE_SOUND`) is not read; the browser
  settings apply.

## Testing

Inbox ordering and notification triggering are driven by snapshot state and
status events; they were verified against live machines with idle and working
agents. `internal/herdr/client_test.go` covers status event parsing;
`web/src/__tests__/dialog.test.ts` the seen marking (once, only on screen).
`web/src/__tests__/sound.test.ts` covers which sound a status change plays
(suppression, muted agents, the chosen browser);
`TestSoundClientMostRecentlyActive` (`internal/server`) the choice of the
browser. Playing in only the most recently used of two browsers was verified
in Chromium against herdr 0.9.5 with `pane report-agent`.
Clearing `done` by opening a workspace by hand was verified against herdr
0.9.5 with `pane report-agent`.
