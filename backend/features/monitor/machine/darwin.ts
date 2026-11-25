// macOS: what its own programs print (sysctl, vm_stat, top, netstat,
// ioreg, df, ps), run side by side for one sample. Memory used is Activity
// Monitor's (app memory, wired and compressed), the disk is the APFS data
// volume's container, and the GPUs are the IOAccelerator registry's.
import { availableParallelism } from 'node:os';
import { posix } from 'node:path';
import { runCmd } from './io.ts';
import { clampPct, fields, parseInt10, parseNum, parseUint, round1, truncateBytes } from './num.ts';
import { parseBatteryTemp } from './sensors.ts';
import { MAX_COMMAND, baseMetrics, normalizeState, type Sampling } from './sample.ts';
import type { Disk, GPU, Memory, Metrics, NetCounter, Process, Processes } from './types.ts';

/** `vm_stat` and the RAM's bytes: used is app memory (anonymous less
 * purgeable pages), wired and compressed pages, as Activity Monitor shows
 * it (active, wired and compressed without the anonymous count). */
export function parseVMStat(raw: string, total: number): Memory {
  let pageSize = 4096;
  const pages = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const ps = /page size of (\d+) /.exec(line);
    if (line.includes('page size of')) {
      if (ps && Number(ps[1]) > 0) pageSize = Number(ps[1]);
      continue;
    }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const n = parseUint(
      line
        .slice(i + 1)
        .trim()
        .replace(/\.+$/, ''),
    );
    if (n !== null) pages.set(line.slice(0, i).trim(), n);
  }
  const get = (k: string) => pages.get(k) ?? 0;
  const anon = get('Anonymous pages');
  const purgeable = get('Pages purgeable');
  const app = anon > purgeable ? anon - purgeable : 0;
  const wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor');
  let used = (app + wired + compressed) * pageSize;
  if (used === 0) used = (get('Pages active') + wired + compressed) * pageSize;
  if (total > 0 && used > total) used = total;
  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: total > used ? total - used : 0,
    usedPct: total > 0 ? clampPct((used / total) * 100) : 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
}

/** A size such as 5120.00M (K, M, G, T: powers of 1024). */
export function parseSized(s: string): number {
  s = s.trim();
  if (s === '') return 0;
  const mult: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  const unit = mult[s[s.length - 1].toLowerCase()];
  const v = parseNum(unit ? s.slice(0, -1) : s);
  return v === null || v < 0 ? 0 : Math.floor(v * (unit ?? 1));
}

/** `sysctl -n vm.swapusage`: "total = 5120.00M  used = 3476.88M  free = …". */
export function parseSwapUsage(raw: string): { total: number; used: number } {
  const f = fields(raw);
  let total = 0;
  let used = 0;
  for (let i = 0; i + 2 < f.length; i++) {
    if (f[i + 1] !== '=') continue;
    if (f[i] === 'total') total = parseSized(f[i + 2]);
    else if (f[i] === 'used') used = parseSized(f[i + 2]);
  }
  return { total, used };
}

/** top's "CPU usage: 4.61% user, 11.36% sys, 84.1% idle": the busy share. */
export function parseTopCPU(raw: string): number | null {
  for (const line of raw.split('\n')) {
    if (!line.includes('CPU usage:')) continue;
    for (const part of line.split(',')) {
      const p = part.trim();
      if (!p.endsWith('idle')) continue;
      const idle = parseNum((fields(p)[0] ?? '').replace(/%$/, ''));
      if (idle !== null) return clampPct(100 - idle);
    }
  }
  return null;
}

/** `sysctl -n vm.loadavg`: "{ 1.78 2.19 2.35 }". */
export function parseLoadAvg(raw: string): [number, number, number] {
  const f = fields(raw.trim().replace(/^\{+|\}+$/g, ''));
  if (f.length < 3) return [0, 0, 0];
  return [round1(parseNum(f[0]) ?? 0), round1(parseNum(f[1]) ?? 0), round1(parseNum(f[2]) ?? 0)];
}

