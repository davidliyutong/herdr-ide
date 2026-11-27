// The System Monitor & Task Manager's hub side
// (docs/features/34-system-monitor.md): routes below /api/m/:id/p/monitor/
// that pass a machine's live metrics and process snapshots on to the page
// as its agent wrote them, and send a process a signal, refused in
// read-only mode and audited as monitor.signal with the pid and the
// signal.
import { z } from 'zod';
import { CoalesceCache } from '#shared/lib/cache.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { MAX_PID, monitorProtocol } from './protocol.ts';
import { settings } from './settings.ts';

/** Bounds a signal's JSON. */
const MAX_SIGNAL_BODY = 4 << 10;

/** Short hub-side TTL for metrics/processes snapshots (shorter than the 1 s
 * minimum poll interval so single-tab polling always gets fresh samples while
 * multi-tab polling coalesces onto one machine call). */
export const MONITOR_CACHE_TTL_MS = 800;
const MONITOR_CACHE_MAX = 256;

export interface MonitorOptions {
  /** Clock function for the hub-side snapshot cache (tests). */
  now?: () => number;
}

/** A signal's body as the Go hub decoded it into its struct: members it
 * does not know are ignored, null is none. */
const signalBody = z
  .object({ pid: z.int().nullish(), signal: z.string().nullish() })
  .nullable()
  .transform((b) => ({ pid: b?.pid ?? 0, signal: (b?.signal ?? '').trim().toUpperCase() || 'TERM' }));

/** A request's JSON body of at most limit bytes read with schema; a body
 * that is too large, not JSON or not of the schema fails with bad_request,
 * as the Go hub's did. */
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

export const monitorFeature = (o: MonitorOptions = {}) =>
  defineFeature({
    id: 'monitor',
    settings,
    setup(ctx) {
      const api = ctx.machineApi;
      const cache = new CoalesceCache<unknown>({ ttlMs: MONITOR_CACHE_TTL_MS, maxEntries: MONITOR_CACHE_MAX, now: o.now });
      ctx.onForget((m) => cache.invalidatePrefix(`${m}\0`, { abort: true }));

      api.get('/metrics', async (c) => {
        const m = c.var.machine;
        return answer(
          c,
          await cache.get(`${m.id}\0metrics`, { signal: c.req.raw.signal }, (signal) =>
            ctx.call(m, monitorProtocol, 'metrics', {}, { signal }),
          ),
        );
      });
      api.get('/processes', async (c) => {
        const m = c.var.machine;
        return answer(
          c,
          await cache.get(`${m.id}\0processes`, { signal: c.req.raw.signal }, (signal) =>
            ctx.call(m, monitorProtocol, 'processes', {}, { signal }),
          ),
        );
      });
      api.post('/signal', ctx.mutating('signal'), async (c) => {
        const p = await readJSON(c, MAX_SIGNAL_BODY, signalBody);
        Object.assign(c.var.audit, { pid: p.pid, signal: p.signal });
        if (p.pid <= 1 || p.pid > MAX_PID) throw new Fail('invalid_pid', 400, 'invalid pid');
        const m = c.var.machine;
        const r = await ctx.call(m, monitorProtocol, 'signal', p, { signal: c.req.raw.signal });
        cache.invalidate(`${m.id}\0processes`);
        return answer(c, r);
      });
    },
  });
