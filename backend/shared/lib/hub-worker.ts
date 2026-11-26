import { Worker } from 'node:worker_threads';
import type { HubWorkerData } from '#hosts/common/hub-state-worker.ts';

export function hubWorker(data: HubWorkerData): Worker {
  const runtime = globalThis as { Bun?: { isStandaloneExecutable?: boolean } };
  const filename = runtime.Bun?.isStandaloneExecutable
    ? './hub-state-worker.ts'
    : import.meta.url.endsWith('.mjs')
      ? './hub-state-worker.mjs'
      : '../../hosts/common/hub-state-worker.ts';
  return new Worker(new URL(filename, import.meta.url), { workerData: data });
}
