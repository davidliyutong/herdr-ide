// Project Search's request to the core (internal/plugins/search): a search
// of the files below a directory of a machine.
import { answer, failureOf, jsonInit, makeErrorText, PluginError } from '../../lib/pluginApi';

/** What a search looks for (the agent's search.Params). */
export interface SearchParams {
  dir: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Comma-separated glob patterns, as VS Code's files to include and to
   * exclude. */
  include?: string;
  exclude?: string;
  maxResults?: number;
}

/** A line with matches: line and col are 1-based (col in UTF-16 code
 * units, as editors count); ranges are the matches in preview, [start,
 * end) in its characters. */
export interface SearchMatch {
  line: number;
  col: number;
  preview: string;
  ranges: Array<[number, number]>;
}

/** A file with matches; path is relative to the directory searched. */
export interface SearchFile {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  /** "rg" (ripgrep) or "builtin" (the agent's own walker). */
  engine: string;
  /** The directory searched, absolute. */
  dir: string;
  files: SearchFile[];
  matchCount: number;
  truncated?: boolean;
  /** Why the search stopped early: max_results, timeout or max_files. */
  reason?: string;
}

export class SearchError extends PluginError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'SearchError';
  }
}

/** A failure as the user reads it; a refused regular expression says
 * why. */
export const errorText = makeErrorText(SearchError, 'search.error', {
  detail: (e, text) => (e.code === 'bad_regex' && e.message ? `${text} ${e.message.replace(/^bad_regex: /, '')}` : text),
});

/** Runs a search on machine m; signal cancels it (the machine stops it). */
export async function search(m: string, p: SearchParams, signal?: AbortSignal): Promise<SearchResult> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/p/search/search`, { ...jsonInit('POST', p), signal });
  return answer<SearchResult>(
    r,
    failureOf((code, message) => new SearchError(code, message)),
  );
}
