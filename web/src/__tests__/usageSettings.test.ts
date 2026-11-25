// @vitest-environment jsdom
//
// The AI usage plugin's settings page (plugins/usage/SettingsPage.tsx): its
// own settings, then a list of the providers saying whether each is on; a
// provider's row opens its settings, whose heading leads back; the search,
// a row the dialog is opened at and read-only mode work as on any page.
// The prices are a form: a row per model under the columns' headings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}), retry: () => {} } }));

import { SettingsDialog } from '../components/SettingsDialog';
import { applySettings, builtinDefaults, useSettings, type SettingDef, type SettingState } from '../settings';
import { useStore } from '../state/store';
import { t } from '../i18n';
import { providerPages } from '../plugins/usage/SettingsPage';
import { parsePrices, serializePrices } from '../plugins/usage/PricesEditor';
import { useUsage } from '../plugins/usage/state';
import { fakeSettingsApi } from './fakeSettings';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const usage = (key: string, type: SettingDef['type'], group: string, order: number, extra: Partial<SettingDef> = {}): SettingDef => ({
  key,
  type,
  default: type === 'bool' ? true : type === 'list' ? [] : 'adaptive',
  scope: 'app',
  section: 'usage',
  group,
  order,
  ...extra,
});

// As backend/features/usage declares them.
const defs: SettingDef[] = [
  usage('usage.refresh', 'enum', 'usageRefresh', 10, { enum: ['manual', 'adaptive'] }),
  usage('usage.statusBar', 'bool', 'usageAlerts', 18),
  usage('usage.prices', 'list', 'usageSpend', 22, { item: 'string' }),
  usage('usage.providers.claude', 'bool', 'usageClaude', 30),
  usage('usage.claudeKeychain', 'bool', 'usageClaude', 31),
  usage('usage.providers.codex', 'bool', 'usageCodex', 34),
  usage('usage.codexHomes', 'list', 'usageCodex', 35, { item: 'string' }),
  usage('usage.providers.opencode', 'bool', 'usageOpencode', 54),
  { key: 'plugins.usage.enabled', type: 'bool', default: true, scope: 'app', section: 'plugins', order: 40 },
];

const state = (): Record<string, SettingState> => {
  const out: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) out[k] = { value: v, source: 'default' };
  return out;
};

