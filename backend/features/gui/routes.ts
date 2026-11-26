// The routes of program windows. A browser window showing a program window
// is the app shell on /m/{id}/gui/{win} (the web UI's files serve it, with
// the app's policy) and has its own WebSocket on /m/{id}/gui/{win}/ws:
// JSON events and binary frames out, commands in (input refused in
// read-only mode). Closing it closes the program window (POST
// /m/{id}/gui/{win}/close, sent by the page with its Origin, which the
// guard checks). POST /api/m/{id}/gui/enable types the display's
// variables into open terminals; GET /api/gui lists every machine's state
// as /ws sends it.
import { z } from 'zod';
import { CloseCode } from '#kernel/channel.ts';
import { Fail } from '#kernel/fail.ts';
import type { FeatureContext } from '#kernel/feature.ts';
import { readBody } from '#kernel/http/app.ts';
import { EnableError, type EnableResult, type Shells } from './enable.ts';
import type { Manager } from './manager.ts';
import { Outbox } from './outbox.ts';
import { Viewer } from './viewer.ts';
import { goneEvent, parseCodecs, parseViewerCommand } from './wire.ts';

export interface RoutesOptions {
  /** The shells of a machine's terminals, while its terminal core is
   * connected (the terminals feature's). */
  shells?: (machine: string) => Shells | undefined;
  now: () => number;
}

/** A window id of a path: a uint32 in decimal. */
function windowId(s: string): number {
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!(n <= 0xffffffff)) throw new Fail('bad_window', 400, 'bad window');
  return n;
}

/** {"terminals": [...]}; none or empty: all of them. */
const enableBody = z.object({ terminals: z.array(z.string()).nullish() });

export function routes(ctx: FeatureContext, mgr: Manager, o: RoutesOptions): void {
  const { timing, limits } = mgr;
  const windows = ctx.route('/m/:id/gui');

  windows.get('/:win/ws', (c) => {
    const m = c.var.machine;
    const id = windowId(c.req.param('win'));
    if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
    const codecs = parseCodecs(c.req.query('video') ?? '');
    const who = c.var.who;
    const input = !ctx.readOnly;
    // Frames are compressed pictures already.
    return c.env.upgrade(
      (ch) => {
        const out = new Outbox(ch, {
          maxMessages: limits.viewerMessages,
          maxBuffered: limits.viewerBuffered,
          writeMs: timing.viewerWriteMs,
          now: o.now,
        });
        const v = new Viewer((msg) => out.push(msg), codecs);
        if (!mgr.attach(m.id, id, v)) {
          out.close();
          ch.send(goneEvent(id));
          ch.close(CloseCode.Normal, 'no such window');
          return { message() {} };
        }
        ctx.audit.log(who, 'gui.open', { machine: m.id, window: id });
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          out.close();
          mgr.detach(m.id, id, v);
        };
        return {
          message: (data) => {
            if (ended) return;
            const n = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
            if (n > limits.viewerMessageBytes) {
              end();
              ch.close(CloseCode.TooBig, 'message too big');
              return;
            }
            if (typeof data !== 'string') return;
            const cmd = parseViewerCommand(data);
            if (cmd) mgr.command(m.id, id, v, cmd, input);
          },
          close: end,
          drain: () => out.flush(),
        };
      },
      { compress: false },
    );
  });

  // Sent (keepalive) when a browser window showing a program window is
  // closed or reloaded; the program window closes after a grace unless a
  // viewer shows it again.
  windows.post('/:win/close', ctx.writable, (c) => {
    const m = c.var.machine;
    const id = windowId(c.req.param('win'));
    ctx.audit.log(c.var.who, 'gui.close', { machine: m.id, window: id });
    mgr.closeWindow(m.id, id);
    return c.body(null, 204);
  });

  ctx.route('/api/m/:id/gui').post('/enable', ctx.writable, async (c) => {
    const m = c.var.machine;
    let raw: unknown;
    try {
      const text = Buffer.from(await readBody(c.req.raw, limits.enableBodyBytes)).toString('utf8');
      raw = text.trim() ? JSON.parse(text) : null;
    } catch {
      throw new Fail('invalid', 400, 'invalid body');
    }
    const body = enableBody.safeParse(raw ?? {});
    if (!body.success) throw new Fail('invalid', 400, 'invalid body');
    const shells = o.shells?.(m.id);
    if (!shells) throw new Fail('no_terminals', 409, 'the terminal core is not connected');
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timing.enableMs)]);
    let res: EnableResult | undefined;
    let err: unknown;
    try {
      res = await mgr.enable(m, shells, body.data.terminals ?? [], signal);
    } catch (e) {
      err = e;
      if (e instanceof EnableError) res = e.result;
    }
    if (res) {
      const ev: Record<string, unknown> = { machine: m.id, typed: res.typed, busy: res.busy, failed: res.failed };
      if (err) ev.error = (err as Error).message;
      ctx.audit.log(c.var.who, 'gui.enable', ev);
    }
    if (err instanceof Fail) throw err;
    if (err) throw new Fail('transport', 502, err instanceof Error ? err.message : String(err));
    return c.json(res);
  });

  // For clients that do not hold a /ws connection.
  ctx.route('/api/gui').get('/', (c) => c.json(mgr.states()));
}
