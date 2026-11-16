// @vitest-environment jsdom
//
// The plugin framework's guards: a plugin that fails while drawing (its
// pane, its panel, its status item) shows that in its place with Try
// Again, and the rest of the page goes on; the Plugins page's switch of a
// setting machines can have of their own (program windows); Monaco's
// editors already open follow later font changes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Files } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useSettings, type SettingDef } from '../settings';
import { usePrefs } from '../prefs';
import { allPlugins, definePlugins } from '../plugins/registry';
import { RightBar } from '../components/RightBar';
import { PluginPane } from '../components/PluginPane';
import { PluginBoundary } from '../components/PluginBoundary';
import { PluginsPage } from '../components/settings/PluginsPage';
import { applyFont, followFont } from '../plugins/monaco';
import { t } from '../i18n';
import { fakeSettingsApi } from './fakeSettings';
import type { PluginDef } from '../plugins/api';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Whether the broken plugin's parts throw. */
let broken = true;
const Broken = () => {
  if (broken) throw new Error('kaput');
  return createElement('div', { className: 'fine' }, 'fine');
};
const flaky: PluginDef = {
  id: 'flaky',
  title: 'plugins.gui.title',
  icon: Files,
  panels: [{ id: 'flaky', title: 'plugins.gui.title', icon: Files, component: Broken }],
  paneViews: { thing: { icon: Files, title: () => 'thing', component: Broken } },
};

describe('the plugin framework', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];
  const render = async (el: ReturnType<typeof createElement>) => {
    await act(async () => root.render(el));
  };
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label));

  beforeEach(() => {
    fakeSettingsApi();
    broken = true;
    useSettings.setState({ values: {}, defs: [] });
    useStore.getState().setPanel(undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    definePlugins(saved);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a plugin's failing pane to itself, with Try Again", async () => {
    definePlugins([flaky]);
    await render(
      createElement('div', null, [
        createElement('span', { key: 'other', className: 'other' }, 'other'),
        createElement(PluginPane, { key: 'p', m: 'm', pane: 'view:x', view: { id: 'x', plugin: 'flaky', kind: 'thing' }, focused: false }),
      ]),
    );
    expect(host.querySelector('.other')).not.toBeNull();
    expect(host.querySelector('.plugin-error')?.textContent).toContain(
      t('plugins.crashed', { plugin: t('plugins.gui.title'), error: 'kaput' }),
    );
    broken = false;
    await act(async () => button(t('plugins.retry'))!.click());
    expect(host.querySelector('.fine')).not.toBeNull();
    expect(host.querySelector('.plugin-error')).toBeNull();
  });

  it("keeps a plugin's failing panel to the panel", async () => {
    definePlugins([flaky]);
    useStore.getState().setPanel('flaky');
    await render(createElement(RightBar));
    expect(host.querySelector('.panel .plugin-error')).not.toBeNull();
    expect(host.querySelector('.rail-button')).not.toBeNull();
  });

  it('shows a failing status item as a small button that tries again', async () => {
    await render(createElement(PluginBoundary, { plugin: 'Flaky', compact: true, children: createElement(Broken) }));
    const b = host.querySelector<HTMLButtonElement>('.plugin-error-item')!;
    expect(b.title).toContain('kaput');
    broken = false;
    await act(async () => b.click());
    expect(host.querySelector('.fine')).not.toBeNull();
  });

  it('switches program windows for every machine without a value of its own, and says so', async () => {
    const def = { key: 'gui.enabled', type: 'bool', default: true, scope: 'remote-machine', section: 'gui', order: 10 } as SettingDef;
    useSettings.setState({
      defs: [def],
      values: { 'gui.enabled': { value: false, source: 'global', machines: { gpu: true } } },
    });
    await render(createElement(PluginsPage, { readOnly: false }));
    const row = host.querySelector('[data-plugin="gui"]')!;
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    // The User value, though one machine has program windows on.
    expect(box.checked).toBe(false);
    expect(row.textContent).toContain(t('plugins.page.perMachine'));
    expect(host.querySelector('[data-plugin="files"]')?.textContent).not.toContain(t('plugins.page.perMachine'));
    await act(async () => box.click());
    await vi.waitFor(() => expect(useSettings.getState().values['gui.enabled']?.value).toBe(true));
  });

  it('gives editors already open the new font', () => {
    const calls: Array<Record<string, unknown>> = [];
    let disposed: (() => void) | undefined;
    const ed = { updateOptions: (o: Record<string, unknown>) => calls.push(o), onDidDispose: (l: () => void) => (disposed = l) };
    followFont(ed);
    const prefs = usePrefs.getState().prefs;
    usePrefs.setState({ prefs: { ...prefs, termFontSize: prefs.termFontSize + 3, termFontFamily: 'Iosevka' } });
    const remeasure = vi.fn();
    applyFont(remeasure);
    expect(calls.at(-1)).toMatchObject({ fontSize: prefs.termFontSize + 3 });
    expect(String(calls.at(-1)?.fontFamily)).toMatch(/^Iosevka, /);
    expect(remeasure).toHaveBeenCalledTimes(1);
    // Unchanged: nothing to do; disposed: no longer followed.
    applyFont(remeasure);
    expect(remeasure).toHaveBeenCalledTimes(1);
    disposed!();
    usePrefs.setState({ prefs });
    applyFont();
    expect(calls.length).toBe(1);
  });
});
