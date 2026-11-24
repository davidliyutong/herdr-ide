// Project Search's action on a machine (docs/features/41-project-search.md),
// as the Go agent serves it while machines run the Go machine build
// (internal/agent/plugin/search): a search of the contents of the files
// below a directory, with ripgrep when the machine has it and a walker of
// the agent's own otherwise. The agent stops a search after 30 s and
// answers what it found; it runs at most 4 at once (busy). The core
// passes the result on to the page as the agent wrote it: a loose object,
// typed, whose members a later agent adds still reach the page.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** Bounds a query and the include or exclude patterns, in bytes (the
 * agent's limits); the matches a search may ask for. */
export const MAX_QUERY = 2000;
export const MAX_GLOBS = 4000;
export const MAX_RESULTS = 5000;

/** How long a search may take: the agent's 30 s and the transfer of what
 * it found. */
export const SEARCH_MS = 45_000;

/** A search's parameters (the agent's Params). */
export const searchParams = z.object({
  /** The directory searched ("~" and relative paths from home). */
  dir: z.string(),
  query: z.string(),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  /** Comma-separated glob patterns, as VS Code's files to include and to
   * exclude. */
  include: z.string().optional(),
  exclude: z.string().optional(),
  /** The most matches (the agent's 2000 when absent). */
  maxResults: z.int().optional(),
});
export type SearchParams = z.infer<typeof searchParams>;

/** A line with matches: line and col 1-based (col in UTF-16 code units);
 * ranges are the matches in preview, [start, end). */
const match = z.looseObject({
  line: z.number(),
  col: z.number(),
  preview: z.string(),
  ranges: z.array(z.tuple([z.number(), z.number()])).nullable(),
});

export const searchResult = z.looseObject({
  /** "rg" or "builtin". */
  engine: z.string(),
  /** The directory searched, absolute. */
  dir: z.string(),
  files: z.array(z.looseObject({ path: z.string(), matches: z.array(match).nullable() })).nullable(),
  matchCount: z.number(),
  truncated: z.boolean().optional(),
  /** Why the search stopped early: max_results, timeout or max_files. */
  reason: z.string().optional(),
});

export const searchProtocol = defineProtocol('search', {
  search: { params: searchParams, result: searchResult, timeoutMs: SEARCH_MS },
});
