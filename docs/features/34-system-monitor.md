# 34 System Monitor and Task Manager

## Context

Working across several local and remote SSH machines makes it easy to lose
sight of which host is CPU-bound, running out of RAM, holding VRAM on a
specific GPU, or saturating disk and network I/O. Checking that usually meant
opening a terminal and running `htop`, `nvidia-smi`, `df`, and `iftop` on each
machine in turn.

The System Monitor & Task Manager plugin (`monitor`) puts both an at-a-glance
resource dashboard and an interactive, searchable process tree right inside
the IDE without requiring root privileges or extra binaries on remote hosts.

## Goals / non-goals

- **Dashboard mode** in two places rendering the exact same live card:
  - Holding **⌘** (Ctrl/Meta on Windows and Linux) and hovering a machine row
    in the left sidebar shows that machine's live CPU, memory, per-GPU,
    network and disk usage.
  - A bottom-right status bar indicator shows live CPU, memory and peak GPU
    usage for the active machine and opens the same dashboard card floating
    upward on hover or click.
- **Task Manager mode** (inspired by Tern): a right-sidebar panel that can
  also be opened as a workspace pane or tab, displaying a windowed process
  list with parent-child **Tree View** and **Flat List**, live fuzzy search
  (preserving ancestor context in Tree View), sorting (by subtree CPU/RSS in
  Tree View), process inspection, and guarded process signaling (`SIGTERM`,
  `SIGKILL`, `SIGSTOP`, `SIGCONT`).
- On-demand polling only: no permanent background daemon or files written on
  machines; polling runs only while a dashboard card, status item or Task
  Manager is visible and pauses when the tab is hidden.
- Non-goal: historical telemetry storage on disk or alerting rules across
  days.

## Design

### Machine side (`internal/agent/plugin/monitor`)

Registered under plugin id `monitor` (`internal/agent/plugins_monitor.go`,
`//go:build unix`), handling three actions of the agent's `plugin` op:

- `metrics`: returns CPU usage (overall, cores, load averages, per-core on
  Linux), memory and swap, **per-GPU** stats (index, name, vendor, compute
  utilization, VRAM used/total/percent, temperature, power draw/limit),
  network Rx/Tx throughput and totals (plus per-interface rates), disk read/
  write I/O throughput, and mounted filesystem capacities.
  - **Linux**: reads `/proc/stat`, `/proc/loadavg`, `/proc/uptime`,
    `/proc/meminfo`, `/proc/net/dev`, `/proc/diskstats`, and `/proc/mounts` +
    `syscall.Statfs` directly with zero shell invocations. On the first
    sample it takes two `/proc/stat` readings 100 ms apart so the very first
    hover already shows live CPU utilization. Per-GPU metrics come from
    `nvidia-smi` (CSV, bounded to 3 s) and AMD/Intel `/sys/class/drm` sysfs
    nodes.
  - **macOS**: runs `sysctl`, `vm_stat`, `top -l 1 -n 0 -s 0`, `netstat -ibn`,
    `ioreg -r -d 1 -w 0 -c IOAccelerator` (Apple Silicon / discrete GPU
    utilization and memory), `ioreg -r -c IOBlockStorageDriver -w 0`, and
    `df -kP` (consolidating APFS `/System/Volumes/Data` into `/`)
    concurrently with a 3 s timeout.
- `processes`: returns the process table (`pid`, `ppid`, `name`, `command`
  truncated to 512 bytes, `user`, `cpuPct`, `memPct`, `rssBytes`, normalized
  `state`, `elapsed`, and per-PID `gpuMemBytes` on NVIDIA Linux hosts). Linux
  reads `/proc/<pid>` directly and computes instantaneous interval CPU% from
  tick deltas; macOS reads `ps -axww`.
- `signal`: sends an allowlisted POSIX signal (`TERM`, `KILL`, `INT`, `HUP`,
  `STOP`, `CONT`) directly via `syscall.Kill`, refusing `pid <= 1` and the
  agent's own PID.

### Core side (`internal/plugins/monitor`)

Mounts three machine routes below `/api/m/{id}/p/monitor/`:

- `GET /api/m/{id}/p/monitor/metrics`
- `GET /api/m/{id}/p/monitor/processes`
- `POST /api/m/{id}/p/monitor/signal` (`Mutating: true`, `Audit: "signal"`,
  recording `pid` and `signal` in the audit log; refused in `--read-only`).

Settings (`internal/plugins/monitor/settings.go`, section `monitor`):

