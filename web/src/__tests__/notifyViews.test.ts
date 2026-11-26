// @vitest-environment jsdom
//
// Agent notifications of plugins' panes (a chat's; plugins/api.ts
// ViewStatusDef): terminal "" and the plugin's own members point to the
// pane, which the notification names, places and shows when clicked; the
// done sound is left out when the user looks at it; the badge counts the
// blocked ones; terminals' notifications are as they were.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));
const played = vi.fn();
vi.mock('../sound', async (orig) => ({ ...(await orig<typeof import('../sound')>()), playSound: (k: string) => played(k) }));

import { notifiedPane, notifyAgent, resetNotifyForTests, updateBadge } from '../notify';
import { useSettings } from '../settings';
import { useStore } from '../state/store';
import { allPlugins, definePlugins } from '../plugins/registry';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { dummyPlugin, resetViewStatuses, setViewStatus, thing } from './viewStatusPlugin';

const saved = [...allPlugins()];
const shown: Array<{ title: string; body?: string; tag?: string; n: { onclick: (() => void) | null } }> = [];
const badge: Array<number | 'clear'> = [];
let hub: FakeHub;
let hasFocus = false;

const page = (visible: boolean) => {
  hasFocus = visible;
  Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true });
};

beforeEach(async () => {
  class FakeNotification {
    static permission = 'granted';
    onclick: (() => void) | null = null;
    constructor(title: string, o?: { body?: string; tag?: string }) {
      shown.push({ title, body: o?.body, tag: o?.tag, n: this });
    }
    close() {}
  }
  vi.stubGlobal('Notification', FakeNotification);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus);
  Object.assign(navigator, {
    setAppBadge: (n: number) => (badge.push(n), Promise.resolve()),
    clearAppBadge: () => (badge.push('clear'), Promise.resolve()),
  });
  // Read-only: what is seen is not what this is about.
  useStore.getState().setReadOnly(true);
  page(false);
  resetViewStatuses();
  definePlugins([dummyPlugin]);
  useSettings.setState({ values: {} });
  hub = new FakeHub();
  hub.machine('m', [FakeHub.term('t1'), FakeHub.term('t2', { agent: 'claude', agent_status: 'working' })], {
    version: 2,
    workspaces: [
      {
        id: 'aaaaaaaa',
        name: 'api',
        cwd: '',
        tabs: [
          { root: { terminal: 't1' }, focused: 't1' },
          { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't2' }, thing('v1', 'one')] }, focused: 't2' },
        ],
        selected: 0,
      },
    ],
    selected: 0,
  });
  hub.install();
  const s = useStore.getState();
  s.setMachines([{ id: 'm', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]);
  s.selectMachine('m');
  hub.model.subscribe('m');
  await settle();
});
afterEach(() => {
  resetNotifyForTests();
  shown.length = 0;
  badge.length = 0;
  played.mockClear();
  definePlugins(saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const chat = (status: 'blocked' | 'done', to = 'v1') => ({
  terminal: '',
  thing: to,
  agent: 'claude',
  display_agent: 'Claude Code',
  agent_status: status,
  title: 'fix tests',
});

describe("a plugin's pane's notification", () => {
  it('names the agent, says where its pane is and shows it when clicked', async () => {
    expect(notifiedPane('m', chat('blocked'))).toBe('view:v1');
    notifyAgent('m', chat('blocked'), false);
    expect(shown.map(({ title, body, tag }) => ({ title, body, tag }))).toEqual([
      { title: 'Claude Code needs your input', body: 'gpu · api · 2\nfix tests', tag: 'm|view:v1' },
    ]);
    shown[0].n.onclick!();
    await settle();
    const layout = hub.layout('m')!;
    expect(L.selectedTab(layout)?.focused).toBe('view:v1');
  });

  it('says only the machine when no pane shows it, and shows nothing when clicked', async () => {
    expect(notifiedPane('m', chat('done', 'gone'))).toBeUndefined();
    expect(notifiedPane('m', { terminal: '', agent_status: 'done' })).toBeUndefined();
    notifyAgent('m', chat('done', 'gone'), false);
    expect(shown.map(({ body, tag }) => ({ body, tag }))).toEqual([{ body: 'gpu\nfix tests', tag: undefined }]);
    shown[0].n.onclick!();
    await settle();
    expect(L.selectedTab(hub.layout('m')!)?.focused).toBe('t1');
  });

  it('says a blocked pane in a toast while the page is in front', () => {
    page(true);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    notifyAgent('m', chat('blocked'), false);
    expect(shown).toEqual([]);
    expect(toast).toHaveBeenCalledWith('Claude Code needs your input · gpu · api · 2');
  });

  it('plays the done sound unless the user looks at the pane', async () => {
    page(true);
    // Its tab is not shown.
    notifyAgent('m', chat('done'), true);
    expect(played.mock.calls).toEqual([['done']]);
    // Its tab is shown, another pane focused.
    hub.model.mutate('m', (l) => L.selectTab(l, 'aaaaaaaa', 1));
    notifyAgent('m', chat('done'), true);
    expect(played.mock.calls.length).toBe(2);
    // Shown and focused.
    hub.model.mutate('m', (l) => L.focusPane(l, 'view:v1'));
    notifyAgent('m', chat('done'), true);
    expect(played.mock.calls.length).toBe(2);
    // The request sound always plays.
    notifyAgent('m', chat('blocked'), true);
    expect(played.mock.calls.at(-1)).toEqual(['request']);
    // A terminal's done on screen plays none, as before.
    notifyAgent('m', { terminal: 't2', agent: 'claude', agent_status: 'done' }, true);
    expect(played.mock.calls.length).toBe(3);
  });
});

describe('the badge', () => {
  it("counts the blocked plugins' panes with the terminals' agents, as they change", async () => {
    updateBadge();
    expect(document.title).not.toMatch(/^\(/);
    setViewStatus('v1', 'blocked');
    expect(badge.at(-1)).toBe(1);
    expect(document.title).toMatch(/^\(1\) /);
    hub.event('m', 'agent', 't2', { agent_status: 'blocked' });
    await settle();
    // App.tsx counts again on every change of the terminals.
    updateBadge();
    expect(badge.at(-1)).toBe(2);
    setViewStatus('v1', 'working');
    expect(badge.at(-1)).toBe(1);
    expect(document.title).toMatch(/^\(1\) /);
    // Off, the plugin's panes count no more.
    setViewStatus('v1', 'blocked');
    expect(badge.at(-1)).toBe(2);
    // Muting the tab with the blocked plugin view excludes it from the badge.
    hub.model.mutate('m', (l) => L.muteTab(l, 'aaaaaaaa', 1, true));
    await settle();
    expect(badge.at(-1)).toBe('clear');
    // Unmuting restores both blocked panes in tab 1 (t2 + v1).
    hub.model.mutate('m', (l) => L.muteTab(l, 'aaaaaaaa', 1, false));
    await settle();
    expect(badge.at(-1)).toBe(2);
    useSettings.setState({ values: { 'plugins.dummy.enabled': { value: false, source: 'global' } } });
    expect(badge.at(-1)).toBe(1);
  });
});
