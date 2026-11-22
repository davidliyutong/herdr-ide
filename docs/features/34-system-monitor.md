# 34 System Monitor and Task Manager

## Context

Across several machines it is easy to lose sight of which host is CPU-bound,
short of memory, holding a GPU's memory, or saturating disk or network.
Checking meant running `htop`, `nvidia-smi`, `df` and `iftop` on each
machine. The `monitor` plugin shows a resource dashboard and a searchable
process tree in the UI, without root or extra binaries on the machines.

## Goals / non-goals

- **Dashboard**: one live card (CPU, memory, per-GPU, network, disk), shown
  by holding **⌘** (Ctrl or Meta on Windows and Linux) while hovering a machine in
  the left sidebar, and from a status bar item (CPU, memory, peak GPU of the
  active machine) that opens it upward.
- **Task Manager**: a right-sidebar panel, also openable as a pane or tab,
  with a tree or flat process list, fuzzy search (keeping ancestors in the
  tree), sorting (by subtree CPU/RSS in the tree), details, and guarded
  signals.
- Polling only while a card, status item or Task Manager is visible; nothing
  runs or is written on machines otherwise.
- Non-goals: stored history, alerting.

## Design

### Machine side (`internal/agent/plugin/monitor`)

Plugin id `monitor` (`internal/agent/plugins_monitor.go`, `//go:build unix`),
three actions of the agent's `plugin` op:

- `metrics`: CPU (overall, per core, load), memory and swap, per-GPU
  utilization, memory, temperature and power, network and disk throughput,
  filesystem capacities.
  - Linux reads `/proc`, `/sys/class/drm` and `statfs` without a shell; the
    first sample takes two `/proc/stat` readings 100 ms apart so the first
    hover already shows CPU use. NVIDIA GPUs come from `nvidia-smi` (3 s
    bound).
  - macOS runs `sysctl`, `vm_stat`, `top`, `netstat`, `ioreg` and `df`
    concurrently with a 3 s timeout.
- `processes`: the process table (command truncated to 512 bytes, CPU%,
  memory, state, elapsed time, per-process GPU memory on NVIDIA Linux).
  Linux reads `/proc/<pid>` and computes interval CPU% from tick deltas;
  macOS reads `ps`.
- `signal`: sends an allowlisted signal (`TERM`, `KILL`, `INT`, `HUP`,
  `STOP`, `CONT`) with `syscall.Kill`, refusing `pid <= 1` and the agent's
  own pid.

### Core side (`internal/plugins/monitor`)

Routes below `/api/m/{id}/p/monitor/`: `GET metrics`, `GET processes`,
`POST signal` (mutating, audited with `pid` and `signal`). Settings
(`settings.go`): `monitor.refreshSeconds` (2, 1–30), `monitor.statusBar`,
`monitor.confirmKill`. Command: `view.panel.monitor`.

### Web UI (`web/src/plugins/monitor`)

- `DashboardCard.tsx`: the shared card.
- `StatusItem.tsx`: the status bar item and the ⌘+hover overlay. The
  overlay finds machine rows by `[data-machine-head]`, so `Sidebar.tsx`
  imports nothing from the plugin. Moving the pointer from a row to the card
  is kept from closing it or switching rows by an aiming corridor
  (`pointInSafeCorridor`) and a short grace delay.
- `TaskManagerPanel.tsx`: the panel; container queries add columns when it
  is wide. A windowed list (`lib/windowed.ts`) keeps thousands of processes
  smooth; the tree is built cycle-safe with subtree rollups.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Always-on streaming from every machine | Wastes ssh bandwidth and CPU on idle machines; polling while visible keeps the cost near zero. |
| A third-party metrics library | More dependencies and notices for numbers `/proc`, `/sys` and the macOS tools already give. |
| `Sidebar.tsx` importing the plugin | Breaks plugin isolation and risks import cycles; the plugin's own overlay unmounts cleanly when disabled. |

## Failure modes

- Machine offline: `offline` (409); other machines are unaffected.
- No `nvidia-smi` or an unsupported driver: an empty GPU list; the other
  metrics continue.
- Process gone before a signal: `ESRCH` becomes `not_found` (404), shown as
  a toast.
- Plugin disabled: routes answer `404 plugin_disabled`; the status item,
  overlay and panel unmount.

## Security

`POST /api/m/{id}/p/monitor/signal` is a mutating route: refused in
`--read-only`, behind the core's Host/Origin and proxy-secret guards,
audited as `monitor.signal` with `pid` and `signal`. The agent allows only
six signals, uses no shell, and refuses `pid <= 1` and its own pid. Metric
and process reads never go through a shell (commands are run directly). See [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agent/plugin/monitor/monitor_test.go`: the Linux and macOS
  parsers, live collection, signal guards.
- `internal/plugins/monitor/monitor_test.go`: routes, mutating/audit flags,
  `invalid_pid`.
- `web/src/__tests__/monitor.test.ts`: formatting, tree building and
  sorting, search, the status item, the ⌘+hover overlay, Task Manager
  interactions.
