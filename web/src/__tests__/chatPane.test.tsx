// @vitest-environment jsdom
//
// The chat plugin's views: the chat pane (its header: agent, title renamed
// in place, directory, state; what keeps a chat from going on: it is no
// more, not connected, its agent failed; the conversation of its source;
// read-only), the Chats panel (attention first; showing, closing and
// deleting a chat), and the status bar's chat.usage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));

import { CHAT_NOTICES } from '../conversation/model';
import { chatPlugin } from '../plugins/chat';
import { ChatsPanel, panelOrder } from '../plugins/chat/ChatsPanel';
import { ChatUsageItem } from '../plugins/chat/UsageItem';
import type { ChatState } from '../plugins/chat/protocol';
import { dropSources } from '../plugins/chat/source';
import { applyStates, liveKey, resetChats, useChats } from '../plugins/chat/state';
import { machineLabel, useChatUi } from '../plugins/chat/ops';
import { resetHostReminders, watchHosts } from '../plugins/chat/hostReminder';
import { definePlugins } from '../plugins/registry';
import { useSettings } from '../settings';
import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { setLocale, t } from '../i18n';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { FakeChatHub } from './chatFake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'c00000000000000a1';
const B = 'c00000000000000b2';
const C = 'c00000000000000c3';
const D = 'c00000000000000d4';

const st = (id: string, extra: Partial<ChatState> = {}): ChatState => ({
  id,
  kind: 'claude',
  title: '',
  cwd: '/home/u/proj',
  state: 'idle',
  status: 'idle',
  updated: '2026-11-22T10:00:00Z',
  seq: 1,
  sessionId: '',
  ...extra,
});
const view = (chat: string, extra: Record<string, unknown> = {}): L.PluginView => ({
  id: `v${chat.slice(-2)}`,
  plugin: 'chat',
  kind: 'chat',
  chat,
  agent: 'claude',
  ...extra,
});

let chats: FakeChatHub;
let hub: FakeHub;
let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string }>;

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
const tick = () => act(async () => void (await settle()));

beforeEach(async () => {
  setLocale('en');
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    }),
  );
  definePlugins([chatPlugin]);
  useSettings.setState({ values: {} });
  resetChats();
  chats = new FakeChatHub();
  chats.auto = true;
  chats.install();
  hub = new FakeHub();
  hub.machine('m', [FakeHub.term('p1')], {
    version: 2,
    workspaces: [
      {
        id: 'w1w1w1w1',
        name: 'one',
        cwd: '/src',
        tabs: [
          { root: { terminal: 'p1' }, focused: 'p1' },
          { root: { view: view(B) }, focused: L.viewKey(view(B).id) },
        ],
        selected: 0,
      },
    ],
    selected: 0,
  });
  hub.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'm', label: 'box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('m');
  hub.model.subscribe('m');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useDialog.setState({ current: undefined });
  useChatUi.setState({ renaming: undefined });
  dropSources();
  chats.conn.close();
  resetChats();
  definePlugins([]);
  vi.unstubAllGlobals();
});

async function pane(v: L.PluginView, m = 'm') {
  const Pane = chatPlugin.paneViews!.chat.component;
  await act(async () => root.render(createElement(Pane, { m, pane: L.viewKey(v.id), view: v, focused: true })));
  await tick();
}

