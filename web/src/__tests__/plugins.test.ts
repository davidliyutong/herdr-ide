// @vitest-environment jsdom
//
// The plugin framework: plugins on and off by their setting, the right
// sidebar's rail and panels, commands that plugins run, their panes and
// their messages from the hub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Files, GitBranch } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { moveRailId, orderRailItems, useStore } from '../state/store';
import { useSettings } from '../settings';
import {
  activePanels,
  allPlugins,
  definePlugins,
  describeView,
  pluginCommand,
  pluginMessage,
  pluginOn,
  pluginSwitch,
} from '../plugins/registry';
import { lazyPlugin } from '../plugins/lazy';
import { RightBar } from '../components/RightBar';
import { PluginPane } from '../components/PluginPane';
import { commandEnabled, runCommand } from '../keymap';
import { isMac } from '../keys';
import { onPanelWheel, resetPanelSwipe } from '../panelSwipe';
import '../commands';
import { fakeSettingsApi } from './fakeSettings';
import type { PluginDef } from '../plugins/api';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = vi.fn();
const messages: unknown[] = [];
const files: PluginDef = {
  id: 'files',
  title: 'plugins.gui.title',
  icon: Files,
  panels: [
    { id: 'files', title: 'plugins.gui.title', icon: Files, component: () => createElement('div', { className: 'files-body' }, 'tree') },
  ],
  paneViews: {
    editor: {
      icon: Files,
      title: (_m, v) => `edit ${String(v.path)}`,
      path: (_m, v) => String(v.path),
      component: () => createElement('div', { className: 'editor' }),
    },
  },
  commands: { 'test.run': { enabled: () => true, run } },
  onMessage: (_m, data) => messages.push(data),
};
const git: PluginDef = {
  id: 'git',
  title: 'plugins.transfers.title',
  icon: GitBranch,
  panels: [
    { id: 'git', title: 'plugins.transfers.title', icon: GitBranch, component: () => createElement('div', { className: 'git-body' }) },
  ],
};

const setValue = (key: string, value: boolean) =>
  useSettings.setState((s) => ({ values: { ...s.values, [key]: { value, source: 'global' } } }));

