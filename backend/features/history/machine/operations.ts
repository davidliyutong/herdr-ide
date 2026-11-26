import { Fail } from '#shared/lib/fail.ts';
import {
  HistoryGeneration,
  validHistoryAdopt,
  validHistoryGeneration,
  validHistoryTerminal,
  type HistoryCaptureParams,
  type HistoryCaptureResult,
  type HistoryListResult,
} from '#shared/proto/agentproto/index.ts';
import { HOST_FILE_RETENTION, MACHINE_DB, pruneHostFiles } from '#shared/store/index.ts';
import type { MachineEnv } from '#machine/feature.ts';
import { TIMING, capture, recorded, storeError, type CaptureEnv, type Timing } from './capture.ts';
import { restoreScreen } from './config.ts';
import { Memory } from './memory.ts';
import { COLUMNS, Store, expired, hasSnapshots, openDB, scanMeta, type MetaRow } from './store.ts';

export interface HistoryMachineOptions {
  timing?: Partial<Timing>;
  /** The time, in ms since the epoch (tests). */
  now?: () => number;
  /** What the agent remembers of the terminals between captures (tests
   * share it to see it, or forget it as an agent started again would). */
  memory?: Memory;
}

/** Applies the snapshots' retention below the data directory base (the
 * days they were written under), as housekeeping, list and read do: it
 * does not wait for a writer that holds the lease, which does the same
 * itself. */
async function pruneAge(base: string, memory: Memory, now: number): Promise<void> {
  if (!hasSnapshots(base)) return;
  let store: Store;
  try {
    ({ store } = await Store.open(base, memory, { wait: false }));
  } catch {
    return;
  }
  try {
    store.pruneAge(now, 0);
  } finally {
    store.close();
  }
}

export type HistoryEnvironment = Pick<MachineEnv, 'base' | 'home' | 'hcSocket'>;

