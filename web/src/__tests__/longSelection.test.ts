// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { LongSelection, STEP_MS, readRange, stepLines, viewTop, visiblePart } from '../terminal/longSelection';

describe('selection geometry', () => {
  it('maps herdr scroll positions to absolute rows', () => {
    expect(viewTop({ offset_from_bottom: 5, max_offset_from_bottom: 20, viewport_rows: 4 })).toBe(15);
  });
  it('paints the visible part of a selection', () => {
    // Rows 14..16 of a 10-column pane showing rows 15..18.
    expect(visiblePart({ row: 16, col: 3 }, { row: 14, col: 0 }, 10, 4, 15)).toEqual({ col: 0, row: 0, length: 13 });
    expect(visiblePart({ row: 15, col: 2 }, { row: 15, col: 5 }, 10, 4, 15)).toEqual({ col: 2, row: 0, length: 3 });
    expect(visiblePart({ row: 1, col: 0 }, { row: 3, col: 0 }, 10, 4, 15)).toBeUndefined();
  });
  it('reads the cells between two boundaries, both ends included', () => {
    expect(readRange({ row: 2, col: 4 }, { row: 0, col: 0 }, 10)).toEqual({ anchor: { row: 0, col: 0 }, cursor: { row: 2, col: 3 } });
    // The end of a row is its last cell.
    expect(readRange({ row: 0, col: 1 }, { row: 1, col: 10 }, 10)).toEqual({ anchor: { row: 0, col: 1 }, cursor: { row: 1, col: 9 } });
    expect(readRange({ row: 3, col: 4 }, { row: 3, col: 4 }, 10)).toBeUndefined();
  });
  it('scrolls faster further past the edge', () => {
    expect(stepLines(0, 20)).toBe(1);
    expect(stepLines(45, 20)).toBe(3);
    expect(stepLines(5000, 20)).toBe(15);
  });
});

