// @vitest-environment jsdom
//
// An agent's earlier session opened as a chat (an import,
// plugins/chat/imports.ts): the chat panel's list of a directory's
// sessions (plugins/chat/Sessions.tsx PastSessions), for each chat kind
// the machine can start, newest first, a page at a time, a session that
// is a chat's showing that chat; and the button in the header of a
// terminal whose agent quit (plugins/agents/ContinueInChat.tsx). Both POST
// new {kind, cwd, resume, import} and open the chat's pane, refuse a
// session a terminal's agent runs (naming that terminal), and open nothing
// on a read-only page. The core's chat routes are a scripted fetch.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BotMessageSquare } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import { FakeCore, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { setLocale } from '../i18n';
import * as L from '../term/layout';
import { allPlugins, definePlugins, TerminalHeaderActions } from '../plugins/registry';
import type { PluginDef } from '../plugins/api';
import { agentsPlugin } from '../plugins/agents';
import { chatTarget, ContinueInChat } from '../plugins/agents/ContinueInChat';
import { chatSessions, importSession } from '../plugins/chat/imports';
import { listedDirectory, PastSessions } from '../plugins/chat/Sessions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const C1 = '019a0000-0000-7000-8000-000000000001';
const CHAT = 'c00000000000000a1';
const NEW_CHAT = 'c0000000000000b02';
const DIR = '/home/u/proj';

/** A chat plugin as the page has it: its id, and a pane that works in
 * the directory of its chat (all of them in DIR here). */
const chatPlugin: PluginDef = {
  id: 'chat',
  title: 'chat.title',
  icon: BotMessageSquare,
  paneViews: { chat: { icon: BotMessageSquare, title: () => 'Chat', directory: () => DIR, component: () => null } },
};

interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

/** The core's chat routes of machine m, scripted. */
class FakeChats {
  requests: Req[] = [];
  agents: unknown[] = [
    { kind: 'claude', available: true, version: '2.1.330' },
    { kind: 'codex', available: true },
    { kind: 'kimi', available: false, reason: 'not_found' },
    // No chats for it on this page: left out.
    { kind: 'gemini', available: true },
  ];
  /** Pages by "kind cwd cursor". */
  pages = new Map<string, unknown>();
  newAnswer: () => Response = () => new Response(JSON.stringify({ chat: { id: NEW_CHAT, kind: 'claude' } }), { status: 200 });

  install() {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://page');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      this.requests.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
      const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (u.pathname === '/api/m/m/p/chat/agents') return ok({ agents: this.agents });
      if (u.pathname === '/api/m/m/p/chat/sessions') {
        const q = u.searchParams;
        const page = this.pages.get(`${q.get('kind')} ${q.get('cwd')} ${q.get('cursor') ?? ''}`);
        return ok(page ?? { sessions: [] });
      }
      if (u.pathname === '/api/m/m/p/chat/new' && method === 'POST') return this.newAnswer();
      return new Response('{"error":"unknown"}', { status: 404 });
    });
  }

  posts = () => this.requests.filter((r) => r.method === 'POST');
  sessionReads = () => this.requests.filter((r) => r.path.endsWith('/sessions')).map((r) => r.query);
}

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let chats: FakeChats;
const saved = [...allPlugins()];

beforeAll(() => setLocale('en'));

beforeEach(() => {
  chats = new FakeChats();
  chats.install();
  useSettings.setState({ values: {} });
  definePlugins([agentsPlugin, chatPlugin]);
  useStore.setState({ toasts: [] });
  useStore.getState().setReadOnly(false);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = root = undefined;
  definePlugins(saved);
  vi.unstubAllGlobals();
});

/** Machine m: workspace w1 with terminal a (in DIR, its leaf as given)
 * focused in its first tab and b in a second, workspace w2 with a chat
 * pane of CHAT. */