describe('plugins', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];

  beforeEach(() => {
    fakeSettingsApi();
    definePlugins([files, git]);
    useSettings.setState({ values: {} });
    useStore.getState().setPanel(undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    run.mockClear();
    messages.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    definePlugins(saved);
    vi.unstubAllGlobals();
  });

  it('are on unless their setting is false; the built-in ones are listed', () => {
    expect(saved.map((p) => p.id)).toEqual([
      'transfers',
      'gui',
      'vscode',
      'browser',
      'files',
      'search',
      'git',
      'monitor',
      'usage',
      'vault',
      'agents',
      'chat',
      'history',
    ]);
    expect(pluginOn(git)).toBe(true);
    setValue('plugins.git.enabled', false);
    expect(pluginOn(git)).toBe(false);
    expect(activePanels().map((p) => p.id)).toEqual(['files']);
    // A plugin with a setting of its own, and one that is always on.
    const gui = saved.find((p) => p.id === 'gui')!;
    setValue('gui.enabled', false);
    expect(pluginOn(gui)).toBe(false);
    expect(pluginSwitch(gui)).toBe(false);
    // Its setting is per machine: on while any machine has it on, the
    // switch (every machine without its own) staying off.
    useSettings.setState((s) => ({
      values: { ...s.values, 'gui.enabled': { value: false, source: 'global', machines: { gpu: true } } },
    }));
    expect(pluginOn(gui)).toBe(true);
    expect(pluginSwitch(gui)).toBe(false);
    expect(pluginOn(saved.find((p) => p.id === 'transfers')!)).toBe(true);
    expect(() => definePlugins([files, files])).toThrow();
  });

  it('shows a rail button per panel, and a panel when one is pressed', async () => {
    await act(async () => root.render(createElement(RightBar)));
    const rail = () => [...host.querySelectorAll<HTMLButtonElement>('.rail-button')];
    expect(rail().map((b) => b.dataset.panel)).toEqual(['files', 'git']);
    expect(host.querySelector('.panel')).toBeNull();
    await act(async () => rail()[1].click());
    expect(useStore.getState().panel).toBe('git');
    expect(host.querySelector('.git-body')).not.toBeNull();
    await act(async () => rail()[1].click());
    expect(useStore.getState().panel).toBeUndefined();
    // Toggle Right Sidebar brings the last panel back, and hides it.
    expect(commandEnabled('view.togglePanel')).toBe(true);
    await act(async () => runCommand('view.togglePanel'));
    expect(useStore.getState().panel).toBe('git');
    await act(async () => runCommand('view.togglePanel'));
    expect(useStore.getState().panel).toBeUndefined();
    // A plugin turned off loses its panel.
    await act(async () => setValue('plugins.files.enabled', false));
    expect(rail().map((b) => b.dataset.panel)).toEqual(['git']);
  });

  it('runs the commands plugins add, and hands them their messages', () => {
    expect(pluginCommand('test.run')).toBeDefined();
    runCommand('test.run');
    expect(run).toHaveBeenCalledTimes(1);
    pluginMessage('files', 'm', { n: 1 });
    pluginMessage('nope', 'm', { n: 2 });
    expect(messages).toEqual([{ n: 1 }]);
    setValue('plugins.files.enabled', false);
    expect(pluginCommand('test.run')).toBeUndefined();
    pluginMessage('files', 'm', { n: 3 });
    expect(messages).toEqual([{ n: 1 }]);
  });

  it('draws a plugin pane by its kind, and says so while the plugin is off', async () => {
    const view = { id: 'v1', plugin: 'files', kind: 'editor', path: '/p/a.go' };
    expect(describeView('m', view)).toMatchObject({ title: 'edit /p/a.go', path: '/p/a.go' });
    await act(async () => root.render(createElement(PluginPane, { m: 'm', pane: 'view:v1', view, focused: false })));
    expect(host.querySelector('.editor')).not.toBeNull();
    await act(async () => setValue('plugins.files.enabled', false));
    expect(host.querySelector('.editor')).toBeNull();
    expect(host.textContent).toContain('files');
    await act(async () =>
      root.render(createElement(PluginPane, { m: 'm', pane: 'view:v2', view: { ...view, plugin: 'gone' }, focused: false })),
    );
    expect(host.textContent).toContain('gone');
  });

  it('customizes right sidebar rail order and icon visibility independently of disabling plugins', async () => {
    useStore.setState({ railOrder: [], hiddenRailPanels: [], panel: undefined });
    await act(async () => root.render(createElement(RightBar)));
    const rail = () => [...host.querySelectorAll<HTMLButtonElement>('.rail-button')];
    expect(rail().map((b) => b.dataset.panel)).toEqual(['files', 'git']);

    // Reorder via railOrder preference.
    await act(async () => useStore.getState().setRailOrder(['git', 'files']));
    expect(rail().map((b) => b.dataset.panel)).toEqual(['git', 'files']);

    // Hiding a rail icon removes its button without disabling its plugin or commands.
    await act(async () => useStore.getState().setRailPanelVisible('files', false));
    expect(rail().map((b) => b.dataset.panel)).toEqual(['git']);
    expect(pluginCommand('test.run')).toBeDefined();
    // Opening a hidden panel programmatically still shows its panel body.
    await act(async () => useStore.getState().setPanel('files'));
    expect(host.querySelector('.files-body')).not.toBeNull();

    // Hiding all icons still keeps the rail reachable for right-click customization.
    await act(async () => useStore.getState().setRailPanelVisible('git', false));
    expect(rail()).toHaveLength(0);
    expect(host.querySelector('.panel-rail')).not.toBeNull();
    expect(host.querySelector('.rail-customize')).toBeNull();

    // Resetting restores visibility and default order.
    await act(async () => {
      useStore.getState().showAllRailPanels();
      useStore.getState().resetRailOrder();
    });
    expect(rail().map((b) => b.dataset.panel)).toEqual(['files', 'git']);
  });

  it('activates an unfocused PluginPane on pointer or focus interaction in split mode', async () => {
    const view = { id: 'v1', plugin: 'files', kind: 'editor', path: '/p/a.go' };
    const onActivate = vi.fn();
    await act(async () =>
      root.render(createElement(PluginPane, { m: 'm', pane: 'view:v1', view, focused: false, shown: true, onActivate })),
    );
    const paneEl = host.querySelector<HTMLElement>('.plugin-pane')!;
    await act(async () => {
      paneEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledTimes(1);

    // Focusing an already-focused pane does not re-trigger onActivate.
    onActivate.mockClear();
    await act(async () =>
      root.render(createElement(PluginPane, { m: 'm', pane: 'view:v1', view, focused: true, shown: true, onActivate })),
    );
    await act(async () => {
      paneEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('moveRailId and orderRailItems reorder visible panels while preserving hidden panels in place', () => {
    const items = [{ id: 'files' }, { id: 'search' }, { id: 'git' }, { id: 'vault' }];
    expect(orderRailItems(items, ['git', 'files']).map((x) => x.id)).toEqual(['git', 'files', 'search', 'vault']);

    // search is hidden; visible = [files, git, vault]. Moving files past vault keeps search at index 1.
    expect(moveRailId(['files', 'search', 'git', 'vault'], ['files', 'git', 'vault'], 'files', 3)).toEqual([
      'git',
      'search',
      'vault',
      'files',
    ]);
    // Moving vault before files keeps search in place.
    expect(moveRailId(['files', 'search', 'git', 'vault'], ['files', 'git', 'vault'], 'vault', 0)).toEqual([
      'vault',
      'search',
      'files',
      'git',
    ]);
    // Adjacent no-op slots and unknown ids return unchanged order.
    expect(moveRailId(['files', 'git'], ['files', 'git'], 'files', 0)).toEqual(['files', 'git']);
    expect(moveRailId(['files', 'git'], ['files', 'git'], 'files', 1)).toEqual(['files', 'git']);
    expect(moveRailId(['files', 'git'], ['files', 'git'], 'missing', 0)).toEqual(['files', 'git']);
  });

  it('view.togglePanel respects railOrder and skips hiddenRailPanels (falling back if all are hidden)', () => {
    useStore.setState({ railOrder: ['git', 'files'], hiddenRailPanels: [], panel: undefined, lastPanel: undefined });
    runCommand('view.togglePanel');
    expect(useStore.getState().panel).toBe('git');
    runCommand('view.togglePanel');
    expect(useStore.getState().panel).toBeUndefined();

    // When the first ordered panel (git) is hidden and lastPanel was git, togglePanel opens visible files.
    useStore.setState({ hiddenRailPanels: ['git'], panel: undefined, lastPanel: 'git' });
    runCommand('view.togglePanel');
    expect(useStore.getState().panel).toBe('files');
    runCommand('view.togglePanel');
    expect(useStore.getState().panel).toBeUndefined();

    // When every panel icon is hidden, togglePanel falls back to ordered active panels.
    useStore.setState({ hiddenRailPanels: ['git', 'files'], panel: undefined, lastPanel: undefined });
    runCommand('view.togglePanel');
    expect(useStore.getState().panel).toBe('git');
    useStore.setState({ railOrder: [], hiddenRailPanels: [], panel: undefined, lastPanel: undefined });
  });

  it('view.panel.next and previous step through the rail’s tools in its order, around the ends; a hidden sidebar opens first', () => {
    useStore.setState({ railOrder: ['git', 'files'], hiddenRailPanels: [], panel: undefined, lastPanel: 'files' });
    runCommand('view.panel.next');
    expect(useStore.getState().panel).toBe('files');
    const order = orderRailItems(activePanels(), ['git', 'files']).map((p) => p.id);
    const at = (id: string) => order.indexOf(id);
    runCommand('view.panel.next');
    expect(useStore.getState().panel).toBe(order[(at('files') + 1) % order.length]);
    runCommand('view.panel.previous');
    expect(useStore.getState().panel).toBe('files');
    useStore.setState({ panel: order[0] });
    runCommand('view.panel.previous');
    expect(useStore.getState().panel).toBe(order[order.length - 1]);
    useStore.setState({ railOrder: [], hiddenRailPanels: [], panel: undefined, lastPanel: undefined });
  });

  it('a swipe with the modifier held steps one tool, however long it goes, and the next swipe another', () => {
    resetPanelSwipe();
    useStore.setState({ railOrder: ['git', 'files'], hiddenRailPanels: [], panel: 'git', lastPanel: 'git' });
    const mod = isMac ? { metaKey: true } : { altKey: true };
    const wheel = (deltaY: number, o: WheelEventInit = mod) => new WheelEvent('wheel', { deltaY, cancelable: true, ...o });
    // Without the modifier: a scroll, left alone.
    const plain = wheel(200, {});
    expect(onPanelWheel(plain, 0)).toBe(false);
    expect(plain.defaultPrevented).toBe(false);
    // One swipe down the list, with momentum: one step.
    for (const [i, dy] of [10, 20, 30, 60, 40, 5].entries()) expect(onPanelWheel(wheel(dy), i * 16)).toBe(true);
    expect(useStore.getState().panel).toBe('files');
    // After a pause, a swipe up the list goes back.
    for (const [i, dy] of [-30, -30].entries()) onPanelWheel(wheel(dy), 1000 + i * 16);
    expect(useStore.getState().panel).toBe('git');
    // A mostly horizontal swipe is no step.
    const sideways = new WheelEvent('wheel', { deltaY: 50, deltaX: 80, cancelable: true, ...mod });
    expect(onPanelWheel(sideways, 3000)).toBe(false);
    useStore.setState({ railOrder: [], hiddenRailPanels: [], panel: undefined, lastPanel: undefined });
  });

  it('catches lazy plugin chunk-load rejections cleanly and toasts on user-triggered actions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useStore.setState({ toasts: [] });
    const failing = lazyPlugin(
      {
        id: 'broken',
        title: 'plugins.gui.title',
        icon: Files,
        commands: { 'broken.run': {} },
        newTabItems: [{ id: 'broken.tab', title: 'plugins.gui.title', icon: Files }],
        receivesMessages: true,
        paneViews: { view: { icon: Files, title: () => 'Broken' } },
      },
      () => Promise.reject(new Error('chunk fetch failed')),
    );
    definePlugins([failing]);

    // User-triggered command failure catches and shows an error toast.
    failing.commands!['broken.run'].run();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().toasts.at(-1)?.kind).toBe('error');
    expect(useStore.getState().toasts.at(-1)?.msg).toContain('chunk fetch failed');

    // User-triggered new-tab item failure also catches and toasts.
    useStore.setState({ toasts: [] });
    failing.newTabItems!('local')[0].run('local', 'ws1');
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().toasts.at(-1)?.kind).toBe('error');

    // Background message / menu preloads catch without toasting or unhandled rejections.
    useStore.setState({ toasts: [] });
    failing.onMessage!('local', { ping: 1 });
    failing.paneViews!.view.menu!('local', { id: 'v1', plugin: 'broken', kind: 'view' });
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().toasts).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
