// Find in a pane (docs/features/20-find-in-panes.md). herdr searches the
// pane's text itself (pane.copy_search: literal, smart case, across soft
// wraps, the scrollback included) and answers with matches in absolute rows,
// the coordinates of selections (selection.ts): row 0 is the oldest line
// kept. A search names the content revision it applies to; herdr refuses a
// stale one, so the revision is read right before (pane.copy_motion, which
// only reads) and the pair is tried again while the pane's output changes.
// The current match is scrolled into view with pane.scroll; the controller
// highlights the matches on the rows shown.

import { create } from 'zustand';
import { ApiError, conn } from '../lib/conn';
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

/** pane.copy_search's answer. herdr returns at most 1024 matches around
 * the current one; `total` counts them all. */
export interface FindResult {
  matches: FindMatch[];
  total: number;
  current?: number | null;
  current_global?: number | null;
  content_revision: number;
}

/** Highlight kinds of a row's ranges (paint.ts): a match, the current one. */
export const MATCH = 1;
export const CURRENT = 2;

/** Searching backward from here finds the newest match. */
const END: Point = { row: 2 ** 32 - 1, col: 0 };
const START: Point = { row: 0, col: 0 };
/** Attempts while the pane's output keeps changing the revision. */
const ATTEMPTS = 8;
/** Pause after typing before the query is searched. */
export const TYPING_MS = 120;

export type FindStatus = 'idle' | 'searching' | 'busy' | 'failed';

export interface FindState {
  open: boolean;
  m?: string;
  pane?: string;
  query: string;
  matches: FindMatch[];
  total: number;
  /** Position of the current match among all of them. */
  index?: number;
  current?: FindMatch;
  status: FindStatus;
  /** Bumped to focus the find bar's input and select its text. */
  focusSeq: number;
}

const initial: FindState = { open: false, query: '', matches: [], total: 0, status: 'idle', focusSeq: 0 };

export const useFind = create<FindState>(() => ({ ...initial }));

/** Whether a keydown opens find: Cmd+F on macOS, Ctrl+Shift+F elsewhere
 * (Ctrl+F belongs to the programs in panes). */
export function isFindKey(ev: KeyboardEvent, mac = isMac): boolean {
  if (ev.code !== 'KeyF' || ev.altKey) return false;
  return mac ? ev.metaKey && !ev.ctrlKey && !ev.shiftKey : ev.ctrlKey && ev.shiftKey && !ev.metaKey;
}

/** The find key's label, for menus. */
export const findKeyLabel = (mac = isMac) => (mac ? 'cmd+f' : 'ctrl+shift+f');

let seq = 0;
let typing: number | undefined;

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
  seq++;
  window.clearTimeout(typing);
  useFind.setState({ ...initial, open: true, m, pane, query, focusSeq: st.focusSeq + 1 });
  if (query) void search('backward');
}

/** Closes find and drops its highlights. */
export function closeFind() {
  seq++;
  window.clearTimeout(typing);
  const { focusSeq } = useFind.getState();
  useFind.setState({ ...initial, focusSeq });
}

/** The query changed: searched once typing pauses, from the newest match. */
export function setFindQuery(query: string) {
  useFind.setState({ query });
  window.clearTimeout(typing);
  seq++;
  if (!query) {
    useFind.setState({ matches: [], total: 0, index: undefined, current: undefined, status: 'idle' });
    return;
  }
  typing = window.setTimeout(() => void search('backward'), TYPING_MS);
}

/** The next older match (up) or newer one (down), wrapping around. */
export function findStep(older: boolean) {
  const st = useFind.getState();
  if (!st.query) return;
  window.clearTimeout(typing);
  void search(older ? 'backward' : 'forward', st.current);
}

/** pane.copy_search with a fresh content revision, again while the pane's
 * output changes it in between. */
export async function copySearch(
  m: string,
  pane: string,
  query: string,
  direction: 'backward' | 'forward',
  previous?: FindMatch,
): Promise<FindResult> {
  for (let i = 0; ; i++) {
    const motion = await conn.api<{ content_revision: number }>(m, 'pane.copy_motion', {
      pane_id: pane,
      cursor: START,
      motion: 'next_word_start',
    });
    try {
      return await conn.api<FindResult>(m, 'pane.copy_search', {
        pane_id: pane,
        query,
        direction,
        cursor: direction === 'backward' ? END : START,
        content_revision: motion.content_revision,
        ...(previous ? { previous: { start: previous.start, end: previous.end } } : {}),
      });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'stale_content') || i >= ATTEMPTS - 1) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

async function search(direction: 'backward' | 'forward', previous?: FindMatch) {
  const { m, pane, query } = useFind.getState();
  if (!m || !pane || !query) return;
  const mine = ++seq;
  useFind.setState({ status: 'searching' });
  try {
    const res = await copySearch(m, pane, query, direction, previous);
    if (mine !== seq) return;
    const matches = res.matches ?? [];
    const current = res.current != null ? matches[res.current] : undefined;
    useFind.setState({ matches, total: res.total ?? matches.length, index: res.current_global ?? undefined, current, status: 'idle' });
    if (current) reveal(m, pane, current);
  } catch (e) {
    if (mine !== seq) return;
    const busy = e instanceof ApiError && e.code === 'stale_content';
    useFind.setState({ matches: [], total: 0, index: undefined, current: undefined, status: busy ? 'busy' : 'failed' });
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
 * to) with the kind (MATCH or CURRENT). A match herdr found across a soft
 * wrap covers the end of its first row and the start of the next. */
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
