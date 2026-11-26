import { hubWorker } from '#shared/lib/hub-worker.ts';
import { StateWorker } from '#shared/lib/state-worker.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { usageOperations } from '#hosts/common/hub-state-worker.ts';
import type { Kept } from './history.ts';
import type { HistoryRecords, UsageStore } from './store.ts';

type Worker = StateWorker<ReturnType<typeof usageOperations>>;

/** Hub-side access to usage history and retained cost reports. */
export class WorkerStore implements UsageStore {
  private readonly worker?: Worker;
  readonly file: string;
  private readonly log: Logger;

  constructor(file: string, log: Logger) {
    this.file = file;
    this.log = log;
    if (file) this.worker = new StateWorker(() => hubWorker({ kind: 'usage', path: file }), log);
  }

  private async use<T>(f: (worker: Worker, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!this.worker) return;
    try {
      return await f(this.worker, AbortSignal.timeout(15_000));
    } catch (e) {
      this.log(`usage: ${(e as Error).message}`);
    }
  }

  readHistory() {
    return this.use((worker, signal) => worker.request('readHistory', signal));
  }

  writeHistory(history: HistoryRecords, accounts: Iterable<Kept>) {
    return this.use((worker, signal) =>
      worker.request('writeHistory', signal, { windows: history.windows, alerts: history.alerts }, [...accounts]),
    );
  }

  readMachineCosts() {
    return this.use((worker, signal) => worker.request('readMachineCosts', signal));
  }

  saveMachineCost(key: string, machine: string, entry: unknown, evicted: readonly string[]) {
    return this.use((worker, signal) => worker.request('saveMachineCost', signal, key, machine, entry, evicted));
  }

  deleteMachineCosts(machine: string) {
    return this.use((worker, signal) => worker.request('deleteMachineCosts', signal, machine));
  }

  async close(): Promise<void> {
    await this.worker?.close();
  }
}
