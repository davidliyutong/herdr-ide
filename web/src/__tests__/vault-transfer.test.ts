// @vitest-environment jsdom
//
// The vault's export and import dialogs and the variable list's choice
// (plugins/vault) against a stand-in for the core: the core builds the
// export file and reads an import, so the page sends passphrases and the
// file's text and never gets a value; an export asks for the vault's
// passphrase again; an import previews, takes a choice per variable and
// imports in one call; chosen variables are exported, deleted or given
// other machines together.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { t } from '../i18n';
import { APP_SLUG } from '../brand';
import { VaultPanel } from '../plugins/vault/VaultPanel';
import { VaultDialogs } from '../plugins/vault/Transfer';
import { endSession, loadVault, openSession, useVault } from '../plugins/vault/api';
import { openVaultExport, openVaultImport, vaultPlugin } from '../plugins/vault';
import { VaultSettingsExtra } from '../plugins/vault/SettingsExtra';
import { useVaultDialog } from '../plugins/vault/dialogs';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  method: string;
  url: string;
  token?: string;
  body?: Record<string, unknown>;
}

const PASS = 'right passphrase';
const FILE_PASS = 'a long file phrase';
const TOKEN = 'tok-1';
const FILE = '{"format":"x-vault-export","version":1,"ciphertext":"c2VhbGVk"}';

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const type = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const field = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>('.vault-transfer label.vault-field')]
    .find((l) => l.querySelector('span')?.textContent === label)!
    .querySelector('input')!;

const submit = () => document.querySelector<HTMLButtonElement>('.vault-transfer button[type="submit"]')!;

