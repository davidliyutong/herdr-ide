# 10 · Remote resource lifecycle

## Context

The hub and its nodes start processes and write files on shared machines. Several hubs reach one machine, nodes can be killed abruptly, and code-server holds hundreds of megabytes; left alone, this exhausts memory and disk the user shares with others.

## Goals / non-goals

Goals: every process has an owner and an end; every file a retention rule; nothing depends on a clean hub shutdown; two hubs never destroy each other's state. Non-goals: quotas; the user's own programs.

## Design

The per-resource table (what starts each process or file, its limits, what reclaims it) is in [deployment](../deployment.md#remote-resources). The rules behind it:

- **Every process has an owner that ends it**: a node ends shortly after its last client ([39](39-nodes.md)), the desktop hub with the shell's stdio ([16](16-desktop-packaging.md)), downloads with their request and a time limit, a video encoder with its window's viewers.
- **What programs depend on outlives the node**: the terminal core runs as a user service or launchd job until the user stops it ([21](21-terminal-core.md)); the virtual display exits shortly after its last client, held by the GUI helper's keeper only while the terminal core runs ([14](14-gui-windows.md)); the chat host is a hidden terminal of the core that also ends by itself once idle, and its agents stop when idle or beyond `chat.maxLive` ([37](37-agent-chats.md)).
- **code-server has one owner**: `cs.pid` names it and its owning node, which stops only its own and hands it over on takeover; a starting node ends one whose owner is gone. The hub releases it after `--code-server-idle` without a connection, unless another hub uses it; hidden VS Code windows unmount after a while so that timer runs (`web/src/codeFrames.ts`).
- **Files are retained by age** (`backend/machine/housekeeping.ts`): uploads and logs after days, partial installs within an hour, shared versioned directories (builds, code-server, encoders) once unused, touched while in use so another hub's version stays; other hosts' files on a shared home after long disuse ([40](40-shared-homes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Delete other versions immediately | Two hubs of different builds would delete each other's files. |
| Keep code-server until the node exits | Nodes live as long as a hub is connected, often days. |
| Terminal core owned by the node | A network drop or hub restart would end the user's programs. |

## Failure modes

- **Node killed**: its code-server lives until the next node reaps it or its own idle timeout.
- **A terminal core nobody uses any more**: it runs until the user stops it from the machine's menu or with `node stop --terminal-core`.

## Testing

`backend/features/vscode/machine.test.ts`, `hub.test.ts`; `backend/machine/housekeeping.test.ts`; `web/src/__tests__/codePanes.test.ts`; `backend/features/gui/machine/display.test.ts`; `backend/features/chat/machine/host/host.test.ts`.
