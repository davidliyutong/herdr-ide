// The terminal history feature's hub side: snapshots of the terminals'
// output that a machine writes to its own disk while history.capture is on
// for it, shown after the terminal core started again. A scheduler
// (scheduler.ts) asks the machines for captures and clears; the routes,
// all a machine's:
//
//   - GET    /api/m/:id/p/history: the snapshots ({terminals, restoreScreen});
//   - GET    /api/m/:id/p/history/read?terminal=&generation=: one
//     generation's bytes as an application/octet-stream attachment under
//     the sandboxing CSP, described by the headers X-History-Pid,
//     X-History-At (ms since the epoch), X-History-Cols, X-History-Rows and
//     X-History-Lines;
//   - DELETE /api/m/:id/p/history[?terminal=]: removes one terminal's
//     snapshots, or all ({removed});
//   - POST   /api/m/:id/p/history/adopt?from=&to=: terminal to, which took
//     the place of terminal from (the terminal core gave the pane a new
//     address), gets the newest generation of from's snapshots as its
//     previous one unless it has a later one, and from's snapshots go
//     ({adopted}).
//
// The clear and the adopt change the machine's files: refused in read-only
// mode, audited as history.clear and history.adopt. What the browser sends
// is checked before the machine is asked, and only what the machine may
// answer passes on: a failure is the machine's code with its fixed
// wording, a timeout, or bad_reply, never an error's text.
import {
  HistoryAction,
  HistoryLimits,
  validHistoryAdopt,
  validHistoryGeneration,
  validHistoryTerminal,
} from '#shared/proto/agentproto/index.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail, offline } from '#kernel/fail.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { CAPTURE_MS, CLEAR_MS, LIST_MS, READ_MS, historyProtocol, type Entry } from './protocol.ts';
import { Scheduler, type Timing } from './scheduler.ts';
import { settings } from './settings.ts';

export interface HistoryOptions {
  /** The scheduler's durations (TIMING). */
  timing?: Partial<Timing>;
  /** The scheduler's clock. */
  now?: () => number;
  /** The routes' time limits by action (the protocol's). */
  routeMs?: Partial<Record<'list' | 'read' | 'clear', number>>;
}

const badRequest = (message: string) => new Fail('bad_request', 400, message);

/** Runs fn with the request's signal and a deadline of ms. A failure is
 * the machine's code (Fail), a timeout (504) once the deadline passed, or
 * bad_reply (502) for anything else: an answer that was not understood. */
async function asking<T>(c: Ctx, ms: number, fn: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  try {
    // The session's own limit comes after the deadline.
    return await fn(AbortSignal.any([c.req.raw.signal, deadline]), ms + 5_000);
  } catch (e) {
    if (deadline.aborted) throw new Fail('timeout', 504, 'the machine did not answer in time');
    if (e instanceof Fail && e.code !== 'invalid_result') throw e;
    throw new Fail('bad_reply', 502, "the machine's answer was not understood");
  }
}

/** An entry as the Go hub wrote it: its snapshot's fields, restored only
 * when set, previous only when there is one. */
const entryOut = (e: Entry) => ({
  terminal: e.terminal,
  pid: e.pid,
  at: e.at,
  lines: e.lines,
  bytes: e.bytes,
  cols: e.cols,
  rows: e.rows,
  ...(e.restored ? { restored: true } : {}),
  ...(e.previous ? { previous: e.previous } : {}),
});

