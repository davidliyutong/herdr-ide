// Project Search's state, kept while its panel is away: the query and its
// options, the folder chosen to search (else the panel follows the focused
// pane's), the last result, and which files are collapsed. One search runs
// at a time: a new one cancels the one in flight (the machine stops it).
import { create } from 'zustand';
import { actions } from '../../actions';
import { errorText, search, type SearchParams, type SearchResult } from './api';
import { paramsKey } from './model';

export interface SearchState {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  /** The include and exclude fields are shown. */
  details: boolean;
  /** The folder the user chose on machine m; without one the panel
   * searches the folder it follows. */
  scope?: { m: string; dir: string };
  /** The last search's result, of machine m with the key of its params. */
  result?: { m: string; key: string; data: SearchResult };
  error?: string;
  /** A search is in flight. */
  busy: boolean;
  /** Files (relative paths) collapsed. */
  collapsed: Record<string, boolean>;
  /** The keyboard's row. */
  cursor?: string;
}

export const useSearch = create<SearchState>(() => ({
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: '',
  exclude: '',
  details: false,
  busy: false,
  collapsed: {},
}));

export const setSearch = (patch: Partial<SearchState>) => useSearch.setState(patch);

/** The params of a search of dir with the panel's query and options. */
export function paramsFor(dir: string, s: SearchState = useSearch.getState()): SearchParams {
  const p: SearchParams = { dir, query: s.query };
  if (s.regex) p.regex = true;
  if (s.caseSensitive) p.caseSensitive = true;
  if (s.wholeWord) p.wholeWord = true;
  if (s.include.trim()) p.include = s.include.trim();
  if (s.exclude.trim()) p.exclude = s.exclude.trim();
  return p;
}

let inflight: { key: string; ctl: AbortController } | undefined;

/** Searches dir of machine m with the panel's query: an empty query
 * clears the result; the search shown already (or in flight) is not run
 * again unless force. */
export async function runSearch(m: string, dir: string, force = false): Promise<void> {
  const s = useSearch.getState();
  if (!s.query) {
    inflight?.ctl.abort();
    inflight = undefined;
    setSearch({ result: undefined, error: undefined, busy: false, cursor: undefined });
    return;
  }
  const p = paramsFor(dir, s);
  const key = paramsKey(m, p);
  if (!force && (inflight?.key === key || (!inflight && s.result?.key === key && !s.error))) return;
  inflight?.ctl.abort();
  const ctl = new AbortController();
  inflight = { key, ctl };
  setSearch({ busy: true });
  try {
    const data = await search(m, p, ctl.signal);
    if (inflight?.ctl !== ctl) return;
    const same = useSearch.getState().result?.key === key;
    setSearch({ result: { m, key, data }, error: undefined, busy: false, ...(same ? {} : { collapsed: {}, cursor: undefined }) });
  } catch (e) {
    if (inflight?.ctl !== ctl || ctl.signal.aborted) return;
    setSearch({ result: undefined, error: errorText(e), busy: false });
  } finally {
    if (inflight?.ctl === ctl) inflight = undefined;
  }
}

/** Cancels the search in flight. */
export function cancelSearch() {
  inflight?.ctl.abort();
  inflight = undefined;
  setSearch({ busy: false });
}

/** Opens a file at a line and column as a path found in a pane does
 * (actions.openPath): in the file explorer's own preview editor by default,
 * in VS Code when files.openLinks says so, else in Quick Look. */
export function openMatch(m: string, path: string, line?: number, col?: number) {
  return actions.openPath(m, path, { line, col });
}
