// A chat continued in a terminal (plugins/chat/handoff.ts): offered while
// the chat's state (plugins/chat/state.ts) names an agent that resumes a
// session by its id and a session, no turn runs and the page may make
// changes; the machine's word on the chat (GET chats) decides
// its kind, session and directory; POST handoff first, and no terminal
// unless the host let the session go; then a new tab of the chat pane's
// workspace runs the kind's resume command as its program
// (agentTerminal.ts), its leaf remembering the session, which a restore
// after the terminal core started again resumes (restore.ts); a terminal
// that already runs the session is shown instead.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import { FakeCore, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { setLocale } from '../i18n';
import * as L from '../term/layout';
import { resumeArgv, sessionTerminal, startAgentTerminal } from '../agentTerminal';
import { canContinueInTerminal, continueInTerminal } from '../plugins/chat/handoff';
import { replaceTerminal, resumeSession } from '../restore';
import { applyStates, useChats } from '../plugins/chat/state';
import type { ChatState } from '../plugins/chat/protocol';

const S = '55555555-5555-4555-8555-555555555555';
const CHAT = 'c00000000000000c3';
const DIR = '/home/u/proj';
const VIEW: L.PluginView = { id: 'v1', plugin: 'chat', kind: 'chat', chat: CHAT, agent: 'claude' };

/** The chat's state as the page has it, with changes. */
const stateOf = (o: Partial<ChatState> = {}): ChatState => ({
  id: CHAT,
  kind: 'claude',
  title: 'A chat',
  cwd: DIR,
  state: 'idle',
  status: 'idle',
  updated: '2026-11-22T10:00:00Z',
  seq: 9,
  sessionId: S,
  ...o,
});

/** The core's chat routes of machine m, scripted. */
class FakeChats {
  requests: string[] = [];
  chats: unknown[] = [{ id: CHAT, kind: 'claude', cwd: DIR, sessionId: S, state: 'idle', status: 'idle' }];
  handoff: () => Response = () => new Response('{}', { status: 200 });

  install() {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://page');
      const method = init?.method ?? 'GET';
      this.requests.push(`${method} ${u.pathname}${u.search}`);
      if (u.pathname === '/api/m/m/p/chat/chats') return new Response(JSON.stringify({ chats: this.chats }), { status: 200 });
      if (u.pathname === '/api/m/m/p/chat/handoff' && method === 'POST') return this.handoff();
      return new Response('{"error":"unknown"}', { status: 404 });
    });
  }
}

let chats: FakeChats;

beforeAll(() => setLocale('en'));

