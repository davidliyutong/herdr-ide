// @vitest-environment jsdom
//
// The variable vault's panel and approval prompts (plugins/vault) against
// a stand-in for the core's routes: values never come with the list, a
// value is shown only after a confirmed reveal, requests are answered once
// and close on every page when resolved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { VaultPanel } from '../plugins/vault/VaultPanel';
import { VaultApprovals } from '../plugins/vault/Approvals';
import { useVault, vaultMessage } from '../plugins/vault/api';
import { mcpCommand, setupSnippets } from '../plugins/vault/setup';
import { pluginMessage } from '../plugins/registry';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe('vault', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let locked: boolean;

  beforeEach(() => {
    calls = [];
    locked = false;
    useVault.setState({ status: undefined, variables: [], log: [], requests: {}, error: undefined });
    useStore.setState({ readOnly: false });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (url === '/api/p/vault' && method === 'GET')
        return json({
          status: { mode: 'keychain', locked },
          variables: [
            { name: 'GITHUB_TOKEN', description: 'for gh', machines: ['*'], injectOnly: false, created: '', updated: '' },
            { name: 'DB_PASS', description: '', machines: [], injectOnly: true, created: '', updated: '' },
          ],
        });
      if (url === '/api/p/vault/log')
        return json({ log: [{ time: '2026-01-01T00:00:00Z', m: 'm1', tool: 'get', names: ['GITHUB_TOKEN'], result: 'approved' }] });
      if (url === '/api/p/vault/requests') return json({ requests: [] });
      if (url.endsWith('/reveal')) return json({ value: 'ghp_secret' });
      if (url.startsWith('/api/p/vault/vars/') && method === 'PUT') return json({});
      if (url.startsWith('/api/p/vault/requests/')) return json({ ok: true });
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

  it('lists variables without values and reveals one after confirming', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    const names = [...host.querySelectorAll<HTMLElement>('.vault-row')].map((r) => r.dataset.name);
    expect(names).toEqual(['GITHUB_TOKEN', 'DB_PASS']);
    expect(host.textContent).not.toContain('ghp_secret');
    expect(host.textContent).toContain('inject only');

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
    expect(calls.find((c) => c.url.endsWith('/reveal'))?.method).toBe('POST');
    expect(host.querySelector('.vault-value')?.textContent).toContain('ghp_secret');

    // Search narrows the list.
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(search, 'db');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...host.querySelectorAll<HTMLElement>('.vault-row')].map((r) => r.dataset.name)).toEqual(['DB_PASS']);
  });

  it('adds a variable with its value, machines and flag', async () => {
    useStore.setState({ order: ['local', 'gpu'], machines: { local: { label: 'Local' }, gpu: { label: 'GPU box' } } as never });
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Add Variable"]')!.click());
    const form = host.querySelector<HTMLFormElement>('.vault-editor')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input.vault-input');
    const type = (el: HTMLInputElement, v: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      type(inputs[0], 'OPENAI_API_KEY');
      type(inputs[1], 'OpenAI');
      type(inputs[2], 'sk-1');
    });
    expect(inputs[2].type).toBe('password');
    const boxes = form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      boxes[0].click(); // inject only
      boxes[3].click(); // GPU box
    });
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/p/vault/vars/OPENAI_API_KEY');
    expect(put?.body).toEqual({ description: 'OpenAI', machines: ['gpu'], injectOnly: true, value: 'sk-1' });
  });

  it('cannot reveal or answer in read-only mode', async () => {
    useStore.setState({ readOnly: true });
    await act(async () => root.render(createElement('div', null, createElement(VaultPanel), createElement(VaultApprovals))));
    await flush();
    expect(host.querySelector<HTMLButtonElement>('[data-action="reveal"]')!.disabled).toBe(true);
    act(() => vaultMessage('m1', { type: 'request', request: { id: 'r1', m: 'm1', tool: 'get', names: ['X'], created: '', expires: '' } }));
    expect(document.querySelector('[data-answer]')).toBeNull();
    expect(document.body.textContent).toContain('read-only');
  });

  it('shows a request on every page until it is answered or resolved', async () => {
    useStore.setState({ machines: { m1: { label: 'gpu-box' } } as never });
    await act(async () => root.render(createElement(VaultApprovals)));
    await flush();
    expect(document.querySelector('.vault-approvals')).toBeNull();
    const request = { id: 'r1', m: 'm1', tool: 'env', names: ['A', 'B'], client: 'claude', terminal: 't7', created: '1', expires: '2' };
    act(() => pluginMessage('vault', 'm1', { type: 'request', request }));
    const card = document.querySelector<HTMLElement>('.vault-approvals [data-request="r1"]')!;
    expect(card.textContent).toContain('claude on gpu-box asks to run a command with A, B.');
    expect(card.textContent).toContain('t7');
    await act(async () => card.querySelector<HTMLButtonElement>('[data-answer="always"]')!.click());
    await flush();
    expect(calls.find((c) => c.url === '/api/p/vault/requests/r1')?.body).toEqual({ answer: 'always' });
    expect(document.querySelector('.vault-approvals')).toBeNull();

    // Answered on another page: the core says it is resolved.
    act(() => vaultMessage('m1', { type: 'request', request: { ...request, id: 'r2' } }));
    expect(document.querySelector('[data-request="r2"]')).not.toBeNull();
    act(() => vaultMessage('m1', { type: 'resolved', id: 'r2', answer: 'deny' }));
    expect(document.querySelector('[data-request="r2"]')).toBeNull();
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
