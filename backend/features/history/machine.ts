// The terminal history feature's machine side. The node owns the worker
// and serves its results over the same history protocol.
import { defineMachine } from '#machine/feature.ts';
import { machineWorker } from '#machine/state-worker.ts';
import { StateWorker } from '#shared/lib/state-worker.ts';
import { historyOperations, type HistoryEnvironment, type HistoryMachineOptions } from './machine/operations.ts';
import { historyProtocol } from './protocol.ts';

export function historyMachine(o: HistoryMachineOptions = {}) {
  return defineMachine(historyProtocol, (env) => {
    const config: HistoryEnvironment = { base: env.base, home: env.home, hcSocket: env.hcSocket };
    const worker = new StateWorker<ReturnType<typeof historyOperations>>(() =>
      machineWorker({ kind: 'history', config, timing: o.timing }),
    );
    // The capture tests share an in-memory clock and inspect the memo.
    const local = o.now || o.memory ? historyOperations(config, o) : undefined;
    return {
      actions: {
        capture: (p, ctx) => local?.capture(ctx.signal, p, ctx.client) ?? worker.request('capture', ctx.signal, p, ctx.client),
        list: (_, ctx) => {
          const configHome = ctx.environ().XDG_CONFIG_HOME;
          return local?.list(ctx.signal, configHome) ?? worker.request('list', ctx.signal, configHome);
        },
        read: (p, ctx) => local?.read(ctx.signal, p) ?? worker.request('read', ctx.signal, p),
        clear: (p, ctx) => local?.clear(ctx.signal, p) ?? worker.request('clear', ctx.signal, p),
        adopt: (p, ctx) => local?.adopt(ctx.signal, p) ?? worker.request('adopt', ctx.signal, p),
      },
      housekeep: (when) => local?.housekeep(env.signal, when) ?? worker.request('housekeep', env.signal, when),
      close: () => worker.close(),
    };
  });
}
