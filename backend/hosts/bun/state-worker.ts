// An entry point of the machine executable for SQLite worker threads.
import { workerData } from 'node:worker_threads';
import { serveJournal } from '#features/chat/machine/host/journal-worker.ts';
import { historyOperations, type HistoryEnvironment } from '#features/history/machine/operations.ts';
import type { Timing } from '#features/history/machine/capture.ts';
import { cacheOperations } from '#features/usage/machine/cache.ts';
import { serveStateWorker } from '#shared/lib/state-worker.ts';

export type StateWorkerData =
  { kind: 'history'; config: HistoryEnvironment; timing?: Partial<Timing> } | { kind: 'usage'; base: string } | { kind: 'journal' };

const data = workerData as StateWorkerData;
if (data.kind === 'journal') serveJournal();
else serveStateWorker(data.kind === 'history' ? historyOperations(data.config, { timing: data.timing }) : cacheOperations(data.base));
