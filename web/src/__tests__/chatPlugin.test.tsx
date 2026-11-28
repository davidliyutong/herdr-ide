// @vitest-environment jsdom
//
// The chat plugin's parts outside its pane: the chats' states (the hub's
// messages numbered by rev, the snapshot, chats that are no more), the
// panes' agent statuses (viewStatus: status, paneOf, seen), the new-tab
// items (the agents a machine can start; a new chat in the focused
// terminal's directory, in the setting's permission mode) and the command
// chat.new, the pane's menu (rename, close, delete), and read-only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));

import { chatPlugin } from '../plugins/chat';
import {
  LAST_MODEL,
  fullAccessAllowed,
  modelUnavailable,
  permissionMode,
  readState,
  readStates,
  rememberModel,
  startModelOptions,
} from '../plugins/chat/api';
import { chatMenu, cleanDir, useChatUi } from '../plugins/chat/ops';
import { STATES_PATH, type ChatState } from '../plugins/chat/protocol';
import { chatSource, dropSources } from '../plugins/chat/source';
import { applyMessage, chatGone, liveKey, loadSnapshot, setLive, resetChats, SNAPSHOT_GAP_MS, useChats } from '../plugins/chat/state';
import { resetSeen, SEEN_RETRY_MAX_MS, SEEN_RETRY_MS, SEEN_TRIES } from '../plugins/chat/status';
import { definePlugins } from '../plugins/registry';
import { useSettings } from '../settings';
import { useStore } from '../state/store';
import { useDialog, type DialogRequest } from '../dialog';
import { isItem, useMenu, closeMenu, type MenuItem } from '../contextMenu';
import { setLocale, t } from '../i18n';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { FakeChatHub } from './chatFake';

const A = 'c00000000000000a1';
const B = 'c00000000000000b2';
const C = 'c00000000000000c3';

const st = (id: string, extra: Partial<ChatState> = {}): ChatState => ({
  id,
  kind: 'claude',
  title: '',
  cwd: '/w',
  state: 'idle',
  status: 'idle',
  updated: '2026-11-22T10:00:00Z',
  seq: 1,
  sessionId: '',
  ...extra,
});
const msg = (states: ChatState[], rev: number, full = false) => ({ t: 'states', states, full, rev });
const view = (chat: string, extra: Record<string, unknown> = {}): L.PluginView => ({
  id: `v${chat.slice(-2)}`,
  plugin: 'chat',
  kind: 'chat',
  chat,
  agent: 'claude',
  ...extra,
});
const status = (m: string, v: L.PluginView) => chatPlugin.viewStatus!.status(m, v);

type Call = { url: string; method: string; body?: unknown };
let calls: Call[];
let answers: Record<string, () => Response>;
let hub: FakeHub;
let chats: FakeChatHub;

function routeOf(url: string, method: string) {
  const u = new URL(url, 'http://x');
  return `${method} ${u.pathname}`;
}

