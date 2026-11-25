// @vitest-environment jsdom
//
// Plugins' panes with an agent status (plugins/api.ts ViewStatusDef, as a
// chat's): the registry's guards and its one subscription per plugin, the
// layout's lists of them, their dots on the sidebar's workspaces, the tabs
// and their headers as terminals' agents have, and their plugin told when
// the user looks at one that is done (seen.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// The terminals' panes are not what this is about.
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import { allPlugins, definePlugins, onViewStatus, viewPaneOf, viewStatus } from '../plugins/registry';
import type { PluginDef } from '../plugins/api';
import type { MachineState } from '../lib/machine';
import { FakeHub, settle } from './fakeTerms';
import { Sidebar } from '../components/Sidebar';
import { Workspace } from '../components/Workspace';
import { followViewsSeen, paneFocused, paneOnScreen } from '../seen';
import * as L from '../term/layout';
import { DUMMY, dummyPlugin, resetViewStatuses, seenCalls, setViewStatus, subscriptions, thing } from './viewStatusPlugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = [...allPlugins()];

/** Machine m: workspace aaaaaaaa with a tab of terminal t1 beside v1 (t1
 * focused) and a tab of v2; workspace bbbbbbbb with a working agent in t2. */
function machine(hub: FakeHub) {
  hub.machine('m', [FakeHub.term('t1'), FakeHub.term('t2', { agent: 'claude', agent_status: 'working' })], {
    version: 2,
    workspaces: [
      {
        id: 'aaaaaaaa',
        name: 'api',
        cwd: '',
        tabs: [
          { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1' }, thing('v1', 'one')] }, focused: 't1' },
          { root: thing('v2', 'two'), focused: 'view:v2' },
        ],
        selected: 0,
      },
      { id: 'bbbbbbbb', name: 'web', cwd: '', tabs: [{ root: { terminal: 't2' }, focused: 't2' }], selected: 0 },
    ],
    selected: 0,
  });
}

let hub: FakeHub;

beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
  resetViewStatuses();
  definePlugins([dummyPlugin]);
  useSettings.setState({ values: {} });
  hub = new FakeHub();
  machine(hub);
  hub.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setZoomed(undefined);
  s.setMachines([{ id: 'm', label: 'gpu', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('m');
  hub.model.subscribe('m');
  await settle();
});
afterEach(() => {
  definePlugins(saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the registry', () => {
  it("answers a pane's status while its plugin is on, nothing for what is no status or a plugin that fails", () => {
    const v1 = thing('v1').view;
    expect(viewStatus('m', v1)).toBeUndefined();
    setViewStatus('v1', 'blocked');
    expect(viewStatus('m', v1)).toBe('blocked');
    // A view of another plugin, or of none, has none.
    expect(viewStatus('m', { ...v1, plugin: 'other' })).toBeUndefined();
    useSettings.setState({ values: { [`plugins.${DUMMY}.enabled`]: { value: false, source: 'global' } } });
    expect(viewStatus('m', v1)).toBeUndefined();
    useSettings.setState({ values: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const odd: PluginDef = {
      ...dummyPlugin,
      id: 'odd',
      viewStatus: {
        status: (_m, v) => {
          if (v.id === 'boom') throw new Error('kaput');
          return 'bogus' as never;
        },
        subscribe: () => () => {},
        paneOf: () => 'not-a-view',
      },
    };
    definePlugins([dummyPlugin, odd]);
    expect(viewStatus('m', { id: 'x', plugin: 'odd', kind: 'thing' })).toBeUndefined();
    expect(viewStatus('m', { id: 'boom', plugin: 'odd', kind: 'thing' })).toBeUndefined();
    expect(viewStatus('m', { id: 'boom', plugin: 'odd', kind: 'thing' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // A notification's pane: only a view key, of the first plugin that has one.
    expect(viewPaneOf('m', { thing: 'v2' })).toBe('view:v2');
    expect(viewPaneOf('m', { other: 1 })).toBeUndefined();
  });

  it("subscribes to each plugin's statuses once, while anyone listens, and again when the plugins change", () => {
    expect(subscriptions()).toBe(0);
    const a = vi.fn();
    const b = vi.fn();
    const offA = onViewStatus(a);
    const offB = onViewStatus(b);
    expect(subscriptions()).toBe(1);
    setViewStatus('v1', 'done');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    // Turning the plugin off changes what its panes show.
    useSettings.setState({ values: { [`plugins.${DUMMY}.enabled`]: { value: false, source: 'global' } } });
    expect(a).toHaveBeenCalledTimes(2);
    // Other settings do not.
    useSettings.setState({
      values: { [`plugins.${DUMMY}.enabled`]: { value: false, source: 'global' }, x: { value: 1, source: 'global' } },
    });
    expect(a).toHaveBeenCalledTimes(2);
    useSettings.setState({ values: {} });
    definePlugins([dummyPlugin]);
    expect(subscriptions()).toBe(1);
    expect(a).toHaveBeenCalledTimes(4);
    offA();
    expect(subscriptions()).toBe(1);
    offB();
    expect(subscriptions()).toBe(0);
  });
});

describe('the layout', () => {
  it("lists a tab's, a workspace's and a layout's plugin panes in order", () => {
    const layout = hub.layout('m')!;
    const [a, b] = layout.workspaces;
    expect(L.tabViews(a.tabs[0])).toEqual([{ key: 'view:v1', view: thing('v1', 'one').view }]);
    expect(L.workspaceViews(a).map((v) => v.key)).toEqual(['view:v1', 'view:v2']);
    expect(L.workspaceViews(b)).toEqual([]);
    expect(L.layoutViews(layout).map((v) => v.key)).toEqual(['view:v1', 'view:v2']);
  });
});

describe('dots', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows a pane's status on its workspace in the sidebar, as an agent's", async () => {
    await act(async () => root.render(createElement(Sidebar)));
    const dot = (ws: string) => host.querySelector(`.ws-item[data-ws-id="${ws}"] .dot`)?.className;
    expect(dot('aaaaaaaa')).toBeUndefined();
    expect(dot('bbbbbbbb')).toBe('dot dot-working');
    await act(async () => setViewStatus('v2', 'done'));
    expect(dot('aaaaaaaa')).toBe('dot dot-done');
    await act(async () => setViewStatus('v1', 'blocked'));
    expect(dot('aaaaaaaa')).toBe('dot dot-blocked');
    await act(async () => {
      setViewStatus('v1', undefined);
      setViewStatus('v2', undefined);
    });
    expect(dot('aaaaaaaa')).toBeUndefined();
  });

  it("shows a pane's status on its tab and in its header", async () => {
    await act(async () => root.render(createElement(Workspace)));
    const tabDot = (i: number) => host.querySelectorAll('.tab')[i].querySelector('.dot')?.className;
    const headerDot = () => host.querySelector('.pane-header[data-pane="view:v1"] .dot')?.className;
    expect([tabDot(0), tabDot(1)]).toEqual([undefined, undefined]);
    expect(headerDot()).toBeUndefined();
    await act(async () => setViewStatus('v1', 'working'));
    expect(tabDot(0)).toBe('dot dot-working');
    expect(headerDot()).toBe('dot dot-working');
    await act(async () => setViewStatus('v2', 'blocked'));
    expect(tabDot(1)).toBe('dot dot-blocked');
    // The terminal's header has none: its terminal has no agent.
    expect(host.querySelector('.pane-header[data-pane="t1"] .dot')).toBeNull();
    // A plugin turned off shows none.
    await act(async () => useSettings.setState({ values: { [`plugins.${DUMMY}.enabled`]: { value: false, source: 'global' } } }));
    expect([tabDot(0), tabDot(1)]).toEqual([undefined, undefined]);
  });
});

describe('seen', () => {
  let stop: () => void;
  let focused = true;
  const visibility = (v: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const focus = (pane: string) => act(async () => hub.model.mutate('m', (l) => L.focusPane(l, pane)));
  const flush = () => act(async () => {});

  beforeEach(async () => {
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    visibility('visible');
    stop = followViewsSeen();
    await flush();
  });
  afterEach(() => stop());

  it('tells the plugin once when the user looks at a pane that is done, and again after it changed', async () => {
    await act(async () => setViewStatus('v1', 'done'));
    // t1 has the focus.
    expect(seenCalls).toEqual([]);
    expect(paneOnScreen('m', 'view:v1')).toBe(true);
    expect(paneFocused('m', 'view:v1')).toBe(false);
    await focus('view:v1');
    expect(paneFocused('m', 'view:v1')).toBe(true);
    expect(seenCalls).toEqual(['m:v1']);
    // Other changes do not tell it again while it stays done.
    await act(async () => setViewStatus('v2', 'blocked'));
    await focus('view:v1');
    expect(seenCalls).toEqual(['m:v1']);
    // Seen, it is idle; done again, it is told again.
    await act(async () => setViewStatus('v1', 'idle'));
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls).toEqual(['m:v1', 'm:v1']);
    // A pane done while the user looks elsewhere is told once it is looked at.
    await act(async () => setViewStatus('v2', 'done'));
    expect(seenCalls).toEqual(['m:v1', 'm:v1']);
    await act(async () => hub.model.mutate('m', (l) => L.selectTab(l, 'aaaaaaaa', 1)));
    expect(seenCalls).toEqual(['m:v1', 'm:v1', 'm:v2']);
  });

  it('waits for the page to be visible and focused, and for the pane to be shown', async () => {
    await focus('view:v1');
    visibility('hidden');
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls).toEqual([]);
    visibility('visible');
    await flush();
    expect(seenCalls).toEqual(['m:v1']);
    // The window loses the focus and gets it back: the user looks again.
    focused = false;
    window.dispatchEvent(new Event('blur'));
    await flush();
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(seenCalls).toEqual(['m:v1', 'm:v1']);
    // Behind a zoomed pane it is not shown.
    await act(async () => setViewStatus('v1', 'idle'));
    await act(async () => useStore.getState().setZoomed({ m: 'm', pane: 't1' }));
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls.length).toBe(2);
    await act(async () => useStore.getState().setZoomed(undefined));
    expect(seenCalls.length).toBe(3);
  });

  it('tells nothing on a read-only page, of another machine, or of a terminal', async () => {
    await act(async () => useStore.getState().setReadOnly(true));
    await focus('view:v1');
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls).toEqual([]);
    await act(async () => useStore.getState().setReadOnly(false));
    expect(seenCalls).toEqual(['m:v1']);
    await act(async () => setViewStatus('v1', 'idle'));
    await act(async () => useStore.getState().selectMachine('other'));
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls).toEqual(['m:v1']);
    // Its machine shown again, the pane is looked at.
    await act(async () => useStore.getState().selectMachine('m'));
    expect(seenCalls).toEqual(['m:v1', 'm:v1']);
    await focus('t1');
    await act(async () => setViewStatus('v1', 'idle'));
    await act(async () => setViewStatus('v1', 'done'));
    expect(seenCalls).toEqual(['m:v1', 'm:v1']);
  });
});
