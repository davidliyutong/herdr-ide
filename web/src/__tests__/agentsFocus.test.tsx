// @vitest-environment jsdom
//
// Where the keyboard is as the agents plugin's surface changes over a
// terminal drawn by the real TerminalView (its emulator a stand-in): a new
// agent tab before its first prompt gives it to the terminal, the first
// conversation drawn to its composer, and the agent's waiting for an answer
// to the terminal, under the conversation's upper part or shown whole,
// unless the user is writing a message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// The emulator: focus goes to its field, its screen is the test's; anything
// else it is asked does nothing.
const shown = vi.hoisted(() => ({ screen: '' }));
vi.mock('../vt/pane', () => ({
  TermPane: class {
    attached = true;
    constructor(_host: HTMLElement, _canvas: HTMLCanvasElement, textarea: HTMLTextAreaElement) {
      const focus = () => textarea.focus({ preventScroll: true });
      const screenText = () => shown.screen;
      return new Proxy(this, {
        get: (target, key) =>
          key === 'focus'
            ? focus
            : key === 'screenText'
              ? screenText
              : key in target
                ? (target as Record<string | symbol, unknown>)[key]
                : () => {},
      });
    }
  },
}));

import { TerminalView } from '../components/TerminalView';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';
import { allPlugins, definePlugins, surfacesCover, TerminalSurfaces, useActivePlugins } from '../plugins/registry';
import { agentsPlugin } from '../plugins/agents';
import { resetFeeds } from '../plugins/agents/transcript';
import { coverIn, strongestCover, useCovers } from '../state/covers';
import { useSettings } from '../settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111';

interface Read {
  refs: string[];
  settled: boolean;
  aborted: boolean;
  answer(body: unknown, status?: number): void;
}
let reads: Read[];
const open = () => reads.filter((r) => !r.settled && !r.aborted);
const text = (s: string) => ({ type: 'text' as const, text: s });
const say = (seq: number, s: string) => ({ seq, t: 'update', update: { sessionUpdate: 'agent_message_chunk', content: text(s) } });
const tail = (session: string, o: Record<string, unknown> = {}) => ({ kind: 'claude', session, file: 'f1', first: 0, next: 0, ...o });

let core: FakeCore;
let host: HTMLDivElement;
let root: Root;
const saved = [...allPlugins()];

/** A terminal's pane as the workspace draws it in the focused tab: the
 * terminal, given the keyboard unless covered all, and the surfaces. */
function Pane({ terminal }: { terminal: string }) {
  const layout = useTerms((s) => s.machines.a?.layout);
  const covers = useCovers((s) => s.covers);
  const active = useActivePlugins();
  const leaf = layout && L.findLeaf(layout, terminal);
  if (!leaf || !L.isTerminalLeaf(leaf)) return null;
  const covered = strongestCover([coverIn(covers, 'a', terminal), surfacesCover(active, 'a', terminal, leaf)]) === 'all';
  return createElement(
    'div',
    { className: 'pane', 'data-pane': terminal },
    createElement(TerminalView, { m: 'a', terminal, focused: !covered, covered, onActivate: () => {} }),
    createElement(TerminalSurfaces, { m: 'a', terminal, leaf, focused: true, onActivate: () => {} }),
  );
}

