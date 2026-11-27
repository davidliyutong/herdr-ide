// @vitest-environment jsdom
//
// System Monitor & Task Manager plugin tests:
//  - process tree building, subtree rollups, cycle safety, search + ancestors
//  - dashboard card in status bar popup and Cmd+hover on sidebar machine rows
//  - Task Manager panel tree view, flat list, search, collapse/expand, signaling

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import {
  buildFlatProcessList,
  buildProcessTree,
  flattenProcessTree,
  formatBytes,
  formatRate,
  formatTemp,
  formatUptime,
  groupByChip,
  hottestTemp,
  peakGpuPct,
  pointInSafeCorridor,
  tempLevel,
} from '../plugins/monitor/model';
import type { Metrics, ProcessInfo, ProcessesReply } from '../plugins/monitor/api';
import { fetchMetrics, fetchProcesses, useMonitor } from '../plugins/monitor/state';
import { MachineHoverMonitor, MonitorStatusItem } from '../plugins/monitor/StatusItem';
import { TaskManagerPanel } from '../plugins/monitor/TaskManagerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sampleProcs: ProcessInfo[] = [
  {
    pid: 1,
    ppid: 0,
    name: 'systemd',
    command: '/sbin/init',
    user: 'root',
    cpuPct: 0.2,
    memPct: 0.1,
    rssBytes: 12 * 1024 * 1024,
    state: 'S',
    elapsed: '5-01:00:00',
  },
  {
    pid: 100,
    ppid: 1,
    name: 'sshd',
    command: '/usr/sbin/sshd -D',
    user: 'root',
    cpuPct: 0.5,
    memPct: 0.2,
    rssBytes: 20 * 1024 * 1024,
    state: 'S',
    elapsed: '5-00:59:00',
  },
  {
    pid: 200,
    ppid: 100,
    name: 'bash',
    command: '-bash',
    user: 'alice',
    cpuPct: 0.1,
    memPct: 0.1,
    rssBytes: 8 * 1024 * 1024,
    state: 'S',
    elapsed: '02:10:00',
  },
  {
    pid: 201,
    ppid: 200,
    name: 'python3',
    command: 'python3 train.py --gpu 0',
    user: 'alice',
    cpuPct: 84.5,
    memPct: 24.0,
    rssBytes: 4 * 1024 ** 3,
    state: 'R',
    elapsed: '01:05:10',
    gpuMemBytes: 12 * 1024 ** 3,
  },
  {
    pid: 300,
    ppid: 1,
    name: 'nginx',
    command: 'nginx: master process',
    user: 'www-data',
    cpuPct: 1.2,
    memPct: 0.5,
    rssBytes: 64 * 1024 * 1024,
    state: 'S',
    elapsed: '4-00:00:00',
  },
];

