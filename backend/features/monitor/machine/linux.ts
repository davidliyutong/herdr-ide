// Linux: /proc's texts (the CPU's ticks, memory, network and block device
// counters, mounts, each process's stat and command line), statfs of the
// mounted file systems, the GPUs (gpu.ts) and the hwmon sensors
// (sensors.ts).
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { NVIDIA_APPS, NVIDIA_GPUS, drmGPUs, parseNvidiaApps, parseNvidiaGPUs } from './gpu.ts';
import { mapLimit, onPath, runCmd, type Bounded } from './io.ts';
import { clampPct, fields, parseInt10, parseNum, parseUint, round1, truncateBytes } from './num.ts';
import { cpuDeltaPct, type Ticks } from './rates.ts';
import { sysfsSensors } from './sensors.ts';
import { MAX_COMMAND, baseMetrics, normalizeState, type Sampling } from './sample.ts';
import type { Disk, GPU, Memory, Metrics, NetCounter, Process, Processes } from './types.ts';

/** The clock ticks of /proc's times per second (USER_HZ, 100 on every
 * Linux the agent meets). */
const CLK_TCK = 100;

/** /proc/stat's CPU ticks: all of them and per core. */
export function parseProcStat(raw: string): { total: Ticks; cores: Ticks[] } | null {
  let total: Ticks | null = null;
  const cores: Ticks[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const f = fields(line);
    if (f.length < 5) continue;
    const vals: number[] = [];
    for (const s of f.slice(1)) {
      const n = parseUint(s);
      if (n === null) break;
      vals.push(n);
    }
    if (vals.length < 4) continue;
    const t: Ticks = { total: vals.reduce((a, b) => a + b, 0), idle: vals[3] + (vals[4] ?? 0) };
    if (f[0] === 'cpu') total = t;
    else cores.push(t);
  }
  return total ? { total, cores } : null;
}

/** /proc/meminfo (kB): used is total less available (MemAvailable, else
 * free, buffers and cache). */
export function parseMeminfo(raw: string): Memory {
  const kv = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const v = parseUint(fields(line.slice(i + 1))[0] ?? '');
    if (v !== null) kv.set(line.slice(0, i).trim(), v * 1024);
  }
  const get = (k: string) => kv.get(k) ?? 0;
  const total = get('MemTotal');
  let avail = get('MemAvailable');
  if (avail === 0) avail = get('MemFree') + get('Buffers') + get('Cached');
  if (avail > total) avail = total;
  const used = total - avail;
  const swapTotal = get('SwapTotal');
  const swapFree = get('SwapFree');
  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: avail,
    usedPct: total > 0 ? clampPct((used / total) * 100) : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal > swapFree ? swapTotal - swapFree : 0,
  };
}

/** /proc/net/dev's bytes received and sent by interface, without the
 * loopback. */
export function parseNetDev(raw: string): Map<string, NetCounter> {
  const res = new Map<string, NetCounter>();
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const iface = line.slice(0, i).trim();
    if (iface === '' || iface === 'lo') continue;
    const f = fields(line.slice(i + 1));
    if (f.length < 9) continue;
    const rx = parseUint(f[0]);
    const tx = parseUint(f[8]);
    if (rx === null || tx === null) continue;
    res.set(iface, { rx, tx });
  }
  return res;
}

/** Whether a name of /proc/diskstats is a whole disk (sda, nvme0n1, vda,
 * xvda, mmcblk0), so that partitions are not counted twice. */
export function wholeDisk(name: string): boolean {
  if (/^(loop|ram|zram|sr)/.test(name)) return false;
  if (name.startsWith('nvme')) {
    const i = name.indexOf('n');
    return i >= 0 && !name.slice(i + 1).includes('p');
  }
  if (name.startsWith('mmcblk')) return !name.slice(6).includes('p');
  const m = /^(sd|vd|xvd|hd)(.*)$/.exec(name);
  return !!m && /^[a-z]+$/.test(m[2]);
}

/** /proc/diskstats' bytes read and written by whole disks (sectors of 512). */
export function parseDiskstats(raw: string): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const line of raw.split('\n')) {
    const f = fields(line);
    if (f.length < 10 || !wholeDisk(f[2])) continue;
    const r = parseUint(f[5]);
    const w = parseUint(f[9]);
    if (r === null || w === null) continue;
    read += r;
    write += w;
  }
  return { read: read * 512, write: write * 512 };
}

