// @vitest-environment jsdom
//
// Plugins' settings pages: a section the core says is a plugin's (or a
// plugin names) is listed under the plugins in the settings dialog, the
// Plugins page opens it from the plugin's row, the page starts with the
// plugin and its switch and says when the plugin is off, ends with the
// plugin's extra component, and the search still finds its settings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Box } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}), retry: () => {} } }));

import { SettingsDialog } from '../components/SettingsDialog';
import { applySettings, builtinDefaults, useSettings, type SettingDef, type SettingState } from '../settings';
import { useStore } from '../state/store';
import { allPlugins, definePlugins, pluginSection, sectionPlugin } from '../plugins/registry';
import type { PluginDef } from '../plugins/api';
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { fakeSettingsApi } from './fakeSettings';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const defs: SettingDef[] = [
  { key: 'terminal.cursorBlink', type: 'bool', default: true, scope: 'app', section: 'terminal', order: 60 },
  { key: 'plugins.usage.enabled', type: 'bool', default: true, scope: 'app', section: 'plugins', order: 40 },
  { key: 'usage.refresh', type: 'enum', enum: ['manual', 'adaptive'], default: 'adaptive', scope: 'app', section: 'usage', order: 10 },
  { key: 'usage.claudeKeychain', type: 'bool', default: true, scope: 'app', section: 'usage', order: 60 },
  // A machine's own setting of a plugin's section.
  { key: 'files.thing', type: 'bool', default: true, scope: 'machine', section: 'filesx', order: 10 },
];

/** A plugin whose page has no settings, only its extra. */
const Extra = ({ readOnly }: { readOnly: boolean }) => createElement('button', { className: 'demo-extra', disabled: readOnly }, 'Export…');
const demo: PluginDef = {
  id: 'demo',
  title: 'plugins.transfers.title',
  icon: Box,
  enableSetting: null,
  settings: { section: 'demo', extra: Extra },
};

const state = (): Record<string, SettingState> => {
  const out: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) out[k] = { value: v, source: 'default' };
  return out;
};

const machines: MachineState[] = [
  { id: 'gpu', label: 'gpu-box', kind: 'ssh', target: 'u@gpu', status: 'ready', enabled: true, updated_at: 0 },
];

describe("plugins' settings pages", () => {
  let host: HTMLElement;
  let root: Root;
  const saved = [...allPlugins()];
  const nav = () => [...host.querySelectorAll<HTMLButtonElement>('.settings-nav button')];
  const navButton = (label: string) => nav().find((b) => b.textContent === label)!;

  beforeEach(async () => {
    fakeSettingsApi();
    definePlugins([...saved, demo]);
    useSettings.setState({
      loaded: true,
      defs,
      sections: [
        { id: 'terminal', order: 30 },
        { id: 'plugins', order: 65 },
        { id: 'usage', order: 66, plugin: 'usage' },
        { id: 'filesx', order: 67, plugin: 'files' },
      ],
      values: state(),
      problems: [],
      file: '',
    });
    useStore.getState().setMachines(machines);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(SettingsDialog)));
    await act(async () => useStore.getState().openSettings({ page: 'terminal' }));
  });
  afterEach(async () => {
    await act(async () => useStore.getState().openSettings(false));
    await act(async () => root.unmount());
    host.remove();
    definePlugins(saved);
    applySettings({ values: state(), problems: [] });
    vi.unstubAllGlobals();
  });

  it('knows which plugin a section belongs to, either way round', () => {
    const usage = allPlugins().find((p) => p.id === 'usage')!;
    expect(pluginSection(usage)).toBe('usage');
    expect(sectionPlugin('usage')).toBe('usage');
    expect(sectionPlugin('filesx')).toBe('files');
    expect(sectionPlugin('demo')).toBe('demo');
    expect(sectionPlugin('terminal')).toBeUndefined();
  });

  it('lists the sections of plugins under the Plugins page, in the plugins’ order', () => {
    const labels = nav().map((b) => b.textContent);
    expect(labels).toEqual(['Terminal', 'Plugins', t('files.title'), t('usage.title'), t('plugins.transfers.title'), 'Keyboard Shortcuts']);
    expect(navButton(t('usage.title')).classList.contains('sub')).toBe(true);
    expect(navButton('Plugins').classList.contains('sub')).toBe(false);
  });

  it("opens a plugin's page from its row, with its switch, and says when it is off", async () => {
    await act(async () => navButton('Plugins').click());
    const row = host.querySelector('.plugins-page [data-plugin="usage"]')!;
    const open = row.querySelector<HTMLButtonElement>('.plugin-settings')!;
    expect(open.getAttribute('aria-label')).toBe(t('plugins.page.settings', { plugin: t('usage.title') }));
    // Plugins without a page of settings have no button.
    expect(host.querySelector('.plugins-page [data-plugin="git"] .plugin-settings')).toBeNull();
    await act(async () => open.click());
    expect(host.querySelector('.settings-page-title')?.textContent).toBe(t('usage.title'));
    expect(host.querySelector('[data-key="usage.claudeKeychain"]')).not.toBeNull();
    const header = host.querySelector<HTMLElement>('.plugin-header[data-plugin="usage"]')!;
    expect(header.querySelector('.plugin-off')).toBeNull();
    await act(async () => header.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await vi.waitFor(() => expect(useSettings.getState().values['plugins.usage.enabled']?.value).toBe(false));
    expect(header.querySelector('.plugin-off')?.textContent).toBe(t('plugins.page.off', { plugin: t('usage.title') }));
    expect(navButton(t('usage.title')).classList.contains('off')).toBe(true);
    // Its settings stay where they are.
    expect(host.querySelector('[data-key="usage.claudeKeychain"]')).not.toBeNull();
  });

  it("ends a plugin's page with its extra, also a page of nothing else", async () => {
    await act(async () => navButton(t('plugins.transfers.title')).click());
    expect(host.querySelector('.settings-page-title')?.textContent).toBe(t('plugins.transfers.title'));
    expect(host.querySelector('.demo-extra')?.textContent).toBe('Export…');
    // Always on: no off note, "Always on" for a switch.
    expect(host.querySelector('.plugin-header[data-plugin="demo"]')?.textContent).toContain(t('plugins.page.always'));
    await act(async () => navButton('Plugins').click());
    expect(host.querySelector('.plugins-page [data-plugin="demo"] .plugin-settings')).not.toBeNull();
  });

  it("finds a plugin's settings by search", async () => {
    const input = host.querySelector<HTMLInputElement>('.settings-search input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'keychain');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...host.querySelectorAll('.settings-section h3')].map((h) => h.textContent)).toEqual([t('settings.section.usage')]);
    expect(host.querySelector('[data-key="usage.claudeKeychain"]')).not.toBeNull();
  });

  it("lists a plugin's sections under a heading in a machine's scope", async () => {
    await act(async () => useStore.getState().openSettings({ machine: 'gpu' }));
    expect(nav().map((b) => b.textContent)).toEqual([t('settings.machine.overview'), t('files.title')]);
    expect(host.querySelector('.settings-nav-heading')?.textContent).toBe(t('settings.section.plugins'));
    await act(async () => navButton(t('files.title')).click());
    // No switch in a machine's scope: the switch is the User setting.
    expect(host.querySelector('.plugin-header[data-plugin="files"] input')).toBeNull();
    expect(host.querySelector('[data-key="files.thing"]')).not.toBeNull();
  });
});