export function historyOperations(env: HistoryEnvironment, o: HistoryMachineOptions = {}) {
  const timing: Timing = { ...TIMING, ...o.timing };
  const now = o.now ?? Date.now;
  const memory = o.memory ?? new Memory();
  const cap: CaptureEnv = { base: env.base, hcSocket: env.hcSocket, memory, timing, now };
  let capturing = false;
  const within = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  /** Another hub's capture ended less than shareMs ago. */
  const shared = (client: string) =>
    client !== '' && !!memory.last && memory.last.client !== client && now() - memory.last.at < timing.shareMs;

  return {
    async capture(signal: AbortSignal, p: HistoryCaptureParams, client: string): Promise<HistoryCaptureResult> {
      signal.throwIfAborted();
      if (capturing || shared(client)) return { captured: 0, skipped: 0, failed: 0, evicted: 0, removed: 0, bytes: 0, busy: true };
      capturing = true;
      try {
        return await capture(cap, p, within(signal, timing.captureMs));
      } finally {
        capturing = false;
        if (client !== '') memory.last = { client, at: now() };
      }
    },

    async list(signal: AbortSignal, configHome: string | undefined): Promise<HistoryListResult> {
      signal.throwIfAborted();
      const out: HistoryListResult = {
        terminals: [],
        restoreScreen: await restoreScreen(env.home, { XDG_CONFIG_HOME: configHome ?? '' }),
      };
      signal.throwIfAborted();
      if (!hasSnapshots(env.base)) return out;
      const t = now();
      await pruneAge(env.base, memory, t);
      signal.throwIfAborted();
      let rows: MetaRow[];
      try {
        // Also tables of a newer version: they are read.
        const { db } = openDB(env.base);
        try {
          rows = db.all<MetaRow>(`SELECT ${COLUMNS} FROM history_snapshots ORDER BY terminal, prev`);
        } finally {
          db.close();
        }
      } catch {
        return out;
      }
      const by = new Map<string, HistoryListResult['terminals'][number]>();
      for (const r of rows) {
        const { m, prev, whole } = scanMeta(r);
        // A writer that holds the lease prunes too; until then an
        // expired generation is not listed.
        if (!whole || expired(m, t, 0)) continue;
        let en = by.get(m.terminal);
        if (!en) {
          en = { terminal: m.terminal, pid: 0, at: 0, lines: 0, bytes: 0, cols: 0, rows: 0 };
          by.set(m.terminal, en);
          out.terminals.push(en);
        }
        const snap = { pid: m.pid, at: m.at, lines: m.lines, bytes: m.bytes, cols: m.cols, rows: m.rows };
        if (prev) en.previous = snap;
        else {
          Object.assign(en, snap);
          if (m.restored) en.restored = true;
        }
      }
      return out;
    },

    async read(signal: AbortSignal, p: { terminal: string; generation: string }) {
      signal.throwIfAborted();
      if (!validHistoryTerminal(p.terminal) || !validHistoryGeneration(p.generation))
        throw new Fail('bad_params', 400, 'history: bad terminal or generation');
      const notFound = new Fail('not_found', 404, 'history: no snapshot');
      if (!hasSnapshots(env.base)) throw notFound;
      const t = now();
      await pruneAge(env.base, memory, t);
      signal.throwIfAborted();
      let row: MetaRow | undefined;
      try {
        const { db } = openDB(env.base);
        try {
          row = db.get<MetaRow>(
            `SELECT ${COLUMNS}, data FROM history_snapshots WHERE terminal = ? AND prev = ?`,
            p.terminal,
            p.generation === HistoryGeneration.Previous ? 1 : 0,
          );
        } finally {
          db.close();
        }
      } catch {
        throw notFound;
      }
      if (!row) throw notFound;
      const { m, whole } = scanMeta(row);
      const data = row.data ?? new Uint8Array();
      if (!whole || expired(m, t, 0) || data.length !== m.bytes) throw notFound;
      return {
        terminal: p.terminal,
        generation: p.generation,
        pid: m.pid,
        at: m.at,
        lines: m.lines,
        bytes: m.bytes,
        cols: m.cols,
        rows: m.rows,
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
      };
    },

    async clear(signal: AbortSignal, p: { terminal?: string }) {
      signal.throwIfAborted();
      const terminal = p.terminal ?? '';
      if (terminal !== '' && !validHistoryTerminal(terminal)) throw new Fail('bad_params', 400, 'history: bad terminal');
      if (!hasSnapshots(env.base)) return { removed: 0 };
      let store: Store;
      try {
        ({ store } = await Store.open(env.base, memory, {
          wait: true,
          signal: within(signal, timing.clearMs),
          retryMs: timing.leaseRetryMs,
        }));
      } catch (e) {
        throw storeError(e);
      }
      try {
        signal.throwIfAborted();
        memory.forgetTerminal(terminal);
        if (terminal !== '') return { removed: store.removeTerminal(terminal) ? 1 : 0 };
        return { removed: store.clearAll() };
      } catch (e) {
        throw storeError(e);
      } finally {
        store.close();
      }
    },

    async adopt(signal: AbortSignal, p: { from: string; to: string }) {
      signal.throwIfAborted();
      if (!validHistoryAdopt(p)) throw new Fail('bad_params', 400, 'history: bad terminals');
      const withinClear = within(signal, timing.clearMs);
      if (!(await recorded(env.hcSocket, p.to, timing, withinClear))) throw new Fail('not_found', 404, 'history: no such terminal');
      if (!hasSnapshots(env.base)) return { adopted: false };
      let store: Store;
      try {
        ({ store } = await Store.open(env.base, memory, { wait: true, signal: withinClear, retryMs: timing.leaseRetryMs }));
      } catch (e) {
        throw storeError(e);
      }
      try {
        withinClear.throwIfAborted();
        memory.forgetTerminal(p.from);
        return { adopted: store.adopt(p.from, p.to) };
      } catch (e) {
        throw storeError(e);
      } finally {
        store.close();
      }
    },

    /** The snapshots' days, and the machine databases of other hosts
     * that share the data directory and that no process opened for
     * HOST_FILE_RETENTION. */
    async housekeep(signal: AbortSignal, when: Date) {
      signal.throwIfAborted();
      await pruneAge(env.base, memory, when.getTime());
      signal.throwIfAborted();
      if (env.base !== '' && env.base.startsWith('/')) pruneHostFiles(env.base, MACHINE_DB, HOST_FILE_RETENTION, when);
    },
  };
}