async function setup(record: Record<string, unknown>, t1: Partial<L.TerminalLeaf>) {
  core = new FakeCore();
  core.machine('a', [FakeCore.term('t1', record)], {
    version: 2,
    workspaces: [{ id: 'w1', name: '', cwd: '/home/u', tabs: [{ root: { terminal: 't1', ...t1 }, focused: 't1' }], selected: 0 }],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'a', label: 'Box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
  await act(async () => root.render(createElement('div', { className: 'tab-panes' }, createElement(Pane, { terminal: 't1' }))));
}

const flush = () => act(async () => void (await settle()));
const q = <E extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<E>(sel);
const surface = () => q('[data-pane="t1"] .pane-surfaces > *');
const terminalInput = () => q<HTMLTextAreaElement>('[data-pane="t1"] .term-input');
const composer = () => q<HTMLTextAreaElement>('[data-pane="t1"] .conv textarea');
async function until(fn: () => unknown) {
  await vi.waitFor(
    async () => {
      await flush();
      expect(fn()).toBeTruthy();
    },
    { timeout: 5000 },
  );
}

beforeEach(() => {
  reads = [];
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://core');
    return new Promise<Response>((resolve, reject) => {
      const r: Read = {
        refs: url.searchParams.getAll('s'),
        settled: false,
        aborted: false,
        answer(body, status = 200) {
          r.settled = true;
          resolve(new Response(JSON.stringify(body), { status }));
        },
      };
      init?.signal?.addEventListener('abort', () => {
        r.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
      reads.push(r);
    });
  });
  useSettings.setState({ values: {} });
  definePlugins([agentsPlugin]);
  resetFeeds();
  // 25 rows in a terminal's area 400 pixels high, the conversation's upper
  // part over its first 152 (jsdom lays nothing out).
  shown.screen = Array.from({ length: 25 }, () => '').join('\n');
  const rect = (height: number) =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('pane-surfaces')) return rect(400);
    if (this.matches('.agents-surface[data-mode="peek"]')) return rect(152);
    return rect(this.classList.contains('agents-surface') ? 400 : 0);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetFeeds();
  useCovers.setState({ covers: {} });
  definePlugins(saved);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the keyboard over a terminal', () => {
  it('is the terminal’s for a new agent tab with no transcript yet, to type the first prompt', async () => {
    await setup({}, { render: 'native', session: S1 });
    expect(document.activeElement).toBe(terminalInput());
    // The agent is found: its conversation is read, over the terminal.
    core.event('a', 'agent', 't1', { agent: 'claude', agent_status: 'idle', agent_session: S1, agent_session_source: 'argv' });
    await flush();
    expect(surface()!.dataset.mode).toBe('loading');
    expect(document.activeElement).toBe(surface());
    // It has written none yet: the terminal, the strip over its top.
    await act(async () => open()[0].answer({ tails: [tail(S1, { code: 'not_found' })] }));
    await flush();
    expect(surface()!.className).toBe('agents-strip');
    expect(terminalInput()!.tabIndex).toBe(0);
    expect(document.activeElement).toBe(terminalInput());
  });

  it('goes to the composer when the conversation is first drawn', async () => {
    await setup({ agent: 'claude', agent_status: 'idle', agent_session: S1, agent_session_source: 'pid' }, {});
    expect(document.activeElement).toBe(terminalInput());
    await act(async () => void terms.mutate('a', (l) => L.setTerminalFields(l, 't1', { render: 'native' })));
    await flush();
    expect(surface()!.dataset.mode).toBe('loading');
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Hello')] })] }));
    await until(() => composer());
    expect(document.activeElement).toBe(composer());
  });

  it('goes to the terminal when the agent begins to wait, but not from a user writing a message', async () => {
    await setup({ agent: 'claude', agent_status: 'working', agent_session: S1, agent_session_source: 'pid' }, { render: 'native' });
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Hello')] })] }));
    await until(() => composer());
    // Nothing written: the terminal takes it, to answer.
    composer()!.focus();
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked', msg: 'approve Bash: rm -rf build' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(surface()!.hasAttribute('data-whole')).toBe(false);
    expect(document.activeElement).toBe(terminalInput());
    // Answered: the composer again.
    core.event('a', 'agent', 't1', { agent_status: 'working', status: { state: 'working' } });
    await until(() => composer());
    expect(document.activeElement).toBe(composer());
    // Written in: it stays there.
    await act(async () => {
      composer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked', msg: 'approve Bash: rm -rf build' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(document.activeElement).toBe(composer());
  });

  it('goes to the terminal shown whole when the question is under the conversation’s upper part, and back to the composer', async () => {
    await setup({ agent: 'codex', agent_status: 'working', agent_session: S1, agent_session_source: 'pid' }, { render: 'native' });
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { kind: 'codex', next: 1024, events: [say(256, 'Hello')] })] }));
    await until(() => composer());
    composer()!.focus();
    // A dialog at the top of a cleared screen.
    shown.screen = Array.from({ length: 25 }, (_, i) => (i === 1 ? '  Update available!' : i === 3 ? '› 1. Update now' : '')).join('\n');
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked', msg: 'Update available' } });
    await flush();
    expect(surface()!.hasAttribute('data-whole')).toBe(true);
    expect(terminalInput()!.tabIndex).toBe(0);
    expect(document.activeElement).toBe(terminalInput());
    core.event('a', 'agent', 't1', { agent_status: 'working', status: { state: 'working' } });
    await until(() => composer());
    expect(document.activeElement).toBe(composer());
  });
});
