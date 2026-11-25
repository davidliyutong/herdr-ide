// What a sample of the monitor works with: the agent's bounded reads and
// the counters it keeps between samples, its options, and what every
// system's metrics start from.
import { availableParallelism, hostname } from 'node:os';
import type { Bounded } from './io.ts';
import type { Rates } from './rates.ts';
import { emptyMemory, type Metrics } from './types.ts';

/** Bounds a process's command line in the answers, in bytes. */
export const MAX_COMMAND = 512;

export interface MonitorOptions {
  /** Linux's /proc and /sys (tests give a tree of their own). */
  procRoot: string;
  sysRoot: string;
  /** Linux's users' names. */
  passwd: string;
  /** How long a helper program (nvidia-smi, sysctl, ps, ioreg…) may run. */
  cmdTimeoutMs: number;
  /** How long a sample waits for the sensors (a hung sysfs read). */
  sensorsBudgetMs: number;
  /** The gap between the two CPU samples of the very first metrics. */
  cpuGapMs: number;
  /** How long one file system's statfs may take (a dead network mount). */
  statfsMs: number;
  /** How long one read of /proc or /sys may take. */
  readMs: number;
  /** The system sampled ('linux' or 'darwin'; others answer what is known
   * everywhere). */
  platform: string;
}

export const MONITOR_DEFAULTS: MonitorOptions = {
  procRoot: '/proc',
  sysRoot: '/sys',
  passwd: '/etc/passwd',
  cmdTimeoutMs: 3000,
  sensorsBudgetMs: 1000,
  cpuGapMs: 100,
  statfsMs: 2000,
  readMs: 2000,
  platform: process.platform,
};

export interface Sampling {
  io: Bounded;
  rates: Rates;
  o: MonitorOptions;
  /** The environment of the helper programs. */
  env: Record<string, string>;
  /** Ends when the core gives up on the action. */
  signal: AbortSignal;
}

/** Go's names of this system's architecture. */
export const goArch = (): string => (process.arch === 'x64' ? 'amd64' : process.arch);

/** What every system's metrics start from. */
export function baseMetrics(now: number, os: string): Metrics {
  return {
    hostname: hostname(),
    os,
    arch: goArch(),
    uptimeSec: 0,
    timestampMs: now,
    cpu: { usagePct: 0, cores: availableParallelism(), load1: 0, load5: 0, load15: 0 },
    memory: emptyMemory(),
    gpus: [],
    network: { rxBytesPerSec: 0, txBytesPerSec: 0, rxBytes: 0, txBytes: 0 },
    diskIO: { readBytesPerSec: 0, writeBytesPerSec: 0, readBytes: 0, writeBytes: 0 },
    disks: [],
  };
}

/** A process's state as the task manager shows it: R, S, D (also macOS's
 * U), T, Z, I, or the first letter of what the system said. */
export function normalizeState(s: string): string {
  if (s === '') return '?';
  switch (s[0]) {
    case 'R':
    case 'S':
    case 'Z':
    case 'I':
      return s[0];
    case 'D':
    case 'U':
      return 'D';
    case 'T':
    case 't':
      return 'T';
  }
  return s[0];
}
