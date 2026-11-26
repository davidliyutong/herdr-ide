// What the monitor's actions answer: the protocol's results as they go on
// the wire (#features/monitor/protocol.ts). Members left out (undefined)
// are those the Go agent wrote with omitempty when empty or nil.
import type { z } from 'zod';
import type { metrics, processes } from '../protocol.ts';

export type Metrics = z.input<typeof metrics>;
export type CPU = Metrics['cpu'];
export type Memory = Metrics['memory'];
export type GPU = NonNullable<Metrics['gpus']>[number];
export type Network = Metrics['network'];
export type DiskIO = Metrics['diskIO'];
export type Disk = NonNullable<Metrics['disks']>[number];
export type Sensors = NonNullable<Metrics['sensors']>;
export type Temp = NonNullable<Sensors['temps']>[number];
export type Fan = NonNullable<Sensors['fans']>[number];
export type Processes = z.input<typeof processes>;
export type Process = NonNullable<Processes['processes']>[number];

/** Cumulative bytes of one network interface. */
export interface NetCounter {
  rx: number;
  tx: number;
}

export const emptyMemory = (): Memory => ({
  totalBytes: 0,
  usedBytes: 0,
  availableBytes: 0,
  usedPct: 0,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
});