const sampleMetrics: Metrics = {
  hostname: 'gpu-box',
  os: 'linux',
  arch: 'amd64',
  uptimeSec: 90061,
  timestampMs: Date.now(),
  cpu: { usagePct: 42.3, cores: 16, load1: 3.1, load5: 2.4, load15: 1.9 },
  memory: {
    totalBytes: 64 * 1024 ** 3,
    usedBytes: 28 * 1024 ** 3,
    availableBytes: 36 * 1024 ** 3,
    usedPct: 43.8,
    swapTotalBytes: 8 * 1024 ** 3,
    swapUsedBytes: 512 * 1024 ** 2,
  },
  gpus: [
    {
      index: 0,
      name: 'NVIDIA RTX 4090',
      vendor: 'nvidia',
      utilPct: 78,
      memUsedBytes: 14 * 1024 ** 3,
      memTotalBytes: 24 * 1024 ** 3,
      memPct: 58.3,
      tempC: 67,
      powerW: 320,
      powerLimitW: 450,
    },
    {
      index: 1,
      name: 'NVIDIA RTX 4090',
      vendor: 'nvidia',
      utilPct: 12,
      memUsedBytes: 2 * 1024 ** 3,
      memTotalBytes: 24 * 1024 ** 3,
      memPct: 8.3,
      tempC: 41,
      powerW: 55,
      powerLimitW: 450,
    },
  ],
  network: {
    rxBytesPerSec: 12.5 * 1024 * 1024,
    txBytesPerSec: 2.1 * 1024 * 1024,
    rxBytes: 10 * 1024 ** 3,
    txBytes: 3 * 1024 ** 3,
    interfaces: [
      {
        name: 'eth0',
        rxBytesPerSec: 12.5 * 1024 * 1024,
        txBytesPerSec: 2.1 * 1024 * 1024,
        rxBytes: 10 * 1024 ** 3,
        txBytes: 3 * 1024 ** 3,
      },
    ],
  },
  diskIO: { readBytesPerSec: 45 * 1024 * 1024, writeBytesPerSec: 12 * 1024 * 1024, readBytes: 0, writeBytes: 0 },
  disks: [
    {
      mount: '/',
      device: '/dev/nvme0n1p2',
      fsType: 'ext4',
      totalBytes: 1000 * 1024 ** 3,
      usedBytes: 420 * 1024 ** 3,
      availBytes: 580 * 1024 ** 3,
      usedPct: 42,
    },
  ],
  sensors: {
    temps: [
      { chip: 'coretemp', label: 'Core 0', tempC: 51.2, highC: 84, critC: 100 },
      { chip: 'coretemp', label: 'Package id 0', tempC: 78.6, highC: 84, critC: 100 },
      { chip: 'nvme', label: 'Composite', tempC: 39 },
    ],
    fans: [
      { chip: 'nct6798', label: 'CPU fan', rpm: 1180.4, minRpm: 300 },
      { chip: 'nct6798', label: 'fan2', rpm: 0 },
    ],
  },
};

const sampleProcReply: ProcessesReply = {
  processes: sampleProcs,
  total: sampleProcs.length,
  cores: 16,
  memTotalBytes: 64 * 1024 ** 3,
  timestampMs: Date.now(),
};

