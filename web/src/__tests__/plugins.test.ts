// @vitest-environment jsdom
//
// The plugin framework: plugins on and off by their setting, the right
// sidebar's rail and panels, commands that plugins run, their panes and
// their messages from the core.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Files, GitBranch } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
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
import { RightBar } from '../components/RightBar';
import { PluginPane } from '../components/PluginPane';
import { commandEnabled, runCommand } from '../keymap';
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
      'git',
      'monitor',
      'usage',
      'vault',
      'agents',
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
});
