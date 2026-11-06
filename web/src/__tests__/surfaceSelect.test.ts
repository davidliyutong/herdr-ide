// @vitest-environment jsdom
//
// Selecting with the pointer paints only the rows whose highlight changed,
// rows herdr moved are copied on the canvas instead of painted again, and a
// drag held past a pane's edge scrolls at a speed set by time, not by how
// fast herdr answers pane.scroll. A path wrapped over two rows is one link,
// the pane's menu copies, pastes and opens paths, and files dropped on a
// pane are pasted as their paths.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: string;
  params: Record<string, unknown>;
  resolve(v: unknown): void;
}
const calls: Call[] = [];
const sent: Array<{ ev?: Array<{ t: string; text?: string }> }> = [];

vi.mock('../lib/conn', () => ({
  conn: {
    sendNow: (msg: (typeof sent)[number]) => sent.push(msg),
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

/** Rows painted (each starts with a fill of the whole row), underlined
 * cells ([x, y]) and copies. */
let rows: number[] = [];
let lines: number[][] = [];
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

const mouse = (type: string, row: number, col = 3, init: MouseEventInit = {}) =>
  new MouseEvent(type, { clientX: col * CW + 1, clientY: row * CH + 1, button: 0, buttons: 1, detail: 1, bubbles: true, ...init });

/** Writes a row of text (padded with blanks). */
function write(y: number, text: string) {
  const cells = Array.from(text.padEnd(W), (ch) => ({ symbol: ch, fg: 0, bg: 0, mod: 0, skip: false, link: -1 }));
  session.grid.apply({ full: false, gen: 1, w: 0, h: 0, moves: [], spans: [{ x: 0, y, cells }] });
}

const range = (a: number, b: number) => [...Array(b - a).keys()].map((i) => a + i);

let readOnly = false;
const dropFiles = vi.fn((_pane: string, _items: DataTransferItemList) => Promise.resolve<string | undefined>("'/tmp/my shot.png' "));
const dropTarget = vi.fn((_pane: string | undefined) => {});

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
      fillRect(x: number, y: number, w: number, h: number) {
        if (x === 0 && w === W * CW) rows.push(y / CH);
        else if (h < CH / 2) lines.push([x / CW, Math.floor(y / CH)]);
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
      readOnly: () => readOnly,
      onDropFiles: (pane, items) => dropFiles(pane, items),
      onDropTarget: (pane) => dropTarget(pane),
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

describe('links', () => {
  it('underlines a path wrapped over two rows on both while Cmd is held', () => {
    ctl.clearSelection();
    write(6, 'x /tmp/shots/abcdefg');
    write(7, 'hij/pose.png');
    setMeta(500);
    flush();
    lines = [];
    window.dispatchEvent(mouse('mousemove', 7, 3, { buttons: 0, metaKey: true }));
    flush();
    expect(lines.filter(([, y]) => y === 6).map(([x]) => x)).toEqual(range(2, W));
    expect(lines.filter(([, y]) => y === 7).map(([x]) => x)).toEqual(range(0, 12));
    window.dispatchEvent(mouse('mousemove', 7, 3, { buttons: 0 }));
    flush();
  });
});

describe('pane menu', () => {
  const clipboard = { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve('pasted')) };
  let menus: typeof import('../contextMenu');
  let actions: typeof import('../actions').actions;
  beforeAll(async () => {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    menus = await import('../contextMenu');
    actions = (await import('../actions')).actions;
  });
  const open = (row: number, col: number, init: MouseEventInit = {}) => {
    menus.useMenu.setState({ menu: undefined });
    const ev = new MouseEvent('contextmenu', {
      clientX: col * CW + 1,
      clientY: row * CH + 1,
      button: 2,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    host.dispatchEvent(ev);
    const entries = menus.useMenu.getState().menu?.entries ?? [];
    return { ev, entries, labels: entries.map((e) => (e === 'sep' ? '-' : e.label + (e.disabled ? ' (off)' : ''))) };
  };
  const item = (entries: import('../contextMenu').MenuEntry[], label: string) =>
    entries.find((e): e is import('../contextMenu').MenuItem => e !== 'sep' && e.label === label)!;

  it('opens a wrapped path under the pointer', () => {
    ctl.clearSelection();
    write(6, 'x /tmp/shots/abcdefg');
    write(7, 'hij/pose.png');
    const preview = vi.spyOn(actions, 'openPreview').mockImplementation(() => {});
    const { ev, entries, labels } = open(7, 3);
    expect(ev.defaultPrevented).toBe(true);
    expect(labels).toEqual(['Copy (off)', 'Paste', '-', 'Preview pose.png', 'Copy full path']);
    item(entries, 'Preview pose.png').run();
    expect(preview).toHaveBeenCalledWith('m1', '/tmp/shots/abcdefghij/pose.png');
    item(entries, 'Copy full path').run();
    expect(clipboard.writeText).toHaveBeenLastCalledWith('/tmp/shots/abcdefghij/pose.png');
    // On macOS Ctrl+click opens the link and is a right click as well: no menu.
    window.dispatchEvent(mouse('mousemove', 7, 3, { buttons: 0, ctrlKey: true }));
    expect(open(7, 3, { button: 0, ctrlKey: true }).entries).toEqual([]);
    window.dispatchEvent(mouse('mousemove', 7, 3, { buttons: 0 }));
    preview.mockRestore();
  });

  it('copies, pastes and opens a selected path that detection does not join', async () => {
    // The first row stops short of the last column (a program's margin).
    write(6, 'x /tmp/shots/abcde');
    write(7, 'hij/main.go');
    host.dispatchEvent(mouse('mousedown', 6, 2));
    window.dispatchEvent(mouse('mousemove', 7, 11));
    window.dispatchEvent(mouse('mouseup', 7, 11));
    const { entries, labels } = open(7, 5);
    // The selected path wins over the part of it found under the pointer.
    expect(labels).toEqual(['Copy', 'Paste', '-', 'Preview main.go', 'Open main.go in VS Code', 'Copy full path']);
    const openPath = vi.spyOn(actions, 'openPath').mockImplementation(() => {});
    item(entries, 'Open main.go in VS Code').run();
    expect(openPath).toHaveBeenCalledWith('m1', '/tmp/shots/abcdehij/main.go', undefined, undefined);
    openPath.mockRestore();
    item(entries, 'Copy').run();
    expect(clipboard.writeText).toHaveBeenLastCalledWith('/tmp/shots/abcde\nhij/main.go');
    sent.length = 0;
    item(entries, 'Paste').run();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.flatMap((m) => m.ev ?? [])).toEqual([{ t: 'paste', text: 'pasted' }]);
  });

  it('opens the menu where the program reports the mouse too', () => {
    session.useSurface.setState({ meta: { m: 'm1', gen: 1, w: W, h: H, panes: [{ ...pane(500), mouse: true }], splits: [], links: [] } });
    const plain = open(7, 3);
    expect(plain.ev.defaultPrevented).toBe(true);
    expect(plain.entries.length).toBeGreaterThan(0);
    expect(open(7, 3, { shiftKey: true }).entries.length).toBeGreaterThan(0);
  });
});

describe('dropped files', () => {
  const items = [] as unknown as DataTransferItemList;
  const drag = (type: string, types = ['Files']) => {
    const ev = new MouseEvent(type, { clientX: 5 * CW + 1, clientY: 4 * CH + 1, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { types, items, dropEffect: 'none' } });
    host.dispatchEvent(ev);
    return ev as MouseEvent & { dataTransfer: { dropEffect: string } };
  };
  beforeEach(() => {
    readOnly = false;
    dropFiles.mockClear();
    dropTarget.mockClear();
    sent.length = 0;
  });

  it('are pasted as their paths into the pane under the pointer', async () => {
    const over = drag('dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(dropTarget).toHaveBeenLastCalledWith('p1');
    const drop = drag('drop');
    expect(drop.defaultPrevented).toBe(true);
    expect(dropTarget).toHaveBeenLastCalledWith(undefined);
    // The items are handed over during the drop event.
    expect(dropFiles).toHaveBeenCalledWith('p1', items);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.flatMap((m) => m.ev ?? [])).toEqual([{ t: 'paste', text: "'/tmp/my shot.png' " }]);
  });

  it('are not taken in read-only mode, by a page not using the session, or without files', () => {
    readOnly = true;
    expect(drag('dragover').defaultPrevented).toBe(false);
    expect(drag('drop').defaultPrevented).toBe(false);
    readOnly = false;
    session.useSurface.setState({ ownership: 'busy' });
    expect(drag('dragover').defaultPrevented).toBe(false);
    session.useSurface.setState({ ownership: 'owner' });
    expect(drag('dragover', ['text/plain']).defaultPrevented).toBe(false);
    expect(dropTarget.mock.calls.every(([p]) => p === undefined)).toBe(true);
    expect(dropFiles).not.toHaveBeenCalled();
  });
});