describe('the AI usage settings page', () => {
  let host: HTMLElement;
  let root: Root;
  const q = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s);
  const providerRow = (p: string) => q<HTMLButtonElement>(`.usage-settings-row[data-provider="${p}"]`)!;
  const shown = (key: string) => q(`[data-key="${key}"]`) !== null;
  /** A provider's row as it reads: its name and whether it is on. */
  const says = (p: string) => [...providerRow(p).querySelectorAll('span:not(.ai-logo)')].map((s) => s.textContent);

  const open = async (view: { page?: string; row?: string }, values = state(), readOnly = false) => {
    useSettings.setState({
      loaded: true,
      readOnly,
      defs,
      sections: [
        { id: 'plugins', order: 65 },
        { id: 'usage', order: 68, plugin: 'usage' },
      ],
      values,
      problems: [],
      file: '',
    });
    await act(async () => root.render(createElement(SettingsDialog)));
    await act(async () => useStore.getState().openSettings(view));
  };

  beforeEach(() => {
    fakeSettingsApi();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => useStore.getState().openSettings(false));
    await act(async () => root.unmount());
    host.remove();
    applySettings({ values: state(), problems: [] });
    vi.unstubAllGlobals();
  });

  it('groups each provider’s settings, its switch first', () => {
    expect(providerPages(defs).map((p) => [p.id, p.switch.key, p.defs.map((d) => d.key)])).toEqual([
      ['claude', 'usage.providers.claude', ['usage.providers.claude', 'usage.claudeKeychain']],
      ['codex', 'usage.providers.codex', ['usage.providers.codex', 'usage.codexHomes']],
      ['opencode', 'usage.providers.opencode', ['usage.providers.opencode']],
    ]);
  });

  it('lists the providers after the other settings, each saying whether it is on', async () => {
    const values = state();
    values['usage.providers.codex'] = { value: false, source: 'global' };
    values['usage.claudeKeychain'] = { value: false, source: 'global' };
    await open({ page: 'usage' }, values);
    expect(shown('usage.refresh') && shown('usage.statusBar') && shown('usage.prices')).toBe(true);
    // The providers' own settings are on their pages.
    expect(shown('usage.providers.claude') || shown('usage.claudeKeychain') || shown('usage.codexHomes')).toBe(false);
    const groups = [...host.querySelectorAll('.settings-group')].map((h) => h.textContent);
    expect(groups).toEqual([
      t('settings.group.usageRefresh'),
      t('settings.group.usageAlerts'),
      t('settings.group.usageSpend'),
      t('settings.group.usageProviders'),
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('.usage-settings-row')];
    expect(rows.map((r) => r.dataset.provider)).toEqual(['claude', 'codex', 'opencode']);
    expect(says('claude')).toEqual([t('usage.provider.claude'), t('settings.on')]);
    expect(says('codex')).toEqual([t('usage.provider.codex'), t('settings.off')]);
    expect(providerRow('codex').classList.contains('off')).toBe(true);
    // A changed setting of a provider marks its row, as a changed row is.
    expect(providerRow('claude').classList.contains('modified')).toBe(true);
    expect(providerRow('opencode').classList.contains('modified')).toBe(false);
  });

  it('opens a provider’s settings and goes back to the list', async () => {
    await open({ page: 'usage' });
    await act(async () => providerRow('claude').click());
    expect(q('.usage-settings-provider')?.dataset.provider).toBe('claude');
    // A page of its own: a Back button, the provider's name, and no header
    // of the plugin (its switch is on the first page).
    expect(q('[data-action="back"]')?.textContent?.trim()).toBe(t('usage.settings.back'));
    expect(q('.usage-settings-title span:not(.ai-logo)')?.textContent).toBe(t('usage.provider.claude'));
    expect(q('[data-key="plugins.usage.enabled"], .plugin-header, .settings-plugin')).toBeNull();
    expect(shown('usage.providers.claude') && shown('usage.claudeKeychain')).toBe(true);
    expect(shown('usage.refresh') || shown('usage.codexHomes') || q('.usage-settings-row') !== null).toBe(false);
    // The heading names the provider: no group heading of its own.
    expect(host.querySelectorAll('.usage-settings-provider .settings-group')).toHaveLength(0);
    // Its switch, set here, shows in the list.
    await act(async () => q<HTMLInputElement>('[data-key="usage.providers.claude"] input[type="checkbox"]')!.click());
    await vi.waitFor(() => expect(useSettings.getState().values['usage.providers.claude']?.value).toBe(false));
    await act(async () => q<HTMLButtonElement>('[data-action="back"]')!.click());
    expect(q('.usage-settings-provider')).toBeNull();
    expect(says('claude')).toEqual([t('usage.provider.claude'), t('settings.off')]);
  });

  it('shows the list again when AI Usage is chosen in the dialog’s list', async () => {
    await open({ page: 'usage' });
    await act(async () => providerRow('codex').click());
    expect(q('.usage-settings-provider')?.dataset.provider).toBe('codex');
    const nav = [...host.querySelectorAll<HTMLButtonElement>('.settings-nav button, nav button')].find(
      (b) => b.textContent?.trim() === t('settings.section.usage'),
    )!;
    await act(async () => nav.click());
    expect(q('.usage-settings-provider')).toBeNull();
    expect(providerRow('codex')).not.toBeNull();
  });

  it('opens at a provider’s setting on that provider’s page', async () => {
    await open({ page: 'usage', row: 'usage.codexHomes' });
    expect(q('.usage-settings-provider')?.dataset.provider).toBe('codex');
    expect(q('[data-key="usage.codexHomes"]')?.classList.contains('asked')).toBe(true);
    // A setting of no provider (the spend's link to the prices): the list.
    await act(async () => useStore.getState().openSettings({ page: 'usage', row: 'usage.prices' }));
    expect(q('.usage-settings-provider')).toBeNull();
    expect(q('[data-key="usage.prices"]')?.classList.contains('asked')).toBe(true);
  });

  it('finds a provider’s settings by search, rows as on any page', async () => {
    await open({ page: 'usage' });
    const input = q<HTMLInputElement>('.settings-search input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'keychain');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(shown('usage.claudeKeychain')).toBe(true);
    expect(q('.usage-settings-row')).toBeNull();
    expect(q('.settings-section .settings-group')?.textContent).toBe(t('settings.group.usageClaude'));
  });

  it('edits the prices as a form of rows under the columns’ headings', async () => {
    const values = state();
    values['usage.prices'] = { value: ['grok-5 3 0.75 9'], source: 'global' };
    useUsage.setState({ cost: { machines: { m: { files: 1, unpriced: ['kimi-k9', 'grok-5'] } } } as never });
    await open({ page: 'usage' }, values);
    const row = () => q('[data-key="usage.prices"]')!;
    const heads = [...row().querySelectorAll('.prices-col-title')].map((e) => e.textContent);
    expect(heads).toEqual(['Model', 'Input', 'Output', 'Cache read', 'Cache write']);
    const cell = (r: number, c: string) => row().querySelectorAll<HTMLInputElement>(`.prices-row input[data-column="${c}"]`)[r];
    // The stored "model input cached output" in its columns.
    expect(['model', 'input', 'output', 'cached', 'cacheWrite'].map((c) => cell(0, c).value)).toEqual(['grok-5', '3', '9', '0.75', '']);
    expect(cell(0, 'cacheWrite').placeholder).toBe(t('usage.prices.cacheWrite.placeholder'));
    const type = async (el: HTMLInputElement, v: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const enter = async (el: HTMLInputElement) =>
      act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const saved = () => useSettings.getState().values['usage.prices']?.value;

    // Edited in place.
    await type(cell(0, 'output'), '12');
    await enter(cell(0, 'output'));
    expect(saved()).toEqual(['grok-5 3 0.75 12']);

    // A model the spend found without a price is offered; the one with a
    // row is not.
    const offers = [...row().querySelectorAll('.prices-suggest')].map((e) => e.textContent);
    expect(offers).toEqual(['kimi-k9']);
    await act(async () => row().querySelector<HTMLButtonElement>('.prices-suggest')!.click());
    expect(cell(1, 'model').value).toBe('kimi-k9');
    expect(document.activeElement).toBe(cell(1, 'input'));
    // Incomplete: said, not saved.
    await type(cell(1, 'input'), '2');
    await enter(cell(1, 'input'));
    expect(row().querySelector('.prices-problem')?.textContent).toBe(t('usage.prices.error.required'));
    expect(saved()).toEqual(['grok-5 3 0.75 12']);
    await type(cell(1, 'output'), '8');
    await enter(cell(1, 'output'));
    // Cache read left empty: the input price.
    expect(saved()).toEqual(['grok-5 3 0.75 12', 'kimi-k9 2 2 8']);
    expect(row().querySelector('.prices-problem')).toBeNull();

    // Removed at once.
    await act(async () =>
      row()
        .querySelector<HTMLButtonElement>(`[aria-label="${t('usage.prices.remove', { model: 'grok-5' })}"]`)!
        .click(),
    );
    expect(saved()).toEqual(['kimi-k9 2 2 8']);
    useUsage.setState({ cost: undefined });
  });

  it('reads and writes the prices’ lines', () => {
    expect(parsePrices(['a 1 0.1 2', ' b  1 0.1 2 1.25 ', ''])).toEqual([
      { model: 'a', input: '1', output: '2', cached: '0.1', cacheWrite: '' },
      { model: 'b', input: '1', output: '2', cached: '0.1', cacheWrite: '1.25' },
    ]);
    const row = (model: string, input: string, output: string, cached = '', cacheWrite = '') => ({
      model,
      input,
      output,
      cached,
      cacheWrite,
    });
    expect(serializePrices([row('a', '1', '2', '0.1'), row('', '', ''), row('b', '1', '2', '', '1.25')])).toEqual([
      'a 1 0.1 2',
      'b 1 1 2 1.25',
    ]);
    expect(serializePrices([row('a', '1', '')])).toBeUndefined();
    expect(serializePrices([row('a', '1', '2'), row('a', '1', '2')])).toBeUndefined();
    expect(serializePrices([row('a b', '1', '2')])).toBeUndefined();
    expect(serializePrices([row('a', '-1', '2')])).toBeUndefined();
    expect(serializePrices([row('a', '1e3', '2')])).toBeUndefined();
    expect(serializePrices([row('a', '10001', '2')])).toBeUndefined();
    expect(serializePrices(Array.from({ length: 51 }, (_, i) => row(`m${i}`, '1', '2')))).toBeUndefined();
  });

  it('shows a read-only hub’s settings without letting them change', async () => {
    await open({ page: 'usage' }, state(), true);
    expect(providerRow('opencode').disabled).toBe(false);
    await act(async () => providerRow('opencode').click());
    expect(q<HTMLInputElement>('[data-key="usage.providers.opencode"] input')!.disabled).toBe(true);
  });
});
