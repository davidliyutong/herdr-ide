// The System Monitor & Task Manager's actions on a machine
// (docs/features/34-system-monitor.md), as the machine side serves them
// (features/monitor/machine): live metrics, a snapshot of the processes,
// and a signal from an allowlist to one of the user's processes. The hub
// passes results on to the page as the agent wrote them, so they are loose
// objects: typed, and a member a later agent adds still reaches the page. A
// Go slice without omitempty may be null.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

const num = z.number();
const opt = z.number().optional();

const cpu = z.looseObject({ usagePct: num, cores: num, load1: num, load5: num, load15: num, perCore: z.array(num).optional() });

const memory = z.looseObject({
  totalBytes: num,
  usedBytes: num,
  availableBytes: num,
  usedPct: num,
  swapTotalBytes: num,
  swapUsedBytes: num,
});

const gpu = z.looseObject({
  index: num,
  name: z.string(),
  vendor: z.string().optional(),
  utilPct: opt,
  memUsedBytes: opt,
  memTotalBytes: opt,
  memPct: opt,
  tempC: opt,
  powerW: opt,
  powerLimitW: opt,
});

const traffic = { rxBytesPerSec: num, txBytesPerSec: num, rxBytes: num, txBytes: num };

const network = z.looseObject({ ...traffic, interfaces: z.array(z.looseObject({ name: z.string(), ...traffic })).optional() });

const diskIO = z.looseObject({ readBytesPerSec: num, writeBytesPerSec: num, readBytes: num, writeBytes: num });

const disk = z.looseObject({
  mount: z.string(),
  device: z.string(),
  fsType: z.string().optional(),
  totalBytes: num,
  usedBytes: num,
  availBytes: num,
  usedPct: num,
});

const sensor = { chip: z.string(), label: z.string() };

const sensors = z.looseObject({
  temps: z.array(z.looseObject({ ...sensor, tempC: num, highC: opt, critC: opt })).optional(),
  fans: z.array(z.looseObject({ ...sensor, rpm: num, minRpm: opt, maxRpm: opt })).optional(),
});

/** One snapshot of a machine's resource usage. */
export const metrics = z.looseObject({
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  uptimeSec: num,
  timestampMs: num,
  cpu,
  memory,
  gpus: z.array(gpu).nullable(),
  network,
  diskIO,
  disks: z.array(disk).nullable(),
  sensors: sensors.optional(),
});

const processInfo = z.looseObject({
  pid: num,
  ppid: num,
  name: z.string(),
  command: z.string(),
  user: z.string(),
  cpuPct: num,
  memPct: num,
  rssBytes: num,
  state: z.string(),
  elapsed: z.string(),
  gpuMemBytes: opt,
});

export const processes = z.looseObject({
  processes: z.array(processInfo).nullable(),
  total: num,
  cores: num,
  memTotalBytes: num,
  timestampMs: num,
});

/** The largest pid: kill(2)'s pid_t is 32 bits, and a larger number would
 * wrap on a machine that passes it on as an int (4294967295 is -1, every
 * process of the user). */
export const MAX_PID = 2 ** 31 - 1;

export const monitorProtocol = defineProtocol('monitor', {
  metrics: { params: z.object({}), result: metrics, timeoutMs: 15_000 },
  processes: { params: z.object({}), result: processes, timeoutMs: 15_000 },
  /** A signal (TERM, KILL, INT, HUP, STOP, CONT) to a process of the
   * agent's user; the agent refuses others, pids up to 1 and beyond
   * MAX_PID. */
  signal: {
    params: z.object({ pid: z.int().min(2).max(MAX_PID), signal: z.string() }),
    result: z.looseObject({ ok: z.boolean(), pid: num, signal: z.string() }),
    timeoutMs: 10_000,
  },
});
