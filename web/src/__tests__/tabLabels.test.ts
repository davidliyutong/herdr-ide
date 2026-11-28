// @vitest-environment jsdom
// What tabs are called: a tab the user has not named shows its number in
// the tab bar, with its terminal's title in the tooltip; elsewhere an
// agent's tab is named with its workspace ("website · 2"), never by a bare
// number.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// The panes are not what this is about.
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));
vi.mock('../components/PaneHeader', () => ({ PaneHeader: () => null }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FakeHub, settle } from './fakeTerms';
import { Workspace } from '../components/Workspace';
import { Palette } from '../components/Palette';
import { Sidebar } from '../components/Sidebar';
import { tabLabel, terminalPlace } from '../actions';
import * as L from '../term/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('tab labels', () => {
  let host: HTMLDivElement;
  let root: Root;
  let hub: FakeHub;

  beforeEach(async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    hub = new FakeHub();
    const tab = (t: string, name?: string) => ({ root: { terminal: t }, focused: t, ...(name ? { name } : {}) });
    hub.machine(
      'm',
      [
        FakeHub.term('t1', { title: 'yutong@nus-ws-1:~' }),
        FakeHub.term('t2', { title: 'yutong@nus-ws-1:~' }),
        FakeHub.term('t3', { title: '✳ Fix the tests', agent: 'claude', agent_status: 'blocked' }),
        FakeHub.term('t4', { title: 'htop' }),
      ],
      {
        version: 2,
        workspaces: [
          {
            id: 'wwwwwwww',
            name: '',
            cwd: '/home/u/src/website',
            tabs: [
              tab('t1'),
              tab('t2', 'server'),
              { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't3' }, { terminal: 't4' }] }, focused: 't3' },
            ],
            selected: 0,
          },
        ],
        selected: 0,
      },
    );
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'nus-ws-1', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('m');
    hub.model.subscribe('m');
    await settle();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useStore.getState().setRenaming(undefined);
    useStore.getState().setPalette(undefined);
    vi.unstubAllGlobals();
  });

  const tabs = () => Array.from(host.querySelectorAll<HTMLElement>('.tab'));

  it('shows numbers for tabs without a name, the name otherwise, the title in the tooltip', async () => {
    await act(async () => root.render(createElement(Workspace)));
    expect(tabs().map((t) => t.querySelector('.tab-label')?.textContent)).toEqual(['1', 'server', '3']);
    expect(tabs()[0].title).toBe('yutong@nus-ws-1:~ · double-click to rename · drag to reorder');
    expect(tabs()[0].getAttribute('aria-label')).toBe('Tab 1: yutong@nus-ws-1:~');
    expect(tabs()[1].title).toContain('server · yutong@nus-ws-1:~');
    // A tab of two panes: a split mark, the count in the tooltip.
    expect(tabs()[2].querySelector('.tab-split')).not.toBeNull();
    expect(tabs()[2].title).toContain('✳ Fix the tests · 2 panes');
    expect(tabs()[2].querySelector('.dot-blocked')).not.toBeNull();
    // The tab bar holds the tabs alone: the sidebar names the workspace.
    expect(host.querySelector('.crumb')).toBeNull();
  });

  it('marks a pinned tab with a pin that a click does not unpin', async () => {
    hub.model.mutate('m', (l) => L.pinTab(l, 'wwwwwwww', 1, true));
    await act(async () => root.render(createElement(Workspace)));
    const pin = host.querySelector<HTMLElement>('.tab.pinned .tab-pin')!;
    expect(pin.tagName).toBe('SPAN');
    expect(host.querySelector('.tab.pinned .tab-close')).toBeNull();
    await act(async () => pin.click());
    expect(hub.model.layout('m')!.workspaces[0].tabs[0].pinned).toBe(true);
  });

  it('shows a tab of VS Code or a preview alone by its mark and name, a tab with a terminal by its number', async () => {
    hub.model.mutate('m', (l) => L.splitPane(l, 't1', 'horizontal', { code: { id: 'c2', folder: '/home/u' } }));
    hub.model.mutate('m', (l) => L.openPane(l, { code: { id: 'c1', folder: '/home/u/src/website' } }));
    hub.model.mutate('m', (l) => L.openPane(l, { preview: { id: 'p1', path: '/home/u/src/website/plot.png' } }));
    await act(async () => root.render(createElement(Workspace)));
    expect(tabs().map((t) => t.querySelector('.tab-label')?.textContent)).toEqual(['1', 'server', '3', 'website', 'plot.png']);
    expect(tabs()[3].querySelector('.code-icon')).not.toBeNull();
    expect(tabs()[3].title).toContain('VS Code · ~/src/website');
    expect(tabs()[4].title).toContain('Preview · ~/src/website/plot.png');
    // A terminal with VS Code beside it: its number and the split mark.
    expect(tabs()[0].querySelector('.code-icon')).toBeNull();
    expect(tabs()[0].querySelector('.tab-split')).not.toBeNull();
  });

  it('renames in place starting from the title; unchanged keeps the number, emptied gives it back', async () => {
    await act(async () => root.render(createElement(Workspace)));
    const rename = async (index: number, value: string | null) => {
      await act(async () => useStore.getState().setRenaming({ kind: 'tab', m: 'm', id: `wwwwwwww:${index}` }));
      const input = host.querySelector<HTMLInputElement>('.tab input')!;
      const before = input.value;
      if (value !== null) input.value = value;
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await act(settle);
      return before;
    };
    expect(await rename(0, null)).toBe('yutong@nus-ws-1:~');
    expect(hub.layout('m')?.workspaces[0].tabs[0].name).toBeUndefined();
    expect(await rename(1, '')).toBe('server');
    expect(hub.layout('m')?.workspaces[0].tabs[1].name).toBeUndefined();
    await rename(0, 'docs');
    expect(tabs().map((t) => t.querySelector('.tab-label')?.textContent)).toEqual(['docs', '2', '3']);
  });

  it('names an agent elsewhere by its workspace and tab', async () => {
    expect(terminalPlace('m', 't4')).toBe('website · 3');
    expect(terminalPlace('m', 't2')).toBe('website · server');
    expect(terminalPlace('m', 'gone')).toBe('');
    expect(tabLabel({ root: { terminal: 'x' }, focused: 'x' }, 4)).toBe('5');
    await act(async () => root.render(createElement(Sidebar)));
    expect(host.querySelector('.inbox-item')?.textContent).toBe('claude · Needs inputwebsite · 3 · ✳ Fix the tests · nus-ws-1');
    await act(async () => root.render(createElement(Palette)));
    await act(async () => useStore.getState().setPalette('workspaces'));
    const labels = Array.from(host.querySelectorAll('.palette-item .ellipsis')).map((e) => e.textContent);
    expect(labels).toEqual(['website', 'claude · website · 3']);
  });

  it('suppresses the blue unread dot on muted tabs and tabs inside a muted workspace', async () => {
    await act(async () => root.render(createElement(Workspace)));
    expect(tabs()[2].querySelector('.dot-blocked')).not.toBeNull();

    // Muting the tab hides its blue dot.
    await act(async () => hub.model.mutate('m', (l) => L.muteTab(l, 'wwwwwwww', 2, true)));
    await act(settle);
    expect(tabs()[2].querySelector('.dot-blocked')).toBeNull();
    expect(tabs()[2].querySelector('.tab-muted')).not.toBeNull();

    // Unmuting the tab brings the blue dot back.
    await act(async () => hub.model.mutate('m', (l) => L.muteTab(l, 'wwwwwwww', 2, false)));
    await act(settle);
    expect(tabs()[2].querySelector('.dot-blocked')).not.toBeNull();

    // Muting the parent workspace also hides the blue dot on its tabs.
    await act(async () => hub.model.mutate('m', (l) => L.muteWorkspace(l, 'wwwwwwww', true)));
    await act(settle);
    expect(tabs()[2].querySelector('.dot-blocked')).toBeNull();

    // Unmuting the workspace restores it.
    await act(async () => hub.model.mutate('m', (l) => L.muteWorkspace(l, 'wwwwwwww', false)));
    await act(settle);
    expect(tabs()[2].querySelector('.dot-blocked')).not.toBeNull();
  });
});
