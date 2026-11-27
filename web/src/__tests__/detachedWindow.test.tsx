// @vitest-environment jsdom
//
// Detached standalone tab windows: URL parsing, tab-bar hiding and Bring All
// Back state, tab context menu entry, and tear-off drag outside window bounds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { detachedRecordForTab, detachedTabUrl, openDetachedTab, parseDetachedTab, useDetachedTabs } from '../detachedWindow';
import { isOutsideWindow } from '../tabDrag';
import { tabMenu } from '../menus';
import { isItem } from '../contextMenu';
import { Workspace } from '../components/Workspace';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { t } from '../i18n';
import type * as L from '../term/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ terminal }: { terminal: string }) => createElement('div', { className: 'mock-term' }, terminal),
}));

function twoTabLayout(): L.Layout {
  return {
    version: 2,
    selected: 0,
    workspaces: [
      {
        id: 'ws1',
        name: 'demo',
        cwd: '/tmp',
        selected: 0,
        tabs: [
          { root: { terminal: 't1' }, focused: 't1' },
          { root: { terminal: 't2' }, focused: 't2' },
        ],
      },
    ],
  };
}

describe('detached tab windows', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const layout = twoTabLayout();
    vi.spyOn(terms, 'layout').mockImplementation((m) => (m === 'local' ? layout : undefined));
    vi.spyOn(terms, 'mutate').mockImplementation(() => true);
    useDetachedTabs.setState({ records: {} });
    useStore.setState({
      readOnly: false,
      machineId: 'local',
      order: ['local'],
      machines: {
        local: { id: 'local', label: 'Local', kind: 'local', status: 'ready', platform: 'darwin/arm64', enabled: true, updated_at: 0 },
      },
      toasts: [],
    });
    useTerms.setState({
      machines: {
        local: {
          backend: { phase: 'ready', code: '', version: '' },
          layout,
          terminals: {
            t1: { address: 't1', title: 'zsh', cwd: '/tmp', exited: false, labels: {} },
            t2: { address: 't2', title: 'vim', cwd: '/tmp', exited: false, labels: {} },
          },
        },
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useDetachedTabs.setState({ records: {} });
    vi.restoreAllMocks();
  });

  it('round-trips detached tab URLs and rejects invalid paths', () => {
    const url = detachedTabUrl('local', 'view:ed-1');
    const parsed = new URL(url, 'https://example.test');
    expect(parseDetachedTab(parsed.pathname, parsed.search)).toEqual({ m: 'local', pane: 'view:ed-1' });
    expect(parseDetachedTab('/', '?m=local&pane=t1')).toBeUndefined();
    expect(parseDetachedTab('/window/tab', '?m=local')).toBeUndefined();
  });

  it('detects when a drag point leaves the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    expect(isOutsideWindow(600, 400)).toBe(false);
    expect(isOutsideWindow(-1, 400)).toBe(true);
    expect(isOutsideWindow(1201, 400)).toBe(true);
    expect(isOutsideWindow(600, -5)).toBe(true);
    expect(isOutsideWindow(600, 805)).toBe(true);
  });

  it('offers Move to New Window in the tab context menu', () => {
    const entries = tabMenu('local', 'ws1', 0).filter(isItem);
    expect(entries.some((e) => e.label === t('menu.openInNewWindow'))).toBe(true);
  });

  it('opens a popup window in browsers and warns if blocked', async () => {
    const fakeWin = { focus: vi.fn() } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin);
    expect(await openDetachedTab('local', 'ws1', 0, { screenX: 800, screenY: 300 })).toBe(true);
    expect(openSpy).toHaveBeenCalledWith(
      detachedTabUrl('local', 't1'),
      expect.stringContaining('-tab-local-t1'),
      expect.stringContaining('popup'),
    );
    expect(fakeWin.focus).toHaveBeenCalled();

    openSpy.mockReturnValue(null);
    expect(await openDetachedTab('local', 'ws1', 1)).toBe(false);
    expect(useStore.getState().toasts.at(-1)?.msg).toBe(t('window.popupBlocked'));
  });

  it('hides detached tabs from the main tab bar and shows Bring All Back when all are detached', () => {
    const layout = twoTabLayout();
    expect(detachedRecordForTab('local', layout.workspaces[0].tabs[0])).toBeUndefined();

    useDetachedTabs.setState({
      records: { w1: { winId: 'w1', m: 'local', panes: ['t1'] } },
    });
    expect(detachedRecordForTab('local', layout.workspaces[0].tabs[0])?.winId).toBe('w1');

    act(() => root.render(createElement(Workspace)));
    const tabs = host.querySelectorAll('.tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].getAttribute('data-tab')).toBe('1');

    act(() => {
      useDetachedTabs.setState({
        records: {
          w1: { winId: 'w1', m: 'local', panes: ['t1'] },
          w2: { winId: 'w2', m: 'local', panes: ['t2'] },
        },
      });
    });
    expect(host.querySelectorAll('.tab')).toHaveLength(0);
    expect(host.textContent).toContain(t('window.detachedCount', { n: 2 }));
    expect(host.textContent).toContain(t('window.bringAllBack'));
  });
});
