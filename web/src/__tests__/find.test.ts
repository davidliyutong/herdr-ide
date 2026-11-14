// @vitest-environment jsdom
//
// Find in panes: the search the machine's agent makes (POST
// /api/m/{id}/find: absolute rows, last cell included) mapped to the rows
// shown, scrolling the current one into view, options, cancelling
// superseded searches, and the find bar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const calls: Array<{ method: string; params: Record<string, any> }> = [];

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
        return Promise.resolve({});
      },
      send: () => {},
      sendNow: () => {},
      setTheme: () => {},
      setSurfaceHandler: () => {},
    },
  };
});

import {
  CURRENT,
  MATCH,
  closeFind,
  FindError,
  findErrorText,
  findOptionKey,
  findStep,
  isFindKey,
  matchRows,
  openFind,
  paneFind,
  revealOffset,
  setFindQuery,
  toggleFindOption,
  useFind,
  TYPING_MS,
  REFRESH_MS,
} from '../surface/find';
import { useSurface } from '../surface/session';
import { useStore } from '../state/store';
import { storage } from '../brand';
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

/** The searches the page asked for: URL, body and whether it was cancelled. */
const searches: Array<{ url: string; body: Record<string, any>; signal?: AbortSignal }> = [];
let reply: (body: Record<string, any>) => { status?: number; json: unknown };

/** The core answers every search with result (or an error status). */
function serve(result: unknown, status = 200) {
  reply = () => ({ status, json: result });
}