describe('monitor model', () => {
  it('formats sizes, rates, uptimes and peak GPU usage', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(24 * 1024 ** 3)).toBe('24.0 GiB');
    expect(formatRate(2.5 * 1024 * 1024)).toBe('2.5 MB/s');
    expect(formatUptime(90061)).toBe('1d 1h');
    expect(formatUptime(3700)).toBe('1h 1m');
    expect(peakGpuPct(sampleMetrics.gpus)).toBe(78);
    expect(peakGpuPct([])).toBeUndefined();
  });

  it('rates temperatures against their thresholds and groups sensors by chip', () => {
    const s = (tempC: number, highC?: number, critC?: number) => ({ chip: 'c', label: 'l', tempC, highC, critC });
    expect(tempLevel(s(60, 84, 100))).toBe('ok');
    expect(tempLevel(s(75, 84, 100))).toBe('warn');
    expect(tempLevel(s(84, 84, 100))).toBe('hot');
    expect(tempLevel(s(84, undefined, 100))).toBe('ok');
    expect(tempLevel(s(86, undefined, 100))).toBe('warn');
    expect(tempLevel(s(100, undefined, 100))).toBe('hot');
    expect(tempLevel(s(79))).toBe('ok');
    expect(tempLevel(s(80))).toBe('warn');
    expect(tempLevel(s(90))).toBe('hot');
    expect(formatTemp(78.6)).toBe('79°C');
    expect(hottestTemp(sampleMetrics.sensors)?.label).toBe('Package id 0');
    expect(hottestTemp(undefined)).toBeUndefined();
    expect(groupByChip(sampleMetrics.sensors!.temps).map((g) => [g.chip, g.items.length])).toEqual([
      ['coretemp', 2],
      ['nvme', 1],
    ]);
    expect(groupByChip(undefined)).toEqual([]);
  });

  it('builds a cycle-safe process tree sorted by subtree CPU and preserves ancestors when searching', () => {
    const roots = buildProcessTree(sampleProcs, 'cpu', 'desc');
    expect(roots.map((r) => r.proc.pid)).toEqual([1]);
    // Children of pid 1: sshd subtree (85.1% CPU) floats above nginx (1.2% CPU).
    expect(roots[0].children.map((c) => c.proc.pid)).toEqual([100, 300]);
    expect(roots[0].descendantCount).toBe(4);

    // Search for "train.py": keeps systemd -> sshd -> bash (ancestorOnly) -> python3 (direct match).
    const filtered = flattenProcessTree(roots, new Set([100]), 'train.py');
    expect(filtered.map((r) => [r.proc.pid, r.depth, r.ancestorOnly])).toEqual([
      [1, 0, true],
      [100, 1, true],
      [200, 2, true],
      [201, 3, false],
    ]);

    // Collapse pid 100 when query is empty hides bash and python3.
    const collapsed = flattenProcessTree(roots, new Set([100]), '');
    expect(collapsed.map((r) => r.proc.pid)).toEqual([1, 100, 300]);

    // Flat list filters and sorts by memory descending.
    const flat = buildFlatProcessList(sampleProcs, 'mem', 'desc', '');
    expect(flat[0].proc.pid).toBe(201);
    expect(flat[1].proc.pid).toBe(300);

    // Cycle safety: mutually referencing PIDs must not infinite-loop.
    const cyclic: ProcessInfo[] = [
      { ...sampleProcs[0], pid: 10, ppid: 11 },
      { ...sampleProcs[0], pid: 11, ppid: 10 },
    ];
    const cycRoots = buildProcessTree(cyclic, 'pid', 'asc');
    expect(flattenProcessTree(cycRoots, new Set(), '').length).toBe(2);
  });

  it('protects diagonal pointer travel inside the aiming corridor toward the floating card', () => {
    const origin = { x: 180, y: 100 };
    const card = { left: 240, right: 590, top: 80, bottom: 420 };
    // Moving diagonally down-right across sibling rows toward the lower part of the card.
    expect(pointInSafeCorridor({ x: 210, y: 200 }, origin, card)).toBe(true);
    // Crossing the horizontal gap directly into the card.
    expect(pointInSafeCorridor({ x: 235, y: 100 }, origin, card)).toBe(true);
    // Moving away to the left or well above the card is outside the corridor.
    expect(pointInSafeCorridor({ x: 120, y: 100 }, origin, card)).toBe(false);
    expect(pointInSafeCorridor({ x: 210, y: 20 }, origin, card)).toBe(false);
  });
});

