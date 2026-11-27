// @vitest-environment jsdom
//
// Detached standalone tab windows: URL parsing, BroadcastChannel sync,
// unsaved-changes protection across detach/dock/close, detached command and
// Palette scoping, initialPane dedup, tab-bar keyboard/drag/switchTab/focusPane
// indexing, keptPanes/CodeLayer/BrowserLayer exclusion, secondary-window
// notify/seen guards, and WorkspaceDialog late-loading vault presets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const shellRef = vi.hoisted(() => ({ current: undefined as unknown }));
const connHandlers = vi.hoisted(() => ({ current: undefined as Record<string, (...args: unknown[]) => unknown> | undefined }));

vi.mock('../shell', () => ({
  get desktopShell() {
    return shellRef.current;
  },
}));
vi.mock('../lib/conn', () => ({
  conn: {
    start: vi.fn((handlers: Record<string, (...args: unknown[]) => unknown>) => {
      connHandlers.current = handlers;
    }),
    setTheme: vi.fn(),
  },
}));
vi.mock('../bootstrap', () => ({
  startBootstrap: () => ({}),
  retryFailedBootstrap: vi.fn(async () => {}),
  loadConfig: vi.fn(async () => {}),
}));
vi.mock('../lib/files', () => ({
  listDir: vi.fn(async (_m: string, path: string) => ({
    dir: { path: path === '~' ? '/home/u' : path, is_dir: true },
    entries: [],
  })),
  formatSize: () => '0 B',
}));
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ terminal }: { terminal: string }) => createElement('div', { className: 'mock-term' }, terminal),
}));

import {
  confirmDetachedTabs,
  DETACHED_ALLOWED_COMMANDS,
  detachedRecordForTab,
  detachedTabUrl,
  dockCurrentTab,
  initDetachedWindowSync,
  initMainWindowSync,
  openDetachedTab,
  parseDetachedTab,
  thisWindowId,
  useDetachedTabs,
} from '../detachedWindow';
import { isOutsideWindow, otherTab, visibleSlotToLayoutSlot } from '../tabDrag';
import { startPaneDrag } from '../paneDrag';
import { tabMenu } from '../menus';
import { isItem } from '../contextMenu';
import { Workspace } from '../components/Workspace';
import { DetachedTabApp } from '../components/DetachedTabApp';
import { Palette } from '../components/Palette';
import { CodeLayer } from '../components/CodeLayer';
import { BrowserLayer } from '../plugins/browser/BrowserLayer';
import { Dialogs } from '../components/Dialogs';
import { actions, current, focusPaneInLayout } from '../actions';
import { commandEnabled } from '../keymap';
import { useKeys } from '../keybindings';
import { useSettings } from '../settings';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { setUnsaved } from '../state/panes';
import { keepEdit, keptEdit } from '../unsaved';
import { resetKeptPanes } from '../keptPanes';
import { useFrames as useCodeFrames } from '../codeFrames';
import { useFrames as useBrowserFrames } from '../plugins/browser/frames';
import { editWorkspaceDialog, useDialog } from '../dialog';
import { resetWorkspacePresets, syncVaultWorkspacePresets } from '../state/workspacePresets';
import { updateBadge } from '../notify';
import { noteViewSeen } from '../seen';
import { t } from '../i18n';
import { APP_NAME } from '../brand';
import type * as L from '../term/layout';
import '../commands';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Minimal synchronous-ish in-memory BroadcastChannel for cross-window tests. */
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  readonly name: string;
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;

  constructor(name: string) {
    this.name = name;
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.channels.set(name, set);
    }
    set.add(this);
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    if (type === 'message' && typeof fn === 'function') this.listeners.add(fn as (ev: MessageEvent) => void);
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
    if (type === 'message' && typeof fn === 'function') this.listeners.delete(fn as (ev: MessageEvent) => void);
  }

  postMessage(data: unknown) {
    if (this.closed) return;
    const peers = [...(FakeBroadcastChannel.channels.get(this.name) ?? [])];
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      const ev = new MessageEvent('message', { data });
      for (const fn of [...peer.listeners]) fn(ev);
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

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

function threeTabLayout(): L.Layout {
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
          { root: { terminal: 't3' }, focused: 't3' },
        ],
      },
    ],
  };
}