async function setup(o: { a?: Record<string, unknown>; b?: Record<string, unknown>; leaf?: Record<string, unknown> } = {}) {
  const core = new FakeCore();
  core.machine('m', [FakeCore.term('a', { cwd: DIR, ...o.a }), FakeCore.term('b', { pid: 200, ...o.b })], {
    version: 2,
    selected: 0,
    workspaces: [
      {
        id: 'w1',
        name: '',
        cwd: '',
        selected: 0,
        tabs: [
          { root: { terminal: 'a', ...o.leaf }, focused: 'a' },
          { root: { terminal: 'b' }, focused: 'b' },
        ],
      },
      {
        id: 'w2',
        name: 'chats',
        cwd: '',
        selected: 0,
        tabs: [{ root: { view: { id: 'v1', plugin: 'chat', kind: 'chat', chat: CHAT, agent: 'codex' } }, focused: 'view:v1' }],
      },
    ],
  });
  const model = core.install();
  useStore
    .getState()
    .setMachines([{ id: 'm', label: 'box', kind: 'local', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  useStore.getState().selectMachine('m');
  model.subscribe('m');
  await settle();
  await settle();
  return { core, model };
}

async function render(el: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  for (let i = 0; i < 4; i++) await act(settle);
}

const rows = () => [...host!.querySelectorAll<HTMLElement>('.agent-session')];
const rowOf = (session: string) => host!.querySelector<HTMLElement>(`.agent-session[data-session="${session}"]`)!;
const labels = () => rows().map((r) => r.querySelector('.tree-label')!.textContent);
const groups = () => [...host!.querySelectorAll('.agent-sessions-kind-title')].map((e) => e.textContent);
const chatViews = (model: FakeCore['model']) =>
  model.layout('m')!.workspaces.flatMap((ws) => L.pluginViews(ws, 'chat', 'chat').map((v) => ({ ws: ws.id, tab: v.tab, view: v.view })));
const toasts = () => useStore.getState().toasts;

/** The sessions of the scripted machine: claude's in two pages (with
 * entries that are none), codex's one, which a chat has. */
function script() {
  chats.pages.set(`claude ${DIR} `, {
    sessions: [
      { sessionId: S2, cwd: DIR, title: 'Older work', updatedAt: '2026-11-01T10:00:00Z' },
      { sessionId: S1, cwd: DIR, title: 'Fix the   parser\n', updatedAt: '2026-11-20T10:00:00Z' },
      { sessionId: '', title: 'no id' },
      { title: 'no id either' },
      { sessionId: 'a\u0000b', title: 'control character' },
      { sessionId: S4, cwd: 'relative/dir', chat: 'not-a-chat' },
    ],
    nextCursor: 'p2',
  });
  chats.pages.set(`claude ${DIR} p2`, {
    sessions: [
      { sessionId: S3, cwd: DIR, title: 'Oldest', updatedAt: '2026-10-01T10:00:00Z' },
      { sessionId: S2, cwd: DIR },
    ],
  });
  chats.pages.set(`codex ${DIR} `, {
    sessions: [{ sessionId: C1, cwd: DIR, title: 'A Codex thread', updatedAt: '2026-11-21T10:00:00Z', chat: CHAT }],
  });
}

describe('the chat panel’s earlier sessions', () => {
  it('list the sessions of each chat kind the machine can start for the focused terminal’s directory, newest first', async () => {
    await setup();
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    expect(groups()).toEqual(['Claude Code', 'Codex']);
    expect(chats.sessionReads()).toEqual([
      { kind: 'claude', cwd: DIR },
      { kind: 'codex', cwd: DIR },
    ]);
    // Entries without an id of the right form are none; a chat id of
    // another form is no chat; a relative directory is the listed one.
    expect(labels()).toEqual(['Fix the parser', 'Older work', 'Session 44444444', 'A Codex thread']);
    expect(rowOf(S4).querySelector('.tree-description')?.textContent ?? '').not.toContain('in a chat');
    expect(rowOf(C1).querySelector('.tree-description')!.textContent).toContain('in a chat');
    expect(host!.querySelector('.agent-sessions-dir')!.textContent).toBe('~/proj');
    expect(host!.querySelector('.section-count')!.textContent).toBe('4');
  });

  it('read the next page of a kind with Show More', async () => {
    await setup();
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    const more = host!.querySelectorAll<HTMLButtonElement>('.agent-sessions-more');
    expect(more).toHaveLength(1);
    await act(async () => more[0].click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(chats.sessionReads().at(-1)).toEqual({ kind: 'claude', cwd: DIR, cursor: 'p2' });
    expect(labels()).toEqual(['Fix the parser', 'Older work', 'Oldest', 'Session 44444444', 'A Codex thread']);
    expect(host!.querySelector('.agent-sessions-more')).toBeNull();
  });

  it('list the directory they are given, "~" as the home directory, and read again with Refresh', async () => {
    await setup();
    script();
    chats.pages.set('claude /home/u/other ', { sessions: [{ sessionId: S3, cwd: '/home/u/other', title: 'Elsewhere' }] });
    await render(createElement(PastSessions, { m: 'm', cwd: '~/other' }));
    expect(labels()).toEqual(['Elsewhere']);
    const before = chats.requests.length;
    await act(async () => host!.querySelector<HTMLButtonElement>('.section-actions button')!.click());
    for (let i = 0; i < 4; i++) await act(settle);
    expect(chats.requests.slice(before).map((r) => r.path)).toEqual([
      '/api/m/m/p/chat/agents',
      '/api/m/m/p/chat/sessions',
      '/api/m/m/p/chat/sessions',
    ]);
    expect(listedDirectory('~', '/home/u')).toBe('/home/u');
    expect(listedDirectory('/srv/x/', '/home/u')).toBe('/srv/x');
    expect(listedDirectory('relative', '/home/u')).toBe('/home/u');
    expect(listedDirectory(undefined, undefined)).toBeUndefined();
  });

  it('say there are none, and draw nothing where no agent can chat', async () => {
    await setup();
    await render(createElement(PastSessions, { m: 'm' }));
    expect(rows()).toEqual([]);
    expect(host!.querySelector('.agent-sessions-note')!.textContent).toBe('No earlier sessions in this folder.');
    await act(async () => root!.unmount());
    root = undefined;
    chats.agents = [{ kind: 'kimi', available: false }];
    await render(createElement(PastSessions, { m: 'm' }));
    expect(host!.querySelector('.agent-sessions')).toBeNull();
  });

  it('open a session as a chat: POST new with import, and the chat’s pane in a new tab', async () => {
    const { model } = await setup();
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    await act(async () => rowOf(S1).click());
    for (let i = 0; i < 4; i++) await act(settle);
    expect(chats.posts()).toEqual([
      { method: 'POST', path: '/api/m/m/p/chat/new', query: {}, body: { kind: 'claude', cwd: DIR, resume: S1, import: true } },
    ]);
    const opened = chatViews(model).find((v) => v.view.chat === NEW_CHAT)!;
    expect(opened.view).toMatchObject({ plugin: 'chat', kind: 'chat', chat: NEW_CHAT, agent: 'claude' });
    expect(opened.ws).toBe('w1');
    expect(L.focusedPane(model.layout('m')!)).toBe(L.viewKey(opened.view.id));
    // The session is that chat's now: a second press shows it.
    expect(rowOf(S1).querySelector('.tree-description')!.textContent).toContain('in a chat');
    await act(async () => rowOf(S1).querySelector<HTMLButtonElement>('.tree-actions button')!.click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(chats.posts()).toHaveLength(1);
    expect(chatViews(model).filter((v) => v.view.chat === NEW_CHAT)).toHaveLength(1);
  });

  it('show the chat a session is already in, without a request', async () => {
    const { model } = await setup();
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    await act(async () => rowOf(C1).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(chats.posts()).toEqual([]);
    const layout = model.layout('m')!;
    expect(L.selectedWorkspace(layout)!.id).toBe('w2');
    expect(L.focusedPane(layout)).toBe('view:v1');
    expect(chatViews(model)).toHaveLength(1);
  });

  it('refuse a session a terminal’s agent runs, naming the terminal, which the toast shows', async () => {
    const { model } = await setup({ b: { agent: 'claude', agent_session: S1, agent_session_source: 'pid' } });
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    await act(async () => rowOf(S1).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(chats.posts()).toEqual([]);
    const [toast] = toasts();
    expect(toast.kind).toBe('warning');
    expect(toast.msg).toBe('This session runs in the terminal proj · 2. Quit the agent there first.');
    await act(async () => toast.action!.run());
    expect(L.focusedPane(model.layout('m')!)).toBe('b');
  });

  it('say what the machine refused', async () => {
    await setup();
    script();
    await render(createElement(PastSessions, { m: 'm' }));
    chats.newAnswer = () => new Response('{"error":"in_terminal","message":"held"}', { status: 409 });
    await act(async () => rowOf(S1).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(toasts().at(-1)!.msg).toBe('This session runs in a terminal. Quit the agent there first.');
    chats.newAnswer = () => new Response('{"error":"too_many","message":"full"}', { status: 409 });
    await act(async () => rowOf(S2).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(toasts().at(-1)).toMatchObject({
      kind: 'error',
      msg: 'The session could not be opened as a chat: the machine keeps as many chats as its settings allow',
    });
    chats.newAnswer = () => new Response('{"chat":{"id":"../etc"}}', { status: 200 });
    await act(async () => rowOf(S2).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(toasts().at(-1)!.msg).toContain('The session could not be opened as a chat');
  });

  it('open nothing on a read-only page, and still show a chat', async () => {
    const { model } = await setup();
    script();
    useStore.getState().setReadOnly(true);
    await render(createElement(PastSessions, { m: 'm' }));
    expect(rowOf(S1).querySelector<HTMLButtonElement>('.tree-actions button')!.disabled).toBe(true);
    expect(rowOf(C1).querySelector<HTMLButtonElement>('.tree-actions button')!.disabled).toBe(false);
    await act(async () => rowOf(S1).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(chats.posts()).toEqual([]);
    expect(await importSession('m', { kind: 'claude', session: S1, cwd: DIR })).toBeUndefined();
    expect(chats.posts()).toEqual([]);
    expect(chatViews(model)).toHaveLength(1);
    // A chat is shown all the same.
    await act(async () => rowOf(C1).click());
    for (let i = 0; i < 3; i++) await act(settle);
    expect(L.focusedPane(model.layout('m')!)).toBe('view:v1');
  });

  it('take a page’s sessions only as far as they are sessions', async () => {
    await setup();
    chats.pages.set(`claude ${DIR} `, { sessions: 'nope', nextCursor: 7 });
    expect(await chatSessions('m', 'claude', DIR)).toEqual({ sessions: [] });
    chats.pages.set(`claude ${DIR} `, { sessions: Array.from({ length: 500 }, (_, i) => ({ sessionId: `s${i}` })) });
    expect((await chatSessions('m', 'claude', DIR)).sessions).toHaveLength(200);
  });
});

describe('Continue in Chat in a terminal’s header', () => {
  const quit = { agent: 'claude', pid: 100, session: S1 };

  it('belongs to the agents plugin', () => {
    expect(agentsPlugin.headerActions).toEqual([ContinueInChat]);
  });

  it('shows while the leaf remembers an agent with chats and its session, and no agent runs', async () => {
    await setup({ leaf: quit });
    const leaf = { terminal: 'a', ...quit };
    const live = FakeCore.term('a');
    expect(chatTarget(leaf, live)).toEqual({ kind: 'claude', session: S1 });
    expect(chatTarget(leaf, { ...live, agent: 'claude' })).toBeUndefined();
    expect(chatTarget(leaf, { ...live, state: 'finished' })).toBeUndefined();
    expect(chatTarget(leaf, undefined)).toBeUndefined();
    expect(chatTarget({ ...leaf, agent: 'gemini' }, live)).toBeUndefined();
    expect(chatTarget({ ...leaf, session: 'not-a-uuid' }, live)).toBeUndefined();
    expect(chatTarget({ terminal: 'a', session: S1 }, live)).toBeUndefined();
  });

  it('opens the session as a chat in the terminal’s directory, in a new tab of its workspace', async () => {
    const { model } = await setup({ leaf: quit });
    await render(createElement(TerminalHeaderActions, { m: 'm', terminal: 'a', leaf: { terminal: 'a', ...quit } }));
    const button = host!.querySelector<HTMLButtonElement>('button.agents-continue')!;
    expect(button.getAttribute('aria-label')).toBe('Continue in Chat');
    expect(button.title).toBe('Continue this Claude Code session in a chat');
    await act(async () => button.click());
    for (let i = 0; i < 4; i++) await act(settle);
    expect(chats.posts().map((r) => r.body)).toEqual([{ kind: 'claude', cwd: DIR, resume: S1, import: true }]);
    const opened = chatViews(model).find((v) => v.view.chat === NEW_CHAT)!;
    expect(opened).toMatchObject({ ws: 'w1', tab: 2, view: { agent: 'claude' } });
  });

  it('is not there on a read-only page, with the chat plugin off, or while an agent runs', async () => {
    await setup({ leaf: quit });
    const draw = async () => {
      if (root) await act(async () => root!.unmount());
      host?.remove();
      await render(createElement(TerminalHeaderActions, { m: 'm', terminal: 'a', leaf: { terminal: 'a', ...quit } }));
      return host!.querySelector('button.agents-continue');
    };
    expect(await draw()).not.toBeNull();
    useStore.getState().setReadOnly(true);
    expect(await draw()).toBeNull();
    useStore.getState().setReadOnly(false);
    useSettings.setState({ values: { 'plugins.chat.enabled': { value: false, source: 'global' } } as never });
    expect(await draw()).toBeNull();
    useSettings.setState({ values: {} });
    expect(await draw()).not.toBeNull();
  });
});
