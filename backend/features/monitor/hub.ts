// The System Monitor & Task Manager's core side
// (docs/features/34-system-monitor.md): routes below /api/m/:id/p/monitor/
// that pass a machine's live metrics and process snapshots on to the page
// as its agent wrote them, and send a process a signal, refused in
// read-only mode and audited as monitor.signal with the pid and the
// signal.
import { z } from 'zod';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { MAX_PID, monitorProtocol } from './protocol.ts';
import { settings } from './settings.ts';

/** Bounds a signal's JSON. */
const MAX_SIGNAL_BODY = 4 << 10;

/** A signal's body as the Go core decoded it into its struct: members it
 * does not know are ignored, null is none. */
const signalBody = z
  .object({ pid: z.int().nullish(), signal: z.string().nullish() })
  .nullable()
  .transform((b) => ({ pid: b?.pid ?? 0, signal: (b?.signal ?? '').trim().toUpperCase() || 'TERM' }));

/** A request's JSON body of at most limit bytes read with schema; a body
 * that is too large, not JSON or not of the schema fails with bad_request,
 * as the Go core's did. */
async function readJSON<S extends z.ZodType>(c: Ctx, limit: number, schema: S): Promise<z.output<S>> {
  let bytes: Uint8Array;
  try {
    bytes = await readBody(c.req.raw, limit);
  } catch (e) {
    if (e instanceof Fail && e.code === 'too_large') throw new Fail('bad_request', 400, e.message);
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (e) {
    throw new Fail('bad_request', 400, (e as Error).message);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Fail('bad_request', 400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const answer = (c: Ctx, result: unknown) => {
  c.header('Cache-Control', 'no-store');
  return c.json(result as object);
};

export const monitorFeature = () =>
  defineFeature({
    id: 'monitor',
    settings,
    setup(ctx) {
      const api = ctx.machineApi;
      api.get('/metrics', async (c) =>
        answer(c, await ctx.call(c.var.machine, monitorProtocol, 'metrics', {}, { signal: c.req.raw.signal })),
      );
      api.get('/processes', async (c) =>
        answer(c, await ctx.call(c.var.machine, monitorProtocol, 'processes', {}, { signal: c.req.raw.signal })),
      );
      api.post('/signal', ctx.mutating('signal'), async (c) => {
        const p = await readJSON(c, MAX_SIGNAL_BODY, signalBody);
        Object.assign(c.var.audit, { pid: p.pid, signal: p.signal });
        if (p.pid <= 1 || p.pid > MAX_PID) throw new Fail('invalid_pid', 400, 'invalid pid');
        return answer(c, await ctx.call(c.var.machine, monitorProtocol, 'signal', p, { signal: c.req.raw.signal }));
      });
    },
  });
