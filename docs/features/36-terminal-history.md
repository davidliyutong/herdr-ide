# 36 · Terminal history

## Context

A terminal's output lives in its terminal core's memory ([21](21-terminal-core.md)). When the core ends with the machine or is stopped, the page brings the workspaces back as new shells ([33](33-workspace-restore.md)), but what the terminals showed is gone. herdr-core's observing attach paints a terminal's styled scrollback unnoticed by the program and other viewers ([21](21-terminal-core.md)).

## Goals / non-goals

Goals: what a terminal showed before its core started again, above the new shell in the same scrollback; nothing on disk unless the user turns it on for a machine; hard limits the machine enforces; nothing that types into, resizes or redraws a terminal.

Non-goals: a record of every byte; snapshots while no hub is connected; a separate viewer; changing herdr-core's configuration.

## Design

**Capture** (`backend/features/history/machine`). The hub's scheduler (`scheduler.ts`) asks a machine for a capture every `history.interval` seconds while `history.capture` (off by default, per machine; `--history-capture`) and the plugin are on; a `--read-only` hub asks nothing. The agent snapshots the live terminals of its instance's own terminal core, never the user's nor the chat host's hidden terminal. A terminal whose program changed (another pid, or a snapshot from before the host's boot) moves its current generation to the previous one. An unchanged screen (a hash of `terminal.read` without history lines, which never scrolls a program) is skipped; otherwise the agent attaches as an observer and keeps the first paint, asking again with fewer lines or the new grid when the core dropped or repainted it, and strips titles. A capture through a node stands for the node's other hubs for a moment, so a machine is captured about once per interval ([39](39-nodes.md)).

**Storage and limits.** A terminal has a current generation and at most one previous. Snapshots are rows of `history_snapshots` in the machine's database ([38](38-sqlite-state.md)), written by one agent of the instance at a time (`history_lease`) in a worker of the node's. The agent clamps what the hub asks to the hard bounds of `HistoryLimits` (`backend/shared/proto/agentproto/history.ts`, 2 MiB per generation); the settings and their ranges are in [reference.md](../reference.md), what removes snapshots in [deployment.md](../deployment.md#remote-resources). Turning capture off makes the hub ask the machine to clear them until it succeeds.

**Routes** (`/api/m/{id}/p/history`). The list carries `restoreScreen`, whether the user's herdr-core configuration sets `restore_screen`. `read` serves one generation's bytes as an attachment with `nosniff`, a sandboxing CSP and `no-store`. `DELETE` and `adopt` (a replaced terminal's newest generation becomes its replacement's previous one) are refused read-only and audited.

**Showing** (`web/src/plugins/history`). The page follows each capturing machine's list (`follow.ts`). For each terminal leaf `chooseSnapshot` picks its previous program's generation, unless herdr-core restored the screen itself (a paint with its restored-screen line, or `restoreScreen` until the new program is captured); else, for a leaf that replaced another terminal ([33](33-workspace-restore.md)), that one's newest, which a writable page then adopts. The bytes become the pane's prelude (`state/preludes.ts`): untrusted output replayed before the stream, then ordinary scrollback ([26](26-web-terminals.md)). The settings page (`SettingsExtra.tsx`) has **Clear Saved Output**.

## Alternatives considered

| Option | Why not |
| --- | --- |
| herdr-core's `restore_screen` alone | The user's setting in a file this app does not write; off by default and empty after a power loss. |
| `terminal.read` text as the snapshot | No styles, and with history it scrolls alternate-screen programs for every viewer. |
| Recording every byte continuously | A stream per terminal at the busiest program's speed and an ever-growing file. |
| Snapshots kept by the hub | Only machines connected while it runs, sent at every capture. |
| Snapshots on by default | Terminal output holds secrets; writing it to disk is the user's choice per machine. |

## Failure modes

- **The terminal core does not run** → `not_running`; the scheduler asks again once the core is ready.
- **A paint dropped, too large or repainted** → retried, then `no_paint`, `too_large` or `repainted` for that terminal; one failure does not stop the others.
- **Too many terminals for the time budget** → the rest `timeout`; the next capture starts with them.
- **Power loss** → the last snapshot; up to one interval is missing.

## Security

Terminal output can hold secrets, so nothing is written unless the user turns `history.capture` on for a machine. Snapshots stay on that machine in the agent's private database within limits the agent enforces; the hub serves them only to a page that passed its guards, as bytes that are never a document of the UI's origin. A snapshot is replayed as untrusted output ([26](26-web-terminals.md)). A program that prints herdr-core's restored-screen line can hide its predecessor's snapshot from view, not from disk. See [SECURITY.md](../../SECURITY.md) (terminal history).

## Testing

- `backend/features/history/machine.test.ts` with a scripted core (`testdata/fakecore.ts`): paints, rotation, limits, the lease, adoption, the chat host never captured; `integration.test.ts` (`make it`) with a real herdr-core; `history.test.ts`: routes, scheduling, clears.
- `web/src/__tests__/history.test.ts` (choice, follower, adoption, retries), `historySettings.test.tsx`, `termPane.test.ts` (preludes).
