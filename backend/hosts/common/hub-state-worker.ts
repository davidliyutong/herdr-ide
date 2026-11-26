import { workerData } from 'node:worker_threads';
import { Store, type HistoryRecords } from '#features/usage/store.ts';
import type { Kept } from '#features/usage/history.ts';
import { AccessLog } from '#features/vault/accesslog.ts';
import { serveStateWorker, stateLog } from '#shared/lib/state-worker.ts';
import { tidyHubDBs } from '#shared/store/hubdb.ts';

export type HubWorkerData =
  | { kind: 'usage'; path: string }
  | { kind: 'vault'; options: Omit<ConstructorParameters<typeof AccessLog>[0], 'logger'> }
  | { kind: 'maintenance' };

export function usageOperations(path: string) {
  const store = new Store(path, stateLog);
  return {
    readHistory: (_signal: AbortSignal) => store.readHistory(),
    writeHistory: (_signal: AbortSignal, history: HistoryRecords, accounts: Kept[]) => store.writeHistory(history, accounts),
    readMachineCosts: (_signal: AbortSignal) => store.readMachineCosts(),
    saveMachineCost: (_signal: AbortSignal, key: string, machine: string, entry: unknown, evicted: readonly string[]) =>
      store.saveMachineCost(key, machine, entry, evicted),
    deleteMachineCosts: (_signal: AbortSignal, machine: string) => store.deleteMachineCosts(machine),
  };
}

export function accessOperations(options: Omit<ConstructorParameters<typeof AccessLog>[0], 'logger'>) {
  const log = new AccessLog({ ...options, logger: stateLog });
  return {
    add: (_signal: AbortSignal, ...args: Parameters<AccessLog['add']>) => log.add(...args),
    list: (_signal: AbortSignal) => log.list(),
    close: (_signal: AbortSignal) => log.close(),
  };
}

export const maintenance = {
  tidy(_signal: AbortSignal, settings: string): void {
    try {
      const t = tidyHubDBs(settings);
      if (t.old.length) stateLog(`removed the database of earlier releases: ${t.old.join(', ')}`);
      if (t.others.length) stateLog(`removed other hosts' unused databases: ${t.others.join(', ')}`);
    } catch (e) {
      stateLog(`databases of earlier releases or other hosts: ${(e as Error).message}`);
    }
  },
};

const data = workerData as HubWorkerData;
switch (data.kind) {
  case 'usage':
    serveStateWorker(usageOperations(data.path));
    break;
  case 'vault':
    serveStateWorker(accessOperations(data.options));
    break;
  case 'maintenance':
    serveStateWorker(maintenance);
    break;
}
