// The Git feature's hub side (docs/features/31-git.md): routes below
// /api/m/:id/p/git/ that run the actions of its machine side (protocol.ts).
// Reads are GETs with their parameters in the query; changes are POSTs
// with a JSON body, refused in read-only mode and audited as
// git.<action> and, with what they acted on and how they ended,
// git.<action>.done. What the machine answers passes to the page as it
// is, and so do its failures' codes (not_a_repo, auth_required, conflicts,
// diverged, git_failed, bad_ref, busy, timeout…).
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { CoalesceCache } from '#shared/lib/cache.ts';
import { gitProtocol, params, READS, WRITES, type Params, type Read } from './protocol.ts';
import { settings } from './settings.ts';

/** Bounds a change's JSON (a patch or a commit message with the rest). */
export const MAX_BODY = 5 << 20;

/** Short hub-side TTLs per git read action, in ms. Coalesces concurrent
 * multi-tab / focus / tree-expand bursts and avoids hammering the machine's
 * MAX_RUNS semaphore; invalidated immediately on any write to that machine. */
export const GIT_CACHE_TTL: Record<Read, number> = {
  repo: 5_000,
  watch: 500,
  status: 1_000,
  log: 2_000,
  show: 5_000,
  blob: 2_000,
  branches: 2_000,
  tags: 2_000,
  stashes: 2_000,
  diffStat: 1_000,
};

const GIT_CACHE_MAX = 512;

export interface GitOptions {
  /** Clock function for the hub-side read cache (tests). */
  now?: () => number;
}

const canonicalParams = (p: Params): string => {
  const keys = Object.keys(p).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = p[k as keyof Params];
  return JSON.stringify(out);
};

const readTtl = (action: Read, p: Params): number => {
  if (action === 'blob' && p.source && p.source !== 'worktree' && p.source !== 'index' && p.source !== 'head') {
    return 10_000;
  }
  return GIT_CACHE_TTL[action];
};

const queryStrings = ['repo', 'path', 'rev', 'rev2', 'source'] as const;
const queryNumbers = ['skip', 'limit', 'parent'] as const;

/** A read's parameters from its query: strings, whole numbers, booleans
 * ("1" or "true") and the repeated branch; empty values are left out. */
export function queryParams(q: URLSearchParams): Params {
  const p: Record<string, unknown> = {};
  for (const k of queryStrings) {
    const v = q.get(k);
    if (v) p[k] = v;
  }
  for (const k of queryNumbers) {
    const v = q.get(k);
    if (!v) continue;
    const n = Number(v);
    if (!/^[+-]?\d+$/.test(v) || !Number.isSafeInteger(n)) throw new Fail('bad_request', 400, `${k} is not a number`);
    p[k] = n;
  }
  const remotes = q.get('remotes');
  if (remotes === '1' || remotes === 'true') p.remotes = true;
  const noFiles = q.get('noFiles');
  if (noFiles === '1' || noFiles === 'true') p.noFiles = true;
  const branches = q.getAll('branch');
  if (branches.length > 0) p.branches = branches;
  return p as Params;
}

/** The members of a change an audit record holds (what it acted on), and
 * its switches. Patches and messages are never recorded; paths only by
 * their number. */
const AUDIT_NAMES = ['repo', 'rev', 'rev2', 'ref', 'onto', 'name', 'to', 'at', 'remote', 'branch', 'tag', 'mode', 'op', 'hash'];
const AUDIT_FLAGS = ['force', 'forceWithLease', 'amend', 'all'];

/** The fields of a change's audit record: its names (at most 512 bytes
 * each), its switches that are on, and how many paths it names. */
export function auditFields(p: Record<string, unknown>): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const k of AUDIT_NAMES) {
    const v = p[k];
    if (typeof v === 'string' && v) f[k] = Buffer.byteLength(v) > 512 ? Buffer.from(v).subarray(0, 512).toString() : v;
  }
  for (const k of AUDIT_FLAGS) if (p[k] === true) f[k] = true;
  let n = 0;
  for (const k of ['paths', 'untracked']) {
    const v = p[k];
    if (Array.isArray(v)) n += v.length;
  }
  if (n > 0) f.paths = n;
  return f;
}

/** A change's JSON body: an object (null is none), at most MAX_BODY bytes;
 * anything else fails with bad_request, as the Go hub's did. */
async function changeBody(c: Ctx): Promise<Record<string, unknown>> {
  let bytes: Uint8Array;
  try {
    bytes = await readBody(c.req.raw, MAX_BODY);
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
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Fail('bad_request', 400, 'the body is not an object');
  return raw as Record<string, unknown>;
}

/** A change's parameters as the agent reads them: a member that is null is
 * none (Go leaves the field as it is); one of another type fails with
 * bad_params, the agent's code. */
function changeParams(body: Record<string, unknown>): Params {
  const r = params.safeParse(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)));
  if (!r.success) throw new Fail('bad_params', 400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/** The code of a failed change, for its record. */
const codeOf = (e: unknown): string =>
  e instanceof Fail ? e.code : e instanceof Error && e.name === 'AbortError' ? 'transport' : 'failed';

const answer = (c: Ctx, result: unknown) => {
  c.header('Cache-Control', 'no-store');
  return c.json(result as object);
};

export const gitFeature = (o: GitOptions = {}) =>
  defineFeature({
    id: 'git',
    settings,
    setup(ctx) {
      const cache = new CoalesceCache<unknown>({ ttlMs: 0, maxEntries: GIT_CACHE_MAX, now: o.now });
      ctx.onForget((m) => cache.invalidatePrefix(`${m}\0`, { abort: true }));

      for (const action of READS)
        ctx.machineApi.get(`/${action}`, async (c) => {
          const p = queryParams(new URL(c.req.url).searchParams);
          const m = c.var.machine;
          const key = `${m.id}\0${action}\0${canonicalParams(p)}`;
          const res = await cache.get(key, { signal: c.req.raw.signal, ttlMs: readTtl(action, p) }, (signal) =>
            ctx.call(m, gitProtocol, action, p, { signal }),
          );
          return answer(c, res);
        });

      for (const action of WRITES)
        ctx.machineApi.post(`/${action}`, ctx.mutating(action), async (c) => {
          const body = await changeBody(c);
          const m = c.var.machine;
          // The route's own record (git.<action>) says how the request
          // ended; this one also what it changed.
          const done = (ok: boolean, code?: string) =>
            ctx.audit.log(c.var.who, `git.${action}.done`, { ...auditFields(body), machine: m.id, ok, ...(code ? { code } : {}) });
          try {
            const r = await ctx.call(m, gitProtocol, action, changeParams(body), { signal: c.req.raw.signal });
            cache.invalidatePrefix(`${m.id}\0`);
            done(true);
            return answer(c, r);
          } catch (e) {
            cache.invalidatePrefix(`${m.id}\0`);
            done(false, codeOf(e));
            throw e;
          }
        });
    },
  });
