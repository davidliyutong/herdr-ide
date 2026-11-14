// Find in a pane (docs/features/20-find-in-panes.md). The machine's agent
// searches the pane's text next to herdr (POST /api/m/{id}/find, the
// core's internal/panefind): a literal or an RE2 regular expression, with
// or without case, whole words only if asked, across soft wraps and the
// whole scrollback. It answers like herdr's pane.copy_search: matches in
// absolute rows, the coordinates of selections (selection.ts), row 0 being
// the oldest line kept. A newer search cancels the one in flight. The
// current match is scrolled into view with pane.scroll; the controller
// highlights the matches on the rows shown.

import { create } from 'zustand';
import { storage } from '../brand';
import { conn } from '../lib/conn';
import { useStore } from '../state/store';
import { isMac } from './input';
import type { Ranges } from './paint';
import type { ScrollInfo } from './protocol';
import { useSurface } from './session';
import type { Point } from './selection';

/** A match: its first and last cell (both included, as herdr reports them). */
export interface FindMatch {
  start: Point;
  end: Point;
}

/** The search's answer: at most 1024 matches around the current one;
 * `total` counts them all, up to a limit (`capped`). */
export interface FindResult {
  matches: FindMatch[];
  total: number;
  current?: number | null;
  current_global?: number | null;
  capped?: boolean;
}

/** How the query is matched; remembered in this browser. */
export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export type FindOption = keyof FindOptions;

/** Highlight kinds of a row's ranges (paint.ts): a match, the current one. */
export const MATCH = 1;
export const CURRENT = 2;

/** Searching backward from here finds the newest match. */
const END: Point = { row: 2 ** 32 - 1, col: 0 };
/** Pause after typing before the query is searched. */
export const TYPING_MS = 150;

/** busy: the pane kept changing size; invalid: the regular expression does
 * not compile (`error` says why). */
export type FindStatus = 'idle' | 'searching' | 'busy' | 'failed' | 'invalid';

export interface FindState {
  open: boolean;
  m?: string;
  pane?: string;
  query: string;
  options: FindOptions;
  matches: FindMatch[];
  total: number;
  capped: boolean;
  /** Position of the current match among all of them. */
  index?: number;
  current?: FindMatch;
  status: FindStatus;
  error?: string;
  /** Bumped to focus the find bar's input and select its text. */
  focusSeq: number;
}

const OPTIONS_KEY = 'find.options';

function loadOptions(): FindOptions {
  const o: FindOptions = { matchCase: false, wholeWord: false, regex: false };
  try {
    const saved = JSON.parse(storage.get(OPTIONS_KEY) ?? '{}') as Partial<FindOptions>;
    for (const k of Object.keys(o) as FindOption[]) if (typeof saved[k] === 'boolean') o[k] = saved[k];
  } catch {
    /* defaults */
  }
  return o;
}

const empty = { matches: [], total: 0, capped: false, index: undefined, current: undefined, status: 'idle' as const, error: undefined };

export const useFind = create<FindState>(() => ({ open: false, query: '', options: loadOptions(), focusSeq: 0, ...empty }));

/** Whether a keydown opens find: Cmd+F on macOS, Ctrl+Shift+F elsewhere
 * (Ctrl+F belongs to the programs in panes). */
export function isFindKey(ev: KeyboardEvent, mac = isMac): boolean {
  if (ev.code !== 'KeyF' || ev.altKey) return false;
  return mac ? ev.metaKey && !ev.ctrlKey && !ev.shiftKey : ev.ctrlKey && ev.shiftKey && !ev.metaKey;
}

/** The find key's label, for menus. */
export const findKeyLabel = (mac = isMac) => (mac ? 'cmd+f' : 'ctrl+shift+f');

const optionCodes: Record<string, FindOption> = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' };

/** The option a keydown in the find bar toggles: Alt+C, Alt+W, Alt+R as in
 * VS Code (also with Cmd on macOS, VS Code's keys there). */
export function findOptionKey(ev: KeyboardEvent, mac = isMac): FindOption | undefined {
  if (!ev.altKey || ev.ctrlKey || ev.shiftKey || (ev.metaKey && !mac)) return;
  return optionCodes[ev.code];
}

/** Option keys' labels, for tooltips. */
export const findOptionKeyLabel = (o: FindOption, mac = isMac) =>
  `${mac ? '⌥' : 'Alt+'}${{ matchCase: 'C', wholeWord: 'W', regex: 'R' }[o]}`;

let typing: number | undefined;
let refresh: number | undefined;
let inflight: AbortController | undefined;
/** Searches and steps run one after another (a step starts from where the
 * one before it ended); cancel() drops what is queued. */
