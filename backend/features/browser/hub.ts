// The browser pane's core side (docs/features/32-browser-and-ports.md):
// port forwards (forwards.ts) and the ports that listen on a machine.
//
//   - GET    /api/p/browser/forwards: the forwards, and whether this client
//     can use them ({forwards, available}): they listen on the core host's
//     loopback, which is the client's localhost only when the client is on
//     that host;
//   - POST   /api/m/:id/p/browser/forwards {port}: makes (or finds) the
//     forward of a port of the machine, a use of it; refused to a client
//     that is not on the core's host (403 forward_local_only) and for the
//     local machine, whose ports need none (400 local_machine); audited as
//     browser.forward with both ports;
//   - DELETE /api/m/:id/p/browser/forwards/:port: ends it, audited as
//     browser.forward_stop;
//   - GET    /api/m/:id/p/browser/listening: the TCP ports the user's
//     programs listen on, on the machine's loopback or every address: what
//     a forward could reach ({ports}).
//
// A forwarded service is another site than the UI: it gets a port of its
// own, hence an origin of its own, which the core's Origin guard refuses.
import { z } from 'zod';
import { defineFeature, type FeatureDef } from '#kernel/feature.ts';
import { open } from '#kernel/agent.ts';
import { Fail, offline } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { closeStream } from '#kernel/machines/transport/session.ts';
import { Forwards, type ForwardsOptions } from './forwards.ts';
import { browserProtocol } from './protocol.ts';
import { DEFAULT_IDLE, settings } from './settings.ts';

/** Bounds a forward's JSON. */
const MAX_BODY = 4 << 10;

export interface BrowserOptions extends Pick<ForwardsOptions, 'now' | 'maxForwards' | 'maxConns' | 'useEveryMs' | 'listen'> {
  /** How often idle forwards are looked for (30 s). */
  reapEveryMs?: number;
}

export interface BrowserFeature extends FeatureDef {
  /** The forwards, once the feature is set up. */
  forwards(): Forwards | undefined;
}

/** A forward's body as the Go core decoded it into its struct ({port});
 * a body that is too large, not JSON or not of that shape fails with
 * bad_request. */
async function portOf(c: Ctx): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(await readBody(c.req.raw, MAX_BODY)).toString('utf8'));
  } catch (e) {
    throw new Fail('bad_request', 400, (e as Error).message);
  }
  const r = z.object({ port: z.int().nullish() }).nullable().safeParse(raw);
  if (!r.success) throw new Fail('bad_request', 400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data?.port ?? 0;
}

const json = (c: Ctx, v: object, status: 200 = 200) => {
  c.header('Cache-Control', 'no-store');
  return c.json(v, status);
};

export function browserFeature(o: BrowserOptions = {}): BrowserFeature {
  let forwards: Forwards | undefined;
  const def = defineFeature({
    id: 'browser',
    settings,
    setup(ctx) {
      const fw = new Forwards({
        ...o,
        logger: ctx.logger,
        // A connection of a forward: a stream to the machine's agent, which
        // dials the port on the machine's own loopback.
        dial: async (m, port, signal) => {
          const mc = ctx.machines.get(m);
          if (!mc) throw offline();
          const { conn } = await open(mc, browserProtocol, 'dial', { port }, { signal });
          const readable = conn.reader.release();
          return {
            readable,
            writable: conn.stream,
            close: () => {
              closeStream(conn.stream);
              if (readable !== conn.stream) readable.destroy();
            },
          };
        },
      });
      forwards = fw;

      // Idle forwards end while the core runs, all of them while the
      // feature is off, and every one when the core stops.
      ctx.service('forwards', async (signal) => {
        const reap = () => {
          const idle = ctx.settings.number('browser.forwardIdle');
          fw.reap((Number.isFinite(idle) ? idle : DEFAULT_IDLE) * 60_000, !(ctx.enabledFor('desktop') || ctx.enabledFor('browser')));
        };
        const t = setInterval(reap, o.reapEveryMs ?? 30_000);
        await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
        clearInterval(t);
        fw.close();
      });
      // A removed machine's forwards end.
      ctx.onForget((m) => fw.closeWhere((f) => f.m === m));

      ctx.api.get('/forwards', (c) => json(c, { forwards: fw.list(), available: c.var.sameHost }));

      ctx.machineApi.post('/forwards', ctx.mutating('forward'), async (c) => {
        const port = await portOf(c);
        c.var.audit.port = port;
        if (!c.var.sameHost) throw new Fail('forward_local_only', 403, "forwards listen on the core's host: open the UI on that host");
        if (c.var.machine.local) throw new Fail('local_machine', 400, "the local machine's ports need no forward");
        if (port < 1 || port > 65535) throw new Fail('bad_request', 400, 'port is 1 to 65535');
        const f = await fw.ensure(c.var.machine.id, port);
        c.var.audit.local = f.local;
        return json(c, f);
      });

      ctx.machineApi.delete('/forwards/:port', ctx.mutating('forward_stop'), (c) => {
        const p = c.req.param('port');
        if (!/^[+-]?\d+$/.test(p) || !Number.isSafeInteger(Number(p))) throw new Fail('bad_request', 400, 'port is a number');
        if (!fw.stop(c.var.machine.id, Number(p))) throw new Fail('not_found', 404, 'no such forward');
        return json(c, { ok: true });
      });

      ctx.machineApi.get('/listening', async (c) => {
        const r = await ctx.call(c.var.machine, browserProtocol, 'listening', {}, { signal: c.req.raw.signal });
        return json(c, { ports: r.ports });
      });
    },
  });
  return Object.assign(def, { forwards: () => forwards });
}
