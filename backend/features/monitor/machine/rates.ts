// What the monitor keeps between samples, per agent (the cores a node
// serves share it): the previous cumulative counters, so throughput and
// CPU percentages are those of the interval since the last sample. A
// previous sample older than a minute, or taken a moment ago, gives no
// rate.
import { clampPct } from './num.ts';
import type { DiskIO, NetCounter, Network } from './types.ts';

/** Cumulative CPU ticks: all of them and the idle ones (idle and iowait). */
export interface Ticks {
  total: number;
  idle: number;
}

/** The busy share of the ticks between two samples. */
export function cpuDeltaPct(prev: Ticks, cur: Ticks): number {
  if (cur.total <= prev.total) return 0;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle >= prev.idle ? cur.idle - prev.idle : 0;
  return clampPct((1 - dIdle / dTotal) * 100);
}

/** Whether a previous sample at prev (ms) is one to compute a rate from. */
const rated = (prev: number, now: number, min = 10): boolean => prev > 0 && now - prev > min && now - prev < 60_000;

export class Rates {
  /** The previous CPU ticks (Linux), all and per core. */
  cpu: { total: Ticks; cores: Ticks[] } | null = null;
  private net = new Map<string, NetCounter>();
  private netAt = 0;
  private disk = { read: 0, write: 0, at: 0 };
  /** The previous ticks of each process (Linux), and when. */
  procTicks = new Map<number, number>();
  procAt = 0;

  /** The network's totals and rates now (ms), from cumulative counters by
   * interface; an interface without traffic is left out of the list. */
  network(now: number, cur: Map<string, NetCounter>): Network {
    const dt = (now - this.netAt) / 1000;
    const hasPrev = rated(this.netAt, now);
    const out: Network = { rxBytesPerSec: 0, txBytesPerSec: 0, rxBytes: 0, txBytes: 0 };
    const interfaces: NonNullable<Network['interfaces']> = [];
    for (const name of [...cur.keys()].sort()) {
      const c = cur.get(name)!;
      out.rxBytes += c.rx;
      out.txBytes += c.tx;
      const iface = { name, rxBytesPerSec: 0, txBytesPerSec: 0, rxBytes: c.rx, txBytes: c.tx };
      const prev = hasPrev ? this.net.get(name) : undefined;
      if (prev) {
        if (c.rx >= prev.rx) iface.rxBytesPerSec = (c.rx - prev.rx) / dt;
        if (c.tx >= prev.tx) iface.txBytesPerSec = (c.tx - prev.tx) / dt;
      }
      out.rxBytesPerSec += iface.rxBytesPerSec;
      out.txBytesPerSec += iface.txBytesPerSec;
      if (c.rx > 0 || c.tx > 0 || iface.rxBytesPerSec > 0 || iface.txBytesPerSec > 0) interfaces.push(iface);
    }
    if (interfaces.length) out.interfaces = interfaces;
    this.net = cur;
    this.netAt = now;
    return out;
  }

  /** Block devices' totals and rates now (ms), from cumulative bytes. */
  diskIO(now: number, read: number, write: number): DiskIO {
    const out: DiskIO = { readBytesPerSec: 0, writeBytesPerSec: 0, readBytes: read, writeBytes: write };
    const dt = (now - this.disk.at) / 1000;
    if (rated(this.disk.at, now)) {
      if (read >= this.disk.read) out.readBytesPerSec = (read - this.disk.read) / dt;
      if (write >= this.disk.write) out.writeBytesPerSec = (write - this.disk.write) / dt;
    }
    this.disk = { read, write, at: now };
    return out;
  }

  /** Whether the previous process ticks were sampled recently enough for
   * a rate now (ms). */
  procRated(now: number): boolean {
    return rated(this.procAt, now, 50);
  }
}