let chain: Promise<void> = Promise.resolve();
let generation = 0;

function enqueue(job: () => Promise<void> | void) {
  const g = generation;
  chain = chain.then(() => (g === generation ? job() : undefined)).catch(() => {});
}

/** Drops pending and running searches: their answers are not wanted. */
function cancel() {
  window.clearTimeout(typing);
  window.clearTimeout(refresh);
  typing = refresh = undefined;
  generation++;
  inflight?.abort();
  inflight = undefined;
  chain = Promise.resolve();
}

/** Opens find for a pane, with text (a selection) as the query if given;
 * an open find bar takes the focus again. */
export function openFind(m: string, pane: string, text?: string) {
  const st = useFind.getState();
  const query = text ?? st.query;
  const same = st.open && st.m === m && st.pane === pane;
  if (same && query === st.query) {
    useFind.setState({ focusSeq: st.focusSeq + 1 });
    return;
  }
  cancel();
  useFind.setState({ ...empty, open: true, m, pane, query, focusSeq: st.focusSeq + 1 });
  if (query) enqueue(() => search(true));
}

/** Closes find and drops its highlights; the options stay. */
export function closeFind() {
  cancel();
  useFind.setState({ ...empty, open: false, m: undefined, pane: undefined, query: '' });
}

/** The query changed: searched once typing pauses, from the newest match. */
export function setFindQuery(query: string) {
  useFind.setState({ query });
  cancel();
  if (!query) {
    useFind.setState(empty);
    return;
  }
  typing = window.setTimeout(() => {
    typing = undefined;
    enqueue(() => search(true));
  }, TYPING_MS);
}

/** Turns an option on or off and searches again from the newest match. */
export function toggleFindOption(o: FindOption) {
  const st = useFind.getState();
  const options = { ...st.options, [o]: !st.options[o] };
  storage.set(OPTIONS_KEY, JSON.stringify(options));
  useFind.setState({ options });
  if (!st.query) return;
  cancel();
  enqueue(() => search(true));
}

/** Pause after stepping through matches before the count and positions
 * are brought up to date. */
export const REFRESH_MS = 400;

/** The next older match (up) or newer one (down), wrapping around. A
 * match among those of the last answer is taken at once; the search then
 * runs again in the background once stepping pauses, keeping that match.
 * Beyond them, the core finds the next one. */
export function findStep(older: boolean) {
  const st = useFind.getState();
  if (!st.query || st.status === 'invalid') return;
  if (typing !== undefined) {
    // The query was not searched yet: search it now, from the newest.
    cancel();
    enqueue(() => search(true));
    return;
  }
  window.clearTimeout(refresh);
  enqueue(() => {
    const now = useFind.getState();
    const next = localStep(now, older);
    if (!next) return search(older, now.current);
    useFind.setState(next);
    if (now.m && now.pane) reveal(now.m, now.pane, next.current);
    window.clearTimeout(refresh);
    refresh = window.setTimeout(() => enqueue(() => search(true, undefined, after(next.current))), REFRESH_MS);
  });
}

/** The match next to the current one among those of the last answer, with
 * its position; around the ends only when the answer holds all matches. */
export function localStep(st: FindState, older: boolean): { current: FindMatch; index: number } | undefined {
  const i = st.current ? st.matches.findIndex((mt) => sameMatch(mt, st.current)) : -1;
  if (i < 0 || st.index === undefined) return;
  const j = i + (older ? -1 : 1);
  if (j >= 0 && j < st.matches.length) return { current: st.matches[j], index: st.index + (older ? -1 : 1) };
  if (st.matches.length !== st.total) return;
  const k = (j + st.matches.length) % st.matches.length;
  return { current: st.matches[k], index: k };
}

/** Searching backward from right after a match finds that match again. */
const after = (mt: FindMatch): Point => ({ row: mt.end.row, col: mt.end.col + 1 });

/** A search the core refused or could not make: the code, and herdr's or
 * the regular expression's words. */
export class FindError extends Error {
  constructor(
    public code: string,
    public detail = '',
  ) {
    super(detail || code);
  }
}

export interface FindRequest {
  query: string;
  options: FindOptions;
  backward: boolean;
  previous?: FindMatch;
  /** Where to search from without a previous match: the end (backward) or
   * the start (forward) by default. */
  from?: Point;
  /** The pane's width as shown, which the agent checks. */
  cols?: number;
}

