// @vitest-environment jsdom
//
// The variable vault's panel and approval prompts (plugins/vault) against
// a stand-in for the core's routes: values never come with the list; the
// gate (a session opened with the passphrase, sent as X-Vault-Session)
// stands before changes, reveals and approvals, a value is shown only
// after a confirmed reveal, requests are answered once and close on every
// page when resolved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { t } from '../i18n';
import { VaultPanel, passStrength } from '../plugins/vault/VaultPanel';
import { VaultApprovals } from '../plugins/vault/Approvals';
import { endSession, loadVault, openSession, useVault, vaultApi, vaultMessage } from '../plugins/vault/api';
import { mcpCommand, setupSnippets } from '../plugins/vault/setup';
import { pluginMessage } from '../plugins/registry';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  method: string;
  url: string;
  token?: string;
  body?: unknown;
}

const PASS = 'right passphrase';
const TOKEN = 'tok-1';

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('vault', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let status: { mode: string; locked: boolean; setup?: boolean };
  /** Holds the next list's answer until released (a load crossing a session's start). */
  let hold: Promise<void> | undefined;

  beforeEach(async () => {
    calls = [];
    status = { mode: 'passphrase', locked: false };
    hold = undefined;
    await endSession().catch(() => undefined);
    useVault.setState({ status: undefined, variables: [], log: [], requests: {}, error: undefined, session: false });
    useStore.setState({ readOnly: false });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers['X-Vault-Session'];
      calls.push({ method, url, token, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
      const open = token === TOKEN;
      if (url === '/api/p/vault' && method === 'GET') {
        const sent = open;
        if (hold) await hold;
        return json({
          status,
          session: sent,
          variables: [
            { name: 'GITHUB_TOKEN', description: 'for gh', machines: ['*'], injectOnly: false, created: '', updated: '' },
            { name: 'DB_PASS', description: '', machines: [], injectOnly: true, created: '', updated: '' },
          ],
        });
      }
      if (url === '/api/p/vault/log')
        return json({ log: [{ time: '2026-01-01T00:00:00Z', m: 'm1', tool: 'get', names: ['GITHUB_TOKEN'], result: 'approved' }] });
      if (url === '/api/p/vault/requests') return json({ requests: [] });
      if (url === '/api/p/vault/session' && method === 'POST') {
        const b = JSON.parse(String(init!.body));
        return b.passphrase === PASS ? json({ session: TOKEN, idle: 1800, status }) : json({ error: 'wrong_passphrase' }, 403);
      }
      if (url === '/api/p/vault/session') return json({ ok: true });
      if (url === '/api/p/vault/passphrase') return json({ session: TOKEN, idle: 1800, status: { mode: 'passphrase', locked: false } });
      const answer = url.startsWith('/api/p/vault/requests/') ? JSON.parse(String(init!.body)).answer : '';
      if (answer === 'deny') return json({ ok: true });
      // The gate.
      if (!open) return json({ error: 'vault_session' }, 401);
      if (url.endsWith('/reveal')) return json({ value: 'ghp_secret' });
      if (url.startsWith('/api/p/vault/vars/') && method === 'PUT') return json({});
      if (url.endsWith('/rename')) return json({ ok: true });
      if (answer) return json({ ok: true });
      return json({ error: 'not_found' }, 404);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const unlock = async (passphrase = PASS) => {
    const field = host.querySelector<HTMLInputElement>(`.vault-gate input[aria-label="${t('vault.passphrase')}"]`)!;
    await act(async () => type(field, passphrase));
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-gate button[type="submit"]')!.click());
    await flush();
  };

  it('lists variables without values; behind the gate reveals one after confirming', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    const names = [...host.querySelectorAll<HTMLElement>('.vault-row')].map((r) => r.dataset.name);
    expect(names).toEqual(['GITHUB_TOKEN', 'DB_PASS']);
    expect(host.textContent).not.toContain('ghp_secret');
    expect(host.textContent).toContain(t('vault.injectOnly.badge'));
    expect(host.querySelector('.vault-access.all')).not.toBeNull();
    expect(host.querySelector('.vault-access.ask')).not.toBeNull();
    // Without a session nothing can be revealed, edited or added.
    expect(host.querySelector<HTMLButtonElement>('[data-action="reveal"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-action="edit"]')!.disabled).toBe(true);
    await unlock('wrong one');
    expect(host.querySelector('.vault-gate .callout.error')?.textContent).toBe(t('vault.error.wrong_passphrase'));
    await unlock();
    expect(useVault.getState().session).toBe(true);
    expect(host.querySelector('.vault-session')).not.toBeNull();

    const reveal = host.querySelector<HTMLButtonElement>('[data-name="GITHUB_TOKEN"] [data-action="reveal"]')!;
    await act(async () => reveal.click());
    // Nothing is fetched before the confirmation.
    expect(calls.some((c) => c.url.endsWith('/reveal'))).toBe(false);
    const dlg = useDialog.getState().current;
    expect(dlg?.kind).toBe('confirm');
    await act(async () => {
      if (dlg?.kind === 'confirm') dlg.resolve(true);
    });
    await flush();
    const call = calls.find((c) => c.url.endsWith('/reveal'));
    expect(call).toMatchObject({ method: 'POST', token: TOKEN });
    expect(host.querySelector('.vault-value')?.textContent).toContain('ghp_secret');

    // Search narrows the list.
    await act(async () => type(host.querySelector<HTMLInputElement>('input[type="search"]')!, 'db'));
    expect([...host.querySelectorAll<HTMLElement>('.vault-row')].map((r) => r.dataset.name)).toEqual(['DB_PASS']);
  });

  it('adds a variable with its value, machines and flag', async () => {
    useStore.setState({
      order: ['local', 'gpu'],
      machines: { local: { label: 'Local', kind: 'local' }, gpu: { label: 'GPU box' } } as never,
    });
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await unlock();
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(t('vault.add')))!.click(),
    );
    const form = document.querySelector<HTMLFormElement>('.vault-editor')!;
    const [name, value] = [...form.querySelectorAll<HTMLInputElement>('input.input')];
    await act(async () => {
      type(name, 'OPENAI_API_KEY');
      type(form.querySelector('textarea')!, 'OpenAI');
      type(value, 'sk-1');
    });
    expect(value.type).toBe('password');
    // Chosen machines: the GPU box; inject only.
    await act(async () => form.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click());
    await act(async () => form.querySelectorAll<HTMLInputElement>('.vault-machine input[type="checkbox"]')[1].click());
    await act(async () => form.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ url: '/api/p/vault/vars/OPENAI_API_KEY', token: TOKEN });
    expect(put?.body).toEqual({ description: 'OpenAI', machines: ['gpu'], injectOnly: true, value: 'sk-1' });
    expect(document.querySelector('.vault-editor')).toBeNull();
  });

  it('renames a variable, then saves what else changed under its new name', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await unlock();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="DB_PASS"] [data-action="edit"]')!.click());
    const form = document.querySelector<HTMLFormElement>('.vault-editor')!;
    const name = form.querySelector<HTMLInputElement>('input.input')!;
    await act(async () => type(name, 'DATABASE_PASSWORD'));
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    const rename = calls.findIndex((c) => c.url.endsWith('/rename'));
    expect(calls[rename]).toMatchObject({ method: 'POST', url: '/api/p/vault/vars/DB_PASS/rename', body: { to: 'DATABASE_PASSWORD' } });
    const put = calls.findIndex((c) => c.method === 'PUT');
    expect(put).toBeGreaterThan(rename);
    expect(calls[put].url).toBe('/api/p/vault/vars/DATABASE_PASSWORD');
    // No new value was typed: none is sent; ask every time is no machine.
    expect(calls[put].body).not.toHaveProperty('value');
    expect(calls[put].body).toMatchObject({ machines: [] });
  });

  it('creates the passphrase of a new vault', async () => {
    status = { mode: '', locked: false, setup: true };
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    expect(host.querySelector('.vault-gate')?.textContent).toContain(t('vault.gate.create.title'));
    const [pass, repeat] = [...host.querySelectorAll<HTMLInputElement>('.vault-gate input[type="password"]')];
    await act(async () => {
      type(pass, 'a good long phrase');
      type(repeat, 'a different phrase');
    });
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-gate button[type="submit"]')!.click());
    expect(host.querySelector('.vault-gate .callout.error')?.textContent).toBe(t('vault.error.mismatch'));
    await act(async () => type(repeat, 'a good long phrase'));
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-gate button[type="submit"]')!.click());
    await flush();
    expect(calls.find((c) => c.url === '/api/p/vault/passphrase')?.body).toEqual({ passphrase: 'a good long phrase' });
    expect(useVault.getState().session).toBe(true);
    expect(passStrength('short')).toBe(0);
    expect(passStrength('longerone')).toBe(1);
    expect(passStrength('longer one')).toBe(2);
    expect(passStrength('Longer One 12!')).toBe(4);
  });

  // A load that crossed the session's start (its answer, without the
  // token, comes after the session opened) does not end it.
  it('keeps a session a stale load says nothing of', async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const load = loadVault();
    hold = undefined;
    await openSession(PASS);
    release();
    await load;
    expect(useVault.getState().session).toBe(true);
    await vaultApi.reveal('GITHUB_TOKEN');
    expect(calls.find((c) => c.url.endsWith('/reveal'))?.token).toBe(TOKEN);
  });

  it('cannot reveal or answer in read-only mode', async () => {
    useStore.setState({ readOnly: true });
    await act(async () => root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultApprovals))));
    await flush();
    expect(host.querySelector<HTMLButtonElement>('[data-action="reveal"]')!.disabled).toBe(true);
    act(() => vaultMessage('m1', { type: 'request', request: { id: 'r1', m: 'm1', tool: 'get', names: ['X'], created: '', expires: '' } }));
    expect(document.querySelector('[data-answer]')).toBeNull();
    expect(document.body.textContent).toContain('read-only');
    act(() => vaultMessage('m1', { type: 'resolved', id: 'r1', answer: 'deny' }));
  });

  it('asks for the passphrase to allow a request; denies without; closes on every page', async () => {
    useStore.setState({ machines: { m1: { label: 'gpu-box' } } as never });
    await act(async () => root.render(createElement(VaultApprovals)));
    await flush();
    expect(document.querySelector('.vault-approvals')).toBeNull();
    const request = { id: 'r1', m: 'm1', tool: 'env', names: ['A', 'B'], client: 'claude', terminal: 't7', created: '1', expires: '2' };
    act(() => pluginMessage('vault', 'm1', { type: 'request', request }));
    const card = document.querySelector<HTMLElement>('.vault-approvals [data-request="r1"]')!;
    expect(card.textContent).toContain('claude on gpu-box asks to run a command with A, B.');
    expect(card.textContent).toContain('t7');
    expect(card.querySelector('[data-note="local"]')).toBeNull();
    // Allowing needs the passphrase on a page without a session.
    const always = card.querySelector<HTMLButtonElement>('[data-answer="always"]')!;
    expect(always.disabled).toBe(true);
    await act(async () => type(card.querySelector<HTMLInputElement>('input[type="password"]')!, PASS));
    await act(async () => always.click());
    await flush();
    const answer = calls.find((c) => c.url === '/api/p/vault/requests/r1');
    expect(answer).toMatchObject({ token: TOKEN, body: { answer: 'always' } });
    expect(calls.findIndex((c) => c.url === '/api/p/vault/session')).toBeLessThan(calls.indexOf(answer!));
    expect(document.querySelector('.vault-approvals')).toBeNull();

    // Denying needs no session.
    await endSession();
    act(() => vaultMessage('m1', { type: 'request', request: { ...request, id: 'r4' } }));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-request="r4"] [data-answer="deny"]')!.click());
    await flush();
    expect(calls.find((c) => c.url === '/api/p/vault/requests/r4')?.body).toEqual({ answer: 'deny' });

    // Answered on another page: the core says it is resolved.
    act(() => vaultMessage('m1', { type: 'request', request: { ...request, id: 'r2' } }));
    expect(document.querySelector('[data-request="r2"]')).not.toBeNull();
    act(() => vaultMessage('m1', { type: 'resolved', id: 'r2', answer: 'deny' }));
    expect(document.querySelector('[data-request="r2"]')).toBeNull();
  });

  it('says what the local machine may read', async () => {
    useStore.setState({ machines: { local: { label: 'This Mac', kind: 'local' } } as never });
    await act(async () => root.render(createElement(VaultApprovals)));
    await flush();
    act(() =>
      vaultMessage('local', { type: 'request', request: { id: 'r3', m: 'local', tool: 'get', names: ['X'], created: '', expires: '' } }),
    );
    expect(document.querySelector('[data-request="r3"] [data-note="local"]')?.textContent).toBe(t('vault.localNote'));
    act(() => vaultMessage('local', { type: 'resolved', id: 'r3', answer: 'deny' }));
  });

  it('gives each machine its setup', () => {
    expect(mcpCommand({ home: '/home/u', data_dir: '/home/u/.x-dev' })).toBe('/home/u/.x-dev/bin/herdr-ide-mcp');
    expect(mcpCommand({ home: '/Users/me' })).toBe('/Users/me/.herdr-ide/bin/herdr-ide-mcp');
    const s = setupSnippets({ home: '/home/u', data_dir: '/home/u/.herdr-ide' });
    expect(s.claude).toBe('claude mcp add --scope user herdr-ide-vault -- /home/u/.herdr-ide/bin/herdr-ide-mcp');
    expect(s.codex).toBe('[mcp_servers.herdr-ide-vault]\ncommand = "/home/u/.herdr-ide/bin/herdr-ide-mcp"');
    expect(JSON.parse(s.json)).toEqual({
      mcpServers: { 'herdr-ide-vault': { command: '/home/u/.herdr-ide/bin/herdr-ide-mcp', args: [] } },
    });
    expect(setupSnippets({ home: '/home/a b' }).claude).toContain("'/home/a b/.herdr-ide/bin/herdr-ide-mcp'");
  });
});