function setLiveLayout(initial: L.Layout) {
  let layout = initial;
  vi.spyOn(terms, 'layout').mockImplementation((m) => (m === 'local' ? layout : undefined));
  vi.spyOn(terms, 'mutate').mockImplementation((m, fn) => {
    if (m !== 'local') return false;
    const next = fn(layout);
    if (next === layout) return false;
    layout = next;
    useTerms.setState((s) => ({
      machines: { ...s.machines, local: { ...s.machines.local, layout } },
    }));
    return true;
  });
  vi.spyOn(terms, 'start').mockImplementation(() => {});
  vi.spyOn(terms, 'subscribe').mockImplementation(() => {});
  vi.spyOn(terms, 'call').mockImplementation(async () => ({}));
  useTerms.setState({
    machines: {
      local: {
        backend: { phase: 'ready', code: '', version: '' },
        layout,
        terminals: {
          t1: { address: 't1', title: 'zsh', cwd: '/tmp', exited: false, labels: {} },
          t2: { address: 't2', title: 'vim', cwd: '/tmp', exited: false, labels: {} },
          t3: { address: 't3', title: 'node', cwd: '/tmp', exited: false, labels: {} },
        },
      },
    },
  });
  return () => layout;
}

describe('detached tab windows', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    shellRef.current = undefined;
    connHandlers.current = undefined;
    window.history.replaceState({}, '', '/');
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    FakeBroadcastChannel.channels.clear();
    setLiveLayout(twoTabLayout());
    resetKeptPanes();
    resetWorkspacePresets();
    useSettings.setState({
      client: 'desktop',
      values: { 'plugins.vscode.enabled': { value: true, source: 'global' } },
    });
    useDetachedTabs.setState({ records: {} });
    useDialog.setState({ current: undefined });
    useCodeFrames.setState({ frames: {}, shown: {}, stopped: {}, windows: {} });
    useBrowserFrames.setState({ frames: {}, shown: {}, pages: {}, nav: {}, retries: {} });
    useStore.setState({
      readOnly: false,
      machineId: 'local',
      workspaceId: 'ws1',
      order: ['local'],
      machines: {
        local: {
          id: 'local',
          label: 'Local',
          kind: 'local',
          status: 'ready',
          platform: 'darwin/arm64',
          enabled: true,
          updated_at: 0,
          info: { home: '/home/u', hostname: 'mac', version: '1', os: 'darwin', arch: 'arm64', user: 'u' },
        },
      },
      toasts: [],
      palette: undefined,
      renaming: undefined,
      zoomed: undefined,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setUnsaved('local', 't1', undefined);
    setUnsaved('local', 't2', undefined);
    setUnsaved('local', 'view:ed1', undefined);
    useDetachedTabs.setState({ records: {} });
    useDialog.setState({ current: undefined });
    shellRef.current = undefined;
    window.history.replaceState({}, '', '/');
    vi.unstubAllGlobals();
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
      records: { w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] } },
    });
    expect(detachedRecordForTab('local', layout.workspaces[0].tabs[0])?.winId).toBe('w1');

    act(() => root.render(createElement(Workspace)));
    const tabs = host.querySelectorAll('.tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].getAttribute('data-tab')).toBe('1');

    act(() => {
      useDetachedTabs.setState({
        records: {
          w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] },
          w2: { winId: 'w2', m: 'local', initialPane: 't2', panes: ['t2'] },
        },
      });
    });
    expect(host.querySelectorAll('.tab')).toHaveLength(0);
    expect(host.textContent).toContain(t('window.detachedCount', { n: 2 }));
    expect(host.textContent).toContain(t('window.bringAllBack'));
  });

  it('confirms unsaved edits before detaching and disposes kept edits once detached (P0-2)', async () => {
    const save = vi.fn(async () => true);
    const dispose = vi.fn();
    setUnsaved('local', 't1', { name: 'notes.md', save });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ focus: vi.fn() } as unknown as Window);

    // Cancel aborts detach without opening a window.
    const pendingCancel = openDetachedTab('local', 'ws1', 0);
    await flush();
    const req1 = useDialog.getState().current;
    expect(req1?.kind).toBe('confirm');
    if (req1?.kind === 'confirm') {
      useDialog.setState({ current: undefined });
      req1.resolve(false, undefined, false);
    }
    expect(await pendingCancel).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();

    // Save saves first and then opens the detached window.
    const pendingSave = openDetachedTab('local', 'ws1', 0);
    await flush();
    const req2 = useDialog.getState().current;
    if (req2?.kind === 'confirm') {
      useDialog.setState({ current: undefined });
      req2.resolve(true, undefined, false);
    }
    expect(await pendingSave).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Once Workspace observes the pane as detached, any lingering keptEdit is disposed.
    keepEdit('local', 't1', { name: 'notes.md', save, dispose });
    expect(keptEdit('local', 't1')).toBeDefined();
    act(() => root.render(createElement(Workspace)));
    act(() => {
      useDetachedTabs.setState({ records: { w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] } } });
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(keptEdit('local', 't1')).toBeUndefined();
  });

  it('excludes detached tabs from closeTabsBeside and coordinates unsaved close confirmation via BroadcastChannel (P0-2)', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const getLayout = setLiveLayout(threeTabLayout());
    // Tab 1 (t2) is detached; tab 0 and tab 2 are visible in main.
    useDetachedTabs.setState({
      records: { 'det-1': { winId: 'det-1', m: 'local', initialPane: 't2', panes: ['t2'] } },
    });

    // closeTabsBeside('others') from tab 0 closes tab 2 only and leaves detached tab 1 intact.
    await actions.closeTabsBeside('local', 'ws1', 0, 'others');
    expect(getLayout().workspaces[0].tabs.map((tb) => tb.focused)).toEqual(['t1', 't2']);
    // Now only tab 0 (visible) and tab 1 (detached) remain: closeOthers and closeRight are disabled.
    expect(commandEnabled('tab.closeOthers')).toBe(false);
    expect(commandEnabled('tab.closeRight')).toBe(false);

    // Simulate a detached window answering confirmClose with Cancel -> closeWorkspaces aborts.
    const peer = new FakeBroadcastChannel(`${(await import('../brand')).APP_SLUG}:windows`);
    peer.addEventListener('message', (ev) => {
      const msg = (ev as MessageEvent).data as { type?: string; reqId?: string; winId?: string };
      if (msg.type === 'confirmClose' && msg.winId === 'det-1') {
        peer.postMessage({ type: 'confirmCloseAck', reqId: msg.reqId, winId: 'det-1' });
        peer.postMessage({ type: 'confirmCloseReply', reqId: msg.reqId, winId: 'det-1', ok: false });
      }
    });
    await actions.closeWorkspaces('local', ['ws1']);
    expect(getLayout().workspaces).toHaveLength(1);
    peer.close();

    // When detached window replies ok: true, confirmDetachedTabs resolves true and workspace closes.
    const peerOk = new FakeBroadcastChannel(`${(await import('../brand')).APP_SLUG}:windows`);
    peerOk.addEventListener('message', (ev) => {
      const msg = (ev as MessageEvent).data as { type?: string; reqId?: string; winId?: string };
      if (msg.type === 'confirmClose' && msg.winId === 'det-1') {
        peerOk.postMessage({ type: 'confirmCloseAck', reqId: msg.reqId, winId: 'det-1' });
        peerOk.postMessage({ type: 'confirmCloseReply', reqId: msg.reqId, winId: 'det-1', ok: true });
      }
    });
    expect(await confirmDetachedTabs('local', ['t2'])).toBe(true);
    await actions.closeWorkspaces('local', ['ws1']);
    expect(getLayout().workspaces).toHaveLength(0);
    peerOk.close();
  });

  it('uses stable initialPane to focus existing detached window after split/focus change (P1-15)', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const openTab = vi.fn(async () => true);
    shellRef.current = { windows: { openTab, focusMain: vi.fn(), isOverMain: vi.fn(async () => false) } };

    // Split tab 0 so it holds [t1, t3] with t3 focused, while the detached window was opened with initialPane 't1'.
    const splitLayout: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [
        {
          id: 'ws1',
          name: 'demo',
          cwd: '/tmp',
          selected: 1,
          tabs: [
            { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1' }, { terminal: 't3' }] }, focused: 't3' },
            { root: { terminal: 't2' }, focused: 't2' },
          ],
        },
      ],
    };
    setLiveLayout(splitLayout);

    const onDock = vi.fn();
    const stopMain = initMainWindowSync({ onDock });
    const detSync = initDetachedWindowSync({
      m: 'local',
      initialPane: 't1',
      getPanes: () => ['t1', 't3'],
      getWorkspace: () => 'ws1',
      onDockAll: vi.fn(),
    });
    // Detached record captured initialPane: 't1' alongside both split panes.
    expect(useDetachedTabs.getState().records[thisWindowId]).toEqual({
      winId: thisWindowId,
      m: 'local',
      initialPane: 't1',
      panes: ['t1', 't3'],
    });

    // Re-detaching or focusing the newly split pane 't3' targets initialPane 't1' (no duplicate window).
    await openDetachedTab('local', 'ws1', 0, { title: 'split' });
    expect(openTab).toHaveBeenLastCalledWith({ m: 'local', pane: 't1', title: 'split' });

    openTab.mockClear();
    actions.focusPane('local', 't3');
    expect(openTab).toHaveBeenLastCalledWith({ m: 'local', pane: 't1', title: undefined });

    detSync.dispose();
    stopMain();
  });

  it('scopes DetachedTabApp commands, Palette, focus, dock unsaved check and bridge callbacks (P0-2, P0-3, P2-2)', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const focusMain = vi.fn();
    const openTab = vi.fn(async () => true);
    let menuListener: ((cmd: string) => void) | undefined;
    shellRef.current = {
      detached: true,
      onCommand: (fn: (cmd: string) => void) => {
        menuListener = fn;
        return () => {};
      },
      pathForFile: () => '',
      setUnsaved: vi.fn(),
      onCloseRequest: () => () => {},
      answerClose: vi.fn(),
      windows: { openTab, focusMain, isOverMain: vi.fn(async () => false) },
      browser: { onOpen: () => () => {} },
    };

    // Main layout selects workspace 2 (ws2), while detached window owns tab 0 of ws1 (pane t1 split with t3).
    const multiWsLayout: L.Layout = {
      version: 2,
      selected: 1,
      workspaces: [
        {
          id: 'ws1',
          name: 'one',
          cwd: '/tmp/one',
          selected: 1,
          tabs: [
            { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1' }, { terminal: 't3' }] }, focused: 't1' },
            { root: { terminal: 't2' }, focused: 't2' },
          ],
        },
        {
          id: 'ws2',
          name: 'two',
          cwd: '/tmp/two',
          selected: 0,
          tabs: [{ root: { terminal: 't2' }, focused: 't2' }],
        },
      ],
    };
    const getLayout = setLiveLayout(multiWsLayout);
    useKeys.setState({
      commands: [
        { id: 'pane.splitRight', section: 'pane', when: 'terminal' },
        { id: 'pane.close', section: 'pane', when: 'terminal' },
        { id: 'tab.close', section: 'tab', when: 'terminal' },
        { id: 'tab.new', section: 'tab', when: 'terminal' },
        { id: 'workspace.close', section: 'workspace', when: 'terminal' },
        { id: 'app.settings', section: 'app', when: 'always' },
      ],
      effective: [
        { key: 'cmd+d', command: 'pane.splitRight', when: 'terminal' },
        { key: 'cmd+t', command: 'tab.new', when: 'terminal' },
        { key: 'cmd+,', command: 'app.settings', when: 'always' },
      ],
    });
    window.history.replaceState({}, '', '/window/tab?m=local&pane=t1');

    await act(async () => root.render(createElement(DetachedTabApp, { m: 'local', pane: 't1' })));

    // 1. current() and focusedContext() resolve to detached window's ws1 tab 0, NOT ws2.
    expect(current()?.ws?.id).toBe('ws1');
    expect(current()?.tabIndex).toBe(0);
    expect(actions.focusedContext()?.pane).toBe('t1');

    // 2. Main-only commands are disabled and pruned from effective keybindings.
    expect(useKeys.getState().effective.every((b) => DETACHED_ALLOWED_COMMANDS.has(b.command))).toBe(true);
    expect(commandEnabled('tab.new')).toBe(false);
    expect(commandEnabled('workspace.close')).toBe(false);
    expect(commandEnabled('app.settings')).toBe(false);
    expect(commandEnabled('pane.splitRight')).toBe(true);
    expect(commandEnabled('tab.close')).toBe(true);

    // Main-only menu commands delivered via desktopShell.onCommand are ignored.
    const newTabSpy = vi.spyOn(actions, 'newTab');
    menuListener?.('tab.new');
    menuListener?.('app.settings');
    expect(newTabSpy).not.toHaveBeenCalled();
    expect(useStore.getState().settings).toBeUndefined();

    // 3. Focusing a split pane in detached window updates tab.focused without jumping layout.selected or ws.selected.
    const focused = focusPaneInLayout(getLayout(), 't3');
    expect(focused.selected).toBe(1);
    expect(focused.workspaces[0].selected).toBe(1);
    expect(focused.workspaces[0].tabs[0].focused).toBe('t3');

    // 4. Bridge callbacks onBridgeClose / onBridgeLeave are wired (not empty no-ops).
    expect(typeof connHandlers.current?.onBridgeClose).toBe('function');
    expect(connHandlers.current?.onBridgeClose?.toString()).toContain('closeWindowPane');
    expect(connHandlers.current?.onBridgeLeave?.toString()).toContain('leaveWindowPane');

    // 5. Palette in detached mode shows Return to Main + detached-safe commands only (no workspaces/settings/tab.new).
    await act(async () => {
      useStore.getState().setPalette('commands');
      root.render(createElement(Palette));
    });
    const paletteText = host.textContent ?? '';
    expect(paletteText).toContain(t('window.returnToMain'));
    expect(paletteText).not.toContain(t('command.tab.new'));
    expect(paletteText).not.toContain(t('command.app.settings'));
    expect(paletteText).not.toContain('two');

    // Re-mount DetachedTabApp to test unsaved guard on dock().
    await act(async () => {
      useStore.getState().setPalette(undefined);
      root.render(createElement(DetachedTabApp, { m: 'local', pane: 't1' }));
    });
    await act(async () => {
      setUnsaved('local', 't1', { name: 'draft.txt', save: vi.fn(async () => true) });
      dockCurrentTab();
    });
    await flush();
    // Unsaved quitDialog opens and focuses this detached window.
    expect(openTab).toHaveBeenCalledWith({ m: 'local', pane: 't1' });
    const dlg = useDialog.getState().current;
    expect(dlg?.kind).toBe('unsaved');
    // Cancelling aborts dock.
    await act(async () => {
      if (dlg?.kind === 'unsaved') {
        useDialog.setState({ current: undefined });
        dlg.resolve('cancel');
      }
    });
    await flush();
    expect(focusMain).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();

    // Discarding allows dock to focusMain and close.
    await act(async () => {
      dockCurrentTab();
    });
    await flush();
    const dlg2 = useDialog.getState().current;
    await act(async () => {
      if (dlg2?.kind === 'unsaved') {
        useDialog.setState({ current: undefined });
        dlg2.resolve('discard');
      }
    });
    await flush();
    expect(focusMain).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('fixes main-window current(), onTabsKey, tabDrag slot mapping, and switchTab when tabs are detached (P0-3, P1-16)', () => {
    const getLayout = setLiveLayout(threeTabLayout());
    // Detach tab 0 (t1); ws.selected is 0 in layout, tabs 1 (t2) and 2 (t3) remain visible.
    useDetachedTabs.setState({
      records: { w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] } },
    });

    // Main current() skips detached tab 0 and falls back to visible tab 1.
    expect(current()?.tabIndex).toBe(1);
    expect(current()?.focused).toBe('t2');

    // switchTab steps only across visible tabs [1, 2].
    actions.switchTab(1);
    expect(getLayout().workspaces[0].selected).toBe(2);
    actions.switchTab(1);
    expect(getLayout().workspaces[0].selected).toBe(1);
    actions.switchTab({ index: 0 });
    expect(getLayout().workspaces[0].selected).toBe(1);
    actions.switchTab({ last: true });
    expect(getLayout().workspaces[0].selected).toBe(2);

    // Workspace onTabsKey uses row.dataset.tab (layout index 1), not DOM index 0.
    act(() => root.render(createElement(Workspace)));
    const firstVisibleTab = host.querySelector<HTMLElement>('.tab[data-tab="1"]')!;
    expect(firstVisibleTab).not.toBeNull();
    act(() => {
      firstVisibleTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(getLayout().workspaces[0].selected).toBe(1);
    act(() => {
      firstVisibleTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    });
    expect(useStore.getState().renaming).toEqual({ kind: 'tab', m: 'local', id: 'ws1:1' });

    // visibleSlotToLayoutSlot and otherTab handle gaps from detached tabs accurately.
    expect(visibleSlotToLayoutSlot(['1', '3'], 0)).toBe(1);
    expect(visibleSlotToLayoutSlot(['1', '3'], 1)).toBe(3);
    expect(visibleSlotToLayoutSlot(['1', '3'], 2)).toBe(4);
    expect(otherTab(1, 0, 3, [1, 2])).toBe(2);
    expect(otherTab(1, 1, 3, [1])).toBeUndefined();

    // When ALL workspace tabs are detached, current().tab is undefined so Cmd+W cannot mutate detached tabs.
    act(() => {
      useDetachedTabs.setState({
        records: {
          w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] },
          w2: { winId: 'w2', m: 'local', initialPane: 't2', panes: ['t2'] },
          w3: { winId: 'w3', m: 'local', initialPane: 't3', panes: ['t3'] },
        },
      });
    });
    expect(current()?.tab).toBeUndefined();
    expect(commandEnabled('pane.close')).toBe(false);
    expect(commandEnabled('tab.close')).toBe(false);
  });

  it('evicts detached panes from main-window keptPanes, CodeLayer, and BrowserLayer immediately (P1-17)', () => {
    // 1. keptPanes: switch from tab 0 to tab 1 so t1 becomes kept, then detach t1 -> immediately unmounted.
    const getLayout = setLiveLayout(twoTabLayout());
    act(() => root.render(createElement(Workspace)));
    expect(host.querySelectorAll('.pane.kept')).toHaveLength(0);
    act(() => {
      actions.selectTab('local', 'ws1', 1);
    });
    expect(getLayout().workspaces[0].selected).toBe(1);
    expect(host.querySelectorAll('.pane.kept')).toHaveLength(1);
    act(() => {
      useDetachedTabs.setState({ records: { w1: { winId: 'w1', m: 'local', initialPane: 't1', panes: ['t1'] } } });
    });
    expect(host.querySelectorAll('.pane.kept')).toHaveLength(0);

    // 2. CodeLayer drops hidden VS Code frame once its pane moves to a detached window.
    act(() => root.unmount());
    root = createRoot(host);
    const codeLayout: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [
        {
          id: 'ws1',
          name: 'demo',
          cwd: '/tmp',
          selected: 0,
          tabs: [{ root: { code: { id: 'c1', folder: '/tmp' } }, focused: 'code:c1' }],
        },
      ],
    };
    setLiveLayout(codeLayout);
    useDetachedTabs.setState({ records: {} });
    useCodeFrames.setState({ frames: { 'local|c1': { m: 'local', id: 'c1', folder: '/tmp', hidden: Date.now(), load: 0 } }, shown: {} });
    act(() => root.render(createElement(CodeLayer)));
    expect(useCodeFrames.getState().frames['local|c1']).toBeDefined();
    act(() => {
      useDetachedTabs.setState({ records: { wc: { winId: 'wc', m: 'local', initialPane: 'code:c1', panes: ['code:c1'] } } });
    });
    expect(useCodeFrames.getState().frames['local|c1']).toBeUndefined();

    // 3. BrowserLayer drops hidden browser frame once its pane moves to a detached window.
    const browserLayout: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [
        {
          id: 'ws1',
          name: 'demo',
          cwd: '/tmp',
          selected: 0,
          tabs: [{ root: { view: { id: 'b1', plugin: 'browser', kind: 'page' } }, focused: 'view:b1' }],
        },
      ],
    };
    setLiveLayout(browserLayout);
    useDetachedTabs.setState({ records: {} });
    useBrowserFrames.setState({ frames: { 'local|b1': { m: 'local', id: 'b1', hidden: Date.now(), load: 0 } }, shown: {} });
    act(() => root.render(createElement(BrowserLayer)));
    expect(useBrowserFrames.getState().frames['local|b1']).toBeDefined();
    act(() => {
      useDetachedTabs.setState({ records: { wb: { winId: 'wb', m: 'local', initialPane: 'view:b1', panes: ['view:b1'] } } });
    });
    expect(useBrowserFrames.getState().frames['local|b1']).toBeUndefined();
  });

  it('guards notify.ts updateBadge and seen.ts noteViewSeen in detached and GUI windows (P1-18)', () => {
    document.title = 'Custom Detached Title';
    window.history.replaceState({}, '', '/window/tab?m=local&pane=t1');
    updateBadge(true);
    expect(document.title).toBe('Custom Detached Title');

    document.title = 'Program Window';
    window.history.replaceState({}, '', '/m/local/gui/42');
    updateBadge(true);
    expect(document.title).toBe('Program Window');
    // noteViewSeen safely no-ops on secondary pages.
    expect(() => noteViewSeen()).not.toThrow();

    window.history.replaceState({}, '', '/');
    updateBadge(true);
    expect(document.title).toBe(APP_NAME);
  });

  it('preserves late-loading vault preset links on Edit Workspace Save and submits passphrase on Enter (P1-19 + Nit #1)', async () => {
    // Vault presets not yet loaded when Edit Workspace opens.
    resetWorkspacePresets();
    act(() => root.render(createElement(Dialogs)));

    let resultPromise!: ReturnType<typeof editWorkspaceDialog>;
    await act(async () => {
      resultPromise = editWorkspaceDialog('local', '/tmp', 'demo', 'ws1');
    });
    await flush();

    // Vault finishes lazy-loading asynchronously with an existing linked preset 'p1'.
    act(() => {
      syncVaultWorkspacePresets({
        variables: [{ name: 'API_KEY' }],
        presets: [
          { id: 'p1', name: 'Prod', variables: ['API_KEY'], groups: [] },
          { id: 'p2', name: 'Staging', variables: ['API_KEY'], groups: [] },
        ],
        workspaceLinks: [{ machine: 'local', workspace: 'ws1', presets: ['p1'] }],
        locked: false,
        session: true,
        verifyEachAllow: true,
      });
    });
    await flush();

    // Clicking Save without editing presets does NOT emit presets: [] (existing links preserved).
    const saveBtn = host.querySelector<HTMLButtonElement>('.dialog-actions button.primary')!;
    await act(async () => saveBtn.click());
    const saved = await resultPromise;
    expect(saved).toEqual({ cwd: '/tmp', label: 'demo' });
    expect(saved?.presets).toBeUndefined();

    // Opening again and explicitly adding preset 'p2' requires passphrase; pressing Enter submits it.
    let resultPromise2!: ReturnType<typeof editWorkspaceDialog>;
    await act(async () => {
      resultPromise2 = editWorkspaceDialog('local', '/tmp', 'demo', 'ws1');
    });
    await flush();
    const pickerBtn = host.querySelector<HTMLButtonElement>('.workspace-presets-field .picker-button')!;
    await act(async () => pickerBtn.click());
    const rows = document.body.querySelectorAll<HTMLElement>('.picker .picker-row');
    // Second row is 'Staging' (p2).
    await act(async () => rows[1].click());
    const passInput = host.querySelector<HTMLInputElement>('input[data-field="workspace-preset-passphrase"]')!;
    expect(passInput).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(passInput, 'secret-pass');
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      passInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    const saved2 = await resultPromise2;
    expect(saved2).toEqual({ cwd: '/tmp', label: 'demo', presets: ['p1', 'p2'], passphrase: 'secret-pass' });
  });

  it('shows Return-to-main drag ghost in desktop detached windows only when cursor is over main window (P2-3)', async () => {
    let over = false;
    const isOverMain = vi.fn(async () => over);
    shellRef.current = {
      detached: true,
      windows: { openTab: vi.fn(async () => true), focusMain: vi.fn(), isOverMain },
    };
    window.history.replaceState({}, '', '/window/tab?m=local&pane=t1');
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

    const btn = document.createElement('div');
    document.body.append(btn);
    startPaneDrag(
      { clientX: 100, clientY: 100, screenX: 100, screenY: 100, pointerId: 1, currentTarget: btn },
      { m: 'local', pane: 't1', ws: 'ws1', label: 'zsh' },
    );

    const pointerMove = (clientX: number, clientY: number, screenX: number, screenY: number) =>
      Object.assign(new MouseEvent('pointermove', { clientX, clientY, screenX, screenY }), { pointerId: 1 });

    // Move outside detached window while NOT over main -> ghost must NOT show return-to-main detach badge.
    window.dispatchEvent(pointerMove(-20, 100, 20, 100));
    await flush();
    const ghost = document.body.querySelector<HTMLElement>('.drag-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost?.classList.contains('detach')).toBe(false);
    expect(ghost?.textContent).not.toContain(t('window.returnToMain'));

    // Move over main window after throttle interval -> ghost updates to Return-to-main detach badge.
    over = true;
    await new Promise((r) => setTimeout(r, 50));
    window.dispatchEvent(pointerMove(-30, 100, 500, 300));
    await flush();
    window.dispatchEvent(pointerMove(-35, 100, 505, 300));
    expect(ghost?.classList.contains('detach')).toBe(true);
    expect(ghost?.textContent).toContain(t('window.returnToMain'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    btn.remove();
  });
});
