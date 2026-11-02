// @vitest-environment jsdom
//
// The surface's cell follows the display's pixel density: moving the window
// to a display with another device pixel ratio measures the cell again, so
// text keeps its size in CSS pixels and the grid fills the same area.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({
  conn: {
    sendNow: () => {},
    send: () => {},
    api: () => Promise.resolve({}),
    setSurfaceHandler: () => {},
    setTheme: () => {},
  },
}));

/** Media queries created so far, with their change listeners. */
const queries: Array<{ media: string; listeners: Set<() => void> }> = [];
let ratio = 2;

function setRatio(r: number) {
  ratio = r;
  // The browser reports a change to queries that no longer match.
  for (const q of queries) if (q.media !== `(resolution: ${r}dppx)`) for (const l of [...q.listeners]) l();
}

const sizes: Array<{ cols: number; rows: number; cw: number; ch: number; dpr: number }> = [];
let ctl: import('../surface/controller').SurfaceController;
const saved = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

beforeAll(async () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ratio });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia = ((media: string) => {
    const q = { media, listeners: new Set<() => void>() };
    queries.push(q);
    return {
      media,
      matches: media === `(resolution: ${ratio}dppx)`,
      addEventListener: (_: string, l: () => void) => q.listeners.add(l),
      removeEventListener: (_: string, l: () => void) => q.listeners.delete(l),
    };
  }) as unknown as typeof window.matchMedia;
  // jsdom has no canvas: a font whose advance is 0.6 of its size.
  HTMLCanvasElement.prototype.getContext = (() => {
    const ctx = {
      font: '',
      measureText() {
        const px = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10);
        return { width: px * 0.6, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 };
      },
      fillRect() {},
      fillText() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
    };
    return ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { SurfaceController } = await import('../surface/controller');
  const { appearanceOf } = await import('../appearance');
  const { getPrefs } = await import('../prefs');
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 800 });
  Object.defineProperty(host, 'clientHeight', { value: 600 });
  const canvas = document.createElement('canvas');
  const textarea = document.createElement('textarea');
  host.append(canvas, textarea);
  document.body.appendChild(host);
  ctl = new SurfaceController(
    host,
    canvas,
    textarea,
    {
      m: () => 'local',
      focusedPane: () => undefined,
      focusPane: () => {},
      appKey: () => false,
      readOnly: () => false,
      linkContext: () => ({ m: 'local' }),
      onSize: (cols, rows, cw, ch, dpr) => sizes.push({ cols, rows, cw, ch, dpr }),
      setTitle: () => {},
    },
    { ...appearanceOf(getPrefs()), fontSize: 10 },
  );
});

afterAll(() => {
  ctl.dispose();
  if (saved) Object.defineProperty(window, 'devicePixelRatio', saved);
});

describe('device pixel ratio changes', () => {
  it('measures the cell again on a display with another pixel ratio', () => {
    const before = sizes.at(-1)!;
    expect(before).toEqual({ cols: 133, rows: 57, cw: 12, ch: 21, dpr: 2 });

    // Onto a 1x external display: half the device pixels per cell, the same
    // cell width in CSS pixels (rows differ only by whole-pixel rounding).
    setRatio(1);
    const after = sizes.at(-1)!;
    expect(after).toEqual({ cols: 133, rows: 54, cw: 6, ch: 11, dpr: 1 });
    expect(after.cw / after.dpr).toBe(before.cw / before.dpr);

    // And back.
    setRatio(2);
    expect(sizes.at(-1)).toEqual(before);
  });

  it('stops watching once disposed', () => {
    const n = sizes.length;
    ctl.dispose();
    setRatio(1);
    expect(sizes.length).toBe(n);
    for (const q of queries) expect(q.listeners.size).toBe(0);
  });
});
