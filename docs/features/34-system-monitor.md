# 34 · System Monitor and Task Manager

## Context

Across several machines it is easy to lose sight of which host is busy, short of memory or holding a GPU. The `monitor` plugin shows a resource dashboard and a process tree, without root or extra binaries on the machines.

## Goals / non-goals

- **Dashboard**: a live card (CPU, memory, GPUs, network, disk, sensors), shown by holding ⌘ (Ctrl or Meta on Windows and Linux) over a machine in the sidebar, and from a status bar item (`monitor.statusBar`).
- **Task Manager** (`view.panel.monitor`, also a pane or tab): a process tree or list with search, sorting by subtree totals, details and guarded signals (`monitor.confirmKill`).
- Polling every `monitor.refreshSeconds` only while one of them is visible; nothing runs on machines otherwise.
- Non-goals: stored history, alerting.

## Design

**Machine side** (`backend/features/monitor/machine.ts`, `machine/linux.ts`, `machine/darwin.ts`), actions of the agent's `plugin` op:

- `metrics`: Linux reads `/proc`, `/sys` (GPUs, hwmon, thermal zones) and `statfs`, NVIDIA GPUs through `nvidia-smi`; macOS runs `sysctl`, `vm_stat`, `top`, `netstat`, `ioreg` and `df`, all without a shell. Without root a Mac reports only its battery's temperature. A hung sensor read leaves a sample without sensors instead of delaying it.
- `processes`: the process table with interval CPU% and, on NVIDIA Linux, GPU memory.
- `signal`: one of `TERM`, `KILL`, `INT`, `HUP`, `STOP`, `CONT` (`machine/signal.ts`), never to `pid <= 1` or the agent itself.

A node shares one sample among its hubs and the hub one among its pages, so rates cover one interval.

**UI** (`web/src/plugins/monitor`): `DashboardCard.tsx`, `StatusItem.tsx` (the status item and the ⌘+hover overlay, which finds sidebar rows by `[data-machine-head]` so `Sidebar.tsx` imports nothing from the plugin) and `TaskManagerPanel.tsx`, a windowed list for thousands of processes.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Always-on streaming from every machine | Wastes ssh bandwidth and CPU on idle machines; polling while visible costs nearly nothing. |
| A third-party metrics library | More dependencies for numbers `/proc`, `/sys` and the macOS tools already give. |

## Failure modes

- Machine offline: `offline` (409); other machines are unaffected.
- No `nvidia-smi` or an unsupported driver: no GPUs; other metrics continue.
- Process gone before a signal: `not_found` (404), shown as a toast.

## Security

`POST /api/m/{id}/p/monitor/signal` is mutating: refused in `--read-only`, behind the hub's guards, audited as `monitor.signal` with `pid` and `signal`. The agent allows only the six signals and uses no shell ([SECURITY.md](../../SECURITY.md)).

## Testing

- `backend/features/monitor/machine.test.ts`, `machine/parsers.test.ts`, `machine/sensors.test.ts` (parsers, sensor trees in a temporary directory, a hung scan, signal guards); `monitor.test.ts` (routes, guards, audit).
- `web/src/__tests__/monitor.test.ts`: the card, tree, search, overlay and Task Manager.