describe('vault files and choices', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let saved: { name: string; text: string }[];
  let vaultStatus: { mode: string; locked: boolean; setup?: boolean };

  beforeEach(async () => {
    calls = [];
    saved = [];
    vaultStatus = { mode: 'passphrase', locked: false };
    await endSession().catch(() => undefined);
    useVault.setState({ status: undefined, variables: [], log: [], requests: {}, error: undefined, session: false });
    useVaultDialog.setState({ dialog: undefined });
    useStore.setState({
      readOnly: false,
      order: ['local', 'gpu'],
      machines: { local: { label: 'This Mac', kind: 'local' }, gpu: { label: 'GPU box' } } as never,
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers['X-Vault-Session'];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, token, body });
      const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
      if (url === '/api/p/vault' && method === 'GET')
        return json({
          status: vaultStatus,
          session: token === TOKEN,
          variables: ['A', 'B', 'C', 'D'].map((name) => ({
            name,
            description: '',
            machines: [],
            injectOnly: false,
            created: '',
            updated: '',
          })),
        });
      if (url === '/api/p/vault/log') return json({ log: [] });
      if (url === '/api/p/vault/requests') return json({ requests: [] });
      if (url === '/api/p/vault/session' && method === 'POST')
        return body.passphrase === PASS
          ? json({ session: TOKEN, status: { mode: 'passphrase', locked: false } })
          : json({ error: 'wrong_passphrase' }, 403);
      if (token !== TOKEN) return json({ error: 'vault_session' }, 401);
      if (url === '/api/p/vault/export') {
        if (body.passphrase !== PASS) return json({ error: 'wrong_passphrase' }, 403);
        return new Response(FILE, { status: 200 });
      }
      if (url === '/api/p/vault/import/preview') {
        if (body.passphrase !== FILE_PASS) return json({ error: 'file_passphrase' }, 400);
        return json({
          exported: '2026-01-02T03:04:05Z',
          variables: [
            { name: 'NEW', description: 'new one', injectOnly: false, machines: ['gpu'], unknown: ['m9'], exists: false },
            { name: 'A', description: '', injectOnly: true, machines: ['*'], exists: true },
            { name: 'B', description: '', injectOnly: false, machines: [], exists: true },
            { name: 'bad-name', description: '', injectOnly: false, machines: [], exists: false, invalid: 'invalid_name' },
          ],
          machines: [
            { id: 'gpu', label: 'GPU box', local: false, known: true },
            { id: 'm9', label: 'old server', local: false, known: false },
          ],
        });
      }
      if (url === '/api/p/vault/import') return json({ imported: ['NEW'] });
      if (url.startsWith('/api/p/vault/vars/')) return url.endsWith('/C') ? json({ error: 'failed' }, 500) : json({ ok: true });
      return json({ error: 'not_found' }, 404);
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, text: this.href });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports the chosen variables once the vault’s passphrase is given again', async () => {
    await act(async () => root.render(createElement(VaultDialogs)));
    await act(async () => openVaultExport(['A', 'C']));
    await flush();
    expect(document.querySelector('.vault-transfer')?.getAttribute('aria-label')).toBe(t('vault.export.title'));
    expect([...document.querySelectorAll('[data-chosen] code')].map((c) => c.textContent)).toEqual(['A', 'C']);
    await act(async () => {
      type(field(t('vault.export.passphrase')), PASS);
      type(field(t('vault.export.filePassphrase')), 'too short');
      type(field(t('vault.passphraseRepeat')), 'too short');
    });
    // Twelve characters at least.
    expect(submit().disabled).toBe(true);
    await act(async () => {
      type(field(t('vault.export.filePassphrase')), FILE_PASS);
      type(field(t('vault.passphraseRepeat')), FILE_PASS + '!');
    });
    await act(async () => submit().click());
    expect(document.querySelector('.vault-transfer .callout.error')?.textContent).toBe(t('vault.error.mismatch'));
    await act(async () => type(field(t('vault.passphraseRepeat')), FILE_PASS));
    await act(async () => submit().click());
    await flush();
    // A page without a session opens one first, with the same passphrase.
    const urls = calls.map((c) => c.url);
    expect(urls.indexOf('/api/p/vault/session')).toBeLessThan(urls.indexOf('/api/p/vault/export'));
    const exp = calls.find((c) => c.url === '/api/p/vault/export')!;
    expect(exp).toMatchObject({ method: 'POST', token: TOKEN, body: { passphrase: PASS, filePassphrase: FILE_PASS, names: ['A', 'C'] } });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(new RegExp(`^${APP_SLUG}-vault-\\d{4}-\\d\\d-\\d\\d\\.json$`));
    expect(document.querySelector('.vault-transfer')).toBeNull();
  });

  it('exports all when nothing is chosen, and says why it failed', async () => {
    await openSession(PASS);
    await act(async () => root.render(createElement(VaultDialogs)));
    await act(async () => openVaultExport());
    await flush();
    expect(document.querySelector('.vault-transfer [role="radiogroup"]')).toBeNull();
    await act(async () => {
      type(field(t('vault.export.passphrase')), 'wrong one');
      type(field(t('vault.export.filePassphrase')), FILE_PASS);
      type(field(t('vault.passphraseRepeat')), FILE_PASS);
    });
    await act(async () => submit().click());
    await flush();
    expect(document.querySelector('.vault-transfer .callout.error')?.textContent).toBe(t('vault.error.wrong_passphrase'));
    expect(calls.find((c) => c.url === '/api/p/vault/export')?.body).toMatchObject({ all: true });
    expect(saved).toHaveLength(0);
  });

  it('previews a file without values, takes a choice per variable and imports in one call', async () => {
    await openSession(PASS);
    await act(async () => root.render(createElement(VaultDialogs)));
    await act(async () => openVaultImport());
    await flush();
    // The page has a session: no vault passphrase is asked.
    expect(document.querySelectorAll('.vault-transfer input[type="password"]')).toHaveLength(1);
    const input = document.querySelector<HTMLInputElement>('[data-field="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([FILE], 'vault.json', { type: 'application/json' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    await act(async () => type(field(t('vault.import.filePassphrase')), 'wrong phrase'));
    await act(async () => submit().click());
    await flush();
    expect(document.querySelector('.vault-transfer .callout.error')?.textContent).toBe(t('vault.error.file_passphrase'));
    await act(async () => type(field(t('vault.import.filePassphrase')), FILE_PASS));
    await act(async () => submit().click());
    await flush();
    expect(calls.filter((c) => c.url === '/api/p/vault/import/preview').at(-1)?.body).toEqual({ file: FILE, passphrase: FILE_PASS });

    const rows = [...document.querySelectorAll<HTMLElement>('.vault-import-row')];
    expect(rows.map((r) => r.dataset.name)).toEqual(['NEW', 'A', 'B', 'bad-name']);
    const select = (i: number) => rows[i].querySelector<HTMLSelectElement>('select')!;
    // New names import, taken ones and invalid ones are skipped at first.
    expect([0, 1, 2, 3].map((i) => select(i).value)).toEqual(['import', 'skip', 'skip', 'skip']);
    expect([...select(3).options].map((o) => o.value)).toEqual(['skip', 'rename']);
    expect(rows[0].textContent).toContain('GPU box');
    expect(rows[0].querySelector('[data-unknown]')?.textContent).toContain('old server');
    // Names that exist: overwrite them all; then rename one of them.
    const bulk = document.querySelector<HTMLSelectElement>(`select[aria-label="${t('vault.import.existing')}"]`)!;
    await act(async () => {
      bulk.value = 'overwrite';
      bulk.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect([1, 2].map((i) => select(i).value)).toEqual(['overwrite', 'overwrite']);
    await act(async () => {
      select(2).value = 'rename';
      select(2).dispatchEvent(new Event('change', { bubbles: true }));
    });
    // A taken name is refused before anything is sent.
    const as = rows[2].querySelector<HTMLInputElement>('input.input')!;
    await act(async () => type(as, 'C'));
    expect(rows[2].querySelector('.error')?.textContent).toBe(t('vault.error.exists'));
    expect(submit().disabled).toBe(true);
    await act(async () => type(as, 'B_IMPORTED'));
    expect(submit().textContent).toContain(t('vault.import.button', { n: 3 }));
    await act(async () => submit().click());
    await flush();
    expect(calls.find((c) => c.url === '/api/p/vault/import')?.body).toEqual({
      file: FILE,
      passphrase: FILE_PASS,
      choices: [
        { i: 0, action: 'import' },
        { i: 1, action: 'overwrite' },
        { i: 2, action: 'rename', as: 'B_IMPORTED' },
        { i: 3, action: 'skip' },
      ],
    });
    expect(document.querySelector('.vault-transfer')).toBeNull();
    expect(JSON.stringify(calls)).not.toContain('value');
  });

  it('chooses variables (all, a range with shift) and deletes or changes them together', async () => {
    await openSession(PASS);
    await act(async () => root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultDialogs))));
    await flush();
    const check = (name: string) => host.querySelector<HTMLInputElement>(`[data-name="${name}"] .vault-row-check`)!;
    await act(async () => check('A').click());
    await act(async () => check('C').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.querySelector('.vault-select-bar')?.getAttribute('data-selected')).toBe('3');
    expect(['A', 'B', 'C', 'D'].map((n) => check(n).checked)).toEqual([true, true, true, false]);
    const all = host.querySelector<HTMLInputElement>(`.vault-select-bar input[type="checkbox"]`)!;
    expect(all.indeterminate).toBe(true);
    await act(async () => all.click());
    expect(host.querySelector('.vault-select-bar')?.getAttribute('data-selected')).toBe('4');
    await act(async () => all.click());
    expect(host.querySelector('.vault-select-bar')?.getAttribute('data-selected')).toBe('0');

    // Export the chosen.
    await act(async () => check('B').click());
    await act(async () => check('D').click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="export"]')!.click());
    expect(useVaultDialog.getState().dialog).toEqual({ kind: 'export', names: ['B', 'D'] });
    act(() => useVaultDialog.setState({ dialog: undefined }));

    // Who may read them: all machines, one call each.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="access"]')!.click());
    const dlg = document.querySelector<HTMLFormElement>('.vault-editor')!;
    await act(async () => dlg.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].click());
    await act(async () => dlg.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual(['/api/p/vault/vars/B', '/api/p/vault/vars/D']);
    for (const p of puts) expect(p.body).toEqual({ machines: ['*'] });

    // Delete them after a confirmation; one that fails is named.
    await act(async () => check('C').click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="delete"]')!.click());
    const confirm = useDialog.getState().current;
    expect(confirm?.kind).toBe('confirm');
    await act(async () => {
      if (confirm?.kind === 'confirm') confirm.resolve(true);
    });
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/p/vault/vars/B',
      '/api/p/vault/vars/D',
      '/api/p/vault/vars/C',
    ]);
    expect(host.querySelector('.callout.error')?.textContent).toContain(`C: ${t('vault.error.failed')}`);
  });

  it("ends the vault's settings page with Import and Export, which a locked vault takes too", async () => {
    expect(vaultPlugin.settings).toEqual({ section: 'vault', extra: VaultSettingsExtra });
    vaultStatus = { mode: 'passphrase', locked: true };
    await act(async () =>
      root.render(createElement('div', null, createElement(VaultSettingsExtra, { readOnly: false }), createElement(VaultDialogs))),
    );
    await flush();
    const button = (a: string) => host.querySelector<HTMLButtonElement>(`[data-vault-files] [data-action="${a}"]`)!;
    expect(host.querySelector('[data-vault-files] [data-note]')).toBeNull();
    // Locked, the dialogs ask for the passphrase, which unlocks it.
    expect(button('import').disabled).toBe(false);
    await act(async () => button('export').click());
    expect(useVaultDialog.getState().dialog).toEqual({ kind: 'export', names: undefined });
    expect(document.querySelector('.vault-transfer')?.getAttribute('aria-label')).toBe(t('vault.export.title'));
    act(() => useVaultDialog.setState({ dialog: undefined }));
    await act(async () => button('import').click());
    expect(useVaultDialog.getState().dialog).toEqual({ kind: 'import' });
    act(() => useVaultDialog.setState({ dialog: undefined }));
    // Read-only: both disabled, and said.
    await act(async () => root.render(createElement(VaultSettingsExtra, { readOnly: true })));
    await flush();
    expect(button('import').disabled && button('export').disabled).toBe(true);
    expect(host.querySelector('[data-vault-files] [data-note]')?.textContent).toBe(t('vault.readOnly'));
    // A vault without a passphrase yet: nothing to do here.
    vaultStatus = { mode: '', locked: false, setup: true };
    await act(async () => root.render(createElement(VaultSettingsExtra, { readOnly: false })));
    await act(async () => loadVault());
    expect(button('import').disabled).toBe(true);
    expect(host.querySelector('[data-vault-files] [data-note]')?.textContent).toBe(t('vault.settings.setup'));
  });
});
