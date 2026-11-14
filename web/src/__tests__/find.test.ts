// @vitest-environment jsdom
//
// Find in panes: herdr's matches (pane.copy_search, absolute rows, last
// cell included) mapped to the rows shown, scrolling the current one into
// view, retrying while the output changes, and the find bar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const calls: Array<{ method: string; params: Record<string, any> }> = [];
let answer: (method: string, params: Record<string, any>) => unknown;

vi.mock('../lib/conn', async () => {
  class ApiError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    conn: {
      api: (_m: string, method: string, params: Record<string, any>) => {
        calls.push({ method, params });
        try {
          return Promise.resolve(answer(method, params));
        } catch (e) {
          return Promise.reject(e);
        }
      },
      send: () => {},
      sendNow: () => {},
      setTheme: () => {},
      setSurfaceHandler: () => {},
    },
  };
});

import { ApiError } from '../lib/conn';
import {
  CURRENT,
  MATCH,
  closeFind,
  copySearch,
  findStep,
  isFindKey,
  matchRows,
  openFind,
  revealOffset,
  setFindQuery,
  useFind,
  TYPING_MS,
} from '../surface/find';
import { useSurface } from '../surface/session';
import { useStore } from '../state/store';
import { FindBar, findCount } from '../components/FindBar';
import { paintRows, sameRanges } from '../surface/paint';
import { palette } from '../surface/colors';
import { themes } from '../terminal/options';
import { Grid } from '../surface/grid';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
const at = (row: number, col: number) => ({ row, col });
const match = (r0: number, c0: number, r1: number, c1: number) => ({ start: at(r0, c0), end: at(r1, c1) });
const flush = () => new Promise((r) => setTimeout(r, 0));

/** herdr's answers: the revision from copy_motion, matches from copy_search. */
function herdr(result: Record<string, unknown>, stale = 0) {
  let rev = 264;
  answer = (method) => {
    if (method === 'pane.copy_motion') return { cursor: at(0, 4), content_revision: (rev += 2) };
    if (method === 'pane.copy_search') {
      if (stale-- > 0) throw new ApiError('stale_content', 'pane content changed');
      return result;
    }
    return {};
  };
}

beforeEach(() => {
  calls.length = 0;
  closeFind();
  useStore.setState({ readOnly: false });
});

