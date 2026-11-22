// @vitest-environment jsdom
//
// The agents plugin over a terminal's pane, as the workspace draws it: the
// switch in the pane's header (for agents with a native view only, shown
// disabled on a read-only page); the strip, the loading view, the
// conversation over the terminal, and its upper part while the agent waits
// for the user, who gets the terminal's keyboard and is told what the agent
// waits for, unless they are writing a message; the terminal shown whole
// instead when what it shows is all under that part (a dialog at the top
// of a cleared screen) or its screen cannot be read, read again as it
// changes; the keyboard handed to what is drawn; a draft that outlives the
// view; and a view that starts over when the agent's session changes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';
import { allPlugins, definePlugins, TerminalHeaderActions, TerminalSurfaces } from '../plugins/registry';
import { agentsPlugin } from '../plugins/agents';
import { resetFeeds } from '../plugins/agents/transcript';
import { RECHECK_MS, SETTLED_MS } from '../plugins/agents/Surface';
import { covers } from '../plugins/agents/view';
import { coverOf, strongestCover, useCovers } from '../state/covers';
import { registerPane, surfaceHandle } from '../state/panes';
import { useSettings } from '../settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

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

/** The header and the surfaces of a terminal's pane, for its leaf as the
 * layout has it. */
function Pane({ terminal }: { terminal: string }) {
  const layout = useTerms((s) => s.machines.a?.layout);
  const leaf = layout && L.findLeaf(layout, terminal);
  if (!leaf || !L.isTerminalLeaf(leaf)) return null;
  return createElement(
    'div',
    { className: 'pane', 'data-pane': terminal },
    createElement('div', { className: 'pane-header' }, createElement(TerminalHeaderActions, { m: 'a', terminal, leaf })),
    createElement(TerminalSurfaces, { m: 'a', terminal, leaf, focused: true, onActivate: () => {} }),
  );
}