beforeEach(async () => {
  setLocale('en');
  calls = [];
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers[routeOf(String(url), method)];
      return a ? a() : new Response('{}', { status: 200 });
    }),
  );
  definePlugins([chatPlugin]);
  useSettings.setState({ values: {} });
  resetChats();
  resetSeen();
  chats = new FakeChatHub();
  chats.auto = true;
  chats.install();
  hub = new FakeHub();
  hub.machine('m', [FakeHub.term('p1', { cwd: '/src/proj' })], {
    version: 2,
    workspaces: [
      { id: 'w1w1w1w1', name: 'one', cwd: '/src', tabs: [{ root: { terminal: 'p1' }, focused: 'p1' }], selected: 0 },
      { id: 'w2w2w2w2', name: 'two', cwd: '/other', tabs: [{ root: { view: view(B) }, focused: `view:${view(B).id}` }], selected: 0 },
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
});

afterEach(() => {
  closeMenu(false);
  useDialog.setState({ current: undefined });
  dropSources();
  chats.conn.close();
  resetChats();
  definePlugins([]);
  vi.unstubAllGlobals();
});

describe('the chats’ states', () => {
  it('takes the hub’s messages in the order of their revs', () => {
    applyMessage('m', msg([st(A), st(B)], 4, true));
    expect(Object.keys(useChats.getState().states.m)).toEqual([A, B]);
    applyMessage('m', msg([st(A, { status: 'working', state: 'working' })], 5));
    applyMessage('m', msg([st(A, { status: 'idle' })], 5)); // again: passed over
    applyMessage('m', msg([st(A, { status: 'done' })], 3)); // older: passed over
    expect(useChats.getState().states.m[A].status).toBe('working');
    applyMessage('m', msg([st(B, { state: 'deleted' })], 6));
    const s = useChats.getState();
    expect(Object.keys(s.states.m)).toEqual([A]);
    expect(chatGone(s, 'm', B)).toBe(true);
    expect(chatGone(s, 'm', A)).toBe(false);
    // A full list: a chat not in it is gone.
    applyMessage('m', msg([st(C)], 7, true));
    expect(chatGone(useChats.getState(), 'm', A)).toBe(true);
    // What is no message is passed over.
    for (const bad of [null, 'x', { t: 'other' }, { t: 'states', states: 'no' }]) applyMessage('m', bad);
    applyMessage('m', msg([{ ...st(C), id: '../x' } as ChatState], 8));
    expect(Object.keys(useChats.getState().states.m)).toEqual([C]);
  });

  it('reads the snapshot first, and the messages that came meanwhile after it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answers[`GET ${STATES_PATH}`] = () =>
      new Response(JSON.stringify({ machines: { m: msg([st(A), st(B)], 10, true), bad: 'x' } }), { status: 200 });
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
    const plain = fetch.getMockImplementation()!;
    fetch.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      await gate;
      return plain(url, init);
    });
    const done = loadSnapshot();
    // Before the snapshot: a change waits for it.
    applyMessage('m', msg([st(A, { status: 'blocked', state: 'waiting' })], 11));
    applyMessage('m', msg([st(C)], 9));
    expect(useChats.getState().states.m).toBeUndefined();
    release();
    await done;
    const s = useChats.getState().states.m;
    expect(Object.keys(s).sort()).toEqual([A, B]);
    expect(s[A].status).toBe('blocked');
  });

  it('reads the snapshot while the plugin is on, and when the page connects again', async () => {
    const reads = () => calls.filter((c) => routeOf(c.url, c.method) === `GET ${STATES_PATH}`).length;
    useSettings.setState({ values: { 'plugins.chat.enabled': { value: false, source: 'global' } } });
    chatPlugin.viewStatus!.subscribe(() => {});
    await settle();
    expect(reads()).toBe(0);
    useSettings.setState({ values: { 'plugins.chat.enabled': { value: true, source: 'global' } } });
    await settle();
    expect(reads()).toBe(1);
    useStore.getState().setConnected(false);
    useStore.getState().setConnected(true);
    await settle();
    expect(reads()).toBe(2);
  });

  it('forgets, after the page connects again, the machines the new snapshot does not have', async () => {
    answers[`GET ${STATES_PATH}`] = () =>
      new Response(JSON.stringify({ machines: { m: msg([st(A)], 3, true), n: msg([st(B)], 4, true) } }), { status: 200 });
    chatPlugin.viewStatus!.subscribe(() => {});
    await settle();
    expect(Object.keys(useChats.getState().states).sort()).toEqual(['m', 'n']);
    // A hub that started again has read only machine m so far.
    answers[`GET ${STATES_PATH}`] = () => new Response(JSON.stringify({ machines: { m: msg([st(A)], 1, true) } }), { status: 200 });
    useStore.getState().setConnected(false);
    useStore.getState().setConnected(true);
    await settle();
    await settle();
    const s = useChats.getState();
    expect(Object.keys(s.states)).toEqual(['m']);
    expect(s.full.n).toBeUndefined();
    expect(chatGone(s, 'n', B)).toBe(false);
    expect(s.deleted.n?.[B]).toBeUndefined();
  });

  it('reads the snapshot again after a gap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      applyMessage('m', msg([st(A)], 1, true));
      await vi.advanceTimersByTimeAsync(SNAPSHOT_GAP_MS);
      calls = [];
      const reads = () => calls.filter((c) => routeOf(c.url, c.method) === `GET ${STATES_PATH}`).length;
      applyMessage('m', msg([st(B)], 5));
      expect(useChats.getState().states.m[B]).toBeDefined();
      expect(reads()).toBe(1);
      // Another gap while it is read: once more, a while after.
      applyMessage('m', msg([st(C)], 9));
      applyMessage('m', msg([st(C)], 12));
      await vi.advanceTimersByTimeAsync(SNAPSHOT_GAP_MS / 2);
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_GAP_MS);
      expect(reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the chat panes’ statuses', () => {
  it('are their chats’ statuses', () => {
    applyMessage('m', msg([st(A, { status: 'blocked' }), st(B, { status: 'nonsense' })], 1, true));
    expect(status('m', view(A))).toBe('blocked');
    expect(status('m', view(B))).toBeUndefined();
    expect(status('m', view(C))).toBeUndefined();
    expect(status('m', view('bad'))).toBeUndefined();
    expect(status('other', view(A))).toBeUndefined();
  });

  it('tell when the states change, not when an attached chat does', () => {
    const fn = vi.fn();
    const off = chatPlugin.viewStatus!.subscribe(fn);
    applyMessage('m', msg([st(A)], 1, true));
    expect(fn).toHaveBeenCalledTimes(1);
    useChats.setState((s) => ({ live: { ...s.live, x: { link: 'attached' } } }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    applyMessage('m', msg([st(B)], 2));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('point a chat’s notification to the pane that shows it', () => {
    const paneOf = chatPlugin.viewStatus!.paneOf!;
    expect(paneOf('m', { terminal: '', chat: B })).toBe(L.viewKey(view(B).id));
    expect(paneOf('m', { terminal: '', chat: A })).toBeUndefined();
    expect(paneOf('m', { terminal: '', chat: 7 })).toBeUndefined();
    expect(paneOf('nobody', { terminal: '', chat: B })).toBeUndefined();
  });

  it('say once that a done chat was seen, up to its last seq', async () => {
    applyMessage('m', msg([st(A, { status: 'done', seq: 42 })], 1, true));
    const seen = chatPlugin.viewStatus!.seen!;
    seen('m', view(A));
    seen('m', view(A));
    expect(status('m', view(A))).toBe('idle');
    await settle();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([`/api/m/m/p/chat/seen?chat=${A}&seq=42`]);
    // Not from a read-only page.
    useStore.getState().setReadOnly(true);
    calls = [];
    seen('m', view(A));
    await settle();
    expect(calls).toEqual([]);
  });

  it('reads seen/unread/stale state fields and exposes unopened chats and openTarget', async () => {
    expect(
      readState({
        id: A,
        kind: 'claude',
        title: 'Unread chat',
        cwd: '/proj',
        state: 'sleeping',
        status: 'done',
        updated: '2026-11-22T10:00:00Z',
        seq: 12,
        sessionId: '',
        seen: 10,
        unread: true,
        stale: true,
      }),
    ).toMatchObject({ id: A, seen: 10, unread: true, stale: true });
    expect(readStates({ t: 'states', states: [], full: true, rev: 2, stale: true })).toMatchObject({ full: true, rev: 2, stale: true });

    applyMessage(
      'm',
      msg(
        [
          st(B, { title: 'Open', status: 'blocked', state: 'waiting' }),
          st(A, { title: 'Wait here', cwd: '/a', status: 'blocked', state: 'waiting' }),
          st(C, { kind: 'codex', title: '', cwd: '/b', status: 'done', state: 'idle' }),
          st('c00000000000000d4', { title: 'Old', cwd: '/c', status: 'idle', state: 'closed' }),
        ],
        10,
        true,
      ),
    );
    const unopened = chatPlugin.viewStatus!.unopened!('m');
    expect(unopened.map((u) => [u.id, u.title, u.directory, u.status])).toEqual([
      [`chat:${A}`, 'Wait here', '/a', 'blocked'],
      [`chat:${C}`, 'Codex', '/b', 'done'],
    ]);
    await chatPlugin.viewStatus!.openTarget!({ kind: 'chat', machine: 'm', chat: C });
    await settle();
    expect(hub.layout('m')!.workspaces[0].tabs).toHaveLength(2);
    expect(chatPlugin.viewStatus!.unopened!('m').map((u) => u.id)).toEqual([`chat:${A}`]);
  });
});

describe('a seen that fails', () => {
  const seenPosts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/seen?')).length;
  afterEach(() => void vi.useRealTimers());

  it('is tried again later, never at once, and the status is not flipped back', async () => {
    let refuse = true;
    answers['POST /api/m/m/p/chat/seen'] = () =>
      refuse ? new Response('{"error":"offline","message":"m"}', { status: 409 }) : new Response('{}', { status: 200 });
    applyMessage('m', msg([st(A, { status: 'done', seq: 50 })], 1, true));
    vi.useFakeTimers();
    const seen = chatPlugin.viewStatus!.seen!;
    seen('m', view(A));
    await vi.advanceTimersByTimeAsync(0);
    expect(seenPosts()).toBe(1);
    expect(status('m', view(A))).toBe('idle');
    // Looking again sends nothing: the retry is on its way.
    seen('m', view(A));
    await vi.advanceTimersByTimeAsync(SEEN_RETRY_MS - 10);
    expect(seenPosts()).toBe(1);
    expect(status('m', view(A))).toBe('idle');
    await vi.advanceTimersByTimeAsync(20);
    expect(seenPosts()).toBe(2);
    refuse = false;
    await vi.advanceTimersByTimeAsync(2 * SEEN_RETRY_MS + 10);
    expect(seenPosts()).toBe(3);
    await vi.advanceTimersByTimeAsync(10 * SEEN_RETRY_MAX_MS);
    expect(seenPosts()).toBe(3);
  });

  it('is given up after SEEN_TRIES, and asked again by the next state that says done', async () => {
    answers['POST /api/m/m/p/chat/seen'] = () => new Response('{"error":"offline","message":"m"}', { status: 409 });
    applyMessage('m', msg([st(A, { status: 'done', seq: 50 })], 1, true));
    vi.useFakeTimers();
    const seen = chatPlugin.viewStatus!.seen!;
    seen('m', view(A));
    await vi.advanceTimersByTimeAsync(SEEN_TRIES * SEEN_RETRY_MAX_MS);
    expect(seenPosts()).toBe(SEEN_TRIES);
    await vi.advanceTimersByTimeAsync(10 * SEEN_RETRY_MAX_MS);
    expect(seenPosts()).toBe(SEEN_TRIES);
    applyMessage('m', msg([st(A, { status: 'done', seq: 50, title: 'again' })], 2));
    expect(status('m', view(A))).toBe('done');
    seen('m', view(A));
    await vi.advanceTimersByTimeAsync(0);
    expect(seenPosts()).toBe(SEEN_TRIES + 1);
  });
});

describe('new chats', () => {
  const agents = (list: unknown[]) => () => new Response(JSON.stringify({ agents: list }), { status: 200 });
  const newChat =
    (id = A, kind = 'codex') =>
    () =>
      new Response(JSON.stringify({ chat: { ...st(id, { kind, state: 'starting' }), capabilities: {} } }), { status: 200 });

  it('are offered for the agents the machine can start', async () => {
    const items = () => chatPlugin.newTabItems!('m').map((i) => [i.id, t(i.title)]);
    expect(items()).toEqual([
      ['chat.claude', 'Claude Code Chat'],
      ['chat.codex', 'Codex Chat'],
      ['chat.agy', 'Antigravity Chat'],
      ['chat.kimi', 'Kimi Code Chat'],
      ['chat.grok', 'Grok Chat'],
    ]);
    answers['GET /api/m/n/p/chat/agents'] = agents([
      { kind: 'codex', available: true, version: '0.171.0' },
      { kind: 'claude', available: false, reason: 'not_found' },
      { kind: 'opencode', available: true },
      'junk',
    ]);
    chatPlugin.newTabItems!('n');
    await settle();
    expect(chatPlugin.newTabItems!('n').map((i) => i.id)).toEqual(['chat.codex']);
  });

  it('start in the focused terminal’s directory, in the setting’s mode, in a new tab', async () => {
    answers['POST /api/m/m/p/chat/new'] = newChat();
    answers['GET /api/m/m/p/chat/agents'] = agents([{ kind: 'codex', available: true }]);
    useSettings.setState({ values: { 'chat.permissionMode': { value: 'default', source: 'global', machines: { m: 'acceptEdits' } } } });
    const item = chatPlugin.newTabItems!('m').find((i) => i.id === 'chat.codex')!;
    await item.run('m', 'w1w1w1w1');
    await settle();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/m/m/p/chat/new');
    expect(post.body).toEqual({ kind: 'codex', cwd: '/src/proj', options: { mode: 'acceptEdits' }, workspace: 'w1w1w1w1' });
    const ws = hub.layout('m')!.workspaces[0];
    expect(ws.tabs).toHaveLength(2);
    const leaf = ws.tabs[1].root as L.PluginLeaf;
    expect(leaf.view).toMatchObject({ plugin: 'chat', kind: 'chat', chat: A, agent: 'codex' });
    expect(useChats.getState().states.m[A]).toMatchObject({ kind: 'codex', state: 'starting' });
    // Shown again: its pane, not another.
    await chatPlugin.newTabItems!('m')[0].run('m', 'w1w1w1w1');
    await settle();
    expect(hub.layout('m')!.workspaces[0].tabs).toHaveLength(2);
  });

  it('leave full access to the machine unless it allows it', () => {
    const values = (v: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: 'global' as const }]));
    expect(permissionMode(values({ 'chat.permissionMode': 'full' }), 'm')).toBeUndefined();
    expect(permissionMode(values({ 'chat.permissionMode': 'full', 'chat.allowFullAccess': true }), 'm')).toBe('full');
    expect(permissionMode(values({ 'chat.permissionMode': 'plan' }), 'm')).toBe('plan');
    expect(permissionMode(values({ 'chat.permissionMode': 'rm -rf' }), 'm')).toBe('default');
    expect(permissionMode({}, 'm')).toBe('default');
    // Per-agent permission mode overrides global chat.permissionMode when not 'inherit',
    // and still enforces allowFullAccess.
    expect(
      permissionMode(
        values({
          'chat.permissionMode': 'default',
          'chat.permissionMode.agy': 'full',
          'chat.permissionMode.claude': 'plan',
          'chat.permissionMode.codex': 'inherit',
        }),
        'm',
        'agy',
      ),
    ).toBeUndefined();
    expect(
      permissionMode(
        values({
          'chat.permissionMode': 'default',
          'chat.permissionMode.agy': 'full',
          'chat.permissionMode.claude': 'plan',
          'chat.permissionMode.codex': 'inherit',
          'chat.allowFullAccess': true,
        }),
        'm',
        'agy',
      ),
    ).toBe('full');
    expect(
      permissionMode(
        values({ 'chat.permissionMode': 'acceptEdits', 'chat.permissionMode.claude': 'plan', 'chat.permissionMode.codex': 'inherit' }),
        'm',
        'claude',
      ),
    ).toBe('plan');
    expect(
      permissionMode(
        values({ 'chat.permissionMode': 'acceptEdits', 'chat.permissionMode.claude': 'plan', 'chat.permissionMode.codex': 'inherit' }),
        'm',
        'codex',
      ),
    ).toBe('acceptEdits');
    // A machine's own value first, then the app's; off by default.
    expect(fullAccessAllowed({}, 'm')).toBe(false);
    const own = { 'chat.allowFullAccess': { value: false, source: 'global' as const, machines: { m: true } } };
    expect([fullAccessAllowed(own, 'm'), fullAccessAllowed(own, 'n')]).toEqual([true, false]);
    expect(cleanDir('/a//b/./c/../d/')).toBe('/a/b/d');
    expect(cleanDir('rel')).toBeUndefined();
  });

  it('start on a shown model when the agent’s default is hidden from the picker (not the hidden default)', async () => {
    answers['POST /api/m/m/p/chat/new'] = newChat(A, 'claude');
    answers['GET /api/m/m/p/chat/agents'] = agents([{ kind: 'claude', available: true }]);
    answers['GET /api/m/m/p/chat/models'] = () =>
      new Response(
        JSON.stringify({
          models: [
            { value: 'default', name: 'Default (recommended)' },
            { value: 'opus', name: 'Opus' },
            { value: 'sonnet', name: 'Sonnet' },
            { value: 'haiku', name: 'Haiku' },
          ],
        }),
        { status: 200 },
      );
    useSettings.setState({ values: { 'chat.visibleModels.claude': { value: ['haiku', 'opus'], source: 'global' } } });
    const item = chatPlugin.newTabItems!('m').find((i) => i.id === 'chat.claude')!;
    await item.run('m', 'w1w1w1w1');
    await settle();
    const post = calls.find((c) => c.method === 'POST')!;
    // In the agent's order, the hidden default left out.
    expect(post.body).toMatchObject({ kind: 'claude', options: { mode: 'default', model: 'opus', models: ['haiku'] } });
  });

  it('start on the model the settings name, the one chosen last, or the first shown the agent offers', () => {
    const values = (v: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: 'global' as const }]));
    const offered = ['default', 'opus', 'sonnet', 'haiku'];
    // Every model shown, no choice: the agent's own default.
    expect(startModelOptions({}, 'claude', offered)).toEqual({});
    // A choice: that model; with every model shown nothing else is asked.
    expect(startModelOptions(values({ 'chat.model.claude': 'sonnet' }), 'claude', offered)).toEqual({ model: 'sonnet' });
    // A choice the agent no longer lists (its cached list): the agent's own default.
    expect(startModelOptions(values({ 'chat.model.claude': 'opus-old' }), 'claude', offered)).toEqual({});
    // Unknown list: the choice is asked, the adapter checks it against the agent's.
    expect(startModelOptions(values({ 'chat.model.claude': 'opus-old' }), 'claude')).toEqual({ model: 'opus-old' });
    // Only some shown: the choice first, then the shown ones in the agent's order.
    const some = { 'chat.visibleModels.claude': ['haiku', 'sonnet'] };
    expect(startModelOptions(values({ ...some, 'chat.model.claude': 'haiku' }), 'claude', offered)).toEqual({
      model: 'haiku',
      models: ['sonnet'],
    });
    // A hidden choice or one withdrawn is passed over.
    expect(startModelOptions(values({ ...some, 'chat.model.claude': 'opus' }), 'claude', offered)).toEqual({
      model: 'sonnet',
      models: ['haiku'],
    });
    expect(startModelOptions(values({ ...some, 'chat.model.claude': 'haiku' }), 'claude', ['default', 'sonnet'])).toEqual({
      model: 'sonnet',
    });
    // Every shown model withdrawn: the agent's own.
    expect(startModelOptions(values(some), 'claude', ['default', 'opus'])).toEqual({});
    // The one chosen last; none chosen yet: as the agent's default.
    expect(startModelOptions(values({ 'chat.model.claude': LAST_MODEL, 'chat.lastModel.claude': 'opus' }), 'claude', offered)).toEqual({
      model: 'opus',
    });
    expect(startModelOptions(values({ 'chat.model.claude': LAST_MODEL }), 'claude', offered)).toEqual({});
    // Why a choice cannot start a chat.
    expect(modelUnavailable(values(some), 'claude', 'opus', offered)).toBe('hidden');
    expect(modelUnavailable(values(some), 'claude', 'haiku', ['sonnet'])).toBe('withdrawn');
    expect(modelUnavailable(values(some), 'claude', 'haiku', offered)).toBeUndefined();
  });

  it('remember the model chosen in a chat only while new chats start with the one chosen last', async () => {
    const put = () => calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings').map((c) => c.body);
    await rememberModel('claude', 'opus');
    expect(put()).toEqual([]);
    useSettings.setState({ values: { 'chat.model.claude': { value: LAST_MODEL, source: 'global' } } });
    await rememberModel('claude', 'opus');
    expect(put()).toEqual([{ key: 'chat.lastModel.claude', value: 'opus' }]);
  });

  it('say why one did not start', async () => {
    answers['POST /api/m/m/p/chat/new'] = () => new Response('{"error":"not_found","message":"no codex"}', { status: 404 });
    const toast = vi.fn(() => 0);
    useStore.setState({ toast });
    await chatPlugin.newTabItems!('m')[1].run('m', 'w1w1w1w1');
    await settle();
    await settle();
    expect(toast).toHaveBeenCalledWith(t('conversation.error.not_found', { agent: 'Codex' }), undefined, undefined, 'error');
    expect(hub.layout('m')!.workspaces[0].tabs).toHaveLength(1);
  });

  it('start from the command: the machine’s one agent, else a menu of them', async () => {
    answers['GET /api/m/m/p/chat/agents'] = agents([{ kind: 'claude', available: true }]);
    answers['POST /api/m/m/p/chat/new'] = newChat(C, 'claude');
    const cmd = chatPlugin.commands!['chat.new'];
    expect(cmd.enabled!()).toBe(true);
    await useChats.setState({ agents: { m: { list: [{ kind: 'claude', available: true }], at: Date.now() } } });
    cmd.run();
    await settle();
    await settle();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ kind: 'claude' });
    useChats.setState({
      agents: {
        m: {
          list: [
            { kind: 'claude', available: true },
            { kind: 'grok', available: true },
          ],
          at: Date.now(),
        },
      },
    });
    cmd.run();
    expect((useMenu.getState().menu?.entries ?? []).filter(isItem).map((e) => e.label)).toEqual(['Claude Code', 'Grok']);
    closeMenu(false);
    // None it can start: said, not an empty menu.
    const toast = vi.fn(() => 0);
    useStore.setState({ toast });
    useChats.setState({ agents: { m: { list: [{ kind: 'claude', available: false, reason: 'not_found' }], at: Date.now() } } });
    cmd.run();
    expect(useMenu.getState().menu).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(t('chat.noAgents', { machine: 'box' }));
    useStore.getState().setReadOnly(true);
    expect(cmd.enabled!()).toBe(false);
  });

  const notRunning = () => new Response('{"error":"not_running","message":"no chat host"}', { status: 409 });

  it('a new workspace asks the machine which agents it can start, starting its host; the others are not offered', async () => {
    answers['GET /api/m/m/p/chat/agents'] = notRunning;
    answers['POST /api/m/m/p/chat/agents'] = agents([
      { kind: 'codex', available: true },
      { kind: 'claude', available: false, reason: 'not_found' },
    ]);
    // While no host serves, nothing is known: every enabled kind.
    await chatPlugin.newTabItems!('m');
    await settle();
    expect(chatPlugin.newTabItems!('m')).toHaveLength(5);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/chat/agents'))).toBe(false);
    const { actions } = await import('../actions');
    await actions.newWorkspace('m', '/src/new', 'new');
    await settle();
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/chat/agents'))!;
    expect(post.url).toBe('/api/m/m/p/chat/agents?refresh=1');
    expect(chatPlugin.newTabItems!('m').map((i) => i.id)).toEqual(['chat.codex']);
  });

  it('a read-only page starts no host to ask', async () => {
    answers['GET /api/m/m/p/chat/agents'] = notRunning;
    useStore.getState().setReadOnly(true);
    chatPlugin.workspaceCreated!('m', 'w1w1w1w1');
    await settle();
    expect(calls.filter((c) => c.url.includes('/chat/agents')).map((c) => c.method)).toEqual(['GET']);
    expect(useChats.getState().agents.m).toBeUndefined();
  });

  it('a chat whose agent is not found has the machine asked again, past the hub’s cache', async () => {
    answers['GET /api/m/m/p/chat/agents'] = agents([{ kind: 'grok', available: false, reason: 'not_found' }]);
    setLive('m', A, { state: 'starting' });
    await settle();
    useChats.setState({ agents: { m: { list: [{ kind: 'grok', available: true }], at: Date.now() } } });
    calls = [];
    const error = { code: 'not_found', message: 'grok is not in the user’s PATH' };
    setLive('m', A, { state: 'failed', error });
    await settle();
    // Once per failure, not for each change that repeats it.
    setLive('m', A, { state: 'failed', error });
    await settle();
    expect(calls.filter((c) => c.url.includes('/chat/agents')).map((c) => c.url)).toEqual(['/api/m/m/p/chat/agents?refresh=1']);
    expect(chatPlugin.newTabItems!('m')).toEqual([]);
    // The chat still says why it failed.
    expect(useChats.getState().live[liveKey('m', A)]).toMatchObject({ state: 'failed', error: { code: 'not_found' } });
  });
});

