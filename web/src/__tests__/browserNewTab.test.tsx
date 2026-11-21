// @vitest-environment jsdom
//
// The tab bar's new-tab button: a plain click makes a terminal; Cmd/Ctrl+click,
// a right click and the chevron offer the kinds of tab: Terminal, then what
// each plugin that is on contributes, a separator between plugins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { useSettings } from '../settings';
import { Workspace } from '../components/Workspace';
import { closeMenu, isItem, useMenu, type MenuEntry } from '../contextMenu';
import { definePlugins } from '../plugins/registry';
import { vscodePlugin } from '../plugins/vscode';
import { browserPlugin } from '../plugins/browser';
import { t } from '../i18n';
import { FakeCore, settle } from './fakeTerms';
import { vscodeOn } from './fakeSettings';
import type { PluginDef } from '../plugins/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let core: FakeCore;
let host: HTMLDivElement;
let root: Root;
const set = (key: string, value: unknown) =>
  useSettings.setState((s) => ({ values: { ...s.values, [key]: { value, source: 'global' } } }) as Partial<typeof s>);
const button = () => host.querySelector<HTMLElement>('.new-tab')!;
const labels = (entries: MenuEntry[]) => entries.map((e) => (isItem(e) ? e.label : '-'));
const menu = () => useMenu.getState().menu?.entries ?? [];
const tabs = () => core.model.layout('m')!.workspaces[0].tabs;

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  definePlugins([vscodePlugin, browserPlugin]);
  vscodeOn();
  set('plugins.browser.enabled', true);
  core = new FakeCore();
  core.machine('m', [FakeCore.term('p1')], {
    version: 2,
    workspaces: [{ id: 'w1w1w1w1', name: 'one', cwd: '/src', tabs: [{ root: { terminal: 'p1' }, focused: 'p1' }], selected: 0 }],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'm', label: 'box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('m');
  core.model.subscribe('m');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Workspace)));
});

afterEach(() => {
  closeMenu(false);
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  definePlugins([]);
});

describe('the new-tab button', () => {
  it('makes a terminal on a plain click, with no menu', async () => {
    await act(async () => button().click());
    await settle();
    expect(core.calls.filter((c) => c.method === 'terminal.run').length).toBe(1);
    expect(tabs().length).toBe(2);
    expect(useMenu.getState().menu).toBeUndefined();
  });

  it('lists Terminal, VS Code and Browser, a separator between plugins, on Cmd+click, a right click and the chevron', async () => {
    const want = [t('tab.newKind.terminal'), '-', 'VS Code', '-', t('browser.title')];
    await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, clientX: 5, clientY: 5 })));
    expect(labels(menu())).toEqual(want);
    expect(core.calls.filter((c) => c.method === 'terminal.run').length).toBe(0);
    act(() => closeMenu(false));
    await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 5, clientY: 5 })));
    expect(labels(menu())).toEqual(want);
    act(() => closeMenu(false));
    await act(async () =>
      button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })),
    );
    expect(labels(menu())).toEqual(want);
    act(() => closeMenu(false));
    await act(async () => host.querySelector<HTMLElement>('.new-tab-kinds')!.click());
    expect(labels(menu())).toEqual(want);
  });

  it('drops the item of a plugin that is off, and the chevron when none is left', async () => {
    set('plugins.browser.enabled', false);
    await act(async () =>
      button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })),
    );
    expect(labels(menu())).toEqual([t('tab.newKind.terminal'), '-', 'VS Code']);
    act(() => closeMenu(false));
    set('plugins.vscode.browser', false);
    await act(async () => void (await settle()));
    expect(host.querySelector('.new-tab-kinds')).toBeNull();
    // Only Terminal is left: the menu has one item.
    await act(async () =>
      button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })),
    );
    expect(labels(menu())).toEqual([t('tab.newKind.terminal')]);
  });

  it('opens a browser pane in a new tab when Browser is chosen', async () => {
    await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, clientX: 5, clientY: 5 })));
    const item = menu()
      .filter(isItem)
      .find((i) => i.label === t('browser.title'))!;
    await act(async () => void item.run!());
    await settle();
    expect(tabs().length).toBe(2);
    const leaf = tabs()[1].root;
    expect(L.isPluginLeaf(leaf) && leaf.view).toMatchObject({ plugin: 'browser', kind: 'page', url: '' });
    expect(core.model.layout('m')!.workspaces[0].selected).toBe(1);
  });

  it('takes any number of items and groups, in plugin order', async () => {
    const icon = () => null;
    const extra = (id: string, ...titles: string[]): PluginDef => ({
      id,
      title: 'browser.title',
      icon,
      newTabItems: () => titles.map((x, i) => ({ id: `${id}${i}`, title: x as 'browser.title', icon, run() {} })),
    });
    definePlugins([vscodePlugin, extra('aa', 'command.tab.new', 'command.tab.close'), browserPlugin, extra('bb')]);
    await act(async () =>
      button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })),
    );
    expect(labels(menu())).toEqual([
      t('tab.newKind.terminal'),
      '-',
      'VS Code',
      '-',
      t('command.tab.new'),
      t('command.tab.close'),
      '-',
      t('browser.title'),
    ]);
  });
});