export const historyFeature = (o: HistoryOptions = {}) =>
  defineFeature({
    id: 'history',
    settings,
    setup(ctx) {
      const routeMs = { list: LIST_MS, read: READ_MS, clear: CLEAR_MS, ...o.routeMs };
      const machine = (id: string) => {
        const m = ctx.machines.get(id);
        if (!m) throw offline();
        return m;
      };
      const scheduler = new Scheduler({
        calls: {
          capture: (m, p, signal) =>
            ctx.call(machine(m), historyProtocol, HistoryAction.Capture, p, { signal, timeoutMs: CAPTURE_MS + 5_000 }),
          clear: (m, signal) => ctx.call(machine(m), historyProtocol, HistoryAction.Clear, {}, { signal, timeoutMs: CLEAR_MS + 5_000 }),
        },
        ready: () =>
          ctx.machines
            .list()
            .filter((m) => m.ready)
            .map((m) => m.id),
        onReadyChange: (wake) => ctx.machines.subscribe({ state: (st) => wake(st.id, st.status === 'ready') }),
        onTerminalCoreReady: (wake) => {
          const core = new Map<string, boolean>(ctx.machines.states().map((st) => [st.id, st.hc?.state === 'ready']));
          return ctx.machines.subscribe({
            state: (st) => {
              const now = st.hc?.state === 'ready';
              const before = core.get(st.id) ?? false;
              core.set(st.id, now);
              if (now && !before) wake(st.id);
            },
          });
        },
        settings: ctx.settings,
        enabled: () => ctx.enabledFor('desktop') || ctx.enabledFor('browser'),
        switchKey: `plugins.${ctx.id}.enabled`,
        readOnly: () => ctx.readOnly,
        audit: ctx.audit,
        logger: ctx.logger,
        now: o.now,
        timing: o.timing,
      });
      ctx.service('scheduler', (signal) => scheduler.run(signal));
      ctx.onForget((m) => scheduler.forget(m));

      const api = ctx.machineApi;
      const query = (c: Ctx) => new URL(c.req.url).searchParams;
      const json = (c: Ctx, v: object) => {
        c.header('Cache-Control', 'no-store');
        return c.json(v);
      };

      api.get('/', async (c) => {
        const r = await asking(c, routeMs.list, (signal, timeoutMs) =>
          ctx.call(c.var.machine, historyProtocol, HistoryAction.List, {}, { signal, timeoutMs }),
        );
        return json(c, {
          terminals: r.terminals.filter((e) => validHistoryTerminal(e.terminal)).map(entryOut),
          restoreScreen: r.restoreScreen,
        });
      });

      api.get('/read', async (c) => {
        const q = query(c);
        const terminal = q.get('terminal') ?? '';
        const generation = q.get('generation') ?? '';
        if (!validHistoryTerminal(terminal) || !validHistoryGeneration(generation))
          throw badRequest('a terminal and a generation (current or previous)');
        const d = await asking(c, routeMs.read, (signal, timeoutMs) =>
          ctx.call(c.var.machine, historyProtocol, HistoryAction.Read, { terminal, generation }, { signal, timeoutMs }),
        );
        if (d.data.length > HistoryLimits.maxBytes || d.terminal !== terminal || d.generation !== generation)
          throw new Fail('bad_reply', 502, "the machine's snapshot is not the one asked for");
        return c.body(new Uint8Array(d.data), 200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(d.data.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          // The bytes are a terminal's output: never a document of the
          // UI's origin, also when the route is opened in a tab.
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Disposition': 'attachment',
          'X-History-Pid': String(Math.trunc(d.pid)),
          'X-History-At': String(Math.trunc(d.at)),
          'X-History-Cols': String(Math.trunc(d.cols)),
          'X-History-Rows': String(Math.trunc(d.rows)),
          'X-History-Lines': String(Math.trunc(d.lines)),
        });
      });

      api.delete('/', ctx.mutating('clear'), async (c) => {
        const terminal = query(c).get('terminal') ?? '';
        if (terminal && !validHistoryTerminal(terminal)) throw badRequest("a terminal's address");
        if (terminal) c.var.audit.terminal = terminal;
        const r = await asking(c, routeMs.clear, (signal, timeoutMs) =>
          ctx.call(c.var.machine, historyProtocol, HistoryAction.Clear, terminal ? { terminal } : {}, { signal, timeoutMs }),
        );
        c.var.audit.removed = r.removed;
        return json(c, { removed: r.removed });
      });

      api.post('/adopt', ctx.mutating('adopt'), async (c) => {
        const q = query(c);
        const p = { from: q.get('from') ?? '', to: q.get('to') ?? '' };
        if (!validHistoryAdopt(p)) throw badRequest("from and to: two terminals' addresses");
        Object.assign(c.var.audit, p);
        const r = await asking(c, routeMs.clear, (signal, timeoutMs) =>
          ctx.call(c.var.machine, historyProtocol, HistoryAction.Adopt, p, { signal, timeoutMs }),
        );
        c.var.audit.adopted = r.adopted;
        return json(c, { adopted: r.adopted });
      });
    },
  });
