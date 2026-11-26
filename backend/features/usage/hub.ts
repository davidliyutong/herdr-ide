// The AI usage feature's hub side (docs/features/29-ai-usage.md): a
// scheduler (usage.ts) asks the connected machines for the limits of the
// AI subscriptions signed in there, merges the accounts seen on several
// machines, keeps their history, fires the alerts and sends the snapshot to
// the pages ({t: "plugin", plugin: "usage", data}). The routes:
//
//   - GET  /api/p/usage[?watch=1]: the snapshot, with an ETag (304 for a
//     matching If-None-Match); watch=1 (the open panel, every minute)
//     counts the panel open for the adaptive cadence;
//   - GET  /api/p/usage/cost?days=&tz=: the spend of the machines' logs
//     (cost.ts), with an ETag;
//   - POST /api/p/usage/refresh: a poll as soon as the gap since the last
//     allows (202 {queued, at});
//   - PUT  /api/m/:id/p/usage/deepseek-key {key}: writes ("" removes) the
//     machine's DeepSeek key file, never audited or returned;
//   - GET  /api/m/:id/p/usage/session?kind=&session=: what a coding agent's
//     session there used, at the user's prices: only reads, so a read-only
//     hub answers it, unaudited.
//
// The refresh and the key change state: refused in read-only mode, audited
// as usage.refresh and usage.deepseek_key.
import { z } from 'zod';
import { byId, validSessionId } from '#shared/agents/kinds.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail, offline } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { usageProtocol } from './protocol.ts';
import { settings } from './settings.ts';
import { hubDBFile } from './store.ts';
import { WorkerStore } from './store-worker.ts';
import { Usage, type UsageDeps } from './usage.ts';

/** The session reads a machine serves at once: each holds a stream of its
 * agent and may search its session directories. */
export const MAX_SESSION_READS = 8;

/** The provider whose prices a kind's sessions are priced with: an agent
 * whose transcripts are the logs the spend reads (Claude Code's, Codex's). */
export function sessionProvider(kind: string): string | undefined {
  const k = byId(kind);
  const p = k?.usageProvider;
  return p && (p === 'claude' || p === 'codex') && k.transcript === p ? p : undefined;
}

export interface UsageOptions {
  /** The scheduler's clock, tick and status pages (tests). */
  now?: () => number;
  tickMs?: number;
  status?: UsageDeps['status'];
}

const keyBody = z.object({ key: z.string().nullish() }).nullable();

export const usageFeature = (o: UsageOptions = {}) =>
  defineFeature({
    id: 'usage',
    settings,
    setup(ctx) {
      const machine = (id: string) => {
        const m = ctx.machines.get(id);
        if (!m) throw offline();
        return m;
      };
      const store = new WorkerStore(hubDBFile(ctx.settings.path), ctx.logger);
      const usage = new Usage({
        settings: ctx.settings,
        limits: async (m, p, signal) => (await ctx.call(machine(m), usageProtocol, 'limits', p, { signal })).accounts,
        cost: (m, p, signal) => ctx.call(machine(m), usageProtocol, 'cost', p, { signal }),
        ready: () => {
          const ready = ctx.machines.list().filter((m) => m.ready);
          return [...ready.filter((m) => m.kind === 'local'), ...ready.filter((m) => m.kind !== 'local')].map((m) => m.id);
        },
        known: (m) => ctx.machines.get(m) !== undefined,
        readOnly: () => ctx.readOnly,
        enabled: () => ctx.enabledFor('desktop') || ctx.enabledFor('browser'),
        broadcast: (s) => ctx.broadcast(s),
        log: ctx.logger,
        store,
        now: o.now,
        tickMs: o.tickMs,
        status: o.status,
      });
      ctx.service('scheduler', async (signal) => {
        const off = ctx.machines.subscribe({ state: (st) => usage.onMachine(st), agent: (ev) => usage.onAgent(ev) });
        try {
          await usage.run(signal);
        } finally {
          off();
          await store.close();
        }
      });
      ctx.onForget((m) => usage.forget(m));

      const query = (c: Ctx) => new URL(c.req.url).searchParams;
      /** The answer, or 304 when If-None-Match is its ETag. */
      const tagged = (c: Ctx, body: object, etag: string) => {
        c.header('ETag', etag);
        if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
        return c.json(body);
      };

      ctx.api.get('/', async (c) => {
        if (query(c).get('watch') === '1') usage.watch();
        await usage.loadHistory();
        const s = usage.snapshot();
        return tagged(c, s, Usage.etag(s));
      });

      ctx.api.get('/cost', async (c) => {
        const q = query(c);
        const n = /^[+-]?\d+$/.test(q.get('days') ?? '') ? Number(q.get('days')) : 0;
        const days = Math.min(n >= 1 ? n : 30, 90);
        let tz = /^[+-]?\d+$/.test(q.get('tz') ?? '') ? Number(q.get('tz')) : 0;
        if (tz < -14 * 60 || tz > 14 * 60) tz = 0;
        const { rep, etag } = await usage.spend.report(days, tz, c.req.raw.signal);
        return tagged(c, rep, etag);
      });

      ctx.api.post('/refresh', ctx.mutating('refresh'), (c) => c.json({ queued: true, at: Math.floor(usage.refresh() / 1000) }, 202));

      ctx.machineApi.put('/deepseek-key', ctx.mutating('deepseek_key'), async (c) => {
        const body = await readJSON(c, 4096, keyBody);
        await ctx.call(c.var.machine, usageProtocol, 'setDeepseekKey', { key: body?.key ?? '' }, { signal: c.req.raw.signal });
        usage.refresh();
        return c.json({ ok: true });
      });

      const reads = new Map<string, number>();
      ctx.machineApi.get('/session', async (c) => {
        const q = query(c);
        const kind = q.get('kind') ?? '';
        const session = q.get('session') ?? '';
        const provider = sessionProvider(kind);
        if (!provider || !validSessionId(session))
          throw new Fail('bad_request', 400, 'kind: an agent whose sessions are priced; session: its session id');
        if (!usage.options().providers.includes(provider)) throw new Fail('provider_off', 404);
        const m = c.var.machine;
        const n = reads.get(m.id) ?? 0;
        if (n >= MAX_SESSION_READS) throw new Fail('busy', 429, "too many reads of the machine's sessions at once");
        reads.set(m.id, n + 1);
        try {
          // Decoded by the protocol's schema: nothing else an agent
          // answered reaches the page.
          return c.json(
            await ctx.call(m, usageProtocol, 'session', { kind, session, prices: usage.prices().own }, { signal: c.req.raw.signal }),
          );
        } finally {
          const left = (reads.get(m.id) ?? 1) - 1;
          if (left > 0) reads.set(m.id, left);
          else reads.delete(m.id);
        }
      });
    },
  });

/** A request's JSON body of at most limit bytes read with schema; a body
 * too large, not JSON or not of the schema fails with bad_request, as the
 * Go hub's did. */
async function readJSON<S extends z.ZodType>(c: Ctx, limit: number, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(await readBody(c.req.raw, limit)).toString('utf8'));
  } catch (e) {
    throw new Fail('bad_request', 400, (e as Error).message);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Fail('bad_request', 400, r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}