/** /proc/loadavg's three averages, to one decimal. */
export function parseLoadavg(raw: string): [number, number, number] | null {
  const f = fields(raw);
  if (f.length < 3) return null;
  return [round1(parseNum(f[0]) ?? 0), round1(parseNum(f[1]) ?? 0), round1(parseNum(f[2]) ?? 0)];
}

/** /proc/uptime's seconds since boot. */
export const parseUptime = (raw: string): number => parseNum(fields(raw)[0] ?? '') ?? 0;

/** File systems that are not disks. */
const SKIP_FS = new Set([
  'proc',
  'sysfs',
  'tmpfs',
  'devtmpfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'pstore',
  'securityfs',
  'debugfs',
  'tracefs',
  'hugetlbfs',
  'mqueue',
  'fusectl',
  'configfs',
  'binfmt_misc',
  'autofs',
  'squashfs',
  'overlay',
  'nsfs',
  'ramfs',
  'efivarfs',
  'bpf',
  'rpc_pipefs',
  'fuse.portal',
]);

/** /proc/mounts' file systems to show: devices (a path, or host:export),
 * each once, not snaps nor the EFI partition. */
export function parseMounts(raw: string): Array<{ device: string; mount: string; fsType: string }> {
  const seen = new Set<string>();
  const out: Array<{ device: string; mount: string; fsType: string }> = [];
  for (const line of raw.split('\n')) {
    const f = fields(line);
    if (f.length < 3) continue;
    const [device, escaped, fsType] = f;
    const mount = escaped.replaceAll('\\040', ' ').replaceAll('\\011', '\t');
    if (SKIP_FS.has(fsType)) continue;
    if (!device.startsWith('/') && !device.includes(':')) continue;
    if (mount.startsWith('/snap/') || mount.startsWith('/boot/efi')) continue;
    if (seen.has(device)) continue;
    seen.add(device);
    out.push({ device, mount, fsType });
  }
  return out;
}

/** A process's /proc/<pid>/stat: its name, state, parent, CPU ticks, start
 * (ticks after boot) and resident pages. */
export interface PidStat {
  comm: string;
  state: string;
  ppid: number;
  utime: number;
  stime: number;
  start: number;
  rssPages: number;
}

export function parsePidStat(raw: string): PidStat | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open || close + 2 >= raw.length) return null;
  const f = fields(raw.slice(close + 2));
  // [0] state, [1] ppid, [11] utime, [12] stime, [19] starttime, [21] rss
  if (f.length < 22) return null;
  const n = (s: string) => parseUint(s) ?? 0;
  return {
    comm: raw.slice(open + 1, close),
    state: f[0],
    ppid: parseInt10(f[1]) ?? 0,
    utime: n(f[11]),
    stime: n(f[12]),
    start: n(f[19]),
    rssPages: Math.max(0, parseInt10(f[21]) ?? 0),
  };
}

/** /proc/<pid>/cmdline's arguments joined by spaces. */
export const formatCmdline = (b: Buffer): string =>
  b
    .toString('utf8')
    .split('\0')
    .filter((s) => s !== '')
    .join(' ');

