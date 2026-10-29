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
  `prefix o` jumps to the most urgent agent; opening one calls `pane.focus`
  so herdr marks a finished agent as seen.
- **Notifications**: a status change to `blocked` or `done` raises a desktop
  notification when the page is hidden (a toast when visible for `blocked`);
  clicking it focuses the agent. The title and the PWA badge count blocked
  agents.
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
| Web Push for closed tabs | Requires a push service and subscription storage; the reverse-proxy model has no user accounts. |

## Failure modes

- Agents herdr cannot classify show `unknown` and never notify.
- Notifications need permission (asked on the first click) and a secure
  context.

## Testing

Inbox ordering and notification triggering are driven by snapshot state and
status events; they were verified against live machines with idle and working
agents. `internal/herdr/client_test.go` covers status event parsing.