describe('monitor UI components', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/metrics')) return new Response(JSON.stringify(sampleMetrics), { status: 200 });
        if (url.endsWith('/processes')) return new Response(JSON.stringify(sampleProcReply), { status: 200 });
        if (url.endsWith('/signal')) return new Response(JSON.stringify({ ok: true, pid: 201, signal: 'TERM' }), { status: 200 });
        return new Response('{}', { status: 404 });
      }),
    );

    useSettings.setState({
      values: { 'monitor.statusBar': { value: true, source: 'global' }, 'monitor.confirmKill': { value: false, source: 'global' } },
    });
    useStore.setState({
      order: ['gpu'],
      machineId: 'gpu',
      readOnly: false,
      machines: {
        gpu: { id: 'gpu', label: 'GPU Server', kind: 'ssh', status: 'ready', platform: 'linux/amd64', enabled: true, updated_at: 0 },
      },
    });
    useMonitor.setState({ machines: {}, targetMachine: undefined });

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('opens the upward-floating dashboard from the status bar with per-GPU, network and disk metrics', async () => {
    await act(async () => {
      root.render(createElement(MonitorStatusItem));
    });

    const btn = host.querySelector<HTMLButtonElement>('.monitor-status-item');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('42%');
    expect(btn!.textContent).toContain('78%');

    await act(async () => {
      btn!.click();
    });

    const pop = host.querySelector('.monitor-popover');
    expect(pop).not.toBeNull();
    expect(pop!.textContent).toContain('GPU Server');
    expect(pop!.querySelectorAll('.monitor-gpu-item').length).toBe(2);
    expect(pop!.textContent).toContain('NVIDIA RTX 4090');
    expect(pop!.textContent).toContain('67°C');
    expect(pop!.textContent).toContain('12.5 MB/s');
    expect(pop!.textContent).toContain('420 GiB');

    // Sensors: grouped by chip, the hottest in the head, a level near the high threshold.
    const sensors = pop!.querySelector('.monitor-sensors');
    expect(sensors).not.toBeNull();
    expect(sensors!.querySelector('.monitor-sec-head .monitor-sec-val')!.textContent).toBe('79°C');
    expect(sensors!.querySelector('.monitor-sec-head .monitor-sec-val')!.className).toContain('level-warn');
    expect([...sensors!.querySelectorAll('.monitor-sensor-chip')].map((e) => e.textContent)).toEqual([
      'coretemp',
      'nvme',
      'Fans · nct6798',
    ]);
    expect(sensors!.querySelectorAll('.monitor-sensor').length).toBe(5);
    expect(sensors!.textContent).toContain('1180 RPM');
    expect(sensors!.textContent).toContain('0 RPM');
  });

  it('hides the sensors section when the machine reports none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...sampleMetrics, sensors: undefined }), { status: 200 })),
    );
    await act(async () => {
      root.render(createElement(MonitorStatusItem));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.monitor-status-item')!.click();
    });
    const pop = host.querySelector('.monitor-popover');
    expect(pop!.textContent).toContain('GPU Server');
    expect(pop!.querySelector('.monitor-sensors')).toBeNull();
  });

  it('opens the same dashboard on Cmd+hover over a left-sidebar machine row and closes on Cmd release', async () => {
    const fakeSidebar = document.createElement('div');
    fakeSidebar.innerHTML = `<div class="machine" data-machine="gpu"><div class="machine-head" data-machine-head>GPU Server</div></div>`;
    document.body.append(fakeSidebar);

    try {
      await act(async () => {
        root.render(createElement(MachineHoverMonitor));
      });

      const head = fakeSidebar.querySelector<HTMLElement>('[data-machine-head]')!;

      // Hover machine without Cmd -> no hover card.
      await act(async () => {
        head.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, metaKey: false }));
      });
      expect(document.body.querySelector('.monitor-hover-card')).toBeNull();

      // Press Meta (Cmd) while hovering machine -> hover card opens immediately.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
      });
      const card = document.body.querySelector('.monitor-hover-card');
      expect(card).not.toBeNull();
      expect(card!.querySelectorAll('.monitor-gpu-item').length).toBe(2);

      // Release Meta -> hover card closes.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
      });
      expect(document.body.querySelector('.monitor-hover-card')).toBeNull();
    } finally {
      fakeSidebar.remove();
    }
  });

  it('keeps the sidebar hover card open across pointer movement and cancels close on entering the card', async () => {
    vi.useFakeTimers();
    const fakeSidebar = document.createElement('div');
    fakeSidebar.innerHTML = `<div class="machine" data-machine="gpu"><div class="machine-head" data-machine-head>GPU Server</div></div><div class="ws-item">workspace</div>`;
    document.body.append(fakeSidebar);

    try {
      await act(async () => {
        root.render(createElement(MachineHoverMonitor));
      });

      const head = fakeSidebar.querySelector<HTMLElement>('[data-machine-head]')!;
      const ws = fakeSidebar.querySelector<HTMLElement>('.ws-item')!;

      // Hover machine and press Meta -> card opens.
      await act(async () => {
        head.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 100 }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
      });
      const card = document.body.querySelector<HTMLElement>('.monitor-hover-card');
      expect(card).not.toBeNull();

      // Pointer moves briefly off the machine row (e.g. across a workspace row / gap):
      // card stays open during the grace period instead of closing immediately.
      await act(async () => {
        ws.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 210, clientY: 140, metaKey: true }));
      });
      expect(document.body.querySelector('.monitor-hover-card')).not.toBeNull();

      // Entering the card cancels the pending close, and releasing Meta inside the card keeps it open.
      await act(async () => {
        card!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 250, clientY: 140, metaKey: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
        vi.advanceTimersByTime(400);
      });
      expect(document.body.querySelector('.monitor-hover-card')).not.toBeNull();

      // Clicking outside dismisses the card immediately.
      await act(async () => {
        ws.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      expect(document.body.querySelector('.monitor-hover-card')).toBeNull();
    } finally {
      fakeSidebar.remove();
      vi.useRealTimers();
    }
  });

  it('delays switching to another machine row while moving diagonally inside the virtual triangle toward the open card', async () => {
    vi.useFakeTimers();
    useStore.setState({
      order: ['gpu', 'cpu'],
      machineId: 'gpu',
      readOnly: false,
      machines: {
        gpu: { id: 'gpu', label: 'GPU Server', kind: 'ssh', status: 'ready', platform: 'linux/amd64', enabled: true, updated_at: 0 },
        cpu: { id: 'cpu', label: 'CPU Box', kind: 'ssh', status: 'ready', platform: 'linux/amd64', enabled: true, updated_at: 0 },
      },
    });
    const fakeSidebar = document.createElement('div');
    fakeSidebar.innerHTML = `
      <div class="machine" data-machine="gpu"><div class="machine-head" data-machine-head>GPU Server</div></div>
      <div class="machine" data-machine="cpu"><div class="machine-head" data-machine-head>CPU Box</div></div>
    `;
    document.body.append(fakeSidebar);

    try {
      await act(async () => {
        root.render(createElement(MachineHoverMonitor));
      });

      const [gpuHead, cpuHead] = fakeSidebar.querySelectorAll<HTMLElement>('[data-machine-head]');
      await act(async () => {
        gpuHead.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 100 }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
      });
      const surface = document.body.querySelector<HTMLElement>('.monitor-hover-surface')!;
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
        left: 240,
        right: 590,
        top: 80,
        bottom: 420,
        width: 350,
        height: 340,
        x: 240,
        y: 80,
        toJSON: () => ({}),
      });

      // Diagonal sweep down-right across CPU Box inside the aiming triangle:
      // card stays on GPU Server immediately instead of hijacking to CPU Box.
      await act(async () => {
        cpuHead.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 195, clientY: 180, metaKey: true }));
      });
      expect(document.body.querySelector('.monitor-card')?.getAttribute('data-machine')).toBe('gpu');

      // Pausing on CPU Box past the switch delay switches cleanly.
      await act(async () => {
        vi.advanceTimersByTime(220);
      });
      expect(document.body.querySelector('.monitor-card')?.getAttribute('data-machine')).toBe('cpu');
    } finally {
      fakeSidebar.remove();
      vi.useRealTimers();
    }
  });

  it('renders Task Manager in tree view, filters processes, switches to flat list, and signals a process', async () => {
    await act(async () => {
      root.render(createElement(TaskManagerPanel));
    });

    // Tree view renders all 5 processes.
    expect(host.querySelectorAll('.monitor-proc-row').length).toBe(5);
    const pythonRow = host.querySelector<HTMLElement>('[data-pid="201"]');
    expect(pythonRow).not.toBeNull();
    expect(pythonRow!.getAttribute('aria-level')).toBe('4');

    // Search for "train.py": keeps 3 dimmed ancestors + python3.
    const input = host.querySelector<HTMLInputElement>('.monitor-search-input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'train.py');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.monitor-proc-row').length).toBe(4);
    expect(host.querySelectorAll('.monitor-proc-row.ancestor').length).toBe(3);

    // Switch to Flat List: shows only the 1 matching process.
    const listBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Flat list"]')!;
    await act(async () => {
      listBtn.click();
    });
    expect(host.querySelectorAll('.monitor-proc-row').length).toBe(1);

    // Click Terminate button on python3 -> sends POST /signal.
    const termBtn = host.querySelector<HTMLButtonElement>('.monitor-proc-actions button')!;
    await act(async () => {
      termBtn.click();
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/m/gpu/p/monitor/signal',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ pid: 201, signal: 'TERM' }) }),
    );
  });

  it('does not abort or restart polling when opening or closing the status bar popover, and does not fetch when pausing Task Manager', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let metricsCalls = 0;
    let procCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/metrics')) {
          metricsCalls++;
          signals.push(init?.signal ?? undefined);
          return new Response(JSON.stringify(sampleMetrics), { status: 200 });
        }
        if (url.endsWith('/processes')) {
          procCalls++;
          return new Response(JSON.stringify(sampleProcReply), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );

    await act(async () => root.render(createElement(MonitorStatusItem)));
    expect(metricsCalls).toBe(1);
    const btn = host.querySelector<HTMLButtonElement>('.monitor-status-item')!;
    await act(async () => btn.click());
    await act(async () => btn.click());
    expect(metricsCalls).toBe(1);
    expect(signals[0]?.aborted).toBe(false);

    // TaskManagerPanel: clicking Pause must not trigger another /processes fetch.
    await act(async () => root.render(createElement(TaskManagerPanel)));
    expect(procCalls).toBe(1);
    const pauseBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Pause updates"]')!;
    await act(async () => pauseBtn.click());
    expect(procCalls).toBe(1);
  });
});

