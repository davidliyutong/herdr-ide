// @vitest-environment jsdom
//
// The agents that need the user, with plugins' panes that have a status (a
// chat's; plugins/api.ts ViewStatusDef) among the terminals' agents: their
// order, Go to Agent Needing Attention, the sidebar's Agents section and
// the palette's agents.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import { allPlugins, definePlugins } from '../plugins/registry';
import { actions, attentionList, attentionName, attentionTitle } from '../actions';
import { Sidebar } from '../components/Sidebar';
import { Palette } from '../components/Palette';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { t } from '../i18n';
import { FakeHub, settle } from './fakeTerms';
import { dummyPlugin, resetViewStatuses, setUnopenedAgents, setViewStatus, thing } from './viewStatusPlugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = [...allPlugins()];
let hub: FakeHub;

beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
  resetViewStatuses();
  definePlugins([dummyPlugin]);
  useSettings.setState({ values: {} });
  hub = new FakeHub();
  hub.machine(
    'm',
    [FakeHub.term('d', { agent: 'claude', agent_status: 'done' }), FakeHub.term('w', { agent: 'codex', agent_status: 'working' })],
    {
      version: 2,
      workspaces: [
        {
          id: 'aaaaaaaa',
          name: 'api',
          cwd: '',
          tabs: [
            { root: { terminal: 'd' }, focused: 'd' },
            { root: thing('v1', 'one'), focused: 'view:v1' },
            { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 'w' }, thing('v2', 'two')] }, focused: 'w' },
          ],
          selected: 0,
        },
        {
          id: 'bbbbbbbb',
          name: 'web',
          cwd: '',
          tabs: [{ root: { split: 'vertical', ratio: 0.5, children: [thing('v3', 'three'), thing('v4', 'four')] }, focused: 'view:v3' }],
          selected: 0,
        },
      ],
      selected: 0,
    },
  );
  hub.install();
  const s = useStore.getState();
  s.setReadOnly(true);
  s.setMachines([{ id: 'm', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]);
  s.selectMachine('m');
  hub.model.subscribe('m');
  await settle();
  setViewStatus('v1', 'blocked');
  setViewStatus('v2', 'done');
  setViewStatus('v3', 'idle');
});
afterEach(() => {
  definePlugins(saved);
  useStore.getState().setPalette(undefined);
  vi.unstubAllGlobals();
});

describe('the attention list', () => {
  it("orders plugins' panes among the terminals' agents, terminals first within a status", () => {
    const list = attentionList();
    expect(list.map((i) => [i.terminal, i.status])).toEqual([
      ['view:v1', 'blocked'],
      ['d', 'done'],
      ['view:v2', 'done'],
      ['w', 'working'],
      ['view:v3', 'idle'],
    ]);
    expect(list[0].view?.id).toBe('v1');
    expect(list[0].record).toBeUndefined();
    expect(list[1].record?.address).toBe('d');
    // A pane goes by its title, a terminal by its agent.
    expect([attentionName(list[0]), attentionTitle(list[0])]).toEqual(['thing one', 'thing one']);
    expect(attentionName(list[1])).toBe('claude');
  });

  it('goes to the pane that most needs the user, a blocked one of a plugin', async () => {
    actions.openAttention();
    await settle();
    const layout = hub.layout('m')!;
    expect(L.selectedTab(layout)?.focused).toBe('view:v1');
    setViewStatus('v1', 'idle');
    // Then the done terminal, before the done pane.
    actions.openAttention();
    await settle();
    expect(L.selectedTab(hub.layout('m')!)?.focused).toBe('d');
  });
});

describe('views', () => {
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

  it("lists plugins' panes in the sidebar's agents, follows their statuses and shows one when clicked", async () => {
    await act(async () => root.render(createElement(Sidebar)));
    const rows = () => [...host.querySelectorAll<HTMLElement>('.inbox-item')];
    expect(rows().map((r) => r.querySelector('.inbox-title')?.textContent)).toEqual([
      `thing one · ${t('status.blocked')}`,
      `claude · ${t('status.done')}`,
      `thing two · ${t('status.done')}`,
    ]);
    // Its place and machine, its directory in the tooltip; its title only once.
    expect(rows()[0].querySelector('.muted')?.textContent).toBe('api · 2 · gpu');
    expect(rows()[0].title).toBe('api · 2 · gpu\n/srv/thing');
    await act(async () => setViewStatus('v2', 'working'));
    expect(rows().length).toBe(2);
    expect(host.querySelector('.inbox .section-title')?.textContent).toContain(t('sidebar.working', { n: 2 }));
    await act(async () => rows()[0].click());
    await act(settle);
    expect(L.selectedTab(hub.layout('m')!)?.focused).toBe('view:v1');
  });

  it('includes unopened conversations in the inbox, attention list, palette, and openAttention, and opens them on click', async () => {
    const open = vi.fn();
    await act(async () => root.render(createElement(Sidebar)));
    await act(async () =>
      setUnopenedAgents('m', [{ id: 'chat:u1', title: 'Background chat', directory: '/srv/bg', status: 'blocked', open }]),
    );
    const list = attentionList();
    expect(list.some((i) => i.terminal === 'chat:u1' && i.status === 'blocked')).toBe(true);
    const rows = [...host.querySelectorAll<HTMLElement>('.inbox-item')];
    const bg = rows.find((r) => r.textContent?.includes('Background chat'))!;
    expect(bg).toBeTruthy();
    expect(bg.querySelector('.muted')?.textContent).toBe('gpu');
    expect(bg.title).toBe('gpu\n/srv/bg');
    await act(async () => bg.click());
    expect(open).toHaveBeenCalledTimes(1);

    // openAttention opens highest-priority unopened chat when pane v1 is idle
    setViewStatus('v1', 'idle');
    actions.openAttention();
    expect(open).toHaveBeenCalledTimes(2);

    // Palette lists unopened chat and invokes open()
    await act(async () => root.render(createElement(Palette)));
    await act(async () => useStore.getState().setPalette('workspaces'));
    await act(settle);
    const item = [...host.querySelectorAll<HTMLElement>('.palette-item')].find((e) => e.textContent?.includes('Background chat'))!;
    expect(item).toBeTruthy();
    await act(async () => item.click());
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("names plugins' panes in the palette's agents", async () => {
    await act(async () => root.render(createElement(Palette)));
    await act(async () => useStore.getState().setPalette('workspaces'));
    await act(settle);
    const texts = [...host.querySelectorAll<HTMLElement>('.palette-item')].map((e) => e.textContent ?? '');
    expect(texts.some((x) => x.includes('thing one · api · 2'))).toBe(true);
    expect(texts.some((x) => x.includes('claude · api · 1'))).toBe(true);
    expect(texts.some((x) => x.includes('view:'))).toBe(false);
  });
});
