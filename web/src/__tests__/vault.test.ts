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
import { SetupGuide } from '../plugins/vault/SetupGuide';
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
  /** Failures to answer with: of the list, a save, an answer, opening a session. */
  type Failure = { code: number; error: string };
  let listError: Failure | undefined;
  let answerError: Failure | undefined;
  let sessionError: Failure | undefined;
  let failPut: boolean;
  /** The core forgot the session (a restart). */
  let sessionGone: boolean;
  /** The requests GET requests answers. */
  let pending: unknown[];
  /** The access log GET log answers. */
  let accessLog: unknown[];
  /** The auto-lock the list says (the setting's). */
  let autoLock: { after: number; setting: number; lockAt?: string };

  beforeEach(async () => {
    calls = [];
    status = { mode: 'passphrase', locked: false };
    hold = undefined;
    listError = answerError = sessionError = undefined;
    failPut = sessionGone = false;
    pending = [];
    autoLock = { after: 3600, setting: 3600, lockAt: new Date(Date.now() + 59 * 60_000 + 30_000).toISOString() };
    accessLog = [{ time: '2026-01-01T00:00:00Z', m: 'm1', tool: 'get', names: ['GITHUB_TOKEN'], result: 'approved' }];
    await endSession().catch(() => undefined);
    useVault.setState({ status: undefined, variables: [], log: [], requests: {}, error: undefined, session: false });
    useStore.setState({ readOnly: false, connected: false });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers['X-Vault-Session'];
      calls.push({ method, url, token, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
      const fail = (f: Failure) => json(f.error ? { error: f.error } : {}, f.code);
      const open = token === TOKEN && !sessionGone;
      if (url === '/api/p/vault' && method === 'GET') {
        if (listError) return fail(listError);
        const sent = open;
        if (hold) await hold;
        return json({
          status,
          session: sent,
          idle: 600,
          autoLock,
          variables: [
            { name: 'GITHUB_TOKEN', description: 'for gh', machines: ['*'], injectOnly: false, created: '', updated: '' },
            { name: 'DB_PASS', description: '', machines: [], injectOnly: true, created: '', updated: '' },
          ],
        });
      }
      if (url === '/api/p/vault/log') return json({ log: accessLog });
      if (url === '/api/p/vault/requests') return json({ requests: pending });
      if (url === '/api/p/vault/session' && method === 'POST') {
        if (sessionError) return fail(sessionError);
        const b = JSON.parse(String(init!.body));
        sessionGone = false;
        return b.passphrase === PASS ? json({ session: TOKEN, idle: 1800, status }) : json({ error: 'wrong_passphrase' }, 403);
      }
      if (url === '/api/p/vault/session') return json({ ok: true });
      if (url === '/api/p/vault/passphrase') return json({ session: TOKEN, idle: 1800, status: { mode: 'passphrase', locked: false } });
      const answer = url.startsWith('/api/p/vault/requests/') ? JSON.parse(String(init!.body)).answer : '';
      if (answer && answerError) return fail(answerError);
      if (answer === 'deny') return json({ ok: true });
      // The gate.
      if (!open) return json({ error: 'vault_session' }, 401);
      if (url.endsWith('/reveal')) return json({ value: 'ghp_secret' });
      if (url.startsWith('/api/p/vault/vars/') && method === 'PUT') return failPut ? json({ error: 'failed' }, 500) : json({});
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
    // The machines are a searchable choice; it lists each with its state.
    await act(async () => form.querySelector<HTMLButtonElement>('.vault-machines-picker')!.click());
    const rows = [...document.querySelectorAll<HTMLElement>('.picker-row')];
    expect(rows.map((r) => r.querySelector('.picker-label')?.textContent)).toEqual(['Local', 'GPU box']);
    expect(rows[0].textContent).toContain(t('vault.thisComputer'));
    await act(async () => rows[1].click());
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('.picker-search')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('.picker')).toBeNull();
    expect(form.querySelector('.vault-machines-picker')?.textContent).toBe('GPU box');
    await act(async () => form.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ url: '/api/p/vault/vars/OPENAI_API_KEY', token: TOKEN });
    expect(put?.body).toEqual({ description: 'OpenAI', machines: ['gpu'], injectOnly: true, value: 'sk-1' });
    expect(document.querySelector('.vault-editor')).toBeNull();
  });

  it('renames a variable and saves what else changed in one call', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await unlock();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="DB_PASS"] [data-action="edit"]')!.click());
    const form = document.querySelector<HTMLFormElement>('.vault-editor')!;
    const name = form.querySelector<HTMLInputElement>('input.input')!;
    await act(async () => type(name, 'DATABASE_PASSWORD'));
    // The first save fails: nothing changed, and the same save is tried again.
    failPut = true;
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    expect(form.querySelector('.callout.error')?.textContent).toBe(t('vault.error.failed'));
    failPut = false;
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    expect(calls.some((c) => c.url.endsWith('/rename'))).toBe(false);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.url).toBe('/api/p/vault/vars/DB_PASS');
      // No new value was typed: none is sent; ask every time is no machine.
      expect(put.body).not.toHaveProperty('value');
      expect(put.body).toMatchObject({ to: 'DATABASE_PASSWORD', machines: [] });
    }
    expect(document.querySelector('.vault-editor')).toBeNull();
  });

  it('says why the vault did not load, and loads it again on retry', async () => {
    listError = { code: 503, error: 'version' };
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    expect(host.querySelector('[data-error="version"]')?.textContent).toContain(t('vault.error.version'));
    listError = { code: 503, error: 'invalid' };
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-load-error button')!.click());
    await flush();
    expect(host.querySelector('[data-error="invalid"]')?.textContent).toContain(t('vault.load.invalid'));
    // Anything else (the core unreachable) says so too, with the retry.
    listError = { code: 502, error: '' };
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-load-error button')!.click());
    await flush();
    expect(host.querySelector('.vault-load-error')?.textContent).toContain(t('vault.load.failed'));
    listError = undefined;
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-load-error button')!.click());
    await flush();
    expect(host.querySelector('.vault-load-error')).toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('.vault-row')].map((r) => r.dataset.name)).toEqual(['GITHUB_TOKEN', 'DB_PASS']);
    // A core that keeps no file says that, without a retry.
    listError = { code: 503, error: 'unavailable' };
    await act(async () => void loadVault());
    await flush();
    expect(host.textContent).toBe(t('vault.unavailable'));
  });

  it('loads the requests and the vault again when the connection to the core comes back', async () => {
    useStore.setState({ connected: true });
    await act(async () => root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultApprovals))));
    await flush();
    await unlock();
    expect(useVault.getState().session).toBe(true);
    act(() => useStore.setState({ connected: false }));
    // The core restarted meanwhile: the session is gone, a request waits.
    sessionGone = true;
    pending = [{ id: 'r9', m: 'm1', tool: 'get', names: ['X'], created: '1', expires: '2' }];
    calls = [];
    act(() => useStore.setState({ connected: true }));
    await flush();
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/api/p/vault/requests', '/api/p/vault']));
    expect(useVault.getState().session).toBe(false);
    expect(host.querySelector('.vault-gate')?.textContent).toContain(t('vault.gate.unlock.title'));
    expect(document.querySelector('.vault-approvals [data-request="r9"]')).not.toBeNull();
    act(() => vaultMessage('m1', { type: 'resolved', id: 'r9', answer: 'deny' }));
  });

  it('keeps a prompt whose answer failed, and says why; drops one the core no longer has', async () => {
    useStore.setState({ machines: { m1: { label: 'gpu-box' } } as never });
    await act(async () => root.render(createElement(VaultApprovals)));
    await flush();
    const request = { id: 'r5', m: 'm1', tool: 'get', names: ['A'], created: '1', expires: '2' };
    act(() => vaultMessage('m1', { type: 'request', request }));
    answerError = { code: 502, error: '' };
    await act(async () => document.querySelector<HTMLButtonElement>('[data-request="r5"] [data-answer="deny"]')!.click());
    await flush();
    expect(document.querySelector('[data-request="r5"] .callout.error')?.textContent).toBe(t('vault.error.failed'));
    // Allowing without a session: the gate's refusal is said in the prompt.
    await openSession(PASS);
    sessionGone = true;
    answerError = undefined;
    await act(async () => document.querySelector<HTMLButtonElement>('[data-request="r5"] [data-answer="once"]')!.click());
    await flush();
    expect(document.querySelector('[data-request="r5"] .callout.error')?.textContent).toBe(t('vault.error.vault_session'));
    expect(useVault.getState().session).toBe(false);
    // Answered elsewhere or expired: the prompt goes.
    answerError = { code: 404, error: 'not_found' };
    await act(async () => document.querySelector<HTMLButtonElement>('[data-request="r5"] [data-answer="deny"]')!.click());
    await flush();
    expect(document.querySelector('[data-request="r5"]')).toBeNull();
  });

  it('tells a check that waits for another from wrong passphrases', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    sessionError = { code: 429, error: 'busy' };
    await unlock();
    expect(host.querySelector('.vault-gate .callout.error')?.textContent).toBe(t('vault.error.busy'));
    sessionError = { code: 429, error: 'wait' };
    await unlock();
    expect(host.querySelector('.vault-gate .callout.error')?.textContent).toBe(t('vault.error.wait'));
    expect(t('vault.error.busy')).not.toBe(t('vault.error.wait'));
    // A key that cannot be kept in locked memory says so, not "could not".
    sessionError = { code: 503, error: 'memory' };
    await unlock();
    expect(host.querySelector('.vault-gate .callout.error')?.textContent).toBe(t('vault.error.memory'));
    expect(t('vault.error.memory')).not.toBe(t('vault.error.failed'));
  });

  it('shows no auto-lock countdown or time of its own in the session bar', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await unlock();
    const bar = host.querySelector<HTMLElement>('.vault-session')!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.vault-autolock')).toBeNull();
    // Change Passphrase, Lock and Settings: nothing that sets a time.
    expect(bar.querySelectorAll('button')).toHaveLength(3);
    expect(bar.textContent).not.toMatch(/\d+:\d\d/);
    expect(calls.some((c) => c.url === '/api/p/vault/autolock')).toBe(false);
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

  it('shows who asked: the process chain the agent saw, the directory, a page', async () => {
    useStore.setState({ machines: { m1: { label: 'gpu-box' } } as never });
    const chain = [
      { pid: 4242, name: 'veldr-mcp' },
      { pid: 4200, name: 'claude' },
    ];
    accessLog = [
      { id: 3, time: '2026-01-02T10:00:00Z', m: '', tool: 'reveal', names: ['GITHUB_TOKEN'], remote: '127.0.0.1:5555', result: 'revealed' },
      { id: 2, time: '2026-01-02T09:00:00Z', m: 'm1', tool: 'get', names: ['NOPE'], result: 'cancelled', count: 3 },
      {
        id: 1,
        time: '2026-01-02T08:00:00Z',
        m: 'm1',
        tool: 'env',
        names: ['A'],
        client: 'claude',
        cwd: '/srv/app',
        process: chain,
        result: 'allowed',
      },
    ];
    await act(async () => root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultApprovals))));
    await flush();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1].click());
    // Without a session the log is not asked for: the core shows it to a
    // session only.
    expect(calls.some((c) => c.url === '/api/p/vault/log')).toBe(false);
    expect(host.querySelector('.vault-entry')).toBeNull();
    expect(host.textContent).toContain(t('vault.log.needsSession'));
    await act(async () => openSession(PASS));
    await flush();
    expect(calls.find((c) => c.url === '/api/p/vault/log')?.token).toBe(TOKEN);
    const entries = [...host.querySelectorAll<HTMLElement>('.vault-entry')];
    expect(entries.map((e) => e.dataset.result)).toEqual(['revealed', 'cancelled', 'allowed']);
    expect(entries[0].textContent).toContain(t('vault.log.page'));
    expect(entries[0].textContent).toContain('127.0.0.1:5555');
    expect(entries[0].textContent).toContain(t('vault.result.revealed'));
    expect(entries[1].textContent).toContain(t('vault.log.count', { count: 3 }));
    expect(entries[2].textContent).toContain('/srv/app');
    expect(entries[2].querySelector('.vault-entry-process')?.textContent).toBe('veldr-mcp (4242) ← claude (4200)');
    // Pages are a choice of the machine filter.
    const filter = host.querySelector<HTMLButtonElement>(`.picker-button[aria-label="${t('vault.log.machine')}"]`)!;
    expect(filter.textContent).toBe(t('vault.log.allMachines'));
    await act(async () => filter.click());
    const options = [...document.querySelectorAll<HTMLElement>('.picker-row')];
    expect(options.map((o) => o.textContent)).toEqual([t('vault.log.allMachines'), t('vault.log.page'), 'gpu-box']);
    // Pages alone.
    await act(async () => options[1].click());
    expect([...host.querySelectorAll<HTMLElement>('.vault-entry')].map((e) => e.dataset.result)).toEqual(['revealed']);
    // The prompt shows the chain too.
    const request = { id: 'r8', m: 'm1', tool: 'get', names: ['A'], client: 'claude', process: chain, created: '1', expires: '2' };
    act(() => vaultMessage('m1', { type: 'request', request }));
    expect(document.querySelector('[data-request="r8"] [data-meta="process"]')?.textContent).toBe('veldr-mcp (4242) ← claude (4200)');
    act(() => vaultMessage('m1', { type: 'resolved', id: 'r8', answer: 'deny' }));
  });

  it('copies a variable’s name, not its value, without a session', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    const button = host.querySelector<HTMLButtonElement>('[data-name="GITHUB_TOKEN"] .vault-row-head [data-action="copy-name"]')!;
    expect(button.getAttribute('aria-label')).toBe(t('vault.copyName'));
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith('GITHUB_TOKEN');
    expect(calls.some((c) => c.url.endsWith('/reveal'))).toBe(false);
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('says what the local machine may read in its setup, not in every prompt', async () => {
    useStore.setState({ machines: { local: { label: 'This Mac', kind: 'local' } } as never, order: ['local'] });
    await act(async () => root.render(createElement(VaultApprovals)));
    await flush();
    act(() =>
      vaultMessage('local', { type: 'request', request: { id: 'r3', m: 'local', tool: 'get', names: ['X'], created: '', expires: '' } }),
    );
    expect(document.querySelector('[data-request="r3"]')).not.toBeNull();
    expect(document.querySelector('[data-request="r3"] [data-note="local"]')).toBeNull();
    act(() => vaultMessage('local', { type: 'resolved', id: 'r3', answer: 'deny' }));
    await act(async () => root.render(createElement(SetupGuide)));
    expect(host.querySelector('[data-note="local"]')?.textContent).toBe(t('vault.localNote'));
  });

  it('gives each machine its setup', () => {
    expect(mcpCommand({ home: '/home/u', data_dir: '/home/u/.x-dev' })).toBe('/home/u/.x-dev/bin/veldr-mcp');
    expect(mcpCommand({ home: '/Users/me' })).toBe('/Users/me/.veldr/bin/veldr-mcp');
    const s = setupSnippets({ home: '/home/u', data_dir: '/home/u/.veldr' });
    expect(s.claude).toBe('claude mcp add --scope user veldr-vault -- /home/u/.veldr/bin/veldr-mcp');
    expect(s.codex).toBe('[mcp_servers.veldr-vault]\ncommand = "/home/u/.veldr/bin/veldr-mcp"');
    expect(JSON.parse(s.json)).toEqual({
      mcpServers: { 'veldr-vault': { command: '/home/u/.veldr/bin/veldr-mcp', args: [] } },
    });
    expect(setupSnippets({ home: '/home/a b' }).claude).toContain("'/home/a b/.veldr/bin/veldr-mcp'");
  });
});
