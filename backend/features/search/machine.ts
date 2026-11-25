// Project Search's machine side (docs/features/41-project-search.md): a
// search of the contents of the files below a directory, as VS Code's
// search view does, with ripgrep when the machine has it (machine/rg.ts)
// and a walker of the agent's own otherwise (machine/walk.ts). Both only
// read: nothing is written on the machine. Results are bounded (maxResults
// matches, previews of 250 characters around the match), and a search that
// stopped early says why (truncated, reason). At most four run at once on
// a machine; one that finds no free place within 3 s fails with busy.
import { statSync } from 'node:fs';
import { Fail } from '#shared/lib/fail.ts';
import { defineMachine, type MachineEnv } from '#machine/feature.ts';
import { MAX_GLOBS, MAX_QUERY, MAX_RESULTS, searchProtocol, type SearchParams } from './protocol.ts';
import type { Result } from './machine/collector.ts';
import { splitGlobs } from './machine/glob.ts';
import { DEFAULT_RESULTS, type Query, type Stop } from './machine/query.ts';
import { bundledRg, lookPath, runRg } from './machine/rg.ts';
import { walk } from './machine/walk.ts';

export interface SearchMachineOptions {
  /** How long a search may run; what it found by then is its result (30 s). */
  timeoutMs?: number;
  /** The searches at once (4), and how long one waits for a place (3 s). */
  maxSearches?: number;
  slotWaitMs?: number;
  /** The ripgrep a search runs, "" for the walker (on PATH, else a
   * code-server's). */
  findRg?: (env: MachineEnv, environ: Record<string, string>) => string;
}

const defaultRg = (env: MachineEnv, environ: Record<string, string>) =>
  lookPath('rg', environ.PATH ?? process.env.PATH) || bundledRg(env.home);

/** p checked, its directory resolved. */
export function check(p: SearchParams, expand: (p: string) => string): Query {
  const bytes = (s = '') => Buffer.byteLength(s);
  if (!p.query || bytes(p.query) > MAX_QUERY || p.query.includes('\0'))
    throw new Fail('bad_params', 400, `query of 1 to ${MAX_QUERY} bytes required`);
  if (/[\r\n]/.test(p.query)) throw new Fail('bad_params', 400, 'a query is one line');
  if (bytes(p.include) > MAX_GLOBS || bytes(p.exclude) > MAX_GLOBS || `${p.include ?? ''}${p.exclude ?? ''}`.includes('\0'))
    throw new Fail('bad_params', 400, `patterns of at most ${MAX_GLOBS} bytes`);
  if (!p.dir || p.dir.includes('\0')) throw new Fail('bad_params', 400, 'no directory');
  const dir = expand(p.dir);
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = `${dir}: ${(e as Error).message}`;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Fail('not_found', 404, msg);
    if (code === 'EACCES' || code === 'EPERM') throw new Fail('denied', 403, msg);
    throw new Fail('failed', 400, msg);
  }
  if (!isDir) throw new Fail('not_dir', 400, `${dir} is not a directory`);
  const limit = Math.min(p.maxResults && p.maxResults > 0 ? p.maxResults : DEFAULT_RESULTS, MAX_RESULTS);
  return { ...p, dir, includes: splitGlobs(p.include), excludes: splitGlobs(p.exclude), limit };
}

/** Places for searches: at most max at once. */
class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** A place within waitMs, else Fail busy; Fail cancelled when signal
   * ends first. */
  async take(waitMs: number, signal: AbortSignal): Promise<() => void> {
    const release = () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
    if (this.active < this.max) {
      this.active++;
      return release;
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', cancel);
        resolve(release);
      };
      const leave = () => this.waiting.splice(this.waiting.indexOf(grant) >>> 0, 1);
      const t = setTimeout(() => {
        leave();
        signal.removeEventListener('abort', cancel);
        reject(new Fail('busy', 503, `${this.max} searches are in progress`));
      }, waitMs);
      const cancel = () => {
        clearTimeout(t);
        leave();
        reject(new Fail('cancelled', 400, 'the search was given up'));
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

/** Runs a search, with ripgrep when there is one, else the walker. */
export async function runSearch(
  q: Query,
  o: { rg: string; environ: Record<string, string>; timeoutMs: number; signal: AbortSignal },
): Promise<Result> {
  const deadline = new AbortController();
  const t = setTimeout(() => deadline.abort(), o.timeoutMs);
  const end = Date.now() + o.timeoutMs;
  const stop: Stop = { signal: AbortSignal.any([o.signal, deadline.signal]), timedOut: () => deadline.signal.aborted || Date.now() >= end };
  try {
    const res = o.rg ? await runRg(o.rg, q, o.environ, stop) : await walk(q, stop);
    res.dir = q.dir;
    res.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    return res;
  } finally {
    clearTimeout(t);
  }
}

export function searchMachine(o: SearchMachineOptions = {}) {
  return defineMachine(searchProtocol, (env) => {
    const gate = new Gate(o.maxSearches ?? 4);
    const findRg = o.findRg ?? defaultRg;
    return {
      actions: {
        // The search ends when the core gives up on it (ctx.signal).
        search: async (p, ctx) => {
          const q = check(p, ctx.expand);
          const release = await gate.take(o.slotWaitMs ?? 3000, ctx.signal);
          try {
            const environ = ctx.environ();
            return await runSearch(q, { rg: findRg(env, environ), environ, timeoutMs: o.timeoutMs ?? 30_000, signal: ctx.signal });
          } finally {
            release();
          }
        },
      },
    };
  });
}
