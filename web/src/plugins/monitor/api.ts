// HTTP client of the System Monitor & Task Manager plugin
// (backend/features/monitor).
import { answer, failureOf, jsonInit, makeErrorText, PluginError } from '../../lib/pluginApi';

export interface CPUMetric {
  usagePct: number;
  cores: number;
  load1: number;
  load5: number;
  load15: number;
  perCore?: number[];
}

export interface MemoryMetric {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPct: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface GPUMetric {
  index: number;
  name: string;
  vendor?: string;
  utilPct?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  memPct?: number;
  tempC?: number;
  powerW?: number;
  powerLimitW?: number;
}

export interface NetInterface {
  name: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxBytes: number;
  txBytes: number;
}

export interface NetMetric {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxBytes: number;
  txBytes: number;
  interfaces?: NetInterface[];
}

export interface DiskIOMetric {
  readBytesPerSec: number;
  writeBytesPerSec: number;
  readBytes: number;
  writeBytes: number;
}

export interface DiskMetric {
  mount: string;
  device: string;
  fsType?: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPct: number;
}

export interface Metrics {
  hostname: string;
  os: string;
  arch: string;
  uptimeSec: number;
  timestampMs: number;
  cpu: CPUMetric;
  memory: MemoryMetric;
  gpus: GPUMetric[];
  network: NetMetric;
  diskIO: DiskIOMetric;
  disks: DiskMetric[];
  /** Hardware temperatures and fans; absent when the machine shows none. */
  sensors?: Sensors;
}

export interface Sensors {
  temps?: TempSensor[];
  fans?: FanSensor[];
}

export interface TempSensor {
  chip: string;
  label: string;
  tempC: number;
  highC?: number;
  critC?: number;
}

export interface FanSensor {
  chip: string;
  label: string;
  rpm: number;
  minRpm?: number;
  maxRpm?: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  user: string;
  cpuPct: number;
  memPct: number;
  rssBytes: number;
  state: string;
  elapsed: string;
  gpuMemBytes?: number;
}

export interface ProcessesReply {
  processes: ProcessInfo[];
  total: number;
  cores: number;
  memTotalBytes: number;
  timestampMs: number;
}

export type SignalName = 'TERM' | 'KILL' | 'INT' | 'HUP' | 'STOP' | 'CONT';

export interface SignalReply {
  ok: boolean;
  pid: number;
  signal: SignalName;
}

export class MonitorError extends PluginError {}

const fail = failureOf((code, message) => new MonitorError(code, message));

export const errorText = makeErrorText(MonitorError, 'monitor.error');

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/monitor`;

export const monitorApi = {
  async metrics(m: string, signal?: AbortSignal): Promise<Metrics> {
    const r = await fetch(`${base(m)}/metrics`, { signal });
    return answer<Metrics>(r, fail);
  },

  async processes(m: string, signal?: AbortSignal): Promise<ProcessesReply> {
    const r = await fetch(`${base(m)}/processes`, { signal });
    return answer<ProcessesReply>(r, fail);
  },

  async signal(m: string, pid: number, sig: SignalName): Promise<SignalReply> {
    const r = await fetch(`${base(m)}/signal`, jsonInit('POST', { pid, signal: sig }));
    return answer<SignalReply>(r, fail);
  },
};