beforeEach(() => {
  calls.length = 0;
  searches.length = 0;
  serve({ matches: [], total: 0 });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    searches.push({ url, body, signal: init.signal ?? undefined });
    const r = reply(body);
    return Promise.resolve(new Response(JSON.stringify(r.json), { status: r.status ?? 200 }));
  });
  closeFind();
  useFind.setState({ options: { matchCase: false, wholeWord: false, regex: false } });
  useStore.setState({ readOnly: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('toggles options with Alt+C, Alt+W and Alt+R in the bar (Option on macOS)', () => {
    // macOS's Option types ç: the code says which key it was.
    expect(findOptionKey(key({ code: 'KeyC', key: 'ç', altKey: true }))).toBe('matchCase');
    expect(findOptionKey(key({ code: 'KeyW', key: '∑', altKey: true }))).toBe('wholeWord');
    expect(findOptionKey(key({ code: 'KeyR', key: 'r', altKey: true }))).toBe('regex');
    // Cmd+Option+C, W and R are the browser's (Chrome's element inspector,
    // Safari's commands).
    expect(findOptionKey(key({ code: 'KeyC', key: 'c', altKey: true, metaKey: true }))).toBeUndefined();
    expect(findOptionKey(key({ code: 'KeyR', key: 'r', altKey: true, metaKey: true }))).toBeUndefined();
    expect(findOptionKey(key({ code: 'KeyC', key: 'c', altKey: true, ctrlKey: true }))).toBeUndefined();
    expect(findOptionKey(key({ code: 'KeyC', key: 'C', altKey: true, shiftKey: true }))).toBeUndefined();
    expect(findOptionKey(key({ code: 'KeyC', key: 'c' }))).toBeUndefined();
    expect(findOptionKey(key({ code: 'KeyX', key: 'x', altKey: true }))).toBeUndefined();
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
  const meta = (inner = 80) =>
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
            inner: { x: 0, y: 0, w: inner, h: 40 },
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

  it('asks the core with the options, the direction and the pane width', async () => {
    serve({ matches: [match(1, 0, 1, 3)], total: 1, current: 0, current_global: 0 });
    const res = await paneFind('local', 'w1:p1', {
      query: 'b.ta',
      options: { matchCase: true, wholeWord: false, regex: true },
      backward: true,
      cols: 79,
    });
    expect(res.total).toBe(1);
    expect(searches[0].url).toBe('/api/m/local/find');
    expect(searches[0].body).toMatchObject({
      pane: 'w1:p1',
      query: 'b.ta',
      regex: true,
      match_case: true,
      whole_word: false,
      backward: true,
      cols: 79,
    });
    // Backward from past the end: the newest match.
    expect(searches[0].body.cursor.row).toBeGreaterThan(1e9);
    expect(searches[0].body.previous).toBeUndefined();
  });

  it('reports the core’s error code', async () => {
    serve({ error: 'invalid_regex', reason: 'missing_paren', expr: 'a(b' }, 400);
    await expect(
      paneFind('local', 'w1:p1', { query: 'a(b', options: { matchCase: false, wholeWord: false, regex: true }, backward: true }),
    ).rejects.toMatchObject({
      code: 'invalid_regex',
      reason: 'missing_paren',
      expr: 'a(b',
    });
  });

  it('says why an expression is invalid in the page’s words', () => {
    expect(findErrorText(new FindError('invalid_regex', '', 'missing_paren', 'a(b'))).toBe('Missing closing ): a(b');
    expect(findErrorText(new FindError('invalid_regex', '', 'perl_op', '(?='))).toBe(
      'Unsupported syntax (no lookaround or backreferences): (?=',
    );
    // A reason the page does not know, or none.
    expect(findErrorText(new FindError('invalid_regex', '', 'new_reason', 'x'))).toBe('Invalid regular expression: x');
    expect(findErrorText(new FindError('invalid_regex'))).toBe('Invalid regular expression');
  });

  it('opens on the newest match and scrolls it into view', async () => {
    meta();
    const found = [match(8, 0, 8, 5), match(71, 0, 71, 5), match(80, 0, 80, 5)];
    serve({ matches: found, total: 3, current: 2, current_global: 2 });
    openFind('local', 'w1:p1', 'line 7');
    await flush();
    await flush();
    let st = useFind.getState();
    expect(st).toMatchObject({ open: true, query: 'line 7', total: 3, index: 2, status: 'idle' });
    expect(st.current).toEqual(found[2]);
    expect(searches[0].body.cols).toBe(80);
    // Row 80 is above rows 84-123: scrolled so that it is in the middle.
    expect(calls.at(-1)).toEqual({ method: 'pane.scroll', params: { pane_id: 'w1:p1', offset_from_bottom: 84 - 61 } });

    // Enter, Enter: the older matches, at once from the answer; wrapping
    // around since it holds all of them.
    vi.useFakeTimers();
    try {
      findStep(true);
      findStep(true);
      await vi.advanceTimersByTimeAsync(0);
      st = useFind.getState();
      expect(st).toMatchObject({ index: 0, current: found[0] });
      expect(searches).toHaveLength(1);
      findStep(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(useFind.getState()).toMatchObject({ index: 2, current: found[2] });
      // Shift+Enter: the newer one, around the end.
      findStep(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(useFind.getState()).toMatchObject({ index: 0, current: found[0] });

      // Once stepping pauses, the search runs again keeping that match.
      serve({ matches: [...found, match(90, 0, 90, 5)], total: 4, current: 0, current_global: 0 });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(searches).toHaveLength(2);
      expect(searches[1].body).toMatchObject({ backward: true, cursor: { row: 8, col: 6 } });
      expect(searches[1].body.previous).toBeUndefined();
      expect(useFind.getState()).toMatchObject({ index: 0, total: 4, current: found[0] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('steps at once while the background refresh is still searching, and drops it', async () => {
    const found = [match(8, 0, 8, 5), match(71, 0, 71, 5), match(80, 0, 80, 5)];
    serve({ matches: found, total: 3, current: 2, current_global: 2 });
    openFind('local', 'w1:p1', 'line');
    await flush();
    await flush();
    vi.useFakeTimers();
    try {
      findStep(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(useFind.getState()).toMatchObject({ index: 1, current: found[1] });
      // The refresh starts once stepping pauses; its answer is slow.
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        searches.push({ url, body: JSON.parse(String(init.body)), signal: init.signal ?? undefined });
        return new Promise(() => {});
      });
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(searches).toHaveLength(2);
      const refresh = searches[1];
      expect(refresh.signal?.aborted).toBe(false);
      // Enter: taken from the answer at once, not after the refresh.
      findStep(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(useFind.getState()).toMatchObject({ index: 0, current: found[0], status: 'idle' });
      expect(refresh.signal?.aborted).toBe(true);
      // Its own refresh follows the pause after it.
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(searches).toHaveLength(3);
      expect(searches[2].body).toMatchObject({ backward: true, cursor: { row: 8, col: 6 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('searches forward from the start, which the core takes as including the first cell', async () => {
    serve({ matches: [match(0, 0, 0, 2)], total: 1, current: 0, current_global: 0 });
    await paneFind('local', 'w1:p1', { query: 'abc', options: { matchCase: false, wholeWord: false, regex: false }, backward: false });
    expect(searches[0].body).toMatchObject({ backward: false, cursor: { row: 0, col: 0 } });
    expect(searches[0].body.previous).toBeUndefined();
  });

  it('asks the core for a match beyond the answer’s window, one step after another', async () => {
    // 2000 matches, the answer holds 3 of them around number 1000.
    const shown = [match(10, 0, 10, 1), match(11, 0, 11, 1), match(12, 0, 12, 1)];
    serve({ matches: shown, total: 2000, current: 0, current_global: 1000 });
    openFind('local', 'w1:p1', 'x');
    await flush();
    await flush();
    let release!: () => void;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      searches.push({ url, body: JSON.parse(String(init.body)), signal: init.signal ?? undefined });
      return new Promise((resolve) => {
        release = () =>
          resolve(new Response(JSON.stringify({ matches: [match(9, 0, 9, 1), ...shown], total: 2000, current: 0, current_global: 999 })));
      });
    });
    findStep(true); // beyond the window: asks
    findStep(false); // waits for that answer, then steps from it
    await flush();
    expect(searches).toHaveLength(2);
    expect(searches[1].body).toMatchObject({ backward: true, previous: shown[0] });
    expect(searches[1].signal?.aborted).toBe(false);
    release();
    await flush();
    await flush();
    // Back to the newer one, from the answer.
    expect(useFind.getState()).toMatchObject({ index: 1000, current: shown[0] });
    expect(searches).toHaveLength(2);
  });

  it('does not scroll in read-only mode', async () => {
    useStore.setState({ readOnly: true });
    serve({ matches: [match(8, 0, 8, 5)], total: 1, current: 0, current_global: 0 });
    openFind('local', 'w1:p1', 'line 7');
    await flush();
    await flush();
    expect(useFind.getState().total).toBe(1);
    expect(calls.some((c) => c.method === 'pane.scroll')).toBe(false);
  });

  it('searches once typing pauses, and cancels a search a newer one replaces', async () => {
    vi.useFakeTimers();
    try {
      openFind('local', 'w1:p1');
      setFindQuery('a');
      setFindQuery('ab');
      expect(searches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(TYPING_MS);
      expect(searches.map((s) => s.body.query)).toEqual(['ab']);

      // A slow answer to "ab" arrives after "abc" was asked: dropped.
      let release!: () => void;
      reply = (body) => {
        if (body.query === 'ab') return { json: { matches: [match(1, 0, 1, 1)], total: 7, current: 0, current_global: 0 } };
        return { json: { matches: [], total: 0 } };
      };
      searches.length = 0;
      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        searches.push({ url, body, signal: init.signal ?? undefined });
        const r = reply(body);
        return new Promise((resolve) => {
          release = () => resolve(new Response(JSON.stringify(r.json)));
        });
      });
      findStep(true);
      await vi.advanceTimersByTimeAsync(0);
      const first = searches[0];
      setFindQuery('abc');
      expect(first.signal?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(useFind.getState().total).not.toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when the regular expression is invalid, and does not step then', async () => {
    serve({ error: 'invalid_regex', reason: 'missing_repeat_arg', expr: '*' }, 400);
    openFind('local', 'w1:p1', '*');
    await flush();
    await flush();
    expect(useFind.getState()).toMatchObject({ status: 'invalid', error: 'Nothing to repeat: *', total: 0 });
    findStep(true);
    expect(searches).toHaveLength(1);
  });

  it('says when the pane kept changing', async () => {
    serve({ error: 'unavailable', detail: 'pane text unavailable' }, 409);
    openFind('local', 'w1:p1', 'x');
    await flush();
    await flush();
    expect(useFind.getState().status).toBe('busy');
  });

  it('remembers options, and searches again when one changes', async () => {
    const set = vi.spyOn(storage, 'set');
    serve({ matches: [match(1, 0, 1, 1)], total: 1, current: 0, current_global: 0 });
    openFind('local', 'w1:p1', 'Foo');
    await flush();
    toggleFindOption('matchCase');
    await flush();
    expect(useFind.getState().options.matchCase).toBe(true);
    expect(set).toHaveBeenLastCalledWith('find.options', JSON.stringify({ matchCase: true, wholeWord: false, regex: false }));
    expect(searches.at(-1)!.body).toMatchObject({ query: 'Foo', match_case: true, backward: true });
    expect(searches.at(-1)!.body.previous).toBeUndefined();
    // Closing keeps them.
    closeFind();
    expect(useFind.getState().options.matchCase).toBe(true);
    set.mockRestore();
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
    expect(findCount({ query: 'x', total: 250000, index: 249999, status: 'idle' })).toBe('250000 of 250000');
    expect(findCount({ query: 'x', total: 0, status: 'busy' })).toMatch(/keeps changing/);
    expect(findCount({ query: '(', total: 0, status: 'invalid' })).toBe('Invalid regular expression');
  });

  const render = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(FindBar, { m: 'local', top: 4, right: 600, maxWidth: 500 })));
    return host;
  };

  it('steps with Enter and Shift+Enter, and closes with Escape', async () => {
    const found = [match(8, 0, 8, 5), match(80, 0, 80, 5)];
    serve({ matches: found, total: 2, current: 1, current_global: 1 });
    openFind('local', 'w1:p1', 'line');
    await flush();
    await flush();
    const host = render();
    const input = host.querySelector<HTMLInputElement>('.find-input')!;
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('.find-count')?.textContent).toBe('2 of 2');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(flush);
    expect(useFind.getState().current).toEqual(found[0]);
    expect(host.querySelector('.find-count')?.textContent).toBe('1 of 2');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    await act(flush);
    expect(useFind.getState().current).toEqual(found[1]);

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useFind.getState().open).toBe(false);
  });

  it('toggles options with their buttons and keys, keeping the focus in the query', async () => {
    serve({ matches: [], total: 0 });
    openFind('local', 'w1:p1', 'x');
    await flush();
    const host = render();
    const input = host.querySelector<HTMLInputElement>('.find-input')!;
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.find-option')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
    act(() => buttons[2].click());
    expect(useFind.getState().options.regex).toBe(true);
    expect(host.querySelectorAll('.find-option.on')).toHaveLength(1);
    const ev = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(useFind.getState().options.wholeWord).toBe(true);
    await flush();
    expect(searches.at(-1)!.body).toMatchObject({ regex: true, whole_word: true });
    expect(document.activeElement).toBe(input);
  });
});
