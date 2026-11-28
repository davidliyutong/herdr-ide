// The agents feature's hub side: the sessions of the coding agents in the
// machines' terminals. While it is on, the terminals feature asks each
// machine's detect stream for the session each agent terminal runs
// (plugins.agents.enabled); this feature serves the page's question
// before it resumes one:
//
//   - GET /api/m/:id/p/agents/resolve?kind=&session=&cwd=: whether a
//     session's transcript exists and ran in the directory cwd
//     ({ok, code?}); at most maxResolving run at once per machine (more:
//     429 busy), each a search of the machine's session directories for
//     an id it does not know.
//
// Everything a request names is checked here before the machine is asked
// (400 bad_request), and the machine checks it again. The request to the
// machine ends with the HTTP request, and within RESOLVE_MS. The route
// only reads: a read-only hub answers it, and it is not audited. The
// feature has no settings of its own.
import { byId, validSessionId } from '#shared/agents/kinds.ts';
import { CoalesceCache } from '#shared/lib/cache.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { agentsProtocol } from './protocol.ts';

/** Resolves a machine serves at once; more are answered 429 busy. */
export const MAX_RESOLVING = 8;
/** Bounds the directory of a resolve, in bytes. */
export const MAX_CWD = 4096;
/** How long a resolve answer is cached on the hub, in ms. Coalesces
 * multi-tab layout restores asking for the same session. */
export const RESOLVE_CACHE_TTL_MS = 5_000;
const RESOLVE_CACHE_MAX = 256;

export interface AgentsOptions {
  /** Resolves at once per machine (MAX_RESOLVING). */
  maxResolving?: number;
  /** Clock function for the hub-side resolve cache (tests). */
  now?: () => number;
}

/** Whether kind is an agent whose transcripts are read. */
const transcriptKind = (kind: string): boolean => !!byId(kind)?.transcript;

/** Whether s can be the directory of a resolve: an absolute POSIX path of
 * at most MAX_CWD bytes without NUL. The machine only compares it with the
 * directory a transcript records. */
export const validCwd = (s: string): boolean => s.startsWith('/') && Buffer.byteLength(s) <= MAX_CWD && !s.includes('\0');

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The first value of each name of a query as Go's url.Query reads it:
 * "+" is a space, a pair with a bad escape or a ";" is left out, and a
 * value that is not UTF-8 is null (a string could not hold its bytes). */
export function goQuery(search: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const unescape = (s: string): Uint8Array | undefined => {
    const bytes: number[] = [];
    for (let i = 0; i < s.length;) {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === '+') bytes.push(0x20);
      else if (ch === '%') {
        const hex = s.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else bytes.push(...Buffer.from(ch, 'utf8'));
    }
    return Uint8Array.from(bytes);
  };
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part || part.includes(';')) continue;
    const eq = part.indexOf('=');
    const k = unescape(eq < 0 ? part : part.slice(0, eq));
    const v = unescape(eq < 0 ? '' : part.slice(eq + 1));
    if (!k || !v) continue;
    let key: string;
    try {
      key = utf8.decode(k);
    } catch {
      continue;
    }
    if (out.has(key)) continue;
    let value: string | null;
    try {
      value = utf8.decode(v);
    } catch {
      value = null;
    }
    out.set(key, value);
  }
  return out;
}

export const agentsFeature = (o: AgentsOptions = {}) =>
  defineFeature({
    id: 'agents',
    setup(ctx) {
      const limit = o.maxResolving ?? MAX_RESOLVING;
      /** The resolves under way, by machine. */
      const resolving = new Map<string, number>();
      const resolveCache = new CoalesceCache<unknown>({
        ttlMs: RESOLVE_CACHE_TTL_MS,
        maxEntries: RESOLVE_CACHE_MAX,
        now: o.now,
      });
      ctx.onForget((m) => resolveCache.invalidatePrefix(`${m}\0`, { abort: true }));

      ctx.machineApi.get('/resolve', async (c) => {
        const q = goQuery(new URL(c.req.url).search);
        const value = (name: string): string | null => (q.has(name) ? (q.get(name) as string | null) : '');
        const [kind, session, cwd] = [value('kind'), value('session'), value('cwd')];
        if (kind === null || session === null || cwd === null || !transcriptKind(kind) || !validSessionId(session) || !validCwd(cwd))
          throw new Fail('bad_request', 400, 'kind: an agent with transcripts; session: its session id; cwd: an absolute directory');
        const m = c.var.machine;
        const key = `${m.id}\0${kind}\0${session}\0${cwd}`;
        const r = await resolveCache.get(key, { signal: c.req.raw.signal }, async (signal) => {
          const n = resolving.get(m.id) ?? 0;
          if (n >= limit) throw new Fail('busy', 429, "too many resolves of the machine's sessions at once");
          resolving.set(m.id, n + 1);
          try {
            // Only the answer's own members reach the page (resolveReply).
            return await ctx.call(m, agentsProtocol, 'resolve', { kind, session, cwd }, { signal });
          } finally {
            const left = (resolving.get(m.id) ?? 1) - 1;
            if (left > 0) resolving.set(m.id, left);
            else resolving.delete(m.id);
          }
        });
        // Do not cache transient misses (not_found / other_cwd) for 5 s so newly
        // created transcripts are found promptly (machine Resolver caches misses
        // for 1 s); keep coalescing concurrent callers and caching ok / compressed.
        const rep = r as { ok?: boolean; code?: string } | null;
        if (!rep || (rep.ok !== true && rep.code !== 'compressed')) {
          resolveCache.invalidate(key);
        }
        c.header('Cache-Control', 'no-store');
        return c.json(r as object);
      });
    },
  });
