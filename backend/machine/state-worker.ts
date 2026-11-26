import { Worker } from 'node:worker_threads';
import type { StateWorkerData } from '#hosts/bun/state-worker.ts';

/** Starts an embedded worker in the compiled executable or its source entry in development. */
export function machineWorker(data: StateWorkerData): Worker {
  const path = Bun.isStandaloneExecutable ? './state-worker.ts' : '../hosts/bun/state-worker.ts';
  return new Worker(new URL(path, import.meta.url), { workerData: data });
}
