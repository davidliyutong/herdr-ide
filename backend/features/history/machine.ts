// The terminal history feature's machine side (docs/features/21-terminal-core.md):
// snapshots of the terminals' output, with their styles, in the machine's
// database (machine-<host>.db in the agent's data directory, machine/store.ts,
// the tables the Go agent keeps), which pages show above the new shell of
// a terminal whose program was replaced. The hub asks for captures only
// while history.capture is on for the machine. Actions:
//
//   - capture {lines, maxTerminals, maxTotalBytes, days}: snapshots every
//     live terminal of the instance's terminal core whose screen changed
//     since its last snapshot, within the limits (HistoryLimits), and
//     removes what the limits, the age and the terminal core's records no
//     longer allow; another hub's capture of the node in the last
//     shareMs stands for this one's (busy);
//   - list: the snapshots, whether the current one shows a screen the
//     terminal core restored itself, and whether the user's herdr-core
//     configuration restores screens (restore_screen);
//   - read {terminal, generation}: one generation's bytes;
//   - clear {terminal?}: one terminal's snapshots, or all;
//   - adopt {from, to}: the newest generation of from's snapshots becomes
//     the previous one of to, a terminal of the terminal core's records
//     that took from's place, and from's snapshots go.
//
// Every limit is enforced here, whatever the hub asks. The days apply
// also without captures: at the agent's housekeeping, and at every list
// and read. The snapshots of a terminal that finished with its program go
// at the next capture; those of one gone from the terminal core's records
// once the agent has seen it gone for the grace. Errors reach the hub
// with a code and a fixed wording, never with a path of the machine.
import { Fail } from '#shared/lib/fail.ts';
import {
  HistoryGeneration,
  validHistoryAdopt,
  validHistoryGeneration,
  validHistoryTerminal,
  type HistoryCaptureResult,
  type HistoryListResult,
} from '#shared/proto/agentproto/index.ts';
import { HOST_FILE_RETENTION, MACHINE_DB, pruneHostFiles } from '#shared/store/index.ts';
import { defineMachine, type MachineEnv } from '#machine/feature.ts';
import { TIMING, capture, recorded, storeError, type CaptureEnv, type Timing } from './machine/capture.ts';
import { restoreScreen } from './machine/config.ts';
import { Memory } from './machine/memory.ts';
import { COLUMNS, Store, expired, hasSnapshots, openDB, scanMeta, type MetaRow } from './machine/store.ts';
import { historyProtocol } from './protocol.ts';

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

export function historyMachine(o: HistoryMachineOptions = {}) {
  return defineMachine(historyProtocol, (env: MachineEnv) => {
    const timing: Timing = { ...TIMING, ...o.timing };
    const now = o.now ?? Date.now;
    const memory = o.memory ?? new Memory();
    const cap: CaptureEnv = { base: env.base, hcSocket: env.hcSocket, memory, timing, now };
    const within = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    /** Another hub's capture ended less than shareMs ago. */
    const shared = (client: string) =>
      client !== '' && !!memory.last && memory.last.client !== client && now() - memory.last.at < timing.shareMs;

    return {
      actions: {
        async capture(p, ctx): Promise<HistoryCaptureResult> {
          if (shared(ctx.client)) return { captured: 0, skipped: 0, failed: 0, evicted: 0, removed: 0, bytes: 0, busy: true };
          try {
            return await capture(cap, p, within(ctx.signal, timing.captureMs));
          } finally {
            if (ctx.client !== '') memory.last = { client: ctx.client, at: now() };
          }
        },

        async list(_p, ctx): Promise<HistoryListResult> {
          const out: HistoryListResult = { terminals: [], restoreScreen: restoreScreen(ctx.home, ctx.environ()) };
          if (!hasSnapshots(env.base)) return out;
          const t = now();
          await pruneAge(env.base, memory, t);
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

        async read(p) {
          if (!validHistoryTerminal(p.terminal) || !validHistoryGeneration(p.generation))
            throw new Fail('bad_params', 400, 'history: bad terminal or generation');
          const notFound = new Fail('not_found', 404, 'history: no snapshot');
          if (!hasSnapshots(env.base)) throw notFound;
          const t = now();
          await pruneAge(env.base, memory, t);
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

        async clear(p, ctx) {
          const terminal = p.terminal ?? '';
          if (terminal !== '' && !validHistoryTerminal(terminal)) throw new Fail('bad_params', 400, 'history: bad terminal');
          if (!hasSnapshots(env.base)) return { removed: 0 };
          let store: Store;
          try {
            ({ store } = await Store.open(env.base, memory, {
              wait: true,
              signal: within(ctx.signal, timing.clearMs),
              retryMs: timing.leaseRetryMs,
            }));
          } catch (e) {
            throw storeError(e);
          }
          try {
            memory.forgetTerminal(terminal);
            if (terminal !== '') return { removed: store.removeTerminal(terminal) ? 1 : 0 };
            return { removed: store.clearAll() };
          } catch (e) {
            throw storeError(e);
          } finally {
            store.close();
          }
        },

        async adopt(p, ctx) {
          if (!validHistoryAdopt(p)) throw new Fail('bad_params', 400, 'history: bad terminals');
          const signal = within(ctx.signal, timing.clearMs);
          if (!(await recorded(env.hcSocket, p.to, timing, signal))) throw new Fail('not_found', 404, 'history: no such terminal');
          if (!hasSnapshots(env.base)) return { adopted: false };
          let store: Store;
          try {
            ({ store } = await Store.open(env.base, memory, { wait: true, signal, retryMs: timing.leaseRetryMs }));
          } catch (e) {
            throw storeError(e);
          }
          try {
            memory.forgetTerminal(p.from);
            return { adopted: store.adopt(p.from, p.to) };
          } catch (e) {
            throw storeError(e);
          } finally {
            store.close();
          }
        },
      },

      /** The snapshots' days, and the machine databases of other hosts
       * that share the data directory and that no process opened for
       * HOST_FILE_RETENTION. */
      async housekeep(when: Date) {
        await pruneAge(env.base, memory, when.getTime());
        if (env.base !== '' && env.base.startsWith('/')) pruneHostFiles(env.base, MACHINE_DB, HOST_FILE_RETENTION, when);
      },
    };
  });
}