async function setup(o: { t1?: Partial<L.TerminalLeaf>; record?: Record<string, unknown>; readOnly?: boolean } = {}) {
  core = new FakeCore();
  core.machine(
    'a',
    [
      FakeCore.term('t1', { agent: 'claude', agent_status: 'idle', agent_session: S1, agent_session_source: 'pid', ...o.record }),
      FakeCore.term('t2'),
    ],
    {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: '',
          cwd: '/home/u',
          tabs: [
            { root: { terminal: 't1', ...o.t1 }, focused: 't1' },
            { root: { terminal: 't2' }, focused: 't2' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    },
  );
  core.install();
  const s = useStore.getState();
  s.setReadOnly(!!o.readOnly);
  s.setMachines([{ id: 'a', label: 'Box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
  await act(async () =>
    root.render(
      createElement('div', { className: 'tab-panes' }, createElement(Pane, { terminal: 't1' }), createElement(Pane, { terminal: 't2' })),
    ),
  );
}

const flush = () => act(async () => void (await settle()));
const q = <E extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<E>(sel);
const surface = () => q('[data-pane="t1"] .pane-surfaces > *');
const leafOf = () => L.findLeaf(core.model.layout('a')!, 't1') as L.TerminalLeaf;
const composer = () => q<HTMLTextAreaElement>('[data-pane="t1"] .conv textarea');
function setValue(el: HTMLTextAreaElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
/** The terminal t1 on screen, its focus recorded; screen: what it shows. */
function fakeTerminal(screen: () => string = () => '') {
  const focus = vi.fn();
  const typed: string[] = [];
  const off = registerPane('a', 't1', {
    focus,
    type: (s) => typed.push(s),
    paste: (s) => typed.push(`paste:${s}`),
    openFind: () => {},
    screenText: screen,
  });
  return { focus, typed, off };
}
/** Where things are drawn (jsdom lays nothing out): a terminal's area 400
 * pixels high and 100 below the page's top, the conversation's upper part
 * over its first 152. */
function layOut() {
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, left: 0, top, right: 800, bottom: top + height, width: 800, height, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('pane-surfaces')) return rect(100, 400);
    if (this.matches('.agents-surface[data-mode="peek"]')) return rect(100, 152);
    if (this.classList.contains('agents-surface')) return rect(100, 400);
    return rect(0, 0);
  });
}
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
  layOut();
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
  vi.useRealTimers();
});

describe('the header’s switch', () => {
  it('is there for an agent with a native view, not for a shell, and says which view is on', async () => {
    await setup();
    const button = q('[data-pane="t1"] .pane-plugin-actions button.agents-toggle')!;
    expect(button).not.toBeNull();
    expect(q('[data-pane="t2"] .agents-toggle')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.hasAttribute('disabled')).toBe(false);
    await act(async () => button.click());
    await flush();
    expect(leafOf().render).toBe('native');
    expect(q('[data-pane="t1"] .agents-toggle')!.getAttribute('aria-pressed')).toBe('true');
    // Pressed again: the terminal.
    await act(async () => q('[data-pane="t1"] .agents-toggle')!.click());
    await flush();
    expect(leafOf().render).toBeUndefined();
  });

  it('is shown disabled on a read-only page, the view following the layout', async () => {
    await setup({ t1: { render: 'native' }, readOnly: true });
    const button = q('[data-pane="t1"] .agents-toggle')!;
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(surface()?.dataset.mode).toBe('loading');
  });
});

describe('the surface', () => {
  it('draws nothing for the terminal view', async () => {
    await setup();
    expect(surface()).toBeNull();
    expect(coverOf('a', 't1')).toBeUndefined();
    await flush();
    expect(reads).toEqual([]);
  });

  it('shows a strip over the terminal while no session is known', async () => {
    await setup({ t1: { render: 'native' }, record: { agent_session: null } });
    expect(surface()!.className).toBe('agents-strip');
    expect(surface()!.dataset.reason).toBe('session');
    expect(coverOf('a', 't1')).toBeUndefined();
    // Its button shows the terminal alone.
    await act(async () => q('.agents-strip button')!.click());
    await flush();
    expect(leafOf().render).toBeUndefined();
  });

  it('covers the terminal with the conversation once read, and with nothing to show leaves it shown', async () => {
    await setup({ t1: { render: 'native' } });
    expect(surface()!.dataset.mode).toBe('loading');
    expect(coverOf('a', 't1')).toBe('all');
    await flush();
    expect(open()[0].refs).toEqual([`claude~${S1}~0~b`]);
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Hello there')] })] }));
    await until(() => q('.conv-agent')?.textContent?.includes('Hello there'));
    expect(surface()!.dataset.mode).toBe('native');
    expect(coverOf('a', 't1')).toBe('all');
    // The transcript went away: the terminal, a strip over its top.
    await act(async () => open()[0].answer({ tails: [tail(S1, { code: 'not_found' })] }));
    await flush();
    expect(surface()!.className).toBe('agents-strip');
    expect(surface()!.dataset.reason).toBe('not_found');
    expect(coverOf('a', 't1')).toBeUndefined();
  });

  it('shrinks to the upper part while the agent waits, saying for what, and gives the terminal the keyboard', async () => {
    await setup({ t1: { render: 'native' } });
    const focus = vi.fn();
    const off = registerPane('a', 't1', { focus, type: () => {}, paste: () => {}, openFind: () => {}, screenText: () => '' });
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Writing the file')] })] }));
    await until(() => q('.conv textarea'));
    q<HTMLTextAreaElement>('.conv textarea')!.focus();
    core.event('a', 'agent', 't1', {
      agent_status: 'blocked',
      status: { state: 'blocked', kind: 'permission', msg: 'approve Write: /tmp/x' },
    });
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(coverOf('a', 't1')).toBe('part');
    expect(q('.conv')!.hasAttribute('data-peek')).toBe(true);
    expect(q('.conv textarea')).toBeNull();
    expect(q('.agents-waiting')!.textContent).toContain('approve Write: /tmp/x');
    expect(focus).toHaveBeenCalled();
    // The same conversation, not drawn anew.
    expect(q('.conv-agent')!.textContent).toContain('Writing the file');
    // Answered: over all of it again.
    core.event('a', 'agent', 't1', { agent_status: 'working', status: { state: 'working' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('native');
    expect(coverOf('a', 't1')).toBe('all');
    expect(q('.conv textarea')).not.toBeNull();
    // Its Show Terminal: the terminal view.
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked' } });
    await flush();
    await act(async () => q('.agents-waiting button')!.click());
    await flush();
    expect(leafOf().render).toBeUndefined();
    expect(surface()).toBeNull();
    off();
  });

  it('keeps what the user wrote across the terminal shown instead and the pane drawn again', async () => {
    await setup({ t1: { render: 'native' } });
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Hello')] })] }));
    await until(() => composer());
    await act(async () => setValue(composer()!, 'half a prompt'));
    // The terminal, then the conversation again.
    await act(async () => q('[data-pane="t1"] .agents-toggle')!.click());
    await flush();
    expect(surface()).toBeNull();
    await act(async () => q('[data-pane="t1"] .agents-toggle')!.click());
    await until(() => composer());
    expect(composer()!.value).toBe('half a prompt');
    // Another tab: the pane is not drawn, then drawn again.
    await act(async () => root.render(createElement('div', { className: 'tab-panes' })));
    await flush();
    await act(async () =>
      root.render(
        createElement('div', { className: 'tab-panes' }, createElement(Pane, { terminal: 't1' }), createElement(Pane, { terminal: 't2' })),
      ),
    );
    await until(() => composer());
    expect(composer()!.value).toBe('half a prompt');
  });

  it('hands the keyboard to the terminal when nothing is left to show, and to the composer when the conversation comes', async () => {
    await setup({ t1: { render: 'native' } });
    const t = fakeTerminal();
    await flush();
    expect(surface()!.dataset.mode).toBe('loading');
    // Covered while it had the keyboard, the terminal gives it to the surface.
    await act(async () => surfaceHandle('a', 't1')!.focus());
    expect(document.activeElement).toBe(surface());
    // No transcript yet (a new tab before its first prompt): the terminal, to type it in.
    await act(async () => open()[0].answer({ tails: [tail(S1, { code: 'not_found' })] }));
    await flush();
    expect(surface()!.className).toBe('agents-strip');
    expect(t.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
    t.off();
  });

  it('gives the composer the keyboard when the first page comes', async () => {
    await setup({ t1: { render: 'native' } });
    await flush();
    await act(async () => surfaceHandle('a', 't1')!.focus());
    const loading = document.activeElement;
    expect(loading).toBe(surface());
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Hello')] })] }));
    await until(() => composer());
    expect(surface()).not.toBe(loading);
    expect(document.activeElement).toBe(composer());
  });

  it('leaves the keyboard with a user writing a message when the agent begins to wait', async () => {
    await setup({ t1: { render: 'native' }, record: { agent_status: 'working' } });
    const t = fakeTerminal();
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Working on it')] })] }));
    await until(() => composer());
    composer()!.focus();
    await act(async () => setValue(composer()!, 'and then'));
    core.event('a', 'agent', 't1', {
      agent_status: 'blocked',
      status: { state: 'blocked', kind: 'permission', msg: 'approve Bash: rm -rf build' },
    });
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(coverOf('a', 't1')).toBe('part');
    // The composer stays, with the keyboard and the text; the banner says why.
    expect(composer()!.value).toBe('and then');
    expect(document.activeElement).toBe(composer());
    expect(t.focus).not.toHaveBeenCalled();
    expect(q('.agents-waiting')!.textContent).toContain('approve Bash: rm -rf build');
    expect(q('.conv .conv-banner')).toBeNull();
    // Enter does not reach the terminal and its question.
    await act(async () => {
      composer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(t.typed).toEqual([]);
    expect(composer()!.value).toBe('and then');
    // Show Terminal: the terminal alone, and the keyboard in it.
    await act(async () => q('.agents-waiting button')!.click());
    await flush();
    expect(leafOf().render).toBeUndefined();
    expect(t.focus).toHaveBeenCalled();
    t.off();
  });

  it('starts over with the agent’s new session', async () => {
    await setup({ t1: { render: 'native' } });
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { next: 1024, events: [say(256, 'Old conversation')] })] }));
    await until(() => q('.conv-agent')?.textContent?.includes('Old conversation'));
    // /clear: the machine finds another session.
    core.event('a', 'agent', 't1', { agent_session: S2 });
    await flush();
    expect(q('.conv-agent')).toBeNull();
    expect(surface()!.dataset.mode).toBe('loading');
    const read = open().find((r) => r.refs[0].startsWith(`claude~${S2}`))!;
    expect(read.refs).toEqual([`claude~${S2}~0~b`]);
    await act(async () => read.answer({ tails: [tail(S2, { file: 'f2', next: 512, events: [say(0, 'New conversation')] })] }));
    await until(() => q('.conv-agent')?.textContent?.includes('New conversation'));
    expect(host.textContent).not.toContain('Old conversation');
  });
});

describe('while the agent waits, where its question is', () => {
  /** A screen of 25 rows (16 pixels each in the area laid out), with text
   * in some. The upper part covers rows 0 to 9. */
  const screen = (lines: Record<number, string>) => Array.from({ length: 25 }, (_, i) => lines[i] ?? '').join('\n');
  // Claude Code: the conversation above, its dialog at the bottom.
  const AT_BOTTOM = screen({
    0: '> write the file',
    17: '╭──────────────────────────╮',
    18: '│ Allow Write to /tmp/x?   │',
    19: '│ › 1. Yes                 │',
    20: '│   2. No                  │',
    21: '╰──────────────────────────╯',
  });
  // Codex: a dialog at the top of a cleared screen.
  const AT_TOP = screen({
    1: '  ✨ Update available! 0.170.0 -> 0.171.0',
    3: '› 1. Update now',
    4: '  2. Skip',
    6: '  Press enter to continue',
  });

  const waitingStrip = () => q('[data-pane="t1"] .agents-strip[data-reason="waiting"]');
  const whole = () => surface()!.hasAttribute('data-whole');
  /** What covers t1 as the workspace takes it: the store's and the pure answer's. */
  const covered = () => strongestCover([coverOf('a', 't1'), covers('a', 't1', leafOf())]);
  const block = (msg = 'approve Write: /tmp/x') =>
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked', kind: 'permission', msg } });
  const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

  /** The conversation over t1, whose screen is what show gives. */
  async function conversation(show: () => string) {
    await setup({ t1: { render: 'native' }, record: { agent: 'codex', agent_status: 'working' } });
    const t = fakeTerminal(show);
    await flush();
    await act(async () => open()[0].answer({ tails: [tail(S1, { kind: 'codex', next: 1024, events: [say(256, 'Working on it')] })] }));
    await until(() => composer());
    return t;
  }

  it('covers the upper part when the question shows below it', async () => {
    const t = await conversation(() => AT_BOTTOM);
    block();
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    expect(covered()).toBe('part');
    expect(q('.agents-waiting')!.textContent).toContain('approve Write: /tmp/x');
    expect(waitingStrip()).toBeNull();
    expect(t.focus).toHaveBeenCalled();
    t.off();
  });

  it('shows the terminal whole when the question is all under the upper part, a strip over its blank bottom', async () => {
    const t = await conversation(() => AT_TOP);
    block('Update available');
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(whole()).toBe(true);
    expect(coverOf('a', 't1')).toBeUndefined();
    expect(covered()).toBeUndefined();
    expect(q('.agents-waiting')).toBeNull();
    expect(waitingStrip()!.dataset.edge).toBe('bottom');
    expect(waitingStrip()!.textContent).toContain('Update available');
    expect(t.focus).toHaveBeenCalled();
    // The same conversation, kept unseen.
    expect(q('.conv-agent')!.textContent).toContain('Working on it');
    // Show Conversation: the upper part over it, until Show Terminal goes back.
    await act(async () => waitingStrip()!.querySelector('button')!.click());
    await flush();
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    expect(waitingStrip()).toBeNull();
    await act(async () => q('.agents-waiting button')!.click());
    await flush();
    expect(whole()).toBe(true);
    expect(leafOf().render).toBe('native');
    t.off();
  });

  it('shows the terminal whole when its screen cannot be read, the strip over its top', async () => {
    const t = await conversation(() => {
      throw new Error('no screen');
    });
    block();
    await flush();
    expect(whole()).toBe(true);
    expect(covered()).toBeUndefined();
    expect(waitingStrip()!.dataset.edge).toBe('top');
    t.off();
  });

  it('follows the screen as the agent draws its dialog after its status', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The screen cleared first, the dialog drawn 300 ms after the status.
    let shows = screen({});
    const t = await conversation(() => shows);
    block();
    await flush();
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    await tick(RECHECK_MS);
    expect(whole()).toBe(false);
    shows = AT_TOP;
    await tick(RECHECK_MS);
    expect(whole()).toBe(true);
    expect(covered()).toBeUndefined();
    // Drawn on below the part: covered again.
    shows = AT_BOTTOM;
    await tick(RECHECK_MS);
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    t.off();
  });

  it('covers the terminal whole again when the agent stops waiting', async () => {
    const t = await conversation(() => AT_TOP);
    block();
    await flush();
    expect(whole()).toBe(true);
    core.event('a', 'agent', 't1', { agent_status: 'working', status: { state: 'working' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('native');
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('all');
    expect(covered()).toBe('all');
    expect(waitingStrip()).toBeNull();
    expect(composer()).not.toBeNull();
    t.off();
  });

  it('stops reading the screen once the answer held, and reads it again as what the agent waits for changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let shows = screen({});
    const reads = vi.fn(() => shows);
    const t = await conversation(reads);
    block('first question');
    await flush();
    await tick(SETTLED_MS + RECHECK_MS);
    const n = reads.mock.calls.length;
    expect(n).toBeGreaterThan(1);
    // Nothing read any more, and what is drawn later is not seen.
    shows = AT_TOP;
    await tick(10 * SETTLED_MS);
    expect(reads.mock.calls.length).toBe(n);
    expect(whole()).toBe(false);
    // Another question: read at once, and again.
    block('second question');
    await flush();
    expect(whole()).toBe(true);
    await tick(RECHECK_MS);
    expect(reads.mock.calls.length).toBeGreaterThan(n + 1);
    t.off();
  });

  it('keeps the upper part, the composer and the keyboard for a user writing a message, whatever the screen shows', async () => {
    const t = await conversation(() => AT_TOP);
    composer()!.focus();
    await act(async () => setValue(composer()!, 'and then'));
    block();
    await flush();
    expect(whole()).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    expect(document.activeElement).toBe(composer());
    expect(t.focus).not.toHaveBeenCalled();
    t.off();
  });
});