describe('a chat’s folder', () => {
  it('is trusted through the hub’s route, not from a read-only page', async () => {
    applyMessage('m', msg([st(A, { cwd: '/home/u/my proj' })], 1, true));
    await chatSource('m', A).trust();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`/api/m/m/p/chat/trust?cwd=${encodeURIComponent('/home/u/my proj').replace(/%20/g, '+')}`);
    expect(post.body).toBeUndefined();
    answers['POST /api/m/m/p/chat/trust'] = () => new Response('{"error":"offline"}', { status: 409 });
    await expect(chatSource('m', A).trust()).rejects.toMatchObject({ code: 'offline' });
    useStore.getState().setReadOnly(true);
    calls = [];
    await expect(chatSource('m', A).trust()).rejects.toMatchObject({ code: 'read_only' });
    await expect(chatSource('m', A).untrust()).rejects.toMatchObject({ code: 'read_only' });
    expect(calls).toEqual([]);
  });

  it('is trusted no more through the hub’s route', async () => {
    applyMessage('m', msg([st(A, { cwd: '/home/u/proj' })], 1, true));
    await chatSource('m', A).untrust();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      `/api/m/m/p/chat/untrust?cwd=${encodeURIComponent('/home/u/proj')}`,
    ]);
    answers['POST /api/m/m/p/chat/untrust'] = () => new Response('{"error":"offline"}', { status: 409 });
    await expect(chatSource('m', A).untrust()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('a chat pane’s menu', () => {
  const labels = (list: ReturnType<typeof chatMenu>) => list.map((e) => (isItem(e) ? e.label : '-'));
  const entry = (list: ReturnType<typeof chatMenu>, label: string) => list.find((e) => isItem(e) && e.label === label) as MenuItem;

  it('renames, forks, switches agent, exports, closes and deletes the chat', async () => {
    applyMessage('m', msg([st(B, { title: 'Fix it' })], 1, true));
    const v = view(B);
    const list = chatMenu('m', v);
    expect(labels(list)).toEqual([
      t('chat.rename'),
      t('chat.fork'),
      t('chat.switchAgent'),
      t('chat.export'),
      t('chat.close'),
      t('chat.delete'),
    ]);
    const sw = entry(list, t('chat.switchAgent'));
    expect((sw.submenu ?? []).filter(isItem).map((e) => e.label)).not.toContain('Claude Code');
    expect((sw.submenu ?? []).filter(isItem).map((e) => e.label)).toContain('Codex');
    entry(list, t('chat.rename')).run!();
    expect(useChatUi.getState().renaming).toBe(`m\n${v.id}`);
    entry(list, t('chat.close')).run!();
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/m/m/p/chat/close?chat=${B}`]);
    entry(list, t('chat.delete')).run!();
    await settle();
    const req = useDialog.getState().current as Extract<DialogRequest, { kind: 'confirm' }>;
    expect(req).toMatchObject({ kind: 'confirm', danger: true });
    expect(req.message).toContain('Fix it');
    useDialog.setState({ current: undefined });
    req.resolve(true);
    await settle();
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`/api/m/m/p/chat/chat?chat=${B}`]);
    expect(chatGone(useChats.getState(), 'm', B)).toBe(true);
    expect(hub.layout('m')!.workspaces.flatMap((w) => L.pluginViews(w, 'chat'))).toEqual([]);
  });

  it('has nothing for a closed chat’s close, a leaf without a chat, or a read-only page', () => {
    applyMessage('m', msg([st(B, { state: 'closed' })], 1, true));
    expect(labels(chatMenu('m', view(B)))).toEqual([
      t('chat.rename'),
      t('chat.fork'),
      t('chat.switchAgent'),
      t('chat.export'),
      t('chat.delete'),
    ]);
    expect(chatMenu('m', view('nope'))).toEqual([]);
    useStore.getState().setReadOnly(true);
    expect(labels(chatMenu('m', view(B)))).toEqual([t('chat.export')]);
    expect(chatMenu('m', view('nope'))).toEqual([]);
  });

  it('confirms lossy fork from context menu and passes workspace + reports vault status on fork', async () => {
    const F = 'c00000000000000f9';
    const toast = vi.fn(() => 0);
    useStore.setState({ toast });
    applyMessage('m', msg([st(B, { kind: 'agy', title: 'Agy Chat' })], 1, true));
    useChats.setState((s) => ({
      live: {
        ...s.live,
        [`m\n${B}`]: {
          link: 'attached',
          info: {
            id: B,
            kind: 'agy',
            title: 'Agy Chat',
            cwd: '/w',
            state: 'idle',
            config: [],
            commands: [],
            capabilities: {
              images: false,
              compact: false,
              queue: false,
              plan: false,
              questions: false,
              effort: false,
              model: false,
              cancelQueued: false,
              fork: false,
            },
          },
        },
      },
    }));
    answers[`POST /api/m/m/p/chat/fork`] = () =>
      new Response(
        JSON.stringify({
          chat: st(F, { kind: 'agy', title: 'Agy Chat (fork)' }),
          vault: { injected: 0, locked: true },
        }),
        { status: 200 },
      );

    const list = chatMenu('m', view(B, { agent: 'agy' }));
    entry(list, t('chat.fork')).run!();
    await settle();
    const dlg = useDialog.getState().current as Extract<DialogRequest, { kind: 'confirm' }>;
    expect(dlg?.kind).toBe('confirm');
    expect(dlg?.title).toBe(t('chat.forkLossyTitle'));
    useDialog.setState({ current: undefined });
    dlg.resolve(true);
    await settle();
    await settle();

    const forkCall = calls.find((c) => c.method === 'POST' && c.url === '/api/m/m/p/chat/fork');
    expect(forkCall).toBeDefined();
    expect(forkCall!.body).toMatchObject({ chat: B, workspace: 'w2w2w2w2' });
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        t('vault.inject.locked'),
        expect.objectContaining({ label: expect.any(String) }),
        undefined,
        'warning',
      ),
    );
  });

  it('titles the pane by the chat, else the agent, and marks a chat that is no more', () => {
    const pane = chatPlugin.paneViews!.chat;
    expect(pane.title('m', view(B))).toBe('Claude Code');
    applyMessage('m', msg([st(B, { title: 'Fix it', cwd: '/x/y' })], 1, true));
    expect(pane.title('m', view(B))).toBe('Fix it');
    expect(pane.directory!('m', view(B))).toBe('/x/y');
    expect(pane.title('m', view(B, { agent: 'nobody' }))).toBe('Fix it');
    expect(pane.title('m', view(A, { agent: 'nobody' }))).toBe(t('chat.pane'));
  });
});