/** `sysctl -n kern.boottime`: "{ sec = 1795076341, usec = 156604 } …", as
 * the seconds since then; 0 when it cannot be read. */
export function parseBoottime(raw: string, now: number): number {
  const m = /sec = ([^, }]*)/.exec(raw);
  const sec = m ? parseInt10(m[1].trim()) : null;
  const nowSec = Math.floor(now / 1000);
  if (sec === null || sec <= 0 || nowSec < sec) return 0;
  return nowSec - sec;
}

/** `netstat -ibn`'s Link rows: bytes received and sent by interface,
 * without the loopback; the first row of a name counts. */
export function parseNetstat(raw: string): Map<string, NetCounter> {
  const res = new Map<string, NetCounter>();
  for (const line of raw.split('\n')) {
    const f = fields(line);
    if (f.length < 10 || !f[2].startsWith('<Link#')) continue;
    const name = f[0].replace(/\*$/, '');
    if (name === '' || name.startsWith('lo')) continue;
    // With an address (11 columns): Name Mtu Network Address Ipkts Ierrs
    // Ibytes Opkts Oerrs Obytes Coll; without one, 10.
    const [ib, ob] = f.length === 10 ? [5, 8] : [6, 9];
    const rx = parseUint(f[ib]);
    const tx = parseUint(f[ob]);
    if (rx === null || tx === null) continue;
    if (!res.has(name)) res.set(name, { rx, tx });
  }
  return res;
}

/** The number after key= in one of ioreg's dictionaries on a line. */
export function ioregNum(line: string, key: string): number | null {
  const i = line.indexOf(key + '=');
  if (i < 0) return null;
  let rest = line.slice(i + key.length + 1);
  const end = rest.search(/[,}]/);
  if (end >= 0) rest = rest.slice(0, end);
  return parseNum(rest);
}

/** `ioreg -r -d 1 -w 0 -c IOAccelerator`: one GPU an object, its model, its
 * utilization and the memory it uses; Apple's share the host's memory
 * (hostMem). */
export function parseIOAccelerator(raw: string, hostMem: number): GPU[] {
  const out: GPU[] = [];
  for (const block of raw.split('+-o ').slice(1)) {
    let name = '';
    let util: number | undefined;
    let used = 0;
    let total = 0;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('"model" = "')) {
        const v = t.slice('"model" = "'.length);
        const end = v.indexOf('"');
        if (end >= 0) name = v.slice(0, end);
      } else if (t.startsWith('"PerformanceStatistics" = {')) {
        const u = ioregNum(t, '"Device Utilization %"') ?? ioregNum(t, '"Renderer Utilization %"');
        if (u !== null) util = clampPct(u);
        const inUse = ioregNum(t, '"In use system memory"');
        const alloc = ioregNum(t, '"Alloc system memory"');
        if (inUse !== null && inUse > 0) used = Math.floor(inUse);
        else if (alloc !== null && alloc > 0) used = Math.floor(alloc);
        const vramUsed = ioregNum(t, '"vramUsedBytes"');
        if (vramUsed !== null && vramUsed > 0) used = Math.floor(vramUsed);
        const vramFree = ioregNum(t, '"vramFreeBytes"');
        if (vramFree !== null && vramFree > 0 && used > 0) total = used + Math.floor(vramFree);
      }
    }
    if (name === '' && util === undefined && used === 0) continue;
    if (name === '') name = 'GPU';
    const lower = name.toLowerCase();
    const vendor =
      lower.includes('amd') || lower.includes('radeon')
        ? 'amd'
        : lower.includes('intel')
          ? 'intel'
          : lower.includes('nvidia')
            ? 'nvidia'
            : 'apple';
    if (total === 0 && vendor === 'apple' && hostMem > 0) total = hostMem;
    out.push({
      index: out.length,
      name,
      vendor,
      utilPct: util,
      memUsedBytes: used || undefined,
      memTotalBytes: total || undefined,
      memPct: total > 0 && used > 0 ? clampPct((used / total) * 100) : undefined,
    });
  }
  return out;
}