- `monitor.refreshSeconds` (default `2`, range `1–30`)
- `monitor.statusBar` (default `true`)
- `monitor.confirmKill` (default `true`)

Command (`internal/keybindings/commands.go`): `view.panel.monitor`.

### Web UI (`web/src/plugins/monitor`)

- `DashboardCard.tsx`: shared live dashboard card (CPU + sparkline + load,
  Memory + swap, per-item GPU cards, Network Rx/Tx + active interfaces,
  Disk I/O + mounts, Refresh and Task Manager actions).
- `StatusItem.tsx`: renders both the bottom-right status bar button (with its
  upward-floating `.gui-menu.monitor-popover` using `useHoverOpen` and
  `useDismiss`) and the `MachineHoverMonitor` portal overlay that detects
  ⌘+hover (Ctrl/Meta on Windows/Linux) on `[data-machine-head]` rows in the
  left sidebar. Because it discovers machine rows via data attributes,
  `Sidebar.tsx` imports nothing from the plugin. Pointer movement from a
  sidebar row to the floating card is protected by a virtual aiming-triangle
  corridor (`pointInSafeCorridor`), a zero-gap left hover bridge, a close
  grace delay, and delayed switching across sibling machine rows when aiming
  diagonally toward the open card.
- `TaskManagerPanel.tsx`: right-sidebar panel (also openable in a pane/tab
  via **Open in Pane**, drag-to-pane, or the new-tab menu). Uses container
  queries (`@container`) so compact columns expand to include User and State
  when opened as a wider pane. Built with `lib/windowed.ts` for smooth
  scrolling over thousands of processes, `lib/match.ts` + `Highlight` for
  fuzzy search, cycle-safe parent-child tree building with subtree CPU/RSS
  rollups, keyboard navigation, right-click context menu, and a selected
  process detail footer.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Always-on background streaming across all machines | Wastes SSH bandwidth and CPU on idle remote servers; on-demand polling while visible keeps remote overhead near zero. |
| Adding a third-party Go system-metrics library | Adds transitive dependencies and `THIRD_PARTY_NOTICES.md` maintenance for metrics already cleanly available in `/proc`, `/sys`, `sysctl`, `vm_stat`, `ioreg`, and `nvidia-smi`. |
| Coupling `Sidebar.tsx` directly to the monitor plugin | Breaks plugin isolation and risks import cycles; listening on `[data-machine-head]` in the plugin's own overlay unmounts cleanly when the plugin is disabled. |

## Failure modes

- Machine offline or disconnected: metrics and process actions fail with
  `offline` (409); the dashboard card and Task Manager show the machine's
  status without breaking other machines.
- Missing `nvidia-smi` or unsupported GPU driver: GPU probing fails silently
  and reports an empty GPU list while CPU, memory, network and disk metrics
  continue normally.
- Process exits before signaling: `syscall.Kill` returns `ESRCH`, mapped to
  `not_found` (404) and displayed as a translated toast.
- Plugin disabled: routes return `404 plugin_disabled`, the status bar item,
  ⌘+hover overlay and Task Manager rail button unmount.

## Security

Process signaling (`POST /api/m/{id}/p/monitor/signal`) is a mutating route:
refused in `--read-only`, subject to the core's Host/Origin and proxy-secret
guards, audited as `monitor.signal` with `pid` and `signal`, limited to an
allowlist of six POSIX signals (`TERM`, `KILL`, `INT`, `HUP`, `STOP`, `CONT`),
invoked via `syscall.Kill` with no shell, and refuses `pid <= 1` and the
agent's own PID. Metrics and process reads run without shells and truncate
command lines to 512 bytes. See [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agent/plugin/monitor/monitor_test.go`: Linux `/proc` parsers,
  `nvidia-smi` multi-GPU and compute-app CSV parsers, macOS `vm_stat`/
  `sysctl`/`top`/`ioreg`/`df`/`ps` parsers, live host collection, and signal
  guardrails (`pid <= 1`, self PID, invalid signal, live child `SIGTERM`).
- `internal/plugins/monitor/monitor_test.go`: route patterns, mutating/audit
  flags, and `invalid_pid` rejection.
- `web/src/__tests__/monitor.test.ts`: formatters, cycle-safe process tree
  building, subtree sorting, search with dimmed ancestor preservation, status
  bar upward popover, left-sidebar ⌘+hover overlay, and Task Manager tree/
  flat/search/signal interactions.
