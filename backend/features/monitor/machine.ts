// The System Monitor & Task Manager's machine side
// (docs/features/34-system-monitor.md): live metrics of the machine (CPU,
// memory, GPUs, network and disk I/O, file systems, temperatures and fans),
// a snapshot of its processes, and a signal from an allowlist to one of
// them. Linux is read from /proc and /sys (linux.ts), macOS from its own
// programs (darwin.ts); rates and CPU shares are those of the interval
// since the agent's previous sample, which the hubs of a node share.
import { defineMachine } from '#machine/feature.ts';
import { waitForResult } from '#shared/lib/wait.ts';
import { monitorProtocol } from './protocol.ts';
import { darwinMetrics, darwinProcesses } from './machine/darwin.ts';
import { Bounded } from './machine/io.ts';
import { linuxMetrics, linuxProcesses } from './machine/linux.ts';
import { Rates } from './machine/rates.ts';
import { MONITOR_DEFAULTS, baseMetrics, type MonitorOptions, type Sampling } from './machine/sample.ts';
import { sendSignal } from './machine/signal.ts';

export type { MonitorOptions } from './machine/sample.ts';

/** Keeps one in-flight sample for all hubs and reuses it briefly on success. */
function sampler<T>(ttlMs: number, read: () => T | Promise<T>) {
  let current: Promise<T> | undefined;
  let validUntil = 0;
  return (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!current || performance.now() >= validUntil) {
      validUntil = Infinity;
      current = Promise.resolve()
        .then(read)
        .then(
          (value) => {
            validUntil = performance.now() + ttlMs;
            return value;
          },
          (error) => {
            current = undefined;
            throw error;
          },
        );
    }
    return waitForResult(current, signal);
  };
}

export const monitorMachine = (opts: Partial<MonitorOptions> = {}) =>
  defineMachine(monitorProtocol, (env) => {
    const o: MonitorOptions = { ...MONITOR_DEFAULTS, ...opts };
    const io = new Bounded();
    const rates = new Rates();
    const sampling = (): Sampling => ({ io, rates, o, env: env.environ(), signal: env.signal });
    const metrics = sampler(o.sampleTtlMs, () => {
      if (o.platform === 'linux') return linuxMetrics(sampling());
      if (o.platform === 'darwin') return darwinMetrics(sampling());
      return baseMetrics(Date.now(), o.platform);
    });
    const processes = sampler(o.sampleTtlMs, () => {
      if (o.platform === 'linux') return linuxProcesses(sampling());
      if (o.platform === 'darwin') return darwinProcesses(sampling());
      return { processes: [], total: 0, cores: 0, memTotalBytes: 0, timestampMs: Date.now() };
    });
    return {
      actions: {
        metrics: (_, ctx) => metrics(ctx.signal),
        processes: (_, ctx) => processes(ctx.signal),
        signal: (p) => sendSignal(p.pid, p.signal),
      },
    };
  });
