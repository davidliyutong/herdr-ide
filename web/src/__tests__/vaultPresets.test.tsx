// @vitest-environment jsdom
//
// Variable Vault groups, presets, workspace preset linking, and automatic
// terminal/chat env injection wiring on the web side.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));
vi.mock('../lib/files', () => ({
  listDir: vi.fn(async (_m: string, path: string) => ({
    dir: { path: path === '~' ? '/home/u' : path, is_dir: true },
    entries: [],
  })),
  formatSize: () => '0 B',
}));

import { useStore } from '../state/store';
import { setTermModel, TermModel, terms, useTerms } from '../state/terms';
import { resetWorkspacePresets, syncVaultWorkspacePresets, workspacePresetIds } from '../state/workspacePresets';
import { editWorkspaceDialog, newWorkspaceDialog, useDialog } from '../dialog';
import { Dialogs } from '../components/Dialogs';
import { t } from '../i18n';
import * as L from '../term/layout';
import { TermConnection } from '../term/connection';
import { VaultPanel } from '../plugins/vault/VaultPanel';
import {
  endSession,
  openSession,
  useVault,
  type VaultGroup,
  type VaultPreset,
  type VaultVariable,
  type VaultWorkspaceLink,
} from '../plugins/vault/api';
import { newChat } from '../plugins/chat/ops';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASS = 'right passphrase';
const TOKEN = 'tok-presets';

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const setInput = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const setSelect = (el: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

describe('vault groups, presets and workspace linking UI', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let variables: VaultVariable[];
  let groups: VaultGroup[];
  let presets: VaultPreset[];
  let workspaceLinks: VaultWorkspaceLink[];
  let locked: boolean;
  let verifyEachAllow: boolean;
  let nextId = 1;

  beforeEach(async () => {
    calls = [];
    nextId = 1;
    locked = false;
    verifyEachAllow = false;
    variables = [
      { name: 'OPENAI_API_KEY', description: 'OpenAI', machines: [], injectOnly: false, created: '1', updated: '1' },
      { name: 'DB_URL', description: 'Postgres', machines: [], injectOnly: false, created: '1', updated: '1' },
    ];
    groups = [];
    presets = [];
    workspaceLinks = [];
    await endSession().catch(() => undefined);
    resetWorkspacePresets();
    useVault.setState({
      status: undefined,
      variables: [],
      groups: [],
      presets: [],
      workspaceLinks: [],
      log: [],
      requests: {},
      error: undefined,
      session: false,
    });
    useStore.setState({
      readOnly: false,
      connected: true,
      order: ['m1'],
      machines: { m1: { id: 'm1', label: 'gpu-box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as never },
      toasts: [],
    });
    const layout: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [{ id: 'ws-1', name: 'Backend', cwd: '/srv/app', selected: 0, tabs: [] }],
    };
    useTerms.setState({ connected: true, machines: { m1: { terminals: {}, layout } } });

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const open = headers['X-Vault-Session'] === TOKEN;

      if (url === '/api/p/vault' && method === 'GET') {
        return json({
          status: { mode: 'passphrase', locked },
          session: open,
          variables,
          groups,
          presets,
          workspaceLinks,
          guard: {
            desktop: false,
            webauthn: false,
            authenticators: [],
            ...(open ? { full: true, verifyEachAllow, exempt: [] } : {}),
          },
        });
      }
      if (url === '/api/p/vault/requests') return json({ requests: [] });
      if (url === '/api/p/vault/log') return json({ log: [] });
      if (url === '/api/p/vault/session' && method === 'POST') {
        locked = false;
        return json({ session: TOKEN, status: { mode: 'passphrase', locked: false } });
      }
      if (url === '/api/p/vault/session' && method === 'DELETE') return json({ ok: true });
      if (url === '/api/p/vault/groups' && method === 'POST') {
        const g: VaultGroup = {
          id: `g${nextId++}`,
          name: body.name,
          description: body.description || undefined,
          created: '1',
          updated: '1',
        };
        groups = [...groups, g];
        return json(g);
      }
      if (url.startsWith('/api/p/vault/groups/') && method === 'PUT') {
        const id = decodeURIComponent(url.slice('/api/p/vault/groups/'.length));
        groups = groups.map((g) => (g.id === id ? { ...g, name: body.name ?? g.name, description: body.description ?? g.description } : g));
        return json(groups.find((g) => g.id === id));
      }
      if (url.startsWith('/api/p/vault/groups/') && method === 'DELETE') {
        const id = decodeURIComponent(url.slice('/api/p/vault/groups/'.length));
        groups = groups.filter((g) => g.id !== id);
        variables = variables.map((v) => (v.group === id ? { ...v, group: undefined } : v));
        presets = presets.map((p) => ({ ...p, groups: p.groups.filter((gid) => gid !== id) }));
        return json({ ok: true });
      }
      if (url === '/api/p/vault/groups/assign' && method === 'POST') {
        const g = body.group || undefined;
        variables = variables.map((v) => (body.names.includes(v.name) ? { ...v, group: g } : v));
        return json({ updated: body.names });
      }
      if (url.startsWith('/api/p/vault/vars/') && method === 'PUT') {
        const name = decodeURIComponent(url.slice('/api/p/vault/vars/'.length));
        const cur = variables.find((v) => v.name === name);
        const linkedIds = new Set(workspaceLinks.flatMap((l) => l.presets));
        const groupWidens =
          !!body.group && body.group !== cur?.group && presets.some((p) => linkedIds.has(p.id) && p.groups.includes(body.group));
        const targetName = (body.to as string | undefined) || name;
        const varWidens = (!cur || targetName !== name) && presets.some((p) => linkedIds.has(p.id) && p.variables.includes(targetName));
        if (verifyEachAllow && (groupWidens || varWidens) && body.passphrase !== PASS) {
          return json({ error: 'vault_proof' }, 401);
        }
        if (cur) {
          variables = variables.map((v) =>
            v.name === name
              ? {
                  ...v,
                  name: targetName,
                  description: body.description ?? v.description,
                  group: body.group !== undefined ? body.group || undefined : v.group,
                }
              : v,
          );
          return json(variables.find((v) => v.name === targetName));
        }
        const created: VaultVariable = {
          name,
          description: body.description ?? '',
          group: body.group || undefined,
          machines: body.machines ?? [],
          injectOnly: !!body.injectOnly,
          created: '1',
          updated: '1',
        };
        variables = [...variables, created];
        return json(created);
      }
      if (url === '/api/p/vault/presets' && method === 'POST') {
        const p: VaultPreset = {
          id: `p${nextId++}`,
          name: body.name,
          description: body.description || undefined,
          variables: body.variables ?? [],
          groups: body.groups ?? [],
          created: '1',
          updated: '1',
        };
        presets = [...presets, p];
        return json(p);
      }
      if (url.startsWith('/api/p/vault/presets/') && method === 'PUT') {
        const id = decodeURIComponent(url.slice('/api/p/vault/presets/'.length));
        presets = presets.map((p) =>
          p.id === id
            ? {
                ...p,
                name: body.name ?? p.name,
                description: body.description ?? p.description,
                variables: body.variables ?? p.variables,
                groups: body.groups ?? p.groups,
              }
            : p,
        );
        return json(presets.find((p) => p.id === id));
      }
      if (url.startsWith('/api/p/vault/presets/') && method === 'DELETE') {
        const id = decodeURIComponent(url.slice('/api/p/vault/presets/'.length));
        presets = presets.filter((p) => p.id !== id);
        workspaceLinks = workspaceLinks
          .map((l) => ({ ...l, presets: l.presets.filter((pid) => pid !== id) }))
          .filter((l) => l.presets.length > 0);
        return json({ ok: true });
      }
      if (url.startsWith('/api/p/vault/workspaces/') && method === 'PUT') {
        const rest = url.slice('/api/p/vault/workspaces/'.length).split('/');
        const machine = decodeURIComponent(rest[0]);
        const workspace = decodeURIComponent(rest[1]);
        workspaceLinks = workspaceLinks.filter((l) => !(l.machine === machine && l.workspace === workspace));
        const link = body.presets?.length ? { machine, workspace, presets: body.presets, updated: '1' } : null;
        if (link) workspaceLinks = [...workspaceLinks, link];
        return json({ link });
      }
      return json({}, 404);
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useDialog.setState({ current: undefined });
    resetWorkspacePresets();
    vi.unstubAllGlobals();
  });

  it('creates, renames, filters, assigns variables to, and deletes groups with ungrouped fallback', async () => {
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // Create a group from the toolbar.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="add-group"]')!.click());
    const nameInput = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    act(() => setInput(nameInput, 'LLM'));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(groups).toHaveLength(1);
    expect(host.querySelector('[data-group-filter="g1"]')?.textContent).toContain('LLM');
    expect(host.querySelector('[data-group-section="g1"]')).not.toBeNull();
    expect(host.querySelector('[data-group-section="__ungrouped__"]')).not.toBeNull();

    // Assign OPENAI_API_KEY to LLM via the variable editor.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="OPENAI_API_KEY"] [data-action="edit"]')!.click());
    const groupSelect = document.querySelector<HTMLSelectElement>(`[role="dialog"] select[aria-label="${t('vault.group')}"]`)!;
    act(() => setSelect(groupSelect, 'g1'));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'OPENAI_API_KEY')?.group).toBe('g1');

    // Filter to the LLM group: only OPENAI_API_KEY is shown.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-filter="g1"]')!.click());
    expect([...host.querySelectorAll<HTMLElement>('[data-name]')].map((el) => el.dataset.name)).toEqual(['OPENAI_API_KEY']);

    // Filter to Ungrouped: only DB_URL is shown.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-filter="ungrouped"]')!.click());
    expect([...host.querySelectorAll<HTMLElement>('[data-name]')].map((el) => el.dataset.name)).toEqual(['DB_URL']);

    // Bulk move DB_URL into LLM.
    await act(async () => host.querySelector<HTMLInputElement>('[data-name="DB_URL"] .vault-row-check')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="group"]')!.click());
    const bulkSel = document.querySelector<HTMLSelectElement>(`[role="dialog"] select[aria-label="${t('vault.group')}"]`)!;
    act(() => setSelect(bulkSel, 'g1'));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.every((v) => v.group === 'g1')).toBe(true);

    // Switch back to All, rename group, then delete group -> variables fall back to ungrouped.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-filter="all"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-section="g1"] [data-action="edit-group"]')!.click());
    const renameInput = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    act(() => setInput(renameInput, 'AI Keys'));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(groups[0].name).toBe('AI Keys');

    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-section="g1"] [data-action="delete-group"]')!.click());
    act(() => {
      const req = useDialog.getState().current;
      if (req?.kind === 'confirm') {
        useDialog.setState({ current: undefined });
        req.resolve(true);
      }
    });
    await flush();
    expect(groups).toEqual([]);
    expect(variables.every((v) => v.group === undefined)).toBe(true);
  });

  it('creates, edits (with missing-var cleanup), links workspaces, and deletes presets', async () => {
    groups = [{ id: 'g1', name: 'AI', created: '1', updated: '1' }];
    variables = [
      { name: 'OPENAI_API_KEY', description: 'OpenAI', machines: [], injectOnly: false, group: 'g1', created: '1', updated: '1' },
      { name: 'DB_URL', description: 'Postgres', machines: [], injectOnly: false, created: '1', updated: '1' },
    ];
    presets = [
      {
        id: 'p1',
        name: 'Backend Env',
        description: 'API + DB',
        groups: ['g1'],
        variables: ['DB_URL', 'DELETED_KEY'],
        created: '1',
        updated: '1',
      },
    ];

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // Open Presets tab.
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][data-tab="presets"]')!.click());
    const card = host.querySelector<HTMLElement>('[data-preset="p1"]')!;
    expect(card.textContent).toContain('Backend Env');
    expect(card.textContent).toContain('DELETED_KEY');
    expect(card.querySelector('.vault-missing-tag')).not.toBeNull();

    // Edit preset and remove missing variables in one click.
    await act(async () => card.querySelector<HTMLButtonElement>('[data-action="edit-preset"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-action="remove-missing"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(presets[0].variables).toEqual(['DB_URL']);

    // Link Backend Env preset to workspace m1/ws-1.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="link-preset"]')!.click());
    const checkbox = document.querySelector<HTMLInputElement>('.vault-link-option input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(workspacePresetIds('m1', 'ws-1')).toEqual(['p1']);
    expect(host.querySelector('[data-preset="p1"] .vault-link-chip')?.textContent).toContain('gpu-box · Backend');

    // Delete preset unlinks it from workspaces.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="delete-preset"]')!.click());
    act(() => {
      const req = useDialog.getState().current;
      if (req?.kind === 'confirm') {
        useDialog.setState({ current: undefined });
        req.resolve(true);
      }
    });
    await flush();
    expect(presets).toEqual([]);
    expect(workspacePresetIds('m1', 'ws-1')).toEqual([]);
  });

  it('offers preset selection in workspace dialogs (respecting unlock and verifyEachAllow)', async () => {
    syncVaultWorkspacePresets({
      variables: [{ name: 'API_KEY' }],
      presets: [{ id: 'p1', name: 'Prod API', variables: ['API_KEY'], groups: [] }],
      workspaceLinks: [],
      locked: false,
      session: true,
      verifyEachAllow: true,
    });
    await act(async () => root.render(createElement(Dialogs)));

    const pending = newWorkspaceDialog('m1', '/srv/app');
    await flush();
    const pickerBtn = document.querySelector<HTMLButtonElement>(`.picker-button[aria-label="${t('vault.workspace.presets')}"]`)!;
    expect(pickerBtn.disabled).toBe(false);
    await act(async () => pickerBtn.click());
    await act(async () => document.querySelector<HTMLElement>('.picker-row')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('.picker-footer .primary')!.click());
    // verifyEachAllow asks for passphrase when linking a preset.
    const passInput = document.querySelector<HTMLInputElement>('[data-field="workspace-preset-passphrase"]')!;
    expect(passInput).not.toBeNull();
    const submitBtn = document.querySelector<HTMLButtonElement>('.dialog-actions .primary')!;
    expect(submitBtn.disabled).toBe(true);
    act(() => setInput(passInput, PASS));
    expect(submitBtn.disabled).toBe(false);
    await act(async () => submitBtn.click());
    expect(await pending).toEqual({ cwd: '/srv/app', label: '', presets: ['p1'], passphrase: PASS });

    // When session is closed, picker is disabled in edit dialog.
    syncVaultWorkspacePresets({
      variables: [{ name: 'API_KEY' }],
      presets: [{ id: 'p1', name: 'Prod API', variables: ['API_KEY'], groups: [] }],
      workspaceLinks: [{ machine: 'm1', workspace: 'ws-1', presets: ['p1'] }],
      locked: true,
      session: false,
      verifyEachAllow: false,
    });
    const edit = editWorkspaceDialog('m1', '/srv/app', 'Backend', 'ws-1');
    await flush();
    const lockedBtn = document.querySelector<HTMLButtonElement>(`.picker-button[aria-label="${t('vault.workspace.presets')}"]`)!;
    expect(lockedBtn.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click());
    expect(await edit).toEqual({ cwd: '/srv/app', label: 'Backend' });
  });

  it('prompts for passphrase directly (never POST /proof) when creating a new variable into a linked group or linked preset name under verifyEachAllow', async () => {
    verifyEachAllow = true;
    groups = [{ id: 'g1', name: 'AI', created: '1', updated: '1' }];
    presets = [{ id: 'p1', name: 'Prod', groups: ['g1'], variables: ['MISSING_REF'], created: '1', updated: '1' }];
    workspaceLinks = [{ machine: 'm1', workspace: 'ws-1', presets: ['p1'], updated: '1' }];

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // 1. New variable created directly into a group belonging to a linked preset.
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-toolbar .primary')!.click());
    const nameIn = document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="API_KEY"]')!;
    const groupSel = document.querySelector<HTMLSelectElement>(`[role="dialog"] select[aria-label="${t('vault.group')}"]`)!;
    const valIn = document.querySelector<HTMLInputElement>('[role="dialog"] input[name="value"]')!;
    act(() => {
      setInput(nameIn, 'NEW_IN_GROUP');
      setSelect(groupSel, 'g1');
      setInput(valIn, 'secret-1');
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    const passIn = document.querySelector<HTMLInputElement>('[data-fresh="change"] input')!;
    expect(passIn).not.toBeNull();
    expect(calls.some((c) => c.url.includes('/proof'))).toBe(false);
    act(() => setInput(passIn, PASS));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'NEW_IN_GROUP')?.group).toBe('g1');

    // 2. New variable created with a name already referenced by a linked preset.
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-toolbar .primary')!.click());
    act(() => {
      setInput(document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="API_KEY"]')!, 'MISSING_REF');
      setInput(document.querySelector<HTMLInputElement>('[role="dialog"] input[name="value"]')!, 'secret-2');
    });
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    const passIn2 = document.querySelector<HTMLInputElement>('[data-fresh="change"] input')!;
    expect(passIn2).not.toBeNull();
    expect(calls.some((c) => c.url.includes('/proof'))).toBe(false);
    act(() => setInput(passIn2, PASS));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.some((v) => v.name === 'MISSING_REF')).toBe(true);
  });
});