/** `ioreg -r -c IOBlockStorageDriver -w 0`'s Statistics: bytes read and
 * written by all drives. */
export function parseBlockStorage(raw: string): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const line of raw.split('\n')) {
    if (!line.includes('"Statistics" = {')) continue;
    const r = ioregNum(line, '"Bytes (Read)"');
    const w = ioregNum(line, '"Bytes (Write)"');
    if (r !== null && r >= 0) read += Math.floor(r);
    if (w !== null && w >= 0) write += Math.floor(w);
  }
  return { read, write };
}

/** `df -kP`: the devices' file systems, APFS's /System/Volumes/Data shown
 * as / (its container's use), the system's internal volumes left out,
 * each device once. */
export function parseDF(raw: string): Disk[] | null {
  let root: Disk | null = null;
  let data: Disk | null = null;
  const others: Disk[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n').slice(1)) {
    const f = fields(line);
    if (f.length < 6 || !f[0].startsWith('/dev/')) continue;
    const dev = f[0];
    const totalK = parseUint(f[1]);
    const usedK = parseUint(f[2]);
    const availK = parseUint(f[3]);
    if (totalK === null || usedK === null || availK === null || totalK === 0) continue;
    const mount = f.slice(5).join(' ');
    const total = totalK * 1024;
    const avail = availK * 1024;
    let used = usedK * 1024;
    const disk = (m: string): Disk => ({
      mount: m,
      device: dev,
      totalBytes: total,
      usedBytes: used,
      availBytes: avail,
      usedPct: clampPct((used / total) * 100),
    });
    if (mount === '/System/Volumes/Data') {
      // On APFS the container's used space is its total less what is free.
      if (total > avail) used = total - avail;
      data = disk('/');
      continue;
    }
    if (mount === '/') {
      root = disk('/');
      continue;
    }
    if (mount.startsWith('/System/Volumes/') || mount.startsWith('/private/var/vm')) continue;
    if (seen.has(dev)) continue;
    seen.add(dev);
    others.push(disk(mount));
  }
  const out = [...(data ? [data] : root ? [root] : []), ...others];
  return out.length ? out : null;
}

/** s split on runs of blanks into at most n parts, the rest whole in the
 * last. */
export function splitN(s: string, n: number): string[] {
  const out: string[] = [];
  let i = 0;
  const blank = (c: string) => c === ' ' || c === '\t';
  while (out.length < n - 1) {
    while (i < s.length && blank(s[i])) i++;
    if (i >= s.length) return out;
    const start = i;
    while (i < s.length && !blank(s[i])) i++;
    out.push(s.slice(start, i));
  }
  while (i < s.length && blank(s[i])) i++;
  if (i < s.length) out.push(s.slice(i));
  return out;
}

/** `ps -axww -o pid=,ppid=,user=,%cpu=,%mem=,rss=,state=,etime=,comm=` and
 * `ps -axww -o pid=,args=`: one process a line. */
export function parsePS(metaRaw: string, argsRaw: string): Process[] {
  const args = new Map<number, string>();
  for (const line of argsRaw.split('\n')) {
    const t = line.trim();
    const sp = t.search(/[ \t]/);
    if (sp <= 0) continue;
    const pid = parseInt10(t.slice(0, sp));
    if (pid !== null) args.set(pid, truncateBytes(t.slice(sp + 1).trim(), MAX_COMMAND));
  }
  const out: Process[] = [];
  for (const line of metaRaw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const f = splitN(t, 9);
    if (f.length < 9) continue;
    const pid = parseInt10(f[0]);
    const ppid = parseInt10(f[1]);
    if (pid === null || ppid === null) continue;
    const comm = f[8].trim();
    let name = posix.basename(comm);
    if (name === '.' || name === '/' || name === '') name = comm;
    out.push({
      pid,
      ppid,
      name,
      command: args.get(pid) || comm,
      user: f[2],
      cpuPct: round1(parseNum(f[3]) ?? 0),
      memPct: round1(parseNum(f[4]) ?? 0),
      rssBytes: (parseUint(f[5]) ?? 0) * 1024,
      state: normalizeState(f[6]),
      elapsed: f[7],
    });
  }
  return out;
}

