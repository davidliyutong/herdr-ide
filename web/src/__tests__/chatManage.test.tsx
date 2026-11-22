// @vitest-environment jsdom
//
// The Agent Chats management/debug panel (plugins/chat/SettingsExtra.tsx):
// headless chat hosts overview across machines (sessions, stop host,
// stop session, open chat) and persisted trusted folders list (surviving
// refresh via POST fallback, machine switching, per-folder revoke, read-only).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));

import { t } from '../i18n';
import type { MachineState } from '../lib/machine';
import { chatPlugin } from '../plugins/chat';
import type { ChatHostOverview } from '../plugins/chat/protocol';
import { ChatSettingsExtra } from '../plugins/chat/SettingsExtra';
import { resetChats } from '../plugins/chat/state';
import { definePlugins } from '../plugins/registry';
import { useStore } from '../state/store';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'c00000000000000a1';
const B = 'c00000000000000b2';

type Call = { method: string; url: string };
let calls: Call[];
let answers: Record<string, () => Response>;
let core: FakeCore;
let host: HTMLDivElement;
let root: Root;

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<E>(sel as never)) as E[];

function routeOf(url: string, method: string) {
  const u = new URL(url, 'http://x');
  return `${method} ${u.pathname}`;
}

beforeEach(async () => {
  calls = [];
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: String(url) });
      const a = answers[routeOf(String(url), method)];
      return a ? a() : new Response('{}', { status: 200 });
    }),
  );
  definePlugins([chatPlugin]);
  resetChats();
  core = new FakeCore();
  core.machine('m1', [FakeCore.term('t1')], {
    version: 2,
    workspaces: [{ id: 'w1w1w1w1', name: 'one', cwd: '/w', tabs: [{ root: { terminal: 't1' }, focused: 't1' }], selected: 0 }],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([
    { id: 'm1', label: 'box-1', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState,
    { id: 'm2', label: 'box-2', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState,
  ]);
  s.selectMachine('m1');
  s.openSettings({ page: 'chat' });
  core.model.subscribe('m1');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useStore.getState().openSettings(false);
  resetChats();
  definePlugins([]);
  vi.unstubAllGlobals();
});

const renderPanel = async (readOnly = false) => {
  await act(async () => root.render(createElement(ChatSettingsExtra, { readOnly })));
  await act(async () => void (await settle()));
};

describe('ChatSettingsExtra (debug/management panel)', () => {
  it('shows headless chat hosts and sessions, and allows opening/stopping sessions and stopping hosts', async () => {
    let hostsPayload: { hosts: ChatHostOverview[] } = {
      hosts: [
        {
          machine: 'm1',
          label: 'box-1',
          machineStatus: 'ready',
          running: true,
          status: 'running',
          pid: 4321,
          version: '1.2.3',
          liveAgents: 1,
          totalChats: 2,
          totalBytes: 2048,
          conns: 2,
          watchers: 1,
          startedAt: '2026-11-22T09:00:00Z',
          sessions: [
            {
              chat: A,
              kind: 'claude',
              title: 'Refactor auth',
              cwd: '/srv/app',
              sessionId: '00000000-0000-0000-0000-000000000001',
              state: 'working',
              status: 'working',
              pid: 9901,
              updated: '2026-11-22T09:05:00Z',
              bytes: 1024,
            },
            {
              chat: B,
              kind: 'codex',
              title: 'Closed task',
              cwd: '/srv/lib',
              sessionId: '',
              state: 'closed',
              status: 'idle',
              updated: '2026-11-22T08:00:00Z',
              bytes: 512,
            },
          ],
        },
        {
          machine: 'm2',
          label: 'box-2',
          machineStatus: 'ready',
          running: false,
          status: 'stopped',
          totalChats: 0,
          sessions: [],
        },
      ],
    };
    answers['GET /api/p/chat/hosts'] = () => new Response(JSON.stringify(hostsPayload), { status: 200 });
    answers['GET /api/m/m1/p/chat/trusted'] = () => new Response(JSON.stringify({ trusted: [] }), { status: 200 });

    await renderPanel();

    const cards = qa('.chat-host-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('box-1');
    expect(cards[0].textContent).toContain(t('chat.manage.hostStatus.running'));
    expect(cards[0].textContent).toContain('PID 4321');
    expect(cards[1].textContent).toContain(t('chat.manage.hostStatus.stopped'));

    const sessions = qa('.chat-host-session');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].textContent).toContain('Refactor auth');
    expect(sessions[0].textContent).toContain('PID 9901');
    expect(sessions[0].textContent).toContain(t('chat.manage.stopSession'));
    expect(sessions[1].textContent).not.toContain(t('chat.manage.stopSession'));

    // Stop session
    await act(async () => sessions[0].querySelector<HTMLButtonElement>('button:not(.icon)')!.click());
    await act(settle);
    expect(calls.some((c) => c.method === 'POST' && c.url === `/api/m/m1/p/chat/close?chat=${A}`)).toBe(true);

    // Busy host stop shows error
    answers['POST /api/m/m1/p/chat/host/stop'] = () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 });
    await act(async () => q<HTMLButtonElement>('.chat-host-stop')!.click());
    await act(settle);
    expect(q('[data-chat-hosts] .error')?.textContent).toContain(t('chat.reason.busy'));

    // Successful host stop refreshes overview
    answers['POST /api/m/m1/p/chat/host/stop'] = () => {
      hostsPayload = {
        hosts: [{ ...hostsPayload.hosts[0], running: false, status: 'stopped', liveAgents: 0, sessions: [] }, hostsPayload.hosts[1]],
      };
      return new Response('{}', { status: 200 });
    };
    await act(async () => q<HTMLButtonElement>('.chat-host-stop')!.click());
    await act(settle);
    expect(q('.chat-host-card[data-host="m1"]')?.dataset.status).toBe('stopped');

    // Open chat closes settings and opens a chat tab
    hostsPayload = {
      hosts: [
        {
          ...hostsPayload.hosts[0],
          running: true,
          status: 'running',
          sessions: [
            {
              chat: A,
              kind: 'claude',
              title: 'Refactor auth',
              cwd: '/srv/app',
              sessionId: '',
              state: 'idle',
              status: 'idle',
              updated: '2026-11-22T09:05:00Z',
              bytes: 1024,
            },
          ],
        },
      ],
    };
    await act(async () => q<HTMLButtonElement>('[data-chat-hosts] .chat-manage-refresh')!.click());
    await act(settle);
    await act(async () => q<HTMLButtonElement>(`[aria-label="${t('chat.manage.openChat')}"]`)!.click());
    await act(settle);
    expect(useStore.getState().settings).toBeUndefined();
    const ws = core.layout('m1')!.workspaces[0];
    expect(ws.tabs).toHaveLength(2);
    expect((ws.tabs[1].root as L.PluginLeaf).view).toMatchObject({ plugin: 'chat', kind: 'chat', chat: A, agent: 'claude' });
  });

  it('lists persisted trusted folders across refresh (falling back to POST) and revokes trust per folder', async () => {
    answers['GET /api/p/chat/hosts'] = () => new Response(JSON.stringify({ hosts: [] }), { status: 200 });
    // Host not running after refresh: GET returns 409 not_running, POST starts host and returns persisted list.
    answers['GET /api/m/m1/p/chat/trusted'] = () => new Response(JSON.stringify({ error: 'not_running' }), { status: 409 });
    let folders = [
      { cwd: '/srv/project-a', at: '2026-11-22T09:00:00Z' },
      { cwd: '/srv/project-b', at: '2026-11-22T09:10:00Z' },
    ];
    answers['POST /api/m/m1/p/chat/trusted'] = () => new Response(JSON.stringify({ trusted: folders }), { status: 200 });
    answers['POST /api/m/m1/p/chat/untrust'] = () => {
      folders = folders.filter((f) => f.cwd !== '/srv/project-a');
      return new Response('{}', { status: 200 });
    };

    await renderPanel();

    expect(calls.map((c) => `${c.method} ${new URL(c.url, 'http://x').pathname}`)).toContain('POST /api/m/m1/p/chat/trusted');
    const rows = qa('.chat-trusted-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dataset.cwd)).toEqual(['/srv/project-a', '/srv/project-b']);

    // Revoke trust on project-a
    await act(async () => rows[0].querySelector<HTMLButtonElement>('button')!.click());
    await act(settle);
    expect(calls.some((c) => c.method === 'POST' && c.url === `/api/m/m1/p/chat/untrust?cwd=${encodeURIComponent('/srv/project-a')}`)).toBe(
      true,
    );
    expect(qa('.chat-trusted-row').map((r) => r.dataset.cwd)).toEqual(['/srv/project-b']);

    // Switch machine
    answers['GET /api/m/m2/p/chat/trusted'] = () =>
      new Response(JSON.stringify({ trusted: [{ cwd: '/opt/other', at: '2026-11-22T10:00:00Z' }] }), { status: 200 });
    const select = q<HTMLSelectElement>('.chat-trusted-machine')!;
    await act(async () => {
      select.value = 'm2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(settle);
    expect(qa('.chat-trusted-row').map((r) => r.dataset.cwd)).toEqual(['/opt/other']);
  });

  it('does not start host or show mutating controls in read-only mode', async () => {
    answers['GET /api/p/chat/hosts'] = () =>
      new Response(
        JSON.stringify({
          hosts: [
            {
              machine: 'm1',
              label: 'box-1',
              machineStatus: 'ready',
              running: true,
              status: 'running',
              totalChats: 1,
              sessions: [
                {
                  chat: A,
                  kind: 'claude',
                  title: 'S',
                  cwd: '/w',
                  sessionId: '',
                  state: 'working',
                  status: 'working',
                  updated: '',
                  bytes: 10,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    answers['GET /api/m/m1/p/chat/trusted'] = () => new Response(JSON.stringify({ error: 'not_running' }), { status: 409 });

    await renderPanel(true);

    expect(q('.chat-host-stop')).toBeNull();
    expect(qa('.chat-host-session button').map((b) => b.getAttribute('aria-label'))).toEqual([t('chat.manage.openChat')]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(q('[data-chat-trusted]')?.textContent).toContain(t('chat.manage.hostNotRunning'));
  });
});
