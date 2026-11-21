// @vitest-environment jsdom
//
// Status bar items that react to the mouse: the uploads and downloads trays
// open when the mouse rests on the button and close after it leaves, a
// click keeps one open (pins it), touch keeps to clicks; the AI usage item
// shows a card of its accounts, tightest first, on hover.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import { Upload } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import type { ListState } from '../transferList';
import { TransferTray } from '../components/TransferPanel';
import { HOVER_CLOSE_MS, HOVER_OPEN_MS } from '../components/useHoverOpen';
import { UsageStatusItem } from '../plugins/usage/StatusItem';
import { applySnapshot, setView, useUsage } from '../plugins/usage/state';
import type { UsageAccount, UsageSnapshot } from '../plugins/usage/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = { id: string };
const list = create<ListState<Item>>((set) => ({
  active: [],
  history: [{ id: 'a' }],
  panel: false,
  setPanel: (panel) => set({ panel }),
}));

function pointer(el: Element, type: 'pointerover' | 'pointerout', pointerType = 'mouse', related: Element | null = null) {
  const e = new MouseEvent(type, { bubbles: true, relatedTarget: related });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  act(() => void el.dispatchEvent(e));
}
const enter = (el: Element, pointerType = 'mouse') => pointer(el, 'pointerover', pointerType);
const leave = (el: Element, pointerType = 'mouse') => pointer(el, 'pointerout', pointerType);
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('transfer tray on hover', () => {
  const render = () =>
    act(() =>
      root.render(
        createElement(TransferTray<Item>, {
          list,
          icon: Upload,
          title: 'Uploads',
          none: 'none',
          count: () => '1',
          canCancelAll: () => false,
          cancelAll: () => {},
          clear: () => {},
          remove: () => undefined,
          row: () => createElement('span'),
        }),
      ),
    );
  const button = () => host.querySelector<HTMLButtonElement>('.gui-tray')!;
  const panel = () => host.querySelector('.transfers-panel');
  beforeEach(() => {
    list.setState({ panel: false });
    render();
  });

  it('opens after the hover delay and closes after leaving', () => {
    enter(button());
    wait(HOVER_OPEN_MS - 10);
    expect(panel()).toBeNull();
    wait(20);
    expect(panel()).not.toBeNull();
    leave(button());
    wait(HOVER_CLOSE_MS - 10);
    expect(panel()).not.toBeNull();
    wait(20);
    expect(panel()).toBeNull();
  });

  it('stays open when the pointer comes back within the grace time', () => {
    enter(button());
    wait(HOVER_OPEN_MS + 1);
    leave(button());
    wait(HOVER_CLOSE_MS - 100);
    enter(panel()!);
    wait(HOVER_CLOSE_MS * 2);
    expect(panel()).not.toBeNull();
  });

  it('is kept by a click while it is open by hover', () => {
    enter(button());
    wait(HOVER_OPEN_MS + 1);
    act(() => button().click());
    expect(panel()).not.toBeNull();
    leave(button());
    wait(HOVER_CLOSE_MS * 2);
    expect(panel()).not.toBeNull();
    // The next click closes it as before.
    act(() => button().click());
    expect(panel()).toBeNull();
  });

  it('is kept once the panel is used', () => {
    enter(button());
    wait(HOVER_OPEN_MS + 1);
    act(() => void panel()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    leave(button());
    wait(HOVER_CLOSE_MS * 2);
    expect(panel()).not.toBeNull();
  });

  it('counts a panel opened by other code as pinned', () => {
    act(() => list.getState().setPanel(true));
    enter(button());
    leave(button());
    wait(HOVER_CLOSE_MS * 2);
    expect(panel()).not.toBeNull();
  });

  it('opens pinned by a click before the hover delay', () => {
    enter(button());
    act(() => button().click());
    leave(button());
    wait(HOVER_CLOSE_MS * 2);
    expect(panel()).not.toBeNull();
  });

  it('ignores a touch pointer', () => {
    enter(button(), 'touch');
    wait(HOVER_OPEN_MS * 2);
    expect(panel()).toBeNull();
    enter(button(), 'pen');
    wait(HOVER_OPEN_MS * 2);
    expect(panel()).toBeNull();
  });
});

describe('usage status item on hover', () => {
  const now = Math.floor(Date.now() / 1000);
  const account = (key: string, pct: number): UsageAccount => ({
    key,
    provider: key.split(':')[0],
    status: 'ok',
    machines: ['local'],
    seenAt: now,
    windows: [{ kind: 'session', usedPct: pct, resetsAt: now + 3600, windowSec: 18000 }],
  });
  const item = () => host.querySelector<HTMLButtonElement>('.usage-status-item')!;
  const card = () => host.querySelector('.usage-hover');

  beforeEach(async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    useSettings.setState({ values: {}, readOnly: false });
    useUsage.setState({ snapshot: undefined, cost: undefined });
    setView({ remaining: false });
    useStore.getState().setPanel(undefined);
    await act(async () => root.render(createElement(UsageStatusItem)));
    const snap: UsageSnapshot = {
      updatedAt: now,
      refresh: 'adaptive',
      interval: 1800,
      polling: false,
      accounts: [account('codex:a', 40), account('claude:b', 85), account('grok:c', 60)],
      machines: {},
      status: {},
    };
    await act(async () => applySnapshot(snap));
  });

  it('shows the accounts, tightest first, and hides after leaving', () => {
    expect(item().hasAttribute('title')).toBe(false);
    enter(item());
    wait(HOVER_OPEN_MS + 1);
    const c = card()!;
    expect(c.getAttribute('role')).toBe('tooltip');
    expect(item().getAttribute('aria-describedby')).toBe(c.id);
    const keys = [...c.querySelectorAll<HTMLElement>('[data-account]')].map((r) => r.dataset.account);
    expect(keys).toEqual(['claude:b', 'grok:c', 'codex:a']);
    expect(c.textContent).toContain('85% used');
    leave(item());
    wait(HOVER_CLOSE_MS + 1);
    expect(card()).toBeNull();
    expect(item().hasAttribute('aria-describedby')).toBe(false);
  });

  it("adds today's spend only once the cost report is loaded", async () => {
    enter(item());
    wait(HOVER_OPEN_MS + 1);
    expect(card()!.querySelector('.usage-hover-today')).toBeNull();
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await act(async () =>
      useUsage.setState({
        cost: {
          generatedAt: now,
          days: 90,
          weekHours: 168,
          monthHours: 750,
          machines: {},
          rows: [
            {
              day,
              provider: 'claude',
              model: 'm',
              machine: 'local',
              input: 1500,
              cached: 0,
              cacheWrite: 0,
              output: 0,
              requests: 1,
              cost: 12.5,
              priced: true,
            },
          ],
        },
      }),
    );
    expect(card()!.querySelector('.usage-hover-today')!.textContent).toContain('$12.50');
  });

  it('still toggles the panel on a click', () => {
    enter(item());
    wait(HOVER_OPEN_MS + 1);
    act(() => item().click());
    expect(useStore.getState().panel).toBe('usage');
    expect(card()).toBeNull();
  });
});