describe('panel env injection wiring (terminals and chat)', () => {
  const prevTerms = terms;
  afterEach(() => {
    setTermModel(prevTerms);
    resetWorkspacePresets();
    vi.unstubAllGlobals();
  });

  it('always passes workspace on startup restore and terminal.run (even before vault loads), and warns when locked', async () => {
    const runCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fakeConn = {
      start() {},
      subscribe() {},
      unsubscribe() {},
      call: async (_m: string, method: string, params: Record<string, unknown>) => {
        runCalls.push({ method, params });
        if (method === 'doc.get') {
          return {
            version: 1,
            value: {
              v: 1,
              selected: 0,
              workspaces: [
                {
                  id: 'ws-linked',
                  name: 'A',
                  cwd: '/a',
                  selected: 0,
                  tabs: [{ root: { terminal: 'old1' }, focused: 'old1' }],
                },
              ],
            },
          };
        }
        return { address: 't1', cwd: '/a' };
      },
      onMessage: undefined as ((msg: Record<string, unknown>) => void) | undefined,
      onConnection: undefined as ((up: boolean) => void) | undefined,
    };
    // Startup before GET /api/p/vault has populated workspace preset cache:
    // auto-restore and manual run still send workspace so the hub resolves links authoritatively.
    resetWorkspacePresets();
    useStore.setState({ readOnly: false, toasts: [] });
    const model = new TermModel(fakeConn as unknown as TermConnection);
    setTermModel(model);
    fakeConn.onMessage?.({ t: 'backend', m: 'm1', state: 'ready', version: '1.0' });
    fakeConn.onMessage?.({
      t: 'snapshot',
      m: 'm1',
      terminals: [{ address: 'old1', cwd: '/a', state: 'finished', reason: 'host_shutdown' }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(runCalls.find((c) => c.method === 'terminal.run')?.params.workspace).toBe('ws-linked');

    runCalls.length = 0;
    await model.run('m1', { workspace: 'ws-linked' }, (l, a) => L.openTerminal(l, a, 'ws-linked'));
    expect(runCalls.find((c) => c.method === 'terminal.run')?.params.workspace).toBe('ws-linked');
    expect(useStore.getState().toasts).toEqual([]);

    // Linked + locked: params.workspace is sent and a warning toast is shown.
    runCalls.length = 0;
    useStore.setState({ toasts: [] });
    syncVaultWorkspacePresets({
      variables: [{ name: 'API_KEY' }],
      presets: [{ id: 'p1', name: 'AI', variables: ['API_KEY'], groups: [] }],
      workspaceLinks: [{ machine: 'm1', workspace: 'ws-linked', presets: ['p1'] }],
      locked: true,
      session: false,
      verifyEachAllow: false,
    });
    await model.run('m1', { workspace: 'ws-linked' }, (l, a) => L.openTerminal(l, a, 'ws-linked'));
    expect(runCalls.find((c) => c.method === 'terminal.run')?.params.workspace).toBe('ws-linked');
    expect(useStore.getState().toasts.some((toast) => toast.msg === t('vault.inject.locked'))).toBe(true);
  });

  it('always passes workspace on chat POST /new (even before vault loads) and surfaces locked/missing vault notices', async () => {
    const posted: unknown[] = [];
    let vaultReply: Record<string, unknown> = { injected: 0, locked: true };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/m/m1/p/chat/new') {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            chat: {
              id: 'c0123456789abcdef',
              kind: 'claude',
              title: '',
              cwd: '/a',
              state: 'idle',
              status: 'idle',
              updated: '1',
              seq: 0,
              sessionId: '',
            },
            vault: vaultReply,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const fakeConn = {
      start() {},
      subscribe() {},
      unsubscribe() {},
      call: async (_m: string, method: string) =>
        method === 'doc.get'
          ? { version: 1, value: { v: 1, selected: 0, workspaces: [{ id: 'ws-chat', name: 'Chat', cwd: '/a', selected: 0, tabs: [] }] } }
          : { version: 2 },
      onMessage: undefined as ((msg: Record<string, unknown>) => void) | undefined,
      onConnection: undefined as ((up: boolean) => void) | undefined,
    };
    const model = new TermModel(fakeConn as unknown as TermConnection);
    setTermModel(model);
    fakeConn.onMessage?.({ t: 'backend', m: 'm1', state: 'ready', version: '1.0' });
    fakeConn.onMessage?.({ t: 'snapshot', m: 'm1', terminals: [] });
    await new Promise((r) => setTimeout(r, 0));

    // Even before vault workspace preset snapshot loads, workspace is sent so the hub resolves links.
    resetWorkspacePresets();
    useStore.setState({ readOnly: false, toasts: [], machines: { m1: { id: 'm1', label: 'gpu', info: { home: '/home/u' } } as never } });
    await newChat('m1', 'claude', { cwd: '/a', workspace: 'ws-chat' });
    expect(posted[0]).toMatchObject({ kind: 'claude', cwd: '/a', workspace: 'ws-chat' });
    expect(useStore.getState().toasts.some((toast) => toast.msg === t('vault.inject.locked'))).toBe(true);

    vaultReply = { injected: 1, missing: ['GONE_VAR'] };
    useStore.setState({ toasts: [] });
    await newChat('m1', 'claude', { cwd: '/a', workspace: 'ws-chat' });
    expect(useStore.getState().toasts.some((toast) => toast.msg === t('vault.inject.missing', { names: 'GONE_VAR' }))).toBe(true);
  });
});
