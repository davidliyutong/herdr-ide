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
import {
  resetWorkspacePresets,
  saveWorkspacePresets,
  syncVaultWorkspacePresets,
  useWorkspacePresets,
  workspacePresetIds,
} from '../state/workspacePresets';
import { editWorkspaceDialog, newWorkspaceDialog, useDialog } from '../dialog';
import { Dialogs } from '../components/Dialogs';
import { t } from '../i18n';
import * as L from '../term/layout';
import { TermConnection } from '../term/connection';
import { VaultPanel } from '../plugins/vault/VaultPanel';
import {
  endSession,
  loadVault,
  openSession,
  useVault,
  VaultError,
  type VaultGroup,
  type VaultPreset,
  type VaultVariable,
  type VaultWorkspaceLink,
} from '../plugins/vault/api';
import { en as vaultEn } from '../plugins/vault/i18n/en';
import { zhCN as vaultZh } from '../plugins/vault/i18n/zh-CN';
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

const pickerPopup = () => document.body.querySelector<HTMLElement>('.picker');
const pickerSearch = () => pickerPopup()!.querySelector<HTMLInputElement>('.picker-search')!;
const groupPickerButton = () =>
  document.querySelector<HTMLButtonElement>(`[role="dialog"] .picker-button[aria-label="${t('vault.group')}"]`)!;
