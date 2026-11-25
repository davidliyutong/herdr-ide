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

### Machine side (`backend/features/monitor/machine.ts`)

Plugin id `monitor` (Linux and macOS: `machine/linux.ts`, `machine/darwin.ts`),
three actions of the agent's `plugin` op:

- `metrics`: CPU (overall, per core, load), memory and swap, per-GPU
  utilization, memory, temperature and power, network and disk throughput,
  filesystem capacities, hardware temperatures and fans.
  - Linux reads `/proc`, `/sys/class/drm` and `statfs` without a shell; the
    first sample takes two `/proc/stat` readings 100 ms apart so the first
    hover already shows CPU use. NVIDIA GPUs come from `nvidia-smi` (3 s
    bound).
  - macOS runs `sysctl`, `vm_stat`, `top`, `netstat`, `ioreg` and `df`
    concurrently with a 3 s timeout.
  - Hardware sensors (`sensors`, left out when a machine has none):
    temperatures (`temps`: `chip`, `label`, `tempC`, the hardware's `highC`
    and `critC` when it reports them) and fans (`fans`: `chip`, `label`,
    `rpm`, `minRpm`, `maxRpm`), sorted by chip, then label, numbers inside
    by value ("Core 2" before "Core 10").
    - Linux reads `/sys/class/hwmon/hwmon*`: `name` is the chip (a second
      chip of the same name gets its directory appended, as two NVMe
      drives), `tempN_input` (millidegrees) with `_label`, `_max`, `_crit`,
      and `fanN_input` (RPM) with `_label`, `_min`, `_max`; a sensor without
      a label is named by its file (`temp1`). A stopped fan stays with 0 RPM.
      Without hwmon temperatures (some ARM boards, virtual machines) the
      thermal zones supply them (`type`, `temp`; the lowest `hot` or
      `passive` trip point as high, `critical` as critical). Temperatures
      outside −50…200 °C are the error values of unconnected inputs and are
      skipped. Plain file reads, no root.
    - macOS shows the battery's temperature only (`ioreg -rn
      AppleSmartBattery -w0`, about 10 ms, `Temperature` in hundredths of a
      degree). Die temperatures and fans are behind the SMC and IOHID, which
      need cgo (the binary is built without it) or `powermetrics` as root:
      a Mac shows no fans, and a desktop Mac no sensors.
    - Bounds: 128 temperatures and 128 fans, from at most 64 hwmon
      directories and 64 thermal zones. The Linux scan runs beside the
      `/proc` reads and a sample waits at most 1 s for it: a hung sysfs file
      leaves that sample without sensors, and no new scan starts until the
      hung one returns (one goroutine, not one per sample).
- `processes`: the process table (command truncated to 512 bytes, CPU%,
  memory, state, elapsed time, per-process GPU memory on NVIDIA Linux).
  Linux reads `/proc/<pid>` and computes interval CPU% from tick deltas;
  macOS reads `ps`.
- `signal`: sends an allowlisted signal (`TERM`, `KILL`, `INT`, `HUP`,
  `STOP`, `CONT`) with `syscall.Kill`, refusing `pid <= 1` and the agent's
  own pid.

### Hub side (`backend/features/monitor`)

Routes below `/api/m/{id}/p/monitor/`: `GET metrics`, `GET processes`,
`POST signal` (mutating, audited with `pid` and `signal`). Settings
(`settings.ts`): `monitor.refreshSeconds` (2, 1–30), `monitor.statusBar`,
`monitor.confirmKill`. Command: `view.panel.monitor`.

### Web UI (`web/src/plugins/monitor`)

- `DashboardCard.tsx`: the shared card. Its last section, **Sensors**,
  shown only when the machine reports some, has the hottest temperature in
  its head, the temperatures by chip in two columns, then the fans by chip,
  scrolling past 180 px. A temperature is a warning within 10 °C of its
  high threshold (15 °C of its critical one without a high one) and hot at
  or above either; without thresholds from 80 °C and 90 °C. The sidebar's
  hover card is the same card; the status bar item shows no sensors.
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
`--read-only`, behind the hub's Host/Origin and proxy-secret guards,
audited as `monitor.signal` with `pid` and `signal`. The agent allows only
six signals, uses no shell, and refuses `pid <= 1` and its own pid. Metric
and process reads never go through a shell (commands are run directly). See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/monitor/machine.test.ts` and `machine/parsers.test.ts`:
  the Linux and macOS parsers, live collection, signal guards.
- `backend/features/monitor/machine/sensors.test.ts`: hwmon and thermal zone
  trees in a temporary directory (labels, thresholds, duplicate chips,
  stopped fans, error values, the fallback, the bound), the 1 s budget
  against a hung scan, the macOS battery's `ioreg` output.
- `backend/features/monitor/monitor.test.ts`: routes, mutating/audit flags,
  `invalid_pid` (`signal params`).
- `web/src/__tests__/monitor.test.ts`: formatting, tree building and
  sorting, temperature levels and the sensors section, search, the status item, the ⌘+hover overlay, Task Manager
  interactions.