describe('LongSelection', () => {
  // A 10x4 pane of 10x20 px cells at (0, 100); herdr has 20 lines of
  // scrollback above it.
  const rect = { left: 0, top: 100, right: 100, bottom: 180, width: 100, height: 80 } as DOMRect;
  let state: { offset: number; max: number; scroll: boolean };
  let calls: Array<[string, Record<string, unknown>]>;
  let term: { cols: number; rows: number; selected?: { col: number; row: number; length: number }; changed(): void } & Pick<
    Terminal,
    'select' | 'clearSelection' | 'onSelectionChange'
  >;
  let l: LongSelection;

  const scroll = () => ({ offset_from_bottom: state.offset, max_offset_from_bottom: state.max, viewport_rows: 4 });
  const api = async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (method === 'pane.scroll') state.offset = Math.min(state.max, params.offset_from_bottom as number);
    if (method === 'pane.selection.read') return { text: `read ${JSON.stringify(params.anchor)} ${JSON.stringify(params.cursor)}` };
    return { pane: { scroll: scroll() } };
  };
  const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) =>
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1, detail: 1, ...init });
  const copy = () => {
    const data: Record<string, string> = {};
    const ev = {
      clipboardData: { setData: (k: string, v: string) => (data[k] = v) },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    l.copy(ev as unknown as ClipboardEvent);
    return { text: data['text/plain'], prevented: ev.preventDefault.mock.calls.length > 0 };
  };
  const methods = () => calls.map((c) => c[0]);

  beforeEach(() => {
    vi.useFakeTimers();
    state = { offset: 0, max: 20, scroll: true };
    calls = [];
    const listeners: Array<() => void> = [];
    term = {
      cols: 10,
      rows: 4,
      select(col: number, row: number, length: number) {
        this.selected = { col, row, length };
        listeners.forEach((f) => f());
      },
      clearSelection() {
        this.selected = undefined;
        listeners.forEach((f) => f());
      },
      onSelectionChange(f: () => void) {
        listeners.push(f);
        return { dispose() {} };
      },
      changed: () => listeners.forEach((f) => f()),
    } as typeof term;
    l = new LongSelection({
      term: term as unknown as Terminal,
      pane: 'w1:p1',
      screen: () => rect,
      canScroll: () => state.scroll,
      api: api as LongSelectionApi,
    });
  });
  afterEach(() => {
    l.dispose();
    vi.useRealTimers();
  });

  type LongSelectionApi = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

  it('scrolls while the pointer is above the pane and copies the whole range', async () => {
    // Anchor between columns 5 and 6 of the third visible row (row 22).
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 130));
    expect(calls).toEqual([]);
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(0);
    expect(methods()).toEqual(['pane.get']);
    // Taken over: from the top of the view (row 20) to the anchor.
    expect(term.selected).toEqual({ col: 0, row: 0, length: 26 });
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(calls[1]).toEqual(['pane.scroll', { pane_id: 'w1:p1', offset_from_bottom: 1 }]);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    // One line up: the view starts at row 19, the anchor is on its fourth row.
    expect(term.selected).toEqual({ col: 0, row: 0, length: 36 });
    // Further away, faster.
    l.move(mouse('mousemove', 50, 40));
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(calls.at(-1)).toEqual(['pane.scroll', { pane_id: 'w1:p1', offset_from_bottom: 5 }]);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    // Rows 15..22 selected; rows 15..18 visible.
    expect(term.selected).toEqual({ col: 0, row: 0, length: 40 });

    l.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toEqual(['pane.selection.read', { pane_id: 'w1:p1', anchor: { row: 15, col: 0 }, cursor: { row: 22, col: 5 } }]);
    expect(copy()).toEqual({ text: 'read {"row":15,"col":0} {"row":22,"col":5}', prevented: true });
    // No more scrolling after the release.
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(STEP_MS * 5);
    expect(calls.length).toBe(n);
  });

  it('scrolls down past the bottom and stops at the live bottom', async () => {
    state.offset = 2;
    l.down(mouse('mousedown', 0, 101));
    l.move(mouse('mousemove', 50, 190));
    await vi.advanceTimersByTimeAsync(0);
    // To the end of the last visible row.
    expect(term.selected).toEqual({ col: 0, row: 0, length: 40 });
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    expect(state.offset).toBe(0);
    expect(calls.filter((c) => c[0] === 'pane.scroll').map((c) => c[1].offset_from_bottom)).toEqual([1, 0]);
    // Back inside: the end follows the pointer, scrolling stops. The anchor
    // (row 18) is out of view; row 20 and three cells of row 21 show.
    l.move(mouse('mousemove', 30, 125));
    expect(term.selected).toEqual({ col: 0, row: 0, length: 13 });
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(calls.length).toBe(n);
  });

  it('leaves the drag to xterm.js without scrollback in that direction', async () => {
    state.max = 0;
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(methods()).toEqual(['pane.get']);
    expect(term.selected).toBeUndefined();
    // Asked again only after the pointer came back and left again.
    l.move(mouse('mousemove', 50, 80));
    await vi.advanceTimersByTimeAsync(0);
    expect(methods()).toEqual(['pane.get']);
    l.move(mouse('mousemove', 50, 150));
    l.move(mouse('mousemove', 50, 80));
    await vi.advanceTimersByTimeAsync(0);
    expect(methods()).toEqual(['pane.get', 'pane.get']);
    l.up();
    expect(copy()).toEqual({ text: undefined, prevented: false });
  });

  it('does nothing in panes it does not control or for other selections', async () => {
    state.scroll = false;
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(calls).toEqual([]);
    l.up();

    state.scroll = true;
    for (const init of [{ detail: 2 }, { shiftKey: true }, { altKey: true }]) {
      l.down(mouse('mousedown', 55, 150, init));
      l.move(mouse('mousemove', 50, 90));
      await vi.advanceTimersByTimeAsync(STEP_MS);
      l.up();
    }
    expect(calls).toEqual([]);
  });

  it('forgets the selection when another one replaces it', async () => {
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    l.up();
    await vi.advanceTimersByTimeAsync(0);
    expect(l.active).toBe(true);
    // A right click keeps it for the browser's menu.
    l.down(mouse('mousedown', 55, 150, { button: 2 }));
    expect(copy().prevented).toBe(true);
    // A selection made by xterm.js (a click, select all) replaces it.
    term.changed();
    expect(l.active).toBe(false);
    expect(copy()).toEqual({ text: undefined, prevented: false });
  });

  it('stops scrolling when the selection is dropped during the drag', async () => {
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(methods()).toContain('pane.scroll');
    // The pane was resized: absolute positions no longer hold.
    term.cols = 12;
    l.repaint();
    expect(l.active).toBe(false);
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(STEP_MS * 5);
    l.move(mouse('mousemove', 50, 80));
    await vi.advanceTimersByTimeAsync(STEP_MS * 5);
    expect(calls.length).toBe(n);
  });

  it('moves the shown selection along when the view moved', async () => {
    l.down(mouse('mousedown', 55, 150));
    l.move(mouse('mousemove', 50, 90));
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    l.up();
    await vi.advanceTimersByTimeAsync(0);
    const before = term.selected;
    // Typing returns herdr to the live bottom: rows 20..23 are visible.
    state.offset = 0;
    l.moved();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.at(-1)?.[0]).toBe('pane.get');
    expect(before).toEqual({ col: 0, row: 0, length: 36 });
    expect(term.selected).toEqual({ col: 0, row: 0, length: 26 });
  });
});
