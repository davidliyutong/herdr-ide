// The monitor's machine side through the wire: the actions as the core
// calls them (#kernel/agent.ts, the protocol's schemas checking the
// results), on this machine and over a Linux /proc and /sys of fixtures,
// and the checks of a signal.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { call } from '#kernel/agent.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { Fail } from '#shared/lib/fail.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { monitorMachine, type MonitorOptions } from './machine.ts';
import { monitorProtocol } from './protocol.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});
const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function start(o: Partial<MonitorOptions> = {}) {
  r = await rig({ features: [monitorMachine(o)] });
  const m = machineOf(r.session);
  return {
    metrics: () => call(m, monitorProtocol, 'metrics', {}),
    processes: () => call(m, monitorProtocol, 'processes', {}),
    signal: (pid: number, signal: string) => call(m, monitorProtocol, 'signal', { pid, signal }),
    /** The machine's own answer to any pid (the core's schema bounds it
     * before it sends). */
    rawSignal: async (pid: number, signal: string) => {
      try {
        await r!.session.request({ op: Op.Plugin, plugin: 'monitor', action: 'signal', params: { pid, signal } });
        return 'sent';
      } catch (e) {
        return (e as { reply?: { code?: string } }).reply?.code ?? 'failed';
      }
    },
  };
}

/** A tree of files (path relative to root → content). */
function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'mon-'));
  roots.push(root);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Fail) return e.code;
    throw e;
  }
  throw new Error('not refused');
};

describe('on this machine', () => {
  test('metrics and processes as the core reads them; the second sample has rates', async () => {
    const a = await start();
    const m = await a.metrics();
    expect(m.os).toBe(process.platform);
    expect(m.cpu.cores).toBeGreaterThan(0);
    expect(m.memory.totalBytes).toBeGreaterThan(0);
    expect(m.memory.usedPct).toBeGreaterThan(0);
    expect(m.memory.usedPct).toBeLessThanOrEqual(100);
    expect(m.disks?.length).toBeGreaterThan(0);
    expect(m.uptimeSec).toBeGreaterThan(0);
    const m2 = await a.metrics();
    expect(m2.timestampMs).toBeGreaterThanOrEqual(m.timestampMs);
    expect(m2.network.rxBytes).toBeGreaterThanOrEqual(0);
    const p = await a.processes();
    expect(p.total).toBeGreaterThan(0);
    const me = p.processes?.find((x) => x.pid === process.pid);
    expect(me?.user).toBe(execFileSync('id', ['-un'], { encoding: 'utf8' }).trim());
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.rssBytes).toBeGreaterThan(0);
  });
});