/** Seconds as ps shows elapsed time: [[dd-]hh:]mm:ss. */
export function formatElapsed(sec: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(sec / 86400);
  const rem = sec % 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  if (days > 0) return `${days}-${p(h)}:${p(m)}:${p(s)}`;
  if (h > 0) return `${p(h)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

/** The users of /etc/passwd by uid. */
export function parsePasswd(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of raw.split('\n')) {
    const f = line.split(':');
    if (f.length < 3 || line.startsWith('#')) continue;
    const uid = parseUint(f[2]);
    if (uid !== null && f[0] && !out.has(uid)) out.set(uid, f[0]);
  }
  return out;
}

/** The page size from the auxiliary vector (/proc/self/auxv, AT_PAGESZ on
 * a 64-bit system), 4096 when it cannot be read. */
export function pageSizeOf(auxv: Buffer | null): number {
  if (auxv)
    for (let i = 0; i + 16 <= auxv.length; i += 16) {
      const key = auxv.readBigUInt64LE(i);
      if (key === 0n) break;
      if (key === 6n) return Number(auxv.readBigUInt64LE(i + 8));
    }
  return 4096;
}

interface LinuxFacts {
  pageSize?: number;
  users?: { until: number; names: Map<number, string> };
  nvidia?: { path: string | undefined; until: number; found: Promise<boolean | null> };
}
const facts = new WeakMap<Bounded, LinuxFacts>();
const FACT_TTL_MS = 60_000;

function factsOf(io: Bounded): LinuxFacts {
  let f = facts.get(io);
  if (!f) facts.set(io, (f = {}));
  return f;
}

function hasNvidia(s: Sampling): Promise<boolean | null> {
  const f = factsOf(s.io);
  const path = s.env.PATH;
  const now = performance.now();
  if (!f.nvidia || f.nvidia.path !== path || f.nvidia.until <= now) {
    f.nvidia = {
      path,
      until: now + FACT_TTL_MS,
      found: s.io.run(`which:nvidia-smi:${path ?? ''}`, s.o.readMs, () => onPath('nvidia-smi', path)),
    };
  }
  return f.nvidia.found;
}

/** One sample of a Linux machine's independent counters and devices. */
export async function linuxMetrics(s: Sampling): Promise<Metrics> {
  const { io, rates, o } = s;
  const proc = (p: string) => io.text(join(o.procRoot, p), o.readMs);
  const m = baseMetrics(Date.now(), 'linux');
  const sensorSignal = AbortSignal.any([s.signal, AbortSignal.timeout(o.sensorsBudgetMs)]);
  const sensors = io.run('sensors', o.sensorsBudgetMs, () => sysfsSensors(io, o.sysRoot, o.readMs, sensorSignal));
  const stamped = (path: string) => proc(path).then((data) => ({ data, at: Date.now() }));
  const [load, up, mem, net, disk, disks, gpus, sensed] = await Promise.all([
    proc('loadavg'),
    proc('uptime'),
    proc('meminfo'),
    stamped('net/dev'),
    stamped('diskstats'),
    linuxDisks(s),
    linuxGPUs(s),
    sensors,
    linuxCPU(s, m),
  ]);
  const avg = parseLoadavg(load ?? '');
  if (avg) [m.cpu.load1, m.cpu.load5, m.cpu.load15] = avg;
  const uptime = parseUptime(up ?? '');
  if (uptime > 0) m.uptimeSec = Math.floor(uptime);
  if (mem !== null) m.memory = parseMeminfo(mem);
  if (net.data !== null) m.network = rates.network(net.at, parseNetDev(net.data));
  if (disk.data !== null) {
    const d = parseDiskstats(disk.data);
    m.diskIO = rates.diskIO(disk.at, d.read, d.write);
  }
  m.disks = disks;
  m.gpus = gpus;
  if (sensed) m.sensors = sensed;
  return m;
}

/** The first metrics request samples the CPU twice to show live usage. */
async function linuxCPU(s: Sampling, m: Metrics): Promise<void> {
  const { o, rates } = s;
  const stat = parseProcStat((await s.io.text(join(o.procRoot, 'stat'), o.readMs)) ?? '');
  if (stat) {
    let prev = rates.cpu;
    let cur = stat;
    rates.cpu = cur;
    if (!prev) {
      await new Promise((r) => setTimeout(r, o.cpuGapMs));
      const again = s.signal.aborted ? null : parseProcStat((await s.io.text(join(o.procRoot, 'stat'), o.readMs)) ?? '');
      if (again) {
        prev = cur;
        cur = again;
        rates.cpu = again;
      } else prev = { total: { total: 0, idle: 0 }, cores: [] }; // since boot
    }
    m.cpu.usagePct = cpuDeltaPct(prev.total, cur.total);
    if (cur.cores.length > 0 && cur.cores.length === prev.cores.length)
      m.cpu.perCore = cur.cores.map((c, i) => cpuDeltaPct(prev.cores[i], c));
  }
}

/** The file systems of /proc/mounts with their usage (statfs); one whose
 * statfs does not answer in time (a dead network mount) is left out. */
async function linuxDisks(s: Sampling): Promise<Disk[] | null> {
  const raw = await s.io.text(join(s.o.procRoot, 'mounts'), s.o.readMs);
  if (raw === null) return null;
  const mounts = parseMounts(raw);
  const stats = await Promise.all(mounts.map((mt) => s.io.statfs(mt.mount, s.o.statfsMs)));
  const out: Disk[] = [];
  mounts.forEach((mt, i) => {
    const st = stats[i];
    if (!st || st.blocks === 0) return;
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    const used = total > free ? total - free : 0;
    out.push({
      mount: mt.mount,
      device: mt.device,
      fsType: mt.fsType || undefined,
      totalBytes: total,
      usedBytes: used,
      availBytes: st.bavail * st.bsize,
      usedPct: clampPct((used / total) * 100),
    });
  });
  out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount < b.mount ? -1 : a.mount > b.mount ? 1 : 0));
  return out.length ? out : null;
}

/** NVIDIA's GPUs (nvidia-smi on PATH) and the DRM class's after them. */
async function linuxGPUs(s: Sampling): Promise<GPU[]> {
  const out: GPU[] = [];
  if (await hasNvidia(s)) {
    const raw = await runCmd('nvidia-smi', NVIDIA_GPUS, { env: s.env, ms: s.o.cmdTimeoutMs, signal: s.signal });
    if (raw !== null) out.push(...parseNvidiaGPUs(raw));
  }
  out.push(...(await drmGPUs(s.io, join(s.o.sysRoot, 'class', 'drm'), out.length, s.o.readMs)));
  return out;
}

/** The processes of /proc: their CPU share since the previous listing (the
 * first: since they started), memory, owner, state and age, and the GPU
 * memory nvidia-smi reports for them. */
export async function linuxProcesses(s: Sampling): Promise<Processes> {
  const { io, rates, o } = s;
  const now = Date.now();
  const gpuMem = (async () => {
    if (!(await hasNvidia(s))) return null;
    const raw = await runCmd('nvidia-smi', NVIDIA_APPS, { env: s.env, ms: o.cmdTimeoutMs, signal: s.signal });
    return raw === null ? null : parseNvidiaApps(raw);
  })();
  const f = factsOf(io);
  const [memory, up, auxv, passwd, names] = await Promise.all([
    io.text(join(o.procRoot, 'meminfo'), o.readMs),
    io.text(join(o.procRoot, 'uptime'), o.readMs),
    f.pageSize === undefined ? io.bytes(join(o.procRoot, 'self', 'auxv'), o.readMs) : null,
    !f.users || f.users.until <= performance.now() ? io.text(o.passwd, o.readMs) : null,
    io.names(o.procRoot, o.readMs),
  ]);
  if (auxv) f.pageSize = pageSizeOf(auxv);
  if (passwd !== null) f.users = { names: parsePasswd(passwd), until: performance.now() + FACT_TTL_MS };
  const memTotal = parseMeminfo(memory ?? '').totalBytes;
  const uptime = parseUptime(up ?? '');
  const pageSize = f.pageSize ?? pageSizeOf(null);
  const users = f.users?.names;
  if (names === null) throw new Error(`cannot list ${o.procRoot}`);
  const pids = names.map((n) => parseUint(n)).filter((p): p is number => p !== null && p > 0);

  const hasPrev = rates.procRated(now);
  const dt = (now - rates.procAt) / 1000;
  const prev = rates.procTicks;
  const ticks = new Map<number, number>();
  const listed = await mapLimit(pids, 32, async (pid): Promise<Process | null> => {
    const dir = join(o.procRoot, String(pid));
    const st = parsePidStat((await io.text(join(dir, 'stat'), o.readMs)) ?? '');
    if (!st) return null;
    const t = st.utime + st.stime;
    ticks.set(pid, t);
    let cpuPct = 0;
    if (hasPrev) {
      const pt = prev.get(pid);
      if (pt !== undefined && t >= pt) cpuPct = round1(((t - pt) / CLK_TCK / dt) * 100);
    } else if (uptime > 0) {
      const age = uptime - st.start / CLK_TCK;
      if (age > 0.5) cpuPct = round1((t / CLK_TCK / age) * 100);
    }
    const rss = st.rssPages * pageSize;
    const [cmd, uid] = await Promise.all([io.bytes(join(dir, 'cmdline'), o.readMs), io.uid(dir, o.readMs)]);
    return {
      pid,
      ppid: st.ppid,
      name: st.comm,
      command: truncateBytes(cmd && cmd.length ? formatCmdline(cmd) : st.comm, MAX_COMMAND),
      user: uid === null ? '' : (users?.get(uid) ?? String(uid)),
      cpuPct,
      memPct: memTotal > 0 ? round1((rss / memTotal) * 100) : 0,
      rssBytes: rss,
      state: normalizeState(st.state),
      elapsed: uptime > 0 ? formatElapsed(Math.max(0, Math.trunc(uptime - st.start / CLK_TCK))) : '',
    };
  });
  rates.procTicks = ticks;
  rates.procAt = now;
  const procs = listed.filter((p): p is Process => p !== null);
  const gm = await gpuMem;
  if (gm?.size) for (const p of procs) if (gm.has(p.pid)) p.gpuMemBytes = gm.get(p.pid);
  return { processes: procs, total: procs.length, cores: availableParallelism(), memTotalBytes: memTotal, timestampMs: now };
}
