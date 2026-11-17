// @vitest-environment jsdom
//
// The frames of browser panes: which are kept, hidden and dropped, and that
// a view's element survives its pane moving (a new tab, another tab shown),
// as moving an element in the document would reload its page.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import * as L from '../term/layout';
import { FRAME_TTL, MAX_HIDDEN_FRAMES, frameKey, nextFrames, useFrames, type Frame, type ShownView } from '../plugins/browser/frames';
import { fakeBrowserApi, flush, mountPane, type Harness } from './browserHarness';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

const view = (m: string, id: string): ShownView => ({ m, id });
const shown = (...vs: ShownView[]) => Object.fromEntries(vs.map((v) => [frameKey(v.m, v.id), v]));
const alive = () => true;

describe('the frames of browser panes', () => {
  it('are one per pane on screen and stay a while off screen, in their order', () => {
    let f = nextFrames({}, shown(view('a', 'x')), alive, 1000);
    expect(f).toEqual({ 'a|x': { m: 'a', id: 'x', load: 0 } });
    f = nextFrames(f, shown(view('a', 'y')), alive, 2000);
    expect(f).toEqual({
      'a|x': { m: 'a', id: 'x', load: 0, hidden: 2000 },
      'a|y': { m: 'a', id: 'y', load: 0 },
    });
    f = nextFrames(f, shown(view('a', 'x'), view('a', 'y')), alive, 3000);
    expect(f['a|x'].hidden).toBeUndefined();
    // The order stays, or the elements would move and reload.
    expect(Object.keys(f)).toEqual(['a|x', 'a|y']);
    // Nothing changed: the same object.
    expect(nextFrames(f, shown(view('a', 'x'), view('a', 'y')), alive, 4000)).toBe(f);
  });

  it('go when hidden too long, beyond the four hidden longest, or when their view left its layout', () => {
    expect(MAX_HIDDEN_FRAMES).toBe(4);
    let f: Record<string, Frame> = {};
    // Six panes shown one after the other: five go off screen.
    for (let i = 0; i <= MAX_HIDDEN_FRAMES + 1; i++) f = nextFrames(f, shown(view('a', `${i}`)), alive, i * 1000);
    expect(Object.keys(f)).toEqual(['a|1', 'a|2', 'a|3', 'a|4', 'a|5']);
    // 2 went off screen at 3000; at FRAME_TTL + 3500 it is the one that expired.
    f = nextFrames(f, shown(view('b', 'z')), alive, FRAME_TTL + 3500);
    expect(Object.keys(f)).toEqual(['a|3', 'a|4', 'a|5', 'b|z']);
    // Closed in the layout (by any client): at once; unknown layout: kept.
    f = nextFrames(f, shown(view('b', 'z')), (fr) => (fr.id === '3' ? false : undefined), FRAME_TTL + 3600);
    expect(Object.keys(f)).toEqual(['a|4', 'a|5', 'b|z']);
    // A frame on screen stays whatever its view says.
    expect(Object.keys(nextFrames(f, shown(view('a', '4')), () => false, FRAME_TTL + 3700))).toEqual(['a|4']);
  });
});

describe('a view’s element', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.unmount();
    h = undefined;
    vi.unstubAllGlobals();
  });

  it('is not recreated when its pane moves to another tab, and goes with its view', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    const el = document.querySelector('.browser-layer iframe');
    expect(el).not.toBeNull();
    // The pane moves: out of its tab into a tab of its own, selected.
    await act(async () => h!.core.model.mutate('a', (l) => L.moveToNewTab(l, 'view:p1', 'w1')));
    await flush();
    expect(document.querySelector('.browser-layer iframe')).toBe(el);
    // Another tab is shown: the pane is off screen, its element stays.
    await act(async () => h!.core.model.mutate('a', (l) => L.selectTab(l, 'w1', 0)));
    await flush();
    expect(document.querySelector('.browser-layer iframe')).toBe(el);
    expect(Object.values(useFrames.getState().frames).map((f) => f.hidden !== undefined)).toEqual([true]);
    // Shown again.
    await act(async () => h!.core.model.mutate('a', (l) => L.selectTab(l, 'w1', 1)));
    await flush();
    expect(document.querySelector('.browser-layer iframe')).toBe(el);
    expect(Object.values(useFrames.getState().frames).map((f) => f.hidden)).toEqual([undefined]);
    // Closed: the view leaves its layout and its frame with it.
    await act(async () => h!.core.model.mutate('a', (l) => L.closePane(l, 'view:p1')));
    await flush();
    expect(document.querySelector('.browser-layer iframe')).toBeNull();
    expect(useFrames.getState().frames).toEqual({});
    expect(useFrames.getState().pages).toEqual({});
  });

  it('is placed over the slot of its pane', async () => {
    fakeBrowserApi();
    const proto = HTMLElement.prototype as unknown as { getBoundingClientRect(): DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
      return (this as HTMLElement).classList.contains('browser-slot')
        ? ({ left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220, x: 10, y: 20, toJSON: () => ({}) } as DOMRect)
        : original.call(this);
    };
    try {
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
      await flush();
      const el = document.querySelector<HTMLElement>('.browser-layer iframe')!;
      expect([el.style.display, el.style.left, el.style.top, el.style.width, el.style.height]).toEqual([
        'block',
        '10px',
        '20px',
        '300px',
        '200px',
      ]);
      // Off screen it is hidden, not moved.
      await act(async () => h!.core.model.mutate('a', (l) => L.selectTab(l, 'w1', 0)));
      await flush();
      expect(document.querySelector<HTMLElement>('.browser-layer iframe')!.style.display).toBe('none');
    } finally {
      proto.getBoundingClientRect = original;
    }
  });
});
