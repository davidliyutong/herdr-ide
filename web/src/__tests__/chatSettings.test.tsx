// @vitest-environment jsdom
//
// The Agent Chats settings layout (plugins/chat/SettingsPage.tsx): general
// settings + Providers submenu list + footer on the first page; per-provider
// model list sub-page with Model List Refresh, per-model visibility checkboxes,
// deep-linking via openSettings({ page: 'chat', row }), visit reset, machine
// switching and read-only gating.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));

import { setLocale, t } from '../i18n';
import type { MachineState } from '../lib/machine';
import { ChatSettingsPage } from '../plugins/chat/SettingsPage';
import { offeredKinds, resetChats } from '../plugins/chat/state';
import { useSettings, type SettingDef } from '../settings';
import { useStore } from '../state/store';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { method: string; url: string; body?: unknown };
let calls: Call[];
let answers: Record<string, (url: string, body?: unknown) => Response | Promise<Response>>;
let host: HTMLDivElement;
let root: Root;

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<E>(sel as never)) as E[];

const DEFS: SettingDef[] = [
  { key: 'chat.permissionMode', type: 'enum', default: 'default', scope: 'machine', section: 'chat', order: 10 },
  {
    key: 'chat.permissionMode.claude',
    type: 'enum',
    enum: ['inherit', 'default', 'acceptEdits', 'plan', 'full'],
    default: 'inherit',
    scope: 'machine',
    section: 'chat',
    group: 'chatModels',
    order: 80,
  },
  {
    key: 'chat.permissionMode.agy',
    type: 'enum',
    enum: ['inherit', 'default', 'acceptEdits', 'plan', 'full'],
    default: 'inherit',
    scope: 'machine',
    section: 'chat',
    group: 'chatModels',
    order: 82,
  },
  {
    key: 'chat.visibleModels.claude',
    type: 'list',
    item: 'string',
    default: [],
    scope: 'app',
    section: 'chat',
    group: 'chatModels',
    order: 100,
  },
  {
    key: 'chat.visibleModels.codex',
    type: 'list',
    item: 'string',
    default: [],
    scope: 'app',
    section: 'chat',
    group: 'chatModels',
    order: 101,
  },
  {
    key: 'chat.visibleModels.agy',
    type: 'list',
    item: 'string',
    default: [],
    scope: 'app',
    section: 'chat',
    group: 'chatModels',
    order: 102,
  },
];

function routeOf(url: string, method: string) {
  const u = new URL(url, 'http://x');
  return `${method} ${u.pathname}`;
}

beforeEach(() => {
  setLocale('en');
  calls = [];
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: String(url), body });
      const fn = answers[routeOf(String(url), method)];
      return fn ? fn(String(url), body) : new Response('{}', { status: 200 });
    }),
  );
  resetChats();
  useSettings.setState({ values: {}, defs: DEFS, loaded: true });
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([
    { id: 'm1', label: 'box-1', kind: 'ssh', status: 'ready' } as unknown as MachineState,
    { id: 'm2', label: 'box-2', kind: 'ssh', status: 'ready' } as unknown as MachineState,
  ]);
  s.selectMachine('m1');
  s.openSettings({ page: 'chat' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useStore.getState().openSettings(false);
  resetChats();
  vi.unstubAllGlobals();
});

async function renderPage(opts: { readOnly?: boolean; visit?: number; machine?: string } = {}) {
  await act(async () =>
    root.render(
      createElement(ChatSettingsPage, {
        readOnly: opts.readOnly ?? false,
        defs: DEFS,
        rows: (list) => createElement('div', { 'data-general-rows': list.map((d) => d.key).join(',') }),
        lead: createElement('div', { 'data-lead': '1' }, 'Lead'),
        footer: createElement('div', { 'data-footer': '1' }, 'Extra'),
        machine: opts.machine,
        visit: opts.visit ?? 0,
      }),
    ),
  );
  await act(settle);
}