describe('the chat pane', () => {
  it('names the agent, the chat, its directory and state, and draws the conversation', async () => {
    chats.chat(A, { kind: 'claude', title: 'Fix the build', cwd: '/home/u/proj', state: 'idle', capabilities: { images: true } }, [
      { seq: 1, t: 'user', content: [{ type: 'text', text: 'Why does it fail?' }] },
      {
        seq: 2,
        t: 'update',
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A missing import.' } },
      },
    ]);
    await pane(view(A));
    expect(q('.chat-agent')!.textContent).toBe('Claude Code');
    expect(q('.chat-title')!.textContent).toBe('Fix the build');
    expect(q('.chat-cwd')!.textContent).toBe('~/proj');
    expect(q('.chat-state')!.textContent).toBe(t('chat.state.idle'));
    await vi.waitFor(async () => {
      await tick();
      expect(host.textContent).toContain('A missing import.');
    });
    expect(host.textContent).toContain('Why does it fail?');
    expect(q<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
    // The state follows the chat's events.
    await act(async () => chats.event(A, { seq: 3, t: 'state', state: 'working' }));
    expect(q('.chat-state')!.textContent).toBe(t('chat.state.working'));
  });

  it('renames the chat in place', async () => {
    chats.chat(A, { kind: 'claude', title: 'Old', state: 'idle' });
    await pane(view(A));
    await act(async () => q('.chat-title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = q<HTMLInputElement>('.chat-title-edit')!;
    expect(input.value).toBe('Old');
    input.value = 'New name';
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await tick();
    expect(chats.ops('command').map((c) => c.cmd)).toEqual([{ op: 'rename', title: 'New name' }]);
    expect(q('.chat-title-edit')).toBeNull();
    // From the pane's menu too.
    await act(async () => useChatUi.setState({ renaming: `m\n${view(A).id}` }));
    expect(q('.chat-title-edit')).not.toBeNull();
  });

  it('keeps the chat’s title in its leaf, for its header and tab', async () => {
    chats.chat(B, { kind: 'claude', title: 'Named', state: 'idle' });
    await pane(view(B));
    await tick();
    const leaf = () => hub.layout('m')!.workspaces[0].tabs[1].root as L.PluginLeaf;
    expect(leaf().view.title).toBe('Named');
    expect(chatPlugin.paneViews!.chat.title('m', leaf().view)).toBe('Named');
    expect(chatPlugin.paneViews!.chat.title('m', { ...view(A), title: 'Kept' })).toBe('Kept');
  });

  it('offers full access as the machine’s setting allows, and trusts the chat’s folder', async () => {
    const modes = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'yolo', name: 'YOLO', full: true },
      ],
    };
    chats.chat(A, { kind: 'kimi', title: 'T', cwd: '/home/u/proj', state: 'idle', config: [modes] }, [
      { seq: 1, t: 'notice', method: CHAT_NOTICES.untrustedFolder, params: { cwd: '/home/u/proj' } },
    ]);
    await pane(view(A, { agent: 'kimi' }));
    const modeBtn = () => q<HTMLButtonElement>('button.conv-select[data-config="mode"]')!;
    await vi.waitFor(() => expect(modeBtn()).toBeTruthy());
    await act(async () => modeBtn().click());
    const yolo = () => document.body.querySelector<HTMLElement>('.conv-select-menu[data-config="mode"] [data-value="yolo"]')!;
    await vi.waitFor(() => expect(yolo()?.getAttribute('aria-disabled')).toBe('true'));
    expect(yolo().textContent).toBe(t('conversation.config.fullOff', { name: 'YOLO' }));
    await act(async () =>
      useSettings.setState({ values: { 'chat.allowFullAccess': { value: false, source: 'global', machines: { m: true } } } }),
    );
    expect(yolo().getAttribute('aria-disabled')).toBeNull();
    await act(async () => modeBtn().click());
    const trust = qa('.conv-notice button').find((b) => b.textContent === t('conversation.notice.trust'))!;
    await act(async () => trust.click());
    await tick();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      `/api/m/m/p/chat/trust?cwd=${encodeURIComponent('/home/u/proj')}`,
    ]);
    expect(q('.conv-notice-text')!.textContent).toBe(t('conversation.notice.trusted'));
    // And taken back from the same notice.
    const untrust = qa('.conv-notice button').find((b) => b.textContent === t('conversation.notice.untrust'))!;
    await act(async () => untrust.click());
    await tick();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      `/api/m/m/p/chat/trust?cwd=${encodeURIComponent('/home/u/proj')}`,
      `/api/m/m/p/chat/untrust?cwd=${encodeURIComponent('/home/u/proj')}`,
    ]);
    expect(q('.conv-notice-text')!.textContent).toBe(t('conversation.notice.untrustedFolder'));
  });

  it('is read-only on a read-only page', async () => {
    useStore.getState().setReadOnly(true);
    chats.chat(A, { kind: 'claude', title: 'T', state: 'idle' });
    await pane(view(A));
    await act(async () => q('.chat-title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(q('.chat-title-edit')).toBeNull();
    await vi.waitFor(() => expect(q<HTMLTextAreaElement>('textarea')?.disabled).toBe(true));
  });

  it('says that a chat is no more, and offers to close its pane', async () => {
    await pane(view(D));
    await vi.waitFor(async () => {
      await tick();
      expect(q('.chat-banner')?.textContent).toContain(t('chat.gone'));
    });
    expect(q('textarea')).toBeNull();
    expect(q('.chat-state')!.textContent).toBe(t('chat.state.deleted'));
    const useGone = chatPlugin.paneViews!.chat.useGone!;
    function Probe() {
      return createElement('i', null, useGone('m', view(D)) ?? 'there');
    }
    const probeHost = document.createElement('div');
    const probe = createRoot(probeHost);
    await act(async () => probe.render(createElement(Probe)));
    expect(probeHost.textContent).toBe(t('chat.gone'));
    await act(async () => probe.unmount());
  });

  it('says when it is not connected, and what a failed agent wrote', async () => {
    chats.chat(A, { kind: 'codex', state: 'failed', error: { code: 'ended', message: 'exit 1', stderr: 'panic: boom' } });
    await pane(view(A, { agent: 'codex' }));
    expect(q('.chat-state')!.textContent).toBe(t('chat.state.failed'));
    const details = q<HTMLDetailsElement>('.chat-stderr')!;
    expect(details.querySelector('summary')!.textContent).toBe(t('chat.stderr'));
    details.open = true;
    await act(async () => details.dispatchEvent(new Event('toggle')));
    expect(details.querySelector('pre')!.textContent).toBe('panic: boom');
    await act(async () => chats.drop());
    expect(q('.chat-banner')!.textContent).toContain(t('chat.offline'));
    expect(q('.chat-state')!.textContent).toBe(t('chat.state.offline'));
  });

  it('says that a leaf names no chat', async () => {
    await pane(view('nope'));
    expect(host.textContent).toBe(t('chat.noChat'));
    expect(chats.sockets).toHaveLength(0);
  });
});

