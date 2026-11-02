// @vitest-environment jsdom
//
// Selecting with the pointer paints only the rows whose highlight changed,
// rows herdr moved are copied on the canvas instead of painted again, and a
// drag held past a pane's edge scrolls at a speed set by time, not by how
// fast herdr answers pane.scroll.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: string;
  params: Record<string, unknown>;
  resolve(v: unknown): void;
}
const calls: Call[] = [];

vi.mock('../lib/conn', () => ({
  conn: {
    sendNow: () => {},
    send: () => {},
    api: (_m: string, method: string, params: Record<string, unknown>) => new Promise((resolve) => calls.push({ method, params, resolve })),
    setSurfaceHandler: () => {},
    setTheme: () => {},
  },
}));

// Cell size with the fake font below: 13px at ratio 1 → 8 × 14 pixels.
const CW = 8;
const CH = 14;
const W = 20;
const H = 10;

/** Rows painted (each starts with a fill of the whole row) and copies. */
let rows: number[] = [];
let copies: number[][] = [];
let frames: FrameRequestCallback[] = [];

function flush() {
  const fs = frames;
  frames = [];
  for (const f of fs) f(0);
}

let ctl: import('../surface/controller').SurfaceController;
let session: typeof import('../surface/session');
let host: HTMLDivElement;

const pane = (offset: number) => ({
  id: 'p1',
  rect: { x: 0, y: 0, w: W, h: H },
  inner: { x: 0, y: 0, w: W, h: H },
  scroll: { offset_from_bottom: offset, max_offset_from_bottom: 1000, viewport_rows: H },
  focused: true,
  mouse: false,
  alt: false,
});

function setMeta(offset: number) {
  session.useSurface.setState({ meta: { m: 'm1', gen: 1, w: W, h: H, panes: [pane(offset)], splits: [], links: [] } });
}

const mouse = (type: string, row: number, col = 3) =>
  new MouseEvent(type, { clientX: col * CW + 1, clientY: row * CH + 1, button: 0, buttons: 1, detail: 1, bubbles: true });

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = (f) => frames.push(f);
  window.cancelAnimationFrame = () => {};
  HTMLCanvasElement.prototype.getContext = (() => {
    const ctx = {
      font: '',
      fillStyle: '',
      measureText() {
        const px = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10);
        return { width: px * 0.6, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 };
      },
      fillRect(x: number, y: number, w: number) {
        if (x === 0 && w === W * CW) rows.push(y / CH);
      },
      drawImage(_c: unknown, ...a: number[]) {
        copies.push(a.map((v, i) => v / (i % 2 ? CH : CW)));
      },
      fillText() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
    };
    return ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  session = await import('../surface/session');
  const { SurfaceController } = await import('../surface/controller');
  const { appearanceOf } = await import('../appearance');
  const { getPrefs } = await import('../prefs');
  host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: W * CW });
  Object.defineProperty(host, 'clientHeight', { value: H * CH });
  const canvas = document.createElement('canvas');
  const textarea = document.createElement('textarea');
  host.append(canvas, textarea);
  document.body.appendChild(host);
  ctl = new SurfaceController(
    host,
    canvas,
    textarea,
    {
      m: () => 'm1',
      focusedPane: () => 'p1',
      focusPane: () => {},
      appKey: () => false,
      readOnly: () => false,
      linkContext: () => ({ m: 'm1' }),
      onSize: () => {},
      setTitle: () => {},
    },
    { ...appearanceOf(getPrefs()), fontSize: 13, fontWeight: 400 },
  );
  session.useSurface.setState({ ownership: 'owner' });
  const cells = (ch: string) => Array.from({ length: W }, () => ({ symbol: ch, fg: 0, bg: 0, mod: 0, skip: false, link: -1 }));
  session.grid.apply({
    full: true,
    gen: 1,
    w: W,
    h: H,
    moves: [],
    spans: Array.from({ length: H }, (_, y) => ({ x: 0, y, cells: cells(String.fromCharCode(97 + y)) })),
  });
});

afterAll(() => ctl.dispose());

beforeEach(() => {
  setMeta(500);
  flush();
  rows = [];
  copies = [];
});

describe('selection painting', () => {
  it('paints only the rows whose highlight changed', () => {
    host.dispatchEvent(mouse('mousedown', 2));
    window.dispatchEvent(mouse('mousemove', 3));
    flush();
    expect(rows.sort()).toEqual([2, 3]);
    rows = [];
    window.dispatchEvent(mouse('mousemove', 3, 9));
    flush();
    expect(rows).toEqual([3]);
    window.dispatchEvent(mouse('mouseup', 3, 9));
    rows = [];
    ctl.clearSelection();
    flush();
    expect(rows.sort()).toEqual([2, 3]);
  });

  it('copies rows herdr moved and paints the uncovered one', () => {
    session.grid.apply({ full: false, gen: 1, w: 0, h: 0, moves: [{ rect: { x: 0, y: 0, w: W, h: H }, shift: 1 }], spans: [] });
    // The metadata of the scrolled surface schedules the paint.
    setMeta(501);
    flush();
    // Rows 1-9 copied to 0-8 (x, y, w, h from and to, in cells).
    expect(copies).toEqual([[0, 1, W, H - 1, 0, 0, W, H - 1]]);
    expect(rows).toEqual([H - 1]);
  });
});

describe('selection drag past an edge', () => {
  it('scrolls by time, not by how fast herdr answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    calls.length = 0;
    host.dispatchEvent(mouse('mousedown', 5));
    // Two rows below the pane's bottom edge.
    window.dispatchEvent(mouse('mousemove', H + 2));
    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'pane.scroll', params: { pane_id: 'p1' } });
    const first = 500 - (calls[0].params.offset_from_bottom as number);
    expect(first).toBeGreaterThanOrEqual(1);
    // herdr takes 400 ms to answer: no second request meanwhile.
    vi.advanceTimersByTime(400);
    expect(calls).toHaveLength(1);
    calls[0].resolve({ pane: { scroll: { offset_from_bottom: 500 - first, max_offset_from_bottom: 1000, viewport_rows: H } } });
    await vi.advanceTimersByTimeAsync(0);
    // The next one goes at once, with the lines owed since (about 60 per
    // second two rows past the edge), from the position herdr answered.
    expect(calls).toHaveLength(2);
    const second = 500 - first - (calls[1].params.offset_from_bottom as number);
    expect(second).toBeGreaterThanOrEqual(20);
    expect(second).toBeLessThanOrEqual(40);
    // The scrolled surface arrives: the selection reaches the new last row.
    setMeta(500 - first);
    expect(ctl.selectionText()).toBeDefined();
    window.dispatchEvent(mouse('mouseup', H + 2));
    calls[1].resolve({});
    await vi.advanceTimersByTimeAsync(200);
    // Released: the text is read, and scrolling stopped.
    expect(calls.map((c) => c.method)).toEqual(['pane.scroll', 'pane.scroll', 'pane.selection.read']);
    vi.useRealTimers();
  });
});