/** One sample of a Mac's metrics, its programs run side by side. */
export async function darwinMetrics(s: Sampling): Promise<Metrics> {
  const now = Date.now();
  const m = baseMetrics(now, 'darwin');
  const run = (file: string, ...args: string[]) => runCmd(file, args, { env: s.env, ms: s.o.cmdTimeoutMs, signal: s.signal });
  const [sysctl, vmStat, top, netstat, gpu, block, df, battery] = await Promise.all([
    run('sysctl', '-n', 'vm.loadavg', 'hw.memsize', 'vm.swapusage', 'kern.boottime'),
    run('vm_stat'),
    run('top', '-l', '1', '-n', '0', '-s', '0'),
    run('netstat', '-ibn'),
    run('ioreg', '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'),
    run('ioreg', '-r', '-c', 'IOBlockStorageDriver', '-w', '0'),
    run('df', '-kP'),
    // The battery is the only temperature readable without root or the SMC
    // and IOHID interfaces; a desktop Mac has none and shows no sensors.
    run('ioreg', '-rn', 'AppleSmartBattery', '-w0'),
  ]);
  let memTotal = 0;
  let swap = { total: 0, used: 0 };
  if (sysctl) {
    const lines = sysctl.trim().split('\n');
    if (lines.length >= 1) [m.cpu.load1, m.cpu.load5, m.cpu.load15] = parseLoadAvg(lines[0]);
    if (lines.length >= 2) memTotal = parseUint(lines[1].trim()) ?? 0;
    if (lines.length >= 3) swap = parseSwapUsage(lines[2]);
    if (lines.length >= 4) m.uptimeSec = parseBoottime(lines[3], now);
  }
  m.memory = vmStat ? parseVMStat(vmStat, memTotal) : { ...m.memory, totalBytes: memTotal };
  m.memory.swapTotalBytes = swap.total;
  m.memory.swapUsedBytes = swap.used;
  const cpu = top ? parseTopCPU(top) : null;
  if (cpu !== null) m.cpu.usagePct = cpu;
  if (gpu) {
    const gpus = parseIOAccelerator(gpu, memTotal);
    if (gpus.length) m.gpus = gpus;
  }
  if (netstat) m.network = s.rates.network(Date.now(), parseNetstat(netstat));
  if (block) {
    const b = parseBlockStorage(block);
    m.diskIO = s.rates.diskIO(Date.now(), b.read, b.write);
  }
  if (df) m.disks = parseDF(df);
  if (battery) {
    const sens = parseBatteryTemp(battery);
    if (sens) m.sensors = sens;
  }
  return m;
}

/** The Mac's processes, as ps lists them. */
export async function darwinProcesses(s: Sampling): Promise<Processes> {
  const now = Date.now();
  const run = (file: string, ...args: string[]) => runCmd(file, args, { env: s.env, ms: s.o.cmdTimeoutMs, signal: s.signal });
  const [meta, args, mem] = await Promise.all([
    run('ps', '-axww', '-o', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,state=,etime=,comm='),
    run('ps', '-axww', '-o', 'pid=,args='),
    run('sysctl', '-n', 'hw.memsize'),
  ]);
  if (meta === null) throw new Error('ps did not answer');
  const procs = parsePS(meta, args ?? '');
  return {
    processes: procs.length ? procs : null,
    total: procs.length,
    cores: availableParallelism(),
    memTotalBytes: parseUint((mem ?? '').trim()) ?? 0,
    timestampMs: now,
  };
}
