// @vitest-environment jsdom
//
// VS Code's two switches: its windows run on the UI's origin, so it is off
// by default everywhere; a browser turns it on only after the user accepts
// the risk (a dialog with a box to tick before Enable), the desktop app
// just toggles its own switch, and each page follows the switch of the
// kind of client the hub says it is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}), retry: () => {} } }));

import { useSettings, loadSettings, builtinDefaults, type Client } from '../settings';
import { useDialog } from '../dialog';
import { acceptRisk, allPlugins, definePlugins, enableSetting, isPluginOn, setPluginSwitch } from '../plugins/registry';
import { vscodePlugin } from '../plugins/vscode';
import { PluginsPage } from '../components/settings/PluginsPage';
import { Dialogs } from '../components/Dialogs';
import { SettingsDialog } from '../components/SettingsDialog';
import { useStore } from '../state/store';
import { t } from '../i18n';
import { fakeSettingsApi } from './fakeSettings';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const value = (key: string) => useSettings.getState().values[key]?.value;

describe('VS Code in browsers and in the desktop app', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];
  const puts: string[] = [];
  const client = (c: Client) => useSettings.setState({ client: c });

  beforeEach(() => {
    fakeSettingsApi();
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)).key);
      return fake(url, init);
    });
    puts.length = 0;
    definePlugins([vscodePlugin]);
    useSettings.setState({ values: {}, defs: [], client: 'browser' });
    useDialog.setState({ current: undefined });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    definePlugins(saved);
    vi.unstubAllGlobals();
  });

  const render = () =>
    act(async () => root.render(createElement('div', null, createElement(PluginsPage, { readOnly: false }), createElement(Dialogs))));
  const box = () => host.querySelector<HTMLInputElement>('[data-plugin="vscode"] input[type="checkbox"]')!;
  const enable = () => host.querySelector<HTMLButtonElement>('.risk-dialog ~ .dialog-actions button[data-answer="accept"]')!;
  const cancelRisk = () =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('.risk-dialog ~ .dialog-actions button')]
        .find((b) => b.textContent === t('dialog.cancel'))!
        .click(),
    );

  it('is off by default for browsers and for the desktop app', () => {
    expect(builtinDefaults['plugins.vscode.enabled']).toBe(false);
    expect(builtinDefaults['plugins.vscode.browser']).toBe(false);
    expect(useSettings.getState().client).toBe('browser');
    expect(isPluginOn('vscode')).toBe(false);
    client('desktop');
    expect(isPluginOn('vscode')).toBe(false);
  });

  it('follows the switch of the kind of client the hub says the page is', async () => {
    useSettings.setState({ values: { 'plugins.vscode.enabled': { value: true, source: 'global' } } });
    // The desktop app's switch on: not in a browser.
    expect(enableSetting(vscodePlugin)).toBe('plugins.vscode.browser');
    expect(isPluginOn('vscode')).toBe(false);
    client('desktop');
    expect(enableSetting(vscodePlugin)).toBe('plugins.vscode.enabled');
    expect(isPluginOn('vscode')).toBe(true);
    // The verdict comes with the settings.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ values: {}, client: 'browser' })));
    expect(await loadSettings()).toBe(true);
    expect(useSettings.getState().client).toBe('browser');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ values: {}, client: 'desktop' })));
    await loadSettings();
    expect(useSettings.getState().client).toBe('desktop');
    // Anything else is a browser.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ values: {}, client: 'admin' })));
    await loadSettings();
    expect(useSettings.getState().client).toBe('browser');
  });

  it('asks a browser to accept the risk before its switch turns on, and nothing when it turns off', async () => {
    await render();
    const row = host.querySelector('[data-plugin="vscode"]')!;
    expect(box().checked).toBe(false);
    expect(row.textContent).toContain(t('plugins.page.browserSwitch'));
    // Cancelled: nothing changes.
    await act(async () => box().click());
    expect(useDialog.getState().current?.kind).toBe('risk');
    const dialog = host.querySelector('.risk-dialog')!;
    expect(dialog.textContent).toContain(t('code.risk.terminals'));
    expect(dialog.textContent).toContain(t('code.risk.scope'));
    expect(enable().textContent).toBe(t('code.risk.enable'));
    expect(enable().disabled).toBe(true);
    // Enable does nothing until the box is ticked.
    await act(async () => enable().click());
    expect(useDialog.getState().current?.kind).toBe('risk');
    const cancel = [...host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find(
      (b) => b.textContent === t('dialog.cancel'),
    )!;
    await act(async () => cancel.click());
    expect(useDialog.getState().current).toBeUndefined();
    expect(puts).toEqual([]);
    expect(box().checked).toBe(false);
    // Accepted: the browsers' switch, not the desktop app's.
    await act(async () => box().click());
    const understand = host.querySelector<HTMLInputElement>('.risk-dialog input[type="checkbox"]')!;
    await act(async () => understand.click());
    expect(enable().disabled).toBe(false);
    await act(async () => enable().click());
    await vi.waitFor(() => expect(value('plugins.vscode.browser')).toBe(true));
    expect(puts).toEqual(['plugins.vscode.browser']);
    expect(value('plugins.vscode.enabled')).toBeUndefined();
    expect(isPluginOn('vscode')).toBe(true);
    expect(box().checked).toBe(true);
    // Off: no question.
    await act(async () => box().click());
    expect(useDialog.getState().current).toBeUndefined();
    await vi.waitFor(() => expect(value('plugins.vscode.browser')).toBe(false));
  });

  it('just toggles the desktop app’s switch in the desktop app', async () => {
    client('desktop');
    await render();
    expect(host.querySelector('[data-plugin="vscode"]')!.textContent).toContain(t('plugins.page.desktopSwitch'));
    await act(async () => box().click());
    expect(useDialog.getState().current).toBeUndefined();
    await vi.waitFor(() => expect(value('plugins.vscode.enabled')).toBe(true));
    expect(puts).toEqual(['plugins.vscode.enabled']);
    expect(isPluginOn('vscode')).toBe(true);
    // A browser opening the same hub still finds it off.
    client('browser');
    expect(isPluginOn('vscode')).toBe(false);
  });

  it('asks wherever the browsers’ switch turns on, from any client, and for nothing else', async () => {
    await render();
    for (const c of ['browser', 'desktop'] as const) {
      client(c);
      const answer = acceptRisk('plugins.vscode.browser');
      await act(async () => {});
      expect(useDialog.getState().current?.kind).toBe('risk');
      const cancel = [...host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find(
        (b) => b.textContent === t('dialog.cancel'),
      )!;
      await act(async () => cancel.click());
      expect(await answer).toBe(false);
    }
    expect(await acceptRisk('plugins.vscode.enabled')).toBe(true);
    expect(await acceptRisk('plugins.files.enabled')).toBe(true);
    expect(useDialog.getState().current).toBeUndefined();
    // The panes' Turn It On asks in a browser too.
    client('browser');
    const turnedOn = setPluginSwitch('vscode', true);
    await act(async () => {});
    expect(useDialog.getState().current?.kind).toBe('risk');
    await cancelRisk();
    expect(await turnedOn).toBeUndefined();
    expect(puts).toEqual([]);
  });

  it('shows both switches in the settings, where the browsers’ asks too', async () => {
    useSettings.setState({
      loaded: true,
      sections: [{ id: 'plugins', order: 65 }],
      defs: [
        { key: 'plugins.vscode.enabled', type: 'bool', default: false, scope: 'app', section: 'plugins', order: 10 },
        { key: 'plugins.vscode.browser', type: 'bool', default: false, scope: 'app', section: 'plugins', order: 15 },
      ],
    });
    await act(async () => root.render(createElement('div', null, createElement(SettingsDialog), createElement(Dialogs))));
    await act(async () => useStore.getState().openSettings({ page: 'plugins' }));
    const search = host.querySelector<HTMLInputElement>('.settings-search input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(search, 'VS Code');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const row = (key: string) => host.querySelector<HTMLElement>(`.setting[data-key="${key}"]`)!;
    expect(row('plugins.vscode.enabled').textContent).toContain(t('settings.plugins.vscode.enabled'));
    expect(row('plugins.vscode.browser').textContent).toContain(t('settings.plugins.vscode.browser.desc'));
    await act(async () => row('plugins.vscode.browser').querySelector<HTMLInputElement>('input')!.click());
    expect(useDialog.getState().current?.kind).toBe('risk');
    await cancelRisk();
    await act(async () => {});
    expect(puts).toEqual([]);
    // The desktop app's switch from a browser: no question, nothing on here.
    await act(async () => row('plugins.vscode.enabled').querySelector<HTMLInputElement>('input')!.click());
    expect(useDialog.getState().current).toBeUndefined();
    await vi.waitFor(() => expect(puts).toEqual(['plugins.vscode.enabled']));
    expect(isPluginOn('vscode')).toBe(false);
    await act(async () => useStore.getState().openSettings(false));
  });
});
