// The System Monitor & Task Manager's machine side
// (docs/features/34-system-monitor.md): live metrics of the machine (CPU,
// memory, GPUs, network and disk I/O, file systems, temperatures and fans),
// a snapshot of its processes, and a signal from an allowlist to one of
// them. Linux is read from /proc and /sys (linux.ts), macOS from its own
// programs (darwin.ts); rates and CPU shares are those of the interval
// since the agent's previous sample, which the hubs of a node share.
import { defineMachine } from '#machine/feature.ts';
import { monitorProtocol } from './protocol.ts';
import { darwinMetrics, darwinProcesses } from './machine/darwin.ts';
import { Bounded } from './machine/io.ts';
import { linuxMetrics, linuxProcesses } from './machine/linux.ts';
import { Rates } from './machine/rates.ts';
import { MONITOR_DEFAULTS, baseMetrics, type MonitorOptions, type Sampling } from './machine/sample.ts';
import { sendSignal } from './machine/signal.ts';

export type { MonitorOptions } from './machine/sample.ts';

export const monitorMachine = (opts: Partial<MonitorOptions> = {}) =>
  defineMachine(monitorProtocol, (env) => {
    const o: MonitorOptions = { ...MONITOR_DEFAULTS, ...opts };
    const io = new Bounded();
    const rates = new Rates();
    const sampling = (signal: AbortSignal): Sampling => ({ io, rates, o, env: env.environ(), signal });
    return {
      actions: {
        metrics: (_, ctx) => {
          if (o.platform === 'linux') return linuxMetrics(sampling(ctx.signal));
          if (o.platform === 'darwin') return darwinMetrics(sampling(ctx.signal));
          return baseMetrics(Date.now(), o.platform);
        },
        processes: (_, ctx) => {
          if (o.platform === 'linux') return linuxProcesses(sampling(ctx.signal));
          if (o.platform === 'darwin') return darwinProcesses(sampling(ctx.signal));
          return { processes: [], total: 0, cores: 0, memTotalBytes: 0, timestampMs: Date.now() };
        },
        signal: (p) => sendSignal(p.pid, p.signal),
      },
    };
  });