describe('ChatSettingsPage (provider submenus & model list visibility)', () => {
  it('lists providers on root page with footer, drills into provider sub-page without footer, and refreshes/toggles models', async () => {
    let savedSetting: Record<string, { value: unknown; source: string }> = {};
    answers['GET /api/m/m1/p/chat/models'] = () => new Response(JSON.stringify({ error: 'not_running' }), { status: 409 });
    answers['POST /api/m/m1/p/chat/models'] = () =>
      new Response(
        JSON.stringify({
          models: [
            { value: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable' },
            { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Fast and smart' },
            { value: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
          ],
          fetchedAt: '2026-11-27T04:00:00Z',
        }),
        { status: 200 },
      );
    answers['PUT /api/settings'] = (_url, body) => {
      const b = body as { key: string; value: unknown };
      savedSetting = { ...savedSetting, [b.key]: { value: b.value, source: 'global' } };
      return new Response(JSON.stringify({ values: savedSetting, problems: [] }), { status: 200 });
    };
    answers['DELETE /api/settings'] = (url) => {
      const key = new URL(url, 'http://x').searchParams.get('key') ?? '';
      const next = { ...savedSetting };
      delete next[key];
      savedSetting = next;
      return new Response(JSON.stringify({ values: savedSetting, problems: [] }), { status: 200 });
    };

    await renderPage();

    // Root page: general rows exclude chat.visibleModels.*, lead + footer shown, provider rows rendered.
    expect(q('[data-lead]')).not.toBeNull();
    expect(q('[data-footer]')).not.toBeNull();
    expect(q('[data-general-rows]')?.getAttribute('data-general-rows')).toBe('chat.permissionMode');
    expect(qa('.chat-settings-row').map((el) => el.dataset.provider)).toEqual(['claude', 'codex', 'agy', 'kimi', 'grok']);
    expect(q('.chat-settings-row[data-provider="agy"]')?.textContent).toContain('Antigravity');

    // Open Claude sub-page: footer hidden, per-agent permission mode row & empty cache prompt shown.
    await act(async () => q<HTMLButtonElement>('.chat-settings-row[data-provider="claude"]')!.click());
    await act(settle);
    expect(q('[data-footer]')).toBeNull();
    expect(q('.chat-settings-provider')?.dataset.provider).toBe('claude');
    expect(q('.chat-provider-mode-row [data-general-rows]')?.getAttribute('data-general-rows')).toBe('chat.permissionMode.claude');
    expect(host.textContent).toContain(t('chat.settings.noModels', { agent: 'Claude Code' }));

    // Refresh Model List triggers POST /models and renders checkboxes (all checked by default).
    await act(async () => q<HTMLButtonElement>('.chat-models-refresh')!.click());
    await act(settle);
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/m/m1/p/chat/models')).toBe(true);
    const boxes = () => qa<HTMLInputElement>('.chat-model-row input[type="checkbox"]');
    expect(boxes()).toHaveLength(3);
    expect(boxes().every((b) => b.checked)).toBe(true);

    // Unchecking Haiku saves explicit allowlist [opus, sonnet].
    await act(async () => boxes()[2].click());
    await act(settle);
    expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings').at(-1)?.body).toEqual({
      key: 'chat.visibleModels.claude',
      value: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      machine: undefined,
    });
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);

    // Unchecking Sonnet keeps Opus; unchecking the last model enters draft-cleared state with hint.
    await act(async () => boxes()[1].click());
    await act(settle);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
    await act(async () => boxes()[0].click());
    await act(settle);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);
    expect(host.textContent).toContain(t('chat.settings.keepOne'));

    // Checking one model from cleared state immediately saves just that model (does not revert to all).
    await act(async () => boxes()[2].click());
    await act(settle);
    expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings').at(-1)?.body).toEqual({
      key: 'chat.visibleModels.claude',
      value: ['claude-haiku-4-5'],
      machine: undefined,
    });
    expect(boxes().map((b) => b.checked)).toEqual([false, false, true]);

    // Select All resets setting via DELETE /api/settings.
    await act(async () => q<HTMLButtonElement>('.chat-models-select-all')!.click());
    await act(settle);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('chat.visibleModels.claude'))).toBe(true);
    expect(boxes().every((b) => b.checked)).toBe(true);

    // Deselect All unchecks every model at once so user can pick only desired models.
    await act(async () => q<HTMLButtonElement>('.chat-models-deselect-all')!.click());
    await act(settle);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(q<HTMLButtonElement>('.chat-models-deselect-all')!.disabled).toBe(true);
    await act(async () => boxes()[0].click());
    await act(settle);
    expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings').at(-1)?.body).toEqual({
      key: 'chat.visibleModels.claude',
      value: ['claude-opus-4-6'],
      machine: undefined,
    });

    // Back returns to root page with footer restored.
    await act(async () => q<HTMLButtonElement>('[data-action="back"]')!.click());
    expect(q('[data-footer]')).not.toBeNull();
    expect(q('.chat-settings-providers')).not.toBeNull();
  });

  it('toggles chat providers directly on the first-level list and filters offeredKinds', async () => {
    let savedSetting: Record<string, { value: unknown; source: string }> = {};
    answers['PUT /api/settings'] = (_url, body) => {
      const b = body as { key: string; value: unknown };
      savedSetting = { ...savedSetting, [b.key]: { value: b.value, source: 'global' } };
      return new Response(JSON.stringify({ values: savedSetting, problems: [] }), { status: 200 });
    };
    await renderPage();
    const row = () => q<HTMLElement>('.chat-settings-row[data-provider="grok"]')!;
    const sw = () => row().querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(offeredKinds('m1').some((k) => k.id === 'grok')).toBe(true);

    // Clicking the switch toggles the provider without opening its sub-page.
    await act(async () => sw().click());
    await act(settle);
    expect(q('.chat-settings-provider')).toBeNull();
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(row().classList.contains('off')).toBe(true);
    expect(offeredKinds('m1').some((k) => k.id === 'grok')).toBe(false);
  });

  it('deep-links to a provider via openSettings({ row }) and resets to root when visit changes', async () => {
    answers['GET /api/m/m1/p/chat/models'] = () =>
      new Response(JSON.stringify({ models: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] }), { status: 200 });
    useStore.getState().openSettings({ page: 'chat', row: 'chat.visibleModels.agy' });
    await renderPage({ visit: 1 });
    expect(q('.chat-settings-provider')?.dataset.provider).toBe('agy');
    expect(q('.chat-model-row[data-model="gemini-4-neon"]')).not.toBeNull();
    // Clicking the sidebar item increments visit and returns to root.
    await renderPage({ visit: 2 });
    expect(q('.chat-settings-provider')).toBeNull();
    expect(q('.chat-settings-providers')).not.toBeNull();
  });

  it('disables refresh and model checkboxes in read-only mode', async () => {
    answers['GET /api/m/m1/p/chat/models'] = () =>
      new Response(JSON.stringify({ models: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }] }), { status: 200 });
    useStore.getState().openSettings({ page: 'chat', row: 'chat.visibleModels.codex' });
    await renderPage({ readOnly: true });
    expect(q<HTMLButtonElement>('.chat-models-refresh')!.disabled).toBe(true);
    expect(q<HTMLInputElement>('.chat-model-row input[type="checkbox"]')!.disabled).toBe(true);
  });
});