describe('find key', () => {
  it('is Cmd+F on macOS and Ctrl+Shift+F elsewhere', () => {
    expect(isFindKey(key({ code: 'KeyF', key: 'f', metaKey: true }), true)).toBe(true);
    expect(isFindKey(key({ code: 'KeyF', key: 'f', ctrlKey: true }), true)).toBe(false);
    expect(isFindKey(key({ code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    // Ctrl+F is the programs' (readline's forward-char).
    expect(isFindKey(key({ code: 'KeyF', key: 'f', ctrlKey: true }), false)).toBe(false);
    expect(isFindKey(key({ code: 'KeyF', key: 'f', metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFindKey(key({ code: 'KeyG', key: 'g', metaKey: true }), true)).toBe(false);
  });
});

describe('matches on rows', () => {
  it('maps herdr ranges, last cell included, to columns per row', () => {
    const cur = match(8, 0, 8, 5);
    const rows = matchRows([match(2, 4, 2, 7), cur], cur, 80);
    expect(rows.get(2)).toEqual([[4, 8, MATCH]]);
    expect(rows.get(8)).toEqual([[0, 6, CURRENT]]);
    expect(rows.has(3)).toBe(false);
  });

  it('splits a match found across a soft wrap', () => {
    const rows = matchRows([match(4, 77, 5, 2)], undefined, 80);
    expect(rows.get(4)).toEqual([[77, 80, MATCH]]);
    expect(rows.get(5)).toEqual([[0, 3, MATCH]]);
  });

  it('keeps ranges inside a narrower pane', () => {
    expect(matchRows([match(1, 70, 1, 90)], undefined, 80).get(1)).toEqual([[70, 80, MATCH]]);
    expect(matchRows([match(1, 85, 1, 90)], undefined, 80).has(1)).toBe(false);
  });

  it('compare with their kind', () => {
    expect(sameRanges([[1, 3, MATCH]], [[1, 3, CURRENT]])).toBe(false);
    expect(sameRanges([[1, 3]], [[1, 3, 0]])).toBe(true);
  });

  it('paint the selection over the current match over other matches', () => {
    const p = palette(themes.dark);
    const fills: Array<{ style: string; x: number }> = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number) {
        fills.push({ style: this.fillStyle, x });
      },
      fillText() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
    };
    const g = new Grid();
    const cell = { symbol: 'a', fg: 0, bg: 0, mod: 0, skip: false, link: -1 };
    g.apply({ full: true, gen: 1, w: 4, h: 1, moves: [], spans: [{ x: 0, y: 0, cells: [cell, cell, cell, cell] }] });
    const metrics = { cw: 10, ch: 20, fontPx: 16, family: 'mono', weight: 400, baseline: 15 };
    const hl = () =>
      [
        [0, 3, MATCH],
        [1, 3, CURRENT],
        [2, 4],
      ] as Array<[number, number, number?]>;
    paintRows(ctx as unknown as CanvasRenderingContext2D, g, { palette: p, metrics, focused: false, highlight: hl }, [0]);
    const cells = fills.slice(1, 5).map((f) => f.style);
    expect(cells).toEqual([p.match, p.matchCurrent, p.selection, p.selection]);
    expect(new Set([p.match, p.matchCurrent, p.selection, p.bg]).size).toBe(4);
  });
});

describe('revealing a match', () => {
  // 84 rows above a view of 40, at the bottom: rows 84-123 are shown.
  const bottom = { offset_from_bottom: 0, max_offset_from_bottom: 84, viewport_rows: 40 };

  it('leaves a shown match where it is', () => {
    expect(revealOffset(match(122, 0, 122, 3), bottom)).toBeUndefined();
    expect(revealOffset(match(84, 0, 84, 3), bottom)).toBeUndefined();
  });

  it('centers a match above or below the view', () => {
    // Row 8 in the middle: the view starts at row 8 - 19 = -11, clamped to 0.
    expect(revealOffset(match(8, 0, 8, 5), bottom)).toBe(84);
    // Row 60: the view starts at 41, 43 rows from the bottom.
    expect(revealOffset(match(60, 0, 60, 5), bottom)).toBe(84 - 41);
    // Scrolled to the top, a match at the bottom.
    expect(revealOffset(match(123, 0, 123, 1), { ...bottom, offset_from_bottom: 84 })).toBe(0);
  });

  it('does not scroll the alternate screen', () => {
    expect(revealOffset(match(3, 0, 3, 1), { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 })).toBeUndefined();
    expect(revealOffset(match(3, 0, 3, 1), undefined)).toBeUndefined();
  });
});

describe('searching', () => {
  it('asks for the revision, then searches it; again while the output changes', async () => {
    herdr({ matches: [match(1, 0, 1, 3)], total: 1, current: 0, current_global: 0, content_revision: 270 }, 2);
    const res = await copySearch('local', 'w1:p1', 'beta', 'backward');
    expect(res.total).toBe(1);
    expect(calls.map((c) => c.method)).toEqual([
      'pane.copy_motion',
      'pane.copy_search',
      'pane.copy_motion',
      'pane.copy_search',
      'pane.copy_motion',
      'pane.copy_search',
    ]);
    const last = calls[5].params;
    expect(last).toMatchObject({ pane_id: 'w1:p1', query: 'beta', direction: 'backward', content_revision: 270 });
    // Backward from past the end: the newest match.
    expect(last.cursor.row).toBeGreaterThan(1e9);
    expect(last.previous).toBeUndefined();
  });

  it('gives up on other errors at once', async () => {
    answer = (method) => {
      if (method === 'pane.copy_search') throw new ApiError('pane_not_found', 'no');
      return { content_revision: 2 };
    };
    await expect(copySearch('local', 'w1:p1', 'x', 'forward')).rejects.toMatchObject({ code: 'pane_not_found' });
    expect(calls).toHaveLength(2);
  });

  it('opens on the newest match and scrolls it into view', async () => {
    useSurface.setState({
      meta: {
        m: 'local',
        gen: 1,
        w: 80,
        h: 40,
        panes: [
          {
            id: 'w1:p1',
            rect: { x: 0, y: 0, w: 80, h: 40 },
            inner: { x: 0, y: 0, w: 80, h: 40 },
            scroll: { offset_from_bottom: 0, max_offset_from_bottom: 84, viewport_rows: 40 },
            focused: true,
            mouse: false,
            alt: false,
          },
        ],
        splits: [],
        links: [],
      },
    });
    const found = [match(8, 0, 8, 5), match(71, 0, 71, 5), match(80, 0, 80, 5)];
    herdr({ matches: found, total: 3, current: 2, current_global: 2, content_revision: 266 });
    openFind('local', 'w1:p1', 'line 7');
    await flush();
    await flush();
    let st = useFind.getState();
    expect(st).toMatchObject({ open: true, query: 'line 7', total: 3, index: 2, status: 'idle' });
    expect(st.current).toEqual(found[2]);
    // Row 80 is above rows 84-123: scrolled so that it is in the middle.
    expect(calls.at(-1)).toEqual({ method: 'pane.scroll', params: { pane_id: 'w1:p1', offset_from_bottom: 84 - 61 } });

    // Enter: the older match, from the current one.
    calls.length = 0;
    herdr({ matches: found, total: 3, current: 1, current_global: 1, content_revision: 268 });
    findStep(true);
    await flush();
    await flush();
    const search = calls.find((c) => c.method === 'pane.copy_search')!.params;
    expect(search.direction).toBe('backward');
    expect(search.previous).toEqual(found[2]);
    st = useFind.getState();
    expect(st.index).toBe(1);

    // Shift+Enter: the newer one.
    calls.length = 0;
    findStep(false);
    await flush();
    expect(calls.find((c) => c.method === 'pane.copy_search')!.params).toMatchObject({ direction: 'forward', previous: found[1] });
  });

  it('does not scroll in read-only mode', async () => {
    useStore.setState({ readOnly: true });
    herdr({ matches: [match(8, 0, 8, 5)], total: 1, current: 0, current_global: 0, content_revision: 266 });
    openFind('local', 'w1:p1', 'line 7');
    await flush();
    await flush();
    expect(useFind.getState().total).toBe(1);
    expect(calls.some((c) => c.method === 'pane.scroll')).toBe(false);
  });

  it('searches once typing pauses, and says when the output kept changing', async () => {
    vi.useFakeTimers();
    try {
      herdr({ matches: [], total: 0, content_revision: 2 }, 100);
      openFind('local', 'w1:p1');
      setFindQuery('a');
      setFindQuery('ab');
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(TYPING_MS + 2000);
      expect(calls.filter((c) => c.method === 'pane.copy_search').every((c) => c.params.query === 'ab')).toBe(true);
      expect(useFind.getState().status).toBe('busy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes without highlights', () => {
    useFind.setState({ open: true, m: 'local', pane: 'w1:p1', query: 'x', matches: [match(1, 0, 1, 0)], total: 1 });
    closeFind();
    expect(useFind.getState()).toMatchObject({ open: false, matches: [], total: 0, query: '' });
  });
});

describe('find bar', () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
  });

  it('counts matches', () => {
    expect(findCount({ query: '', total: 0, status: 'idle' })).toBe('');
    expect(findCount({ query: 'x', total: 0, status: 'idle' })).toBe('No results');
    expect(findCount({ query: 'x', total: 1500, index: 1499, status: 'idle' })).toBe('1500 of 1500');
    expect(findCount({ query: 'x', total: 0, status: 'busy' })).toMatch(/keeps changing/);
  });

  it('steps with Enter and Shift+Enter, and closes with Escape', async () => {
    const found = [match(8, 0, 8, 5), match(80, 0, 80, 5)];
    herdr({ matches: found, total: 2, current: 1, current_global: 1, content_revision: 266 });
    openFind('local', 'w1:p1', 'line');
    await flush();
    await flush();
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(FindBar, { m: 'local', top: 4, right: 600, maxWidth: 500 })));
    const input = host.querySelector<HTMLInputElement>('.find-input')!;
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('.find-count')?.textContent).toBe('2 of 2');

    calls.length = 0;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(calls.find((c) => c.method === 'pane.copy_search')?.params.direction).toBe('backward');
    calls.length = 0;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    await flush();
    expect(calls.find((c) => c.method === 'pane.copy_search')?.params.direction).toBe('forward');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useFind.getState().open).toBe(false);
  });
});