describe('monitor state abort and loading-flag races', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  beforeEach(() => {
    useMonitor.setState({ machines: {}, targetMachine: undefined });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ref-counts shared fetchMetrics waiters and never lets an aborted flight clear a newer flight’s loading flag', async () => {
    const calls: Array<{ signal?: AbortSignal; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            calls.push({ signal: init?.signal ?? undefined, resolve, reject });
          }),
      ),
    );

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = fetchMetrics('m1', ac1.signal);
    const p2 = fetchMetrics('m1', ac2.signal);
    expect(calls).toHaveLength(1);
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(true);

    // Aborting first of two waiters keeps the underlying request alive.
    ac1.abort();
    await p1;
    expect(calls[0].signal?.aborted).toBe(false);

    // Aborting the last waiter aborts flight 1, then starting flight 2 immediately must stay loading even after flight 1 rejects.
    ac2.abort();
    await p2;
    expect(calls[0].signal?.aborted).toBe(true);

    const ac3 = new AbortController();
    const p3 = fetchMetrics('m1', ac3.signal);
    expect(calls).toHaveLength(2);
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(true);

    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(true);

    calls[1].resolve(new Response(JSON.stringify(sampleMetrics), { status: 200 }));
    await p3;
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(false);
    expect(useMonitor.getState().machines.m1.metrics?.hostname).toBe('gpu-box');

    // Aborting when idle clears metricsLoading even if the request resolves right after abort.
    const ac4 = new AbortController();
    const p4 = fetchMetrics('m1', ac4.signal);
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(true);
    ac4.abort();
    await p4;
    calls[2].resolve(new Response(JSON.stringify(sampleMetrics), { status: 200 }));
    await flush();
    expect(useMonitor.getState().machines.m1.metricsLoading).toBe(false);
  });

  it('keeps processesLoading true when an aborted fetchProcesses settles after a replacement flight starts', async () => {
    const calls: Array<{ signal?: AbortSignal; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            calls.push({ signal: init?.signal ?? undefined, resolve, reject });
          }),
      ),
    );

    const ac1 = new AbortController();
    const p1 = fetchProcesses('m2', ac1.signal);
    ac1.abort();
    await p1;
    expect(calls[0].signal?.aborted).toBe(true);

    const ac2 = new AbortController();
    const p2 = fetchProcesses('m2', ac2.signal);
    expect(calls).toHaveLength(2);
    expect(useMonitor.getState().machines.m2.processesLoading).toBe(true);

    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(useMonitor.getState().machines.m2.processesLoading).toBe(true);

    calls[1].resolve(new Response(JSON.stringify(sampleProcReply), { status: 200 }));
    await p2;
    expect(useMonitor.getState().machines.m2.processesLoading).toBe(false);
    expect(useMonitor.getState().machines.m2.processes?.total).toBe(sampleProcs.length);

    // Aborting when idle clears processesLoading on abort rejection.
    const ac3 = new AbortController();
    const p3 = fetchProcesses('m2', ac3.signal);
    ac3.abort();
    await p3;
    calls[2].reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(useMonitor.getState().machines.m2.processesLoading).toBe(false);
  });
});
