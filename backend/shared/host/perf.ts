// What the hub's own process uses: processor time and memory, for the
// settings' Performance page. It measures this process only, not the
// agents, terminal cores and ssh connections it starts.
import { availableParallelism, cpus } from 'node:os';

/** The hub process's use of the system at one moment (GET /api/perf). */
export interface Usage {
  /** The processor time the process has used since it started (user and
   * system), in milliseconds; a client turns two samples into a share of
   * the time between them. */
  cpu_ms: number;
  /** What the process holds of the system's memory (its resident set),
   * in bytes. */
  memory: number;
  /** How many things the process waits on (sockets, timers, requests):
   * the field Go filled with its goroutines. */
  goroutines: number;
  /** How long the process has run, in milliseconds. */
  uptime_ms: number;
  /** How many processors the process may use at once. */
  cpus: number;
}

/** Measures the process now. */
export function sample(): Usage {
  const cpu = process.cpuUsage(); // microseconds
  return {
    cpu_ms: Math.floor((cpu.user + cpu.system) / 1000),
    memory: process.memoryUsage().rss,
    goroutines: activeResources(),
    uptime_ms: Math.floor(process.uptime() * 1000),
    cpus: typeof availableParallelism === 'function' ? availableParallelism() : Math.max(1, cpus().length),
  };
}

function activeResources(): number {
  const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  try {
    return info ? info.call(process).length : 0;
  } catch {
    return 0;
  }
}