/** Searches a pane's text on its machine (one request). */
export async function paneFind(m: string, pane: string, req: FindRequest, signal?: AbortSignal): Promise<FindResult> {
  const res = await fetch(`/api/m/${encodeURIComponent(m)}/find`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      pane,
      query: req.query,
      regex: req.options.regex,
      match_case: req.options.matchCase,
      whole_word: req.options.wholeWord,
      backward: req.backward,
      cursor: req.from ?? (req.backward ? END : { row: 0, col: 0 }),
      ...(req.previous ? { previous: { start: req.previous.start, end: req.previous.end } } : {}),
      ...(req.cols ? { cols: req.cols } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new FindError(body.error || String(res.status), body.detail);
  return body as FindResult;
}

async function search(backward: boolean, previous?: FindMatch, from?: Point) {
  const { m, pane, query, options } = useFind.getState();
  if (!m || !pane || !query) return;
  const meta = useSurface.getState().meta;
  const cols = meta?.m === m ? meta.panes.find((p) => p.id === pane)?.inner.w : undefined;
  const ctl = new AbortController();
  inflight = ctl;
  // A background refresh keeps the count shown meanwhile.
  if (!from) useFind.setState({ status: 'searching', error: undefined });
  try {
    const res = await paneFind(m, pane, { query, options, backward, previous, from, cols }, ctl.signal);
    if (ctl.signal.aborted) return;
    const matches = res.matches ?? [];
    const current = res.current != null ? matches[res.current] : undefined;
    useFind.setState({
      matches,
      total: res.total ?? matches.length,
      capped: !!res.capped,
      index: res.current_global ?? undefined,
      current,
      status: 'idle',
    });
    if (current) reveal(m, pane, current);
  } catch (e) {
    // A failed background refresh leaves the matches found before.
    if (ctl.signal.aborted || from) return;
    const code = e instanceof FindError ? e.code : '';
    const status: FindStatus = code === 'invalid_regex' ? 'invalid' : code === 'unavailable' ? 'busy' : 'failed';
    useFind.setState({ ...empty, status, error: e instanceof FindError ? e.detail : String(e) });
  } finally {
    if (inflight === ctl) inflight = undefined;
  }
}

/** Scrolls the pane so the match is shown, unless it is. Read-only pages
 * do not scroll: the position is shared by every client of the pane. */
function reveal(m: string, pane: string, match: FindMatch) {
  if (useStore.getState().readOnly) return;
  const meta = useSurface.getState().meta;
  const p = meta?.m === m ? meta.panes.find((x) => x.id === pane) : undefined;
  const offset = revealOffset(match, p?.scroll);
  if (offset !== undefined) void conn.api(m, 'pane.scroll', { pane_id: pane, offset_from_bottom: offset }).catch(() => {});
}

/** The scroll position (offset from the bottom) that shows a match in the
 * middle of the view, or undefined when it is shown already or the pane
 * does not scroll (the alternate screen). */
export function revealOffset(match: FindMatch, s: ScrollInfo | undefined): number | undefined {
  if (!s || s.max_offset_from_bottom <= 0) return;
  const rows = s.viewport_rows;
  const top = s.max_offset_from_bottom - s.offset_from_bottom;
  if (match.start.row >= top && match.end.row < top + rows) return;
  const height = match.end.row - match.start.row + 1;
  const want = match.start.row - Math.max(0, Math.floor((rows - height) / 2));
  const clamped = Math.min(Math.max(want, 0), s.max_offset_from_bottom);
  return s.max_offset_from_bottom - clamped;
}

const sameMatch = (a: FindMatch, b: FindMatch | undefined) =>
  !!b && a.start.row === b.start.row && a.start.col === b.start.col && a.end.row === b.end.row && a.end.col === b.end.col;

/** The matches' columns per absolute row, for a pane `cols` wide: [from,
 * to) with the kind (MATCH or CURRENT). A match found across a soft wrap
 * covers the end of its first row and the start of the next. */
export function matchRows(matches: FindMatch[], current: FindMatch | undefined, cols: number): Map<number, Ranges> {
  const rows = new Map<number, Ranges>();
  for (const mt of matches) {
    const kind = sameMatch(mt, current) ? CURRENT : MATCH;
    for (let row = mt.start.row; row <= mt.end.row; row++) {
      const from = Math.min(row === mt.start.row ? mt.start.col : 0, cols);
      const to = Math.min(row === mt.end.row ? mt.end.col + 1 : cols, cols);
      if (to <= from) continue;
      const r = rows.get(row);
      if (r) r.push([from, to, kind]);
      else rows.set(row, [[from, to, kind]]);
    }
  }
  return rows;
}
