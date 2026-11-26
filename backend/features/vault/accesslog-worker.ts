import { hubWorker } from '#shared/lib/hub-worker.ts';
import { StateWorker } from '#shared/lib/state-worker.ts';
import type { accessOperations } from '#hosts/common/hub-state-worker.ts';
import { AccessLog, Result, type Access, type AccessLogOptions } from './accesslog.ts';

type Worker = StateWorker<ReturnType<typeof accessOperations>>;

/** The persisted log runs on the hub's worker, including durable releases. */
export class WorkerAccessLog {
  private readonly worker?: Worker;
  private readonly memory?: AccessLog;
  private readonly options: AccessLogOptions;

  constructor(options: AccessLogOptions) {
    this.options = options;
    const { logger, ...opts } = options;
    if (opts.db) this.worker = new StateWorker(() => hubWorker({ kind: 'vault', options: opts }), logger);
    else this.memory = new AccessLog(options);
  }

  async add(rec: Omit<Access, 'id'>, coalesce: boolean, durable: boolean): Promise<{ kept: Access; ok: boolean }> {
    if (this.memory) return this.memory.add(rec, coalesce, durable);
    try {
      return await this.worker!.request('add', AbortSignal.timeout(15_000), rec, coalesce, durable);
    } catch (e) {
      this.options.logger(`vault: access log: ${(e as Error).message}`);
      return { kept: { ...rec, id: 0, result: durable ? Result.LogFailed : rec.result }, ok: !durable };
    }
  }

  async list(): Promise<Access[]> {
    if (this.memory) return this.memory.list();
    try {
      return await this.worker!.request('list', AbortSignal.timeout(15_000));
    } catch (e) {
      this.options.logger(`vault: access log: ${(e as Error).message}`);
      return [];
    }
  }

  async close(): Promise<void> {
    this.memory?.close();
    if (!this.worker) return;
    try {
      await this.worker.request('close', AbortSignal.timeout(1000));
    } catch {
      // A stalled disk may outlast the hub.
    } finally {
      await this.worker.close();
    }
  }
}