const pressKey = (key: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
const selectGroup = async (query: string) => {
  await act(async () => groupPickerButton().click());
  act(() => setInput(pickerSearch(), query));
  await act(async () => pickerPopup()!.querySelector<HTMLElement>('.picker-row')!.click());
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

    // Assign OPENAI_API_KEY to LLM via the variable editor's searchable group picker.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="OPENAI_API_KEY"] [data-action="edit"]')!.click());
    expect(document.querySelector('[role="dialog"] select')).toBeNull();
    await selectGroup('LLM');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'OPENAI_API_KEY')?.group).toBe('g1');

    // Filter to the LLM group: only OPENAI_API_KEY is shown.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-filter="g1"]')!.click());
    expect([...host.querySelectorAll<HTMLElement>('[data-name]')].map((el) => el.dataset.name)).toEqual(['OPENAI_API_KEY']);

    // Filter to Ungrouped: only DB_URL is shown.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-filter="ungrouped"]')!.click());
    expect([...host.querySelectorAll<HTMLElement>('[data-name]')].map((el) => el.dataset.name)).toEqual(['DB_URL']);

    // Bulk move DB_URL into LLM via the searchable group picker.
    await act(async () => host.querySelector<HTMLInputElement>('[data-name="DB_URL"] .vault-row-check')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="group"]')!.click());
    expect(document.querySelector('[role="dialog"] select')).toBeNull();
    await selectGroup('LLM');
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
    expect(document.querySelector('[role="dialog"] select')).toBeNull();
    const nameIn = document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="API_KEY"]')!;
    const valIn = document.querySelector<HTMLInputElement>('[role="dialog"] input[name="value"]')!;
    act(() => {
      setInput(nameIn, 'NEW_IN_GROUP');
      setInput(valIn, 'secret-1');
    });
    await selectGroup('AI');
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

  it('uses a searchable group picker in variable editor and bulk move dialogs with filtering, Ungrouped, keyboard navigation, Escape, click-outside, and empty state', async () => {
    groups = [
      { id: 'g1', name: 'Production API', description: 'Live keys', created: '1', updated: '1' },
      { id: 'g2', name: 'LLM Models', description: 'OpenAI and Claude', created: '1', updated: '1' },
      { id: 'g3', name: 'Staging DB', description: 'Test postgres', created: '1', updated: '1' },
    ];
    variables = [
      { name: 'OPENAI_API_KEY', description: 'OpenAI', machines: [], injectOnly: false, created: '1', updated: '1' },
      { name: 'DB_URL', description: 'Postgres', machines: [], injectOnly: false, group: 'g3', created: '1', updated: '1' },
    ];

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // Open Edit Variable dialog for an ungrouped variable: no native <select>.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="OPENAI_API_KEY"] [data-action="edit"]')!.click());
    expect(document.querySelector('[role="dialog"] select')).toBeNull();
    const trigger = groupPickerButton();
    expect(trigger.classList.contains('vault-group-picker')).toBe(true);
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toBe(t('vault.group.none'));

    // Open popover: portaled outside dialog, auto-focused combobox search input, proper ARIA listbox/options.
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const pop = pickerPopup()!;
    expect(pop).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')!.contains(pop)).toBe(false);
    const search = pickerSearch();
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(search.placeholder).toBe(t('vault.group.search'));
    const listbox = pop.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    const initialOptions = [...pop.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(initialOptions).toHaveLength(4);
    expect(initialOptions[0].textContent).toBe(t('vault.group.none'));
    expect(initialOptions[0].getAttribute('aria-selected')).toBe('true');
    expect(initialOptions[0].querySelector('.picker-current')).not.toBeNull();
    expect(initialOptions[0].classList.contains('active')).toBe(true);

    // Case-insensitive filtering by group name and description.
    act(() => setInput(search, 'pRoD'));
    expect([...pop.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.querySelector('.picker-label')!.textContent)).toEqual([
      'Production API',
    ]);
    act(() => setInput(search, 'claude'));
    expect([...pop.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.querySelector('.picker-label')!.textContent)).toEqual([
      'LLM Models',
    ]);

    // Empty search state: clear empty message; Enter does not select or close.
    act(() => setInput(search, 'no-such-group'));
    expect(pop.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(pop.querySelector('.picker-empty')?.textContent).toBe(t('vault.group.noMatch'));
    await pressKey('Enter', search);
    expect(pickerPopup()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Escape closes the picker and restores focus to trigger WITHOUT closing the outer dialog.
    await pressKey('Escape', search);
    expect(pickerPopup()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Keyboard navigation: ArrowDown on closed trigger opens popover; ArrowDown/ArrowUp move active option; Enter selects without submitting.
    await pressKey('ArrowDown', trigger);
    expect(pickerPopup()).not.toBeNull();
    const kbSearch = pickerSearch();
    expect(document.activeElement).toBe(kbSearch);
    const activeLabel = () => pickerPopup()!.querySelector('.picker-row.active .picker-label')?.textContent;
    expect(activeLabel()).toBe(t('vault.group.none'));
    await pressKey('ArrowDown', kbSearch);
    expect(activeLabel()).toBe('Production API');
    expect(kbSearch.getAttribute('aria-activedescendant')).toBe(pickerPopup()!.querySelector('.picker-row.active')!.id);
    await pressKey('ArrowDown', kbSearch);
    expect(activeLabel()).toBe('LLM Models');
    await pressKey('ArrowUp', kbSearch);
    expect(activeLabel()).toBe('Production API');
    await pressKey('ArrowDown', kbSearch);
    expect(activeLabel()).toBe('LLM Models');
    await pressKey('Enter', kbSearch);
    expect(pickerPopup()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(trigger.textContent).toBe('LLM Models');
    expect(document.activeElement).toBe(trigger);

    // Reopen to verify selected checkmark moved to LLM Models, then click outside closes popover without closing dialog.
    await act(async () => trigger.click());
    const selectedOpt = pickerPopup()!.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!;
    expect(selectedOpt.querySelector('.picker-label')?.textContent).toBe('LLM Models');
    expect(selectedOpt.querySelector('.picker-current')).not.toBeNull();
    await act(async () => {
      document.querySelector('.modal-title')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(pickerPopup()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(trigger.textContent).toBe('LLM Models');

    // Save variable with new group.
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'OPENAI_API_KEY')?.group).toBe('g2');

    // Edit a grouped variable (DB_URL in Staging DB) and switch it back to Ungrouped via search + Enter.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="DB_URL"] [data-action="edit"]')!.click());
    expect(groupPickerButton().textContent).toBe('Staging DB');
    await act(async () => groupPickerButton().click());
    expect(pickerPopup()!.querySelector('[role="option"][aria-selected="true"] .picker-label')?.textContent).toBe('Staging DB');
    act(() => setInput(pickerSearch(), t('vault.group.none').toLowerCase()));
    await pressKey('Enter', pickerSearch());
    expect(groupPickerButton().textContent).toBe(t('vault.group.none'));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'DB_URL')?.group).toBeUndefined();

    // Escape when the picker is closed still closes the outer variable editor dialog.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="DB_URL"] [data-action="edit"]')!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await pressKey('Escape', groupPickerButton());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Bulk "Move to Group…" dialog: no native <select>, Escape closes picker only, filter & select moves variables.
    await act(async () => host.querySelector<HTMLInputElement>('[data-name="DB_URL"] .vault-row-check')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="group"]')!.click());
    expect(document.querySelector('[role="dialog"] select')).toBeNull();
    expect(groupPickerButton().textContent).toBe(t('vault.group.none'));
    await act(async () => groupPickerButton().click());
    expect(pickerPopup()).not.toBeNull();
    await pressKey('Escape', pickerSearch());
    expect(pickerPopup()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await selectGroup('stag');
    expect(groupPickerButton().textContent).toBe('Staging DB');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(variables.find((v) => v.name === 'DB_URL')?.group).toBe('g3');
  });

  it('commits fresh vault list when parallel log fetch returns 401 vault_session', async () => {
    await act(async () => openSession(PASS));
    expect(useVault.getState().session).toBe(true);
    locked = true;
    const prevFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/p/vault/log') return new Response(JSON.stringify({ error: 'vault_session' }), { status: 401 });
      if (url === '/api/p/vault' && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            status: { mode: 'passphrase', locked: true },
            session: false,
            variables: [{ name: 'FRESH_VAR', description: '', machines: [], injectOnly: false, created: '1', updated: '1' }],
            groups: [],
            presets: [],
            workspaceLinks: [],
            guard: { desktop: false, webauthn: false, authenticators: [] },
          }),
          { status: 200 },
        );
      }
      return prevFetch(url, init);
    });
    await act(async () => loadVault());
    expect(useVault.getState().status?.locked).toBe(true);
    expect(useVault.getState().session).toBe(false);
    expect(useVault.getState().variables.map((v) => v.name)).toEqual(['FRESH_VAR']);
    expect(useWorkspacePresets.getState().locked).toBe(true);
    expect(useWorkspacePresets.getState().session).toBe(false);
  });

  it('normalizes externally deleted group IDs in variable, bulk-group, and preset editors', async () => {
    groups = [{ id: 'g1', name: 'AI', created: '1', updated: '1' }];
    variables = [
      { name: 'OPENAI_API_KEY', description: 'OpenAI', machines: [], injectOnly: false, group: 'g1', created: '1', updated: '1' },
      { name: 'DB_URL', description: 'Postgres', machines: [], injectOnly: false, created: '1', updated: '1' },
    ];
    presets = [{ id: 'p1', name: 'Prod', groups: ['g1'], variables: ['DB_URL'], created: '1', updated: '1' }];

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // 1. Variable editor: group g1 deleted externally while dialog is open -> submits group: ''.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="OPENAI_API_KEY"] [data-action="edit"]')!.click());
    await act(async () => useVault.setState({ groups: [] }));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(calls.findLast((c) => c.method === 'PUT' && c.url === '/api/p/vault/vars/OPENAI_API_KEY')?.body).toMatchObject({ group: '' });

    // 2. BulkGroup dialog: selected group g1 deleted externally -> submits group: ''.
    await act(async () => useVault.setState({ groups: [{ id: 'g1', name: 'AI', created: '1', updated: '1' }] }));
    await act(async () => host.querySelector<HTMLInputElement>('[data-name="DB_URL"] .vault-row-check')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-bulk="group"]')!.click());
    await selectGroup('AI');
    await act(async () => useVault.setState({ groups: [] }));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(calls.findLast((c) => c.method === 'POST' && c.url === '/api/p/vault/groups/assign')?.body).toMatchObject({ group: '' });

    // 3. PresetEditor: referenced group g1 deleted externally -> submits groups: [].
    await act(async () => useVault.setState({ groups: [{ id: 'g1', name: 'AI', created: '1', updated: '1' }] }));
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][data-tab="presets"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="edit-preset"]')!.click());
    await act(async () => useVault.setState({ groups: [] }));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(calls.findLast((c) => c.method === 'PUT' && c.url === '/api/p/vault/presets/p1')?.body).toMatchObject({ groups: [] });
  });

  it('guards IME composition Escape, uses localized placeholder and pane vocabulary, and dismisses picker before outer modal on backdrop click', async () => {
    groups = [{ id: 'g1', name: 'AI', created: '1', updated: '1' }];
    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // i18n vocabulary checks (P1-36 & Docs P2-5).
    expect(vaultEn['vault.preset.namePlaceholder']).toBe('Production API');
    expect(vaultZh['vault.preset.namePlaceholder']).toBeTruthy();
    expect(vaultEn['vault.preset.empty']).toContain('pane');
    expect(vaultEn['vault.preset.empty']).not.toContain('panel');
    expect(vaultEn['vault.inject.locked']).toContain('pane');
    expect(vaultEn['vault.inject.locked']).not.toContain('panel');
    expect(vaultZh['vault.preset.empty']).toContain('窗格');
    expect(vaultZh['vault.preset.empty']).not.toContain('面板');
    expect(vaultZh['vault.inject.locked']).toContain('窗格');
    expect(vaultZh['vault.inject.locked']).not.toContain('面板');
    expect(vaultZh['vault.preset.linkEmpty']).toContain('侧栏');
    expect(vaultZh['vault.preset.linkEmpty']).not.toContain('侧边栏');

    // Open variable editor, open GroupPicker, click modal backdrop: closes picker only; second click closes modal.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-name="OPENAI_API_KEY"] [data-action="edit"]')!.click());
    await act(async () => groupPickerButton().click());
    expect(pickerPopup()).not.toBeNull();
    const backdrop = document.querySelector<HTMLElement>('.modal-backdrop')!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(pickerPopup()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // IME composing Escape (isComposing or keyCode 229) must not close the dialog.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      const e1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      Object.defineProperty(e1, 'isComposing', { value: true });
      dialog.dispatchEvent(e1);
      const e2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      Object.defineProperty(e2, 'keyCode', { value: 229 });
      dialog.dispatchEvent(e2);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Second backdrop press (with picker closed) dismisses the modal.
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Preset editor uses localized placeholder and guards IME Escape.
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][data-tab="presets"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="add-preset"]')!.click());
    const presetName = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(presetName.placeholder).toBe(t('vault.preset.namePlaceholder'));
    await act(async () => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      Object.defineProperty(e, 'isComposing', { value: true });
      presetName.dispatchEvent(e);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await pressKey('Escape', presetName);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('guards preset deletion while in flight and shows errors on failure', async () => {
    presets = [{ id: 'p1', name: 'Prod', groups: [], variables: ['DB_URL'], created: '1', updated: '1' }];
    let finishDelete!: (r: Response) => void;
    const prevFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/p/vault/presets/p1' && init?.method === 'DELETE') {
        return new Promise<Response>((r) => (finishDelete = r));
      }
      return prevFetch(url, init);
    });

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][data-tab="presets"]')!.click());

    const delBtn = () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="delete-preset"]')!;
    await act(async () => delBtn().click());
    act(() => {
      const req = useDialog.getState().current;
      if (req?.kind === 'confirm') {
        useDialog.setState({ current: undefined });
        req.resolve(true);
      }
    });
    await flush();
    expect(delBtn().disabled).toBe(true);

    await act(async () => finishDelete(new Response(JSON.stringify({ error: 'failed' }), { status: 500 })));
    await flush();
    expect(delBtn().disabled).toBe(false);
    expect(host.querySelector('.callout.error')?.textContent).toBeTruthy();
  });

  it('applies Shift-click range selection in visible grouped order and skips collapsed groups', async () => {
    groups = [
      { id: 'g1', name: 'Alpha', created: '1', updated: '1' },
      { id: 'g2', name: 'Beta', created: '1', updated: '1' },
    ];
    variables = [
      { name: 'Z_VAR', description: '', machines: [], injectOnly: false, group: 'g1', created: '1', updated: '1' },
      { name: 'A_VAR', description: '', machines: [], injectOnly: false, group: 'g2', created: '1', updated: '1' },
      { name: 'B_VAR', description: '', machines: [], injectOnly: false, group: 'g2', created: '1', updated: '1' },
      { name: 'M_VAR', description: '', machines: [], injectOnly: false, created: '1', updated: '1' },
    ];

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();

    // Collapse Beta so A_VAR and B_VAR are hidden; visible order is Z_VAR, M_VAR.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-section="g2"] .vault-group-toggle')!.click());
    const checkOf = (name: string) => host.querySelector<HTMLInputElement>(`[data-name="${name}"] .vault-row-check`)!;
    await act(async () => checkOf('Z_VAR').click());
    await act(async () => {
      checkOf('M_VAR').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(host.querySelector('.vault-select-bar')?.textContent).toContain(t('vault.bulk.selected', { n: 2 }));

    // Expand Beta, clear selection, click Z_VAR then Shift-click A_VAR: selects Z_VAR and A_VAR only (grouped order, not alphabetical).
    await act(async () => host.querySelector<HTMLButtonElement>('[data-group-section="g2"] .vault-group-toggle')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.vault-select-bar button:last-child')!.click());
    await act(async () => checkOf('Z_VAR').click());
    await act(async () => {
      checkOf('A_VAR').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(checkOf('Z_VAR').checked).toBe(true);
    expect(checkOf('A_VAR').checked).toBe(true);
    expect(checkOf('B_VAR').checked).toBe(false);
    expect(checkOf('M_VAR').checked).toBe(false);
  });

  it('tracks reactive workspace link updates, refreshes on partial failure, and localizes workspace preset save errors', async () => {
    presets = [{ id: 'p1', name: 'Prod', groups: [], variables: ['DB_URL'], created: '1', updated: '1' }];
    useTerms.setState({
      connected: true,
      machines: {
        m1: {
          terminals: {},
          layout: {
            version: 2,
            selected: 0,
            workspaces: [
              { id: 'ws-1', name: 'Backend', cwd: '/srv/b', selected: 0, tabs: [] },
              { id: 'ws-2', name: 'Frontend', cwd: '/srv/f', selected: 0, tabs: [] },
              { id: 'ws-3', name: 'Worker', cwd: '/srv/w', selected: 0, tabs: [] },
            ],
          },
        },
      },
    });

    await act(async () => root.render(createElement(VaultPanel)));
    await flush();
    await act(async () => openSession(PASS));
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][data-tab="presets"]')!.click());

    // Open LinkWorkspacesDialog, then externally link ws-2 while open.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="link-preset"]')!.click());
    workspaceLinks = [{ machine: 'm1', workspace: 'ws-2', presets: ['p1'], updated: '1' }];
    await act(async () => useVault.setState({ workspaceLinks }));
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>('.vault-link-option input[type="checkbox"]')];
    expect(boxes().map((b) => b.checked)).toEqual([false, true, false]);

    // Check ws-1 and save -> only ws-1 is PUT; ws-2 is NOT reverted.
    await act(async () => boxes()[0].click());
    calls.length = 0;
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/api/p/vault/workspaces/m1/ws-1']);
    expect(workspacePresetIds('m1', 'ws-2')).toEqual(['p1']);

    // Partial failure: ws-1 succeeds, ws-3 fails -> loadVault() refreshes state anyway.
    const prevFetch = globalThis.fetch;
    let failWs3 = true;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/p/vault/workspaces/m1/ws-3' && init?.method === 'PUT' && failWs3) {
        return new Response(JSON.stringify({ error: 'failed' }), { status: 500 });
      }
      return prevFetch(url, init);
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-preset="p1"] [data-action="link-preset"]')!.click());
    await act(async () => boxes()[0].click());
    await act(async () => boxes()[2].click());
    calls.length = 0;
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.click());
    await flush();
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/p/vault')).toBe(true);
    expect(workspacePresetIds('m1', 'ws-1')).toEqual([]);
    expect(document.querySelector('[role="dialog"] .callout.error')).not.toBeNull();
    failWs3 = false;

    // Workspace preset saver wraps VaultError with localized error text (Nit #9).
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'vault_session' }), { status: 401 }));
    let caught: unknown;
    try {
      await saveWorkspacePresets('m1', 'ws-1', ['p1']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).message).toBe(t('vault.error.vault_session'));
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
      connected: true,
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
    model.subscribe('m1');
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
      connected: true,
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
    model.subscribe('m1');
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