beforeEach(() => {
  chats = new FakeChats();
  chats.install();
  useSettings.setState({ values: {} });
  useChats.setState({ states: {}, full: {}, deleted: {} });
  useStore.setState({ toasts: [] });
  useStore.getState().setReadOnly(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Machine m: workspace w1 with terminal a and those of placed in tabs
 * of their own, and workspace w2 (selected) with the chat's pane;
 * terminals as given besides a. */
async function setup(terminals: Array<Record<string, unknown> & { address: string }> = [], placed: string[] = []) {
  const core = new FakeCore();
  const tabs = ['a', ...placed].map((t) => ({ root: { terminal: t }, focused: t }));
  core.machine('m', [FakeCore.term('a'), ...terminals], {
    version: 2,
    selected: 1,
    workspaces: [
      { id: 'w1', name: '', cwd: '', selected: 0, tabs },
      { id: 'w2', name: 'chats', cwd: '', selected: 0, tabs: [{ root: { view: VIEW }, focused: 'view:v1' }] },
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

const runs = (core: FakeCore) => core.calls.filter((c) => c.method === 'terminal.run').map((c) => c.params);
const toasts = () => useStore.getState().toasts.map((t) => t.msg);
const leafOf = (model: FakeCore['model'], address: string) => L.findLeaf(model.layout('m')!, address);

describe('an agent as a terminal’s program', () => {
  it('resumes a session by the kind’s own command, only with a session id', () => {
    expect(resumeArgv('claude', S)).toEqual(['claude', '--resume', S]);
    expect(resumeArgv('codex', S)).toEqual(['codex', 'resume', S]);
    expect(resumeArgv('kimi', S)).toBeUndefined();
    expect(resumeArgv('claude', '--dangerously-skip-permissions')).toBeUndefined();
    expect(resumeArgv('claude', 'ABCDEF01-5555-4555-8555-555555555555')).toBeUndefined();
    expect(resumeArgv(undefined, S)).toBeUndefined();
  });

  it('starts in a new tab of the workspace, its leaf with the session, which a restore resumes', async () => {
    const { core, model } = await setup();
    const address = await startAgentTerminal('m', ['claude', '--resume', S], { workspace: 'w1', cwd: DIR, session: S });
    await settle();
    expect(address).toBe('t1');
    expect(runs(core)).toEqual([expect.objectContaining({ argv: ['claude', '--resume', S], cwd: DIR, keep: true })]);
    const ws = model.layout('m')!.workspaces.find((w) => w.id === 'w1')!;
    expect(ws.tabs.map((t) => L.tabPanes(t))).toEqual([['a'], ['t1']]);
    expect(L.selectedWorkspace(model.layout('m')!)!.id).toBe('w1');
    // No agent before the machine sees it: a leaf with an agent but not
    // its program's pid would read as one whose program is gone.
    expect(leafOf(model, 't1')).toEqual({ terminal: 't1', session: S });
    // The machine detects the agent: the leaf remembers it with its pid
    // and keeps the session.
    core.event('m', 'agent', 't1', { agent: 'claude' });
    await settle();
    await settle();
    expect(leafOf(model, 't1')).toEqual({ terminal: 't1', session: S, agent: 'claude', pid: 100 });
    // The terminal core starts again: the new terminal asks for the
    // agent back in that session.
    const restored = replaceTerminal(model.layout('m')!, 't1', 't9');
    expect(resumeSession(restored, 't9')).toEqual({ agent: 'claude', session: S });
  });

  it('takes only a session id into the leaf, and starts nothing on a read-only page', async () => {
    const { core, model } = await setup();
    await startAgentTerminal('m', ['codex'], { session: 'nope' });
    await settle();
    expect(leafOf(model, 't1')).toEqual({ terminal: 't1' });
    useStore.getState().setReadOnly(true);
    expect(await startAgentTerminal('m', ['codex'])).toBeUndefined();
    expect(runs(core)).toHaveLength(1);
  });

  it('finds the live terminal whose agent runs a session', async () => {
    await setup([
      FakeCore.term('b', { agent: 'claude', agent_session: S }),
      FakeCore.term('c', { agent_session: 'other' }),
      FakeCore.term('d', { agent: 'codex', agent_session: 'other', state: 'finished' }),
    ]);
    expect(sessionTerminal('m', S)).toBe('b');
    expect(sessionTerminal('m', 'other')).toBeUndefined();
    expect(sessionTerminal('m', '')).toBeUndefined();
  });
});

describe('a chat continued in a terminal', () => {
  it('is offered while the chat’s state names an agent that resumes by id and a session, no turn runs, on a page that may make changes', async () => {
    await setup();
    expect(canContinueInTerminal('m', VIEW)).toBe(false);
    applyStates('m', [stateOf()], true);
    expect(canContinueInTerminal('m', VIEW)).toBe(true);
    const offered = (o: Partial<ChatState>) => {
      applyStates('m', [stateOf(o)], true);
      return canContinueInTerminal('m', VIEW);
    };
    for (const o of [{ status: 'done' }, { state: 'sleeping' }, { state: 'closed' }, { state: 'failed' }, { kind: 'codex' }]) {
      expect(offered(o), JSON.stringify(o)).toBe(true);
    }
    for (const o of [
      { state: 'working', status: 'working' },
      { state: 'waiting', status: 'blocked' },
      { state: 'starting', sessionId: '' },
      { state: 'starting' },
      { sessionId: '' },
      { sessionId: 'not-a-uuid' },
      { kind: 'kimi' },
    ]) {
      expect(offered(o), JSON.stringify(o)).toBe(false);
    }
    applyStates('m', [stateOf()], true);
    expect(canContinueInTerminal('m', { ...VIEW, chat: 'c1' })).toBe(false);
    useStore.getState().setReadOnly(true);
    expect(canContinueInTerminal('m', VIEW)).toBe(false);
  });

  it('hands the chat over, then resumes its session in a new tab of the pane’s workspace', async () => {
    const { core, model } = await setup();
    await continueInTerminal('m', VIEW);
    await settle();
    expect(chats.requests).toEqual(['GET /api/m/m/p/chat/chats', `POST /api/m/m/p/chat/handoff?chat=${CHAT}`]);
    expect(runs(core)).toEqual([expect.objectContaining({ argv: ['claude', '--resume', S], cwd: DIR })]);
    const ws = model.layout('m')!.workspaces.find((w) => w.id === 'w2')!;
    expect(ws.tabs.map((t) => L.tabPanes(t))).toEqual([['view:v1'], ['t1']]);
    expect(leafOf(model, 't1')).toEqual({ terminal: 't1', session: S });
    expect(L.focusedPane(model.layout('m')!)).toBe('t1');
    expect(toasts()).toEqual([]);
  });

  it('goes by the machine’s kind and session, never the leaf’s', async () => {
    const { core } = await setup();
    chats.chats = [{ id: CHAT, kind: 'codex', cwd: DIR, sessionId: S, state: 'sleeping' }];
    await continueInTerminal('m', VIEW);
    await settle();
    expect(runs(core).map((p) => p.argv)).toEqual([['codex', 'resume', S]]);
  });

  it('starts no terminal unless the host let the session go', async () => {
    const { core } = await setup();
    chats.handoff = () => new Response('{"error":"busy","message":"a turn runs"}', { status: 409 });
    await continueInTerminal('m', VIEW);
    await settle();
    expect(runs(core)).toEqual([]);
    expect(toasts()).toEqual(['The chat could not continue in a terminal: the agent is working; wait for its turn to end, or stop it']);
    // A chat without an agent process, or handed off before, has let it go.
    for (const code of ['sleeping', 'handed_off']) {
      chats.handoff = () => new Response(JSON.stringify({ error: code, message: '' }), { status: 409 });
      await continueInTerminal('m', VIEW);
      await settle();
    }
    expect(runs(core)).toHaveLength(2);
  });

  it('says why when the chat is gone, has no session yet, or the list cannot be read', async () => {
    const { core } = await setup();
    chats.chats = [];
    await continueInTerminal('m', VIEW);
    chats.chats = [{ id: CHAT, kind: 'claude', cwd: DIR, sessionId: '', state: 'starting' }];
    await continueInTerminal('m', VIEW);
    chats.chats = [{ id: CHAT, kind: 'kimi', cwd: DIR, sessionId: S, state: 'idle' }];
    await continueInTerminal('m', VIEW);
    vi.stubGlobal('fetch', async () => new Response('{"error":"offline","message":"down"}', { status: 409 }));
    await continueInTerminal('m', VIEW);
    expect(toasts()).toEqual([
      'The chat is no longer on the machine.',
      'This chat has no session a terminal can continue yet.',
      'This chat has no session a terminal can continue yet.',
      'The chat could not continue in a terminal: the machine is not connected',
    ]);
    expect(chats.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(runs(core)).toEqual([]);
  });

  it('starts no terminal when the host says one the page does not know runs the session', async () => {
    const { core } = await setup();
    chats.handoff = () => new Response('{"error":"in_terminal","message":"held"}', { status: 409 });
    await continueInTerminal('m', VIEW);
    await settle();
    expect(runs(core)).toEqual([]);
    expect(toasts()).toEqual(['The chat could not continue in a terminal: the session runs in a terminal']);
  });

  it('shows the terminal that already runs the session instead of starting another', async () => {
    const { core, model } = await setup([FakeCore.term('b', { agent: 'claude', agent_session: S, pid: 300 })], ['b']);
    await continueInTerminal('m', VIEW);
    await settle();
    expect(chats.requests.at(-1)).toBe(`POST /api/m/m/p/chat/handoff?chat=${CHAT}`);
    expect(runs(core)).toEqual([]);
    expect(L.focusedPane(model.layout('m')!)).toBe('b');
  });

  it('does nothing on a read-only page', async () => {
    const { core } = await setup();
    useStore.getState().setReadOnly(true);
    await continueInTerminal('m', VIEW);
    expect(chats.requests).toEqual([]);
    expect(runs(core)).toEqual([]);
  });
});