describe('the Chats panel', () => {
  const rows = () => qa('.chat-row-title').map((e) => e.textContent);

  it('lists the chats that need the user first, then those working, then the latest', async () => {
    applyStates(
      'm',
      [
        st(A, { title: 'old idle', updated: '2026-11-20T00:00:00Z' }),
        st(B, { title: 'working', status: 'working', state: 'working' }),
        st(C, { title: 'blocked', status: 'blocked', state: 'waiting', updated: '2026-01-01T00:00:00Z' }),
        st(D, { title: 'new closed', state: 'closed', updated: '2026-11-22T11:00:00Z' }),
        st('c00000000000000e5', { title: 'done', status: 'done' }),
      ],
      true,
    );
    expect(panelOrder(Object.values(useChats.getState().states.m)).map((s) => s.title)).toEqual([
      'blocked',
      'done',
      'working',
      'new closed',
      'old idle',
    ]);
    await act(async () => root.render(createElement(ChatsPanel)));
    expect(rows()).toEqual(['blocked', 'done', 'working', 'new closed', 'old idle']);
    expect(qa('.chat-row-state').map((e) => e.textContent)).toEqual([t('chat.state.waiting'), t('chat.state.closed')]);
  });

  it('shows a chat: its pane, else a new tab of it', async () => {
    applyStates('m', [st(A, { title: 'no pane', kind: 'codex' }), st(B, { title: 'in a pane' })], true);
    await act(async () => root.render(createElement(ChatsPanel)));
    const row = (title: string) => qa('.chat-row-main').find((e) => e.textContent?.includes(title))!;
    await act(async () => row('in a pane').click());
    await tick();
    const ws = () => hub.layout('m')!.workspaces[0];
    expect(ws().selected).toBe(1);
    expect(ws().tabs).toHaveLength(2);
    await act(async () => row('no pane').click());
    await tick();
    expect(ws().tabs).toHaveLength(3);
    expect((ws().tabs[2].root as L.PluginLeaf).view).toMatchObject({ plugin: 'chat', kind: 'chat', chat: A, agent: 'codex' });
  });

  it('closes, archives and restores chats with a bottom-left toast, not on a read-only page', async () => {
    useStore.setState({ toasts: [] });
    applyStates('m', [st(A, { title: 'one' }), st(B, { title: 'two', state: 'closed' })], true);
    await act(async () => root.render(createElement(ChatsPanel)));
    expect(qa(`[aria-label="${t('chat.closeNamed', { title: 'two' })}"]`)).toHaveLength(0);
    // The closed status label lives inside .chat-row-main while actions are a flex sibling (no overlap).
    const closedRow = qa('.chat-row').find((r) => r.textContent?.includes('two'))!;
    expect(closedRow.querySelector('.chat-row-main .chat-row-state')?.textContent).toBe(t('chat.state.closed'));
    expect(closedRow.querySelector('.chat-row-main .chat-row-actions')).toBeNull();
    expect(closedRow.querySelector(':scope > .chat-row-actions')).not.toBeNull();
    await act(async () => q<HTMLButtonElement>(`[aria-label="${t('chat.closeNamed', { title: 'one' })}"]`)!.click());
    await tick();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/m/m/p/chat/close?chat=${A}`]);
    const archiveBtn = q<HTMLButtonElement>(`[aria-label="${t('chat.archiveNamed', { title: 'two' })}"]`)!;
    expect(archiveBtn.title).toBe(t('chat.archive'));
    await act(async () => archiveBtn.click());
    await tick();
    expect(useDialog.getState().current).toBeUndefined();
    // Archived, not deleted: the chat is kept, listed apart and folded.
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toContain(`/api/m/m/p/chat/archive?chat=${B}`);
    expect(rows()).toEqual(['one']);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      msg: t('chat.archived', { title: 'two' }),
      action: { label: t('chat.restore') },
      position: 'bottom-left',
    });
    const toggle = q<HTMLButtonElement>('.chat-archived-toggle')!;
    expect(toggle.textContent).toBe(t('chat.panel.archived', { n: 1 }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(rows()).toEqual(['one', 'two']);
    expect(q(`[aria-label="${t('chat.archiveNamed', { title: 'two' })}"]`)).toBeNull();
    expect(q(`[aria-label="${t('chat.deleteNamed', { title: 'two' })}"]`)).not.toBeNull();
    await act(async () => q<HTMLButtonElement>(`[aria-label="${t('chat.restoreNamed', { title: 'two' })}"]`)!.click());
    await tick();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toContain(`/api/m/m/p/chat/unarchive?chat=${B}`);
    expect(q('.chat-archived')).toBeNull();
    expect(rows()).toEqual(['one', 'two']);
    // Management button opens Agent Chats settings page
    await act(async () => q<HTMLButtonElement>(`[aria-label="${t('chat.manage.open')}"]`)!.click());
    expect(useStore.getState().settings).toEqual({ page: 'chat' });
    useStore.getState().openSettings(false);
    await act(async () => useStore.getState().setReadOnly(true));
    expect(qa('.chat-row-actions')).toHaveLength(0);
    expect(q(`[aria-label="${t('chat.new')}"]`)).toBeNull();
  });

  it('says a chat host of another build, reminds of it once when no chat runs, and restarts it', async () => {
    useStore.setState({ toasts: [] });
    resetHostReminders();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(url), method });
        // The old host is gone once asked to end.
        if (String(url) === '/api/m/m/p/chat/agents' && method === 'GET')
          return new Response('{"error":"not_running","message":"no chat host"}', { status: 409 });
        return new Response('{}', { status: 200 });
      }),
    );
    const version = 'v0.5.0-3-gabc-dirty.1700000001';
    applyStates('m', [st(A, { title: 'one', status: 'working', state: 'working' })], true);
    useChats.setState({ hosts: { m: { version, outdated: true } } });
    watchHosts();
    await act(async () => root.render(createElement(ChatsPanel)));
    expect(q('.chat-host-outdated span')!.textContent).toBe(t('chat.host.outdatedBanner', { version }));
    const restart = q<HTMLButtonElement>('.chat-host-outdated button')!;
    expect(restart.textContent).toBe(t('chat.host.restart'));
    expect(restart.disabled).toBe(true);
    const said = () => useStore.getState().toasts.filter((x) => x.msg === t('chat.host.outdated', { machine: machineLabel('m'), version }));
    // A chat works: not said yet.
    expect(said()).toHaveLength(0);
    await act(async () => applyStates('m', [st(A, { title: 'one', status: 'done', state: 'idle' })], false));
    expect(said()).toHaveLength(1);
    expect(said()[0].action?.label).toBe(t('chat.host.restart'));
    await act(async () => applyStates('m', [st(A, { title: 'one', state: 'idle' })], false));
    expect(said()).toHaveLength(1);

    expect(restart.disabled).toBe(false);
    const before = calls.length;
    await act(async () => restart.click());
    await vi.waitFor(() => expect(q('.chat-host-outdated')).toBeNull());
    // Asked to end, looked for until gone, then this build's started.
    expect(calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/m/m/p/chat/host/stop',
      'GET /api/m/m/p/chat/agents',
      'POST /api/m/m/p/chat/agents',
    ]);
    expect(useStore.getState().toasts.at(-1)?.msg).toBe(t('chat.host.restarted', { machine: machineLabel('m') }));
    resetHostReminders();
  });

  it('says when the machine is not connected or has no chats', async () => {
    useChats.setState({ full: { m: true }, states: { m: {} } });
    await act(async () => root.render(createElement(ChatsPanel)));
    expect(host.textContent).toContain(t('chat.panel.none'));
    await act(async () =>
      useStore.getState().setMachines([{ id: 'm', label: 'box', kind: 'ssh', status: 'connecting' } as unknown as MachineState]),
    );
    expect(host.textContent).toContain(t('chat.panel.offline'));
  });
});

describe('the status bar’s chat usage', () => {
  it('shows the focused chat’s cost, context and tightest limit', async () => {
    const usage = {
      used: 37_000,
      size: 100_000,
      cost: { amount: 0.5, currency: 'USD' },
      limits: [
        { id: 'week', label: 'week', usedPercent: 20 },
        { id: '5h', windowMinutes: 300, usedPercent: 80 },
      ],
    };
    await act(async () => root.render(createElement(ChatUsageItem)));
    expect(host.textContent).toBe('');
    useChats.setState({ live: { [liveKey('m', B)]: { link: 'attached', usage } } });
    // The chat's tab is shown and its pane focused.
    await act(async () => hub.model.mutate('m', (l) => L.selectTab(l, 'w1w1w1w1', 1)));
    await tick();
    const item = q('.chat-usage-item')!;
    expect(Array.from(item.querySelectorAll('.chat-usage-part')).map((e) => e.textContent)).toEqual([
      '$0.50',
      t('chat.usage.context', { pct: 37 }),
      t('chat.usage.limit', { window: '5h', pct: 80 }),
    ]);
    expect(item.className).toContain('warn');
    // Another pane focused: nothing.
    await act(async () => hub.model.mutate('m', (l) => L.selectTab(l, 'w1w1w1w1', 0)));
    await tick();
    expect(q('.chat-usage-item')).toBeNull();
  });
});