describe('Linux', () => {
  /** A /proc of one process (4242, owned by the test's user) and a sample
   * of the machine's counters at stage n. */
  function proc(n: number) {
    const auxv = Buffer.alloc(32);
    auxv.writeBigUInt64LE(6n, 0); // AT_PAGESZ
    auxv.writeBigUInt64LE(4096n, 8);
    return {
      stat: `cpu  ${100 + 100 * n} 0 100 ${800 + 100 * n} 0 0 0 0 0 0\ncpu0 ${50 + 100 * n} 0 50 ${400 + 100 * n} 0 0 0 0 0 0\n`,
      loadavg: '0.50 0.25 0.10 1/100 4242\n',
      uptime: '1000.50 900.00\n',
      meminfo: 'MemTotal: 1000000 kB\nMemAvailable: 250000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
      'net/dev': `Inter-| Receive | Transmit\n face |bytes packets|bytes\n    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n  eth0: ${1000 + 2000 * n} 1 0 0 0 0 0 0 ${500 * n} 1 0 0 0 0 0 0\n`,
      diskstats: `   8 0 sda 1 0 ${100 * n} 0 1 0 0 0 0 0 0\n`,
      mounts: '/dev/sda1 / ext4 rw 0 0\nproc /proc proc rw 0 0\n',
      'self/auxv': auxv,
      // 300 ticks of CPU after 3 of a run that started at tick 50000.
      '4242/stat': `4242 (python3) S 1 4242 4242 0 -1 0 0 0 0 0 ${250 + 100 * n} 50 0 0 20 0 1 0 50000 0 256 0`,
      '4242/cmdline': 'python3\0train.py\0',
    };
  }

  test('metrics from /proc and /sys: CPU between samples (twice on the first), memory, rates, disks, GPUs, sensors', async () => {
    const root = tree(Object.fromEntries(Object.entries(proc(0)).map(([k, v]) => [`proc/${k}`, v])));
    const sys = tree({
      'class/hwmon/hwmon0/name': 'coretemp',
      'class/hwmon/hwmon0/temp1_input': '52000',
      'class/drm/card0/device/vendor': '0x1002',
      'class/drm/card0/device/gpu_busy_percent': '37',
      'class/drm/card0/device/mem_info_vram_used': '1073741824',
      'class/drm/card0/device/mem_info_vram_total': '4294967296',
      'class/drm/card0-DP-1/status': 'connected',
      'class/drm/card1/device/vendor': '0x10de',
    });
    // nvidia-smi on the PATH: its GPUs come first.
    const bin = tree({ 'nvidia-smi': '#!/bin/sh\necho "0, NVIDIA A100, 90, 2048, 40960, 55, 200.5, 400.0"\n' });
    chmodSync(join(bin, 'nvidia-smi'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const a = await start({ platform: 'linux', procRoot: join(root, 'proc'), sysRoot: sys, cpuGapMs: 1 });
      // The first sample reads the CPU twice; between the same ticks: 0 %.
      const m = await a.metrics();
      expect(m.os).toBe('linux');
      expect(m.cpu).toMatchObject({ usagePct: 0, load1: 0.5, load5: 0.3, load15: 0.1, perCore: [0] });
      expect(m.uptimeSec).toBe(1000);
      expect(m.memory).toMatchObject({ totalBytes: 1024e6, usedBytes: 768e6, usedPct: 75 });
      expect(m.network).toMatchObject({
        rxBytes: 1000,
        txBytes: 0,
        rxBytesPerSec: 0,
        interfaces: [{ name: 'eth0', rxBytes: 1000, txBytes: 0 }],
      });
      expect(m.disks?.[0]).toMatchObject({ mount: '/', device: '/dev/sda1', fsType: 'ext4' });
      expect(m.gpus).toEqual([
        {
          index: 0,
          name: 'NVIDIA A100',
          vendor: 'nvidia',
          utilPct: 90,
          memUsedBytes: 2048 * 1024 * 1024,
          memTotalBytes: 40960 * 1024 * 1024,
          memPct: 5,
          tempC: 55,
          powerW: 200.5,
          powerLimitW: 400,
        },
        { index: 1, name: 'AMD GPU (card0)', vendor: 'amd', utilPct: 37, memUsedBytes: 1073741824, memTotalBytes: 4294967296, memPct: 25 },
      ]);
      expect(m.sensors).toEqual({ temps: [{ chip: 'coretemp', label: 'temp1', tempC: 52 }] });

      // The counters move on: shares and rates are the interval's.
      for (const [k, v] of Object.entries(proc(1))) writeFileSync(join(root, 'proc', k), v);
      await new Promise((res) => setTimeout(res, 50));
      const m2 = await a.metrics();
      // total +200, idle +100 -> 50 %; cpu0 likewise.
      expect(m2.cpu.usagePct).toBe(50);
      expect(m2.cpu.perCore).toEqual([50]);
      expect(m2.network.rxBytes).toBe(3000);
      expect(m2.network.rxBytesPerSec).toBeGreaterThan(0);
      expect(m2.diskIO.readBytes).toBe(100 * 512);
      expect(m2.diskIO.readBytesPerSec).toBeGreaterThan(0);
    } finally {
      process.env.PATH = path;
    }
  });

  test("processes from /proc: the first share since the process started, then the interval's; owner, command, age, GPU memory", async () => {
    const files = Object.fromEntries(Object.entries(proc(0)).map(([k, v]) => [`proc/${k}`, v]));
    const root = tree({ ...files, passwd: `nobody:x:65534:65534::/:/bin/false\nme:x:${process.getuid!()}:0::/:/bin/sh\n` });
    const bin = tree({ 'nvidia-smi': '#!/bin/sh\necho "4242, 512"\n' });
    chmodSync(join(bin, 'nvidia-smi'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const a = await start({ platform: 'linux', procRoot: join(root, 'proc'), passwd: join(root, 'passwd') });
      const p = await a.processes();
      expect(p).toMatchObject({ total: 1, memTotalBytes: 1024e6 });
      // 300 ticks (3 s) over the 500.5 s since it started at 500 s.
      expect(p.processes?.[0]).toEqual({
        pid: 4242,
        ppid: 1,
        name: 'python3',
        command: 'python3 train.py',
        user: 'me',
        cpuPct: 0.6,
        memPct: 0.1,
        rssBytes: 256 * 4096,
        state: 'S',
        elapsed: '08:20',
        gpuMemBytes: 512 * 1024 * 1024,
      });
      writeFileSync(join(root, 'proc', '4242', 'stat'), proc(1)['4242/stat']);
      await new Promise((res) => setTimeout(res, 100));
      const p2 = await a.processes();
      // 100 ticks (1 s) in about 0.1 s: a busy process.
      expect(p2.processes?.[0].cpuPct).toBeGreaterThan(100);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('signals', () => {
  test('refused for pids up to 1, the agent and signals off the list; sent otherwise; a process that is gone is not_found', async () => {
    const a = await start();
    // Up to 1, and beyond pid_t (which kill(2) would take as -1, every
    // process, and as the agent itself): refused by the protocol.
    for (const pid of [0, 1, -5, 2 ** 32 - 1, 2 ** 32 + process.pid, 2 ** 31]) expect(await a.rawSignal(pid, 'CONT')).toBe('bad_params');
    expect(await refusal(a.signal(process.pid, 'TERM'))).toBe('invalid_pid');
    expect(await refusal(a.signal(999999, 'SEGV'))).toBe('invalid_signal');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise<string | null>((res) => child.once('exit', (_, sig) => res(sig)));
    expect(await a.signal(child.pid!, ' term ')).toEqual({ ok: true, pid: child.pid!, signal: 'TERM' });
    expect(await exited).toBe('SIGTERM');
    expect(await refusal(a.signal(child.pid!, 'KILL'))).toBe('not_found');
    expect(await a.signal(child.pid!, '').catch((e: Fail) => e.code)).toBe('not_found');
  });

  test("another user's process is the kernel's to refuse", async () => {
    if (process.getuid!() === 0) return;
    const a = await start();
    // A root process of another session (CONT, harmless, reaches any
    // process of the sender's own session; macOS's root daemons are
    // launchd's); pid 1 is refused before.
    const session = (pid: number | 'self') => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[3];
      } catch {
        return null;
      }
    };
    const p = await a.processes();
    const theirs = p.processes?.find(
      (x) => x.pid > 1 && x.pid !== process.pid && x.user === 'root' && (session('self') === null || session(x.pid) !== session('self')),
    );
    if (!theirs) return;
    expect(await refusal(a.signal(theirs.pid, 'CONT'))).toBe('permission_denied');
  });
});
