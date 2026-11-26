// Project Search's hub side (docs/features/41-project-search.md):
//
//   - POST /api/m/:id/p/search/search {dir, query, regex, caseSensitive,
//     wholeWord, include, exclude, maxResults}: the files below dir of the
//     machine with their matching lines, the engine that ran and whether
//     the search stopped early, as the machine's agent answered.
//
// A POST for the length of its query and patterns; it only reads, so it is
// not mutating and a read-only hub searches too. A search the machine
// does not answer in time is a 504 timeout; the machine stops it when the
// request ends.
import { z } from 'zod';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import { MAX_GLOBS, MAX_QUERY, MAX_RESULTS, SEARCH_MS, searchProtocol, type SearchParams } from './protocol.ts';

/** Bounds a search's JSON. */
export const MAX_BODY = 16 << 10;

export interface SearchOptions {
  /** How long the machine may take (SEARCH_MS). */
  timeoutMs?: number;
}

const str = z.string().nullish();
const flag = z.boolean().nullish();

/** A search's body as the Go hub decoded it into its struct: members it
 * does not know are ignored, null is none; what is empty or false is left
 * out of the parameters (omitempty). */
const body = z
  .object({
    dir: str,
    query: str,
    regex: flag,
    caseSensitive: flag,
    wholeWord: flag,
    include: str,
    exclude: str,
    maxResults: z.int().nullish(),
  })
  .nullable()
  .transform((b): SearchParams => {
    const p: SearchParams = { dir: b?.dir ?? '', query: b?.query ?? '' };
    if (b?.regex) p.regex = true;
    if (b?.caseSensitive) p.caseSensitive = true;
    if (b?.wholeWord) p.wholeWord = true;
    if (b?.include) p.include = b.include;
    if (b?.exclude) p.exclude = b.exclude;
    if (b?.maxResults) p.maxResults = b.maxResults;
    return p;
  });

/** Why p is not a search, or undefined: the answer's message. */
export function problem(p: SearchParams): string | undefined {
  const bytes = (s = '') => Buffer.byteLength(s);
  if (!p.query || bytes(p.query) > MAX_QUERY || /[\0\r\n]/.test(p.query)) return 'a query of one line, 1 to 2000 bytes';
  if (!p.dir || p.dir.includes('\0')) return 'dir required';
  if (bytes(p.include) > MAX_GLOBS || bytes(p.exclude) > MAX_GLOBS) return 'patterns of at most 4000 bytes';
  if ((p.maxResults ?? 0) < 0 || (p.maxResults ?? 0) > MAX_RESULTS) return 'maxResults between 0 and 5000';
  return undefined;
}

/** A search's parameters from a request's body; bad_request (400) for a
 * body that is too large, not JSON, not a search's or not one to run. */
export async function searchOf(req: Request): Promise<SearchParams> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(await readBody(req, MAX_BODY)).toString('utf8'));
  } catch (e) {
    throw new Fail('bad_request', 400, (e as Error).message);
  }
  const r = body.safeParse(raw);
  if (!r.success) throw new Fail('bad_request', 400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const why = problem(r.data);
  if (why) throw new Fail('bad_request', 400, why);
  return r.data;
}

export const searchFeature = (o: SearchOptions = {}) =>
  defineFeature({
    id: 'search',
    setup(ctx) {
      const limit = o.timeoutMs ?? SEARCH_MS;
      ctx.machineApi.post('/search', async (c) => {
        const p = await searchOf(c.req.raw);
        const deadline = AbortSignal.timeout(limit);
        try {
          // The session's own limit comes after the deadline: the deadline
          // is what answers timeout.
          const r = await ctx.call(c.var.machine, searchProtocol, 'search', p, {
            signal: AbortSignal.any([c.req.raw.signal, deadline]),
            timeoutMs: limit + 5_000,
          });
          c.header('Cache-Control', 'no-store');
          return c.json(r);
        } catch (e) {
          if (deadline.aborted) throw new Fail('timeout', 504, 'the machine did not answer in time');
          throw e;
        }
      });
    },
  });
