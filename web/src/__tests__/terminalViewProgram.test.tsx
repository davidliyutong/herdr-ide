// @vitest-environment jsdom
//
// A terminal's view (components/TerminalView.tsx) tells its pane the pid
// of the terminal's program from the machine's records while the terminal
// is live, and when it changes (onProgram), so that a pane whose program
// ended attaches again when the terminal core starts another at its
// address (vt/pane.ts setProgram, tested with the real pane in
// termPane.test.ts); the notice of the end goes when it does. The pane is
// a stand-in that records what it is told.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

const { made } = vi.hoisted(() => ({
  made: [] as Array<{ programs: Array<number | undefined>; o: Record<string, (...a: unknown[]) => void> }>,
}));
vi.mock('../vt/pane', () => ({
  TermPane: class {
    attached = false;
    programs: Array<number | undefined> = [];
    o: Record<string, (...a: unknown[]) => void>;
    off: () => void;
    constructor(_h: HTMLElement, _c: HTMLCanvasElement, _t: HTMLTextAreaElement, o: Record<string, (...a: unknown[]) => void>) {
      this.o = o;
      made.push(this);
      const onProgram = o.onProgram as unknown as (fn: (pid: number | undefined) => void) => () => void;
      this.off = onProgram((pid) => void this.programs.push(pid));
    }
    focus() {}
    setShown() {}
    setAppearance() {}
    type() {}
    paste() {}
    openFind() {}
    screenText() {
      return '';
    }
    scrollTo() {}
    dispose() {
      this.off();
    }
  },
}));

import { TerminalView } from '../components/TerminalView';
import { useStore } from '../state/store';
import { FakeCore, settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let core: FakeCore;
let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => void (await settle()));

beforeEach(async () => {
  made.length = 0;
  useStore.setState({ readOnly: false });
  core = new FakeCore();
  core.machine('a', [FakeCore.term('t1', { pid: 200 })], {
    version: 2,
    workspaces: [{ id: 'w1', name: '', cwd: '/home/u', tabs: [{ root: { terminal: 't1' }, focused: 't1' }], selected: 0 }],
    selected: 0,
  });
  core.install().subscribe('a');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(TerminalView, { m: 'a', terminal: 't1', focused: true, onActivate: () => {} })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a terminal’s view', () => {
  it('tells its pane the program of the terminal while it is live, and takes the notice of its end away when it has another', async () => {
    expect(made).toHaveLength(1);
    const pane = made[0];
    expect(pane.programs).toEqual([200]);
    // The terminal core stops: the program ends, then its record says so.
    act(() => pane.o.onClosed('exited', 1));
    expect(host.querySelector('.term-ended')?.textContent).toBe('The program ended (exit code 1).');
    core.event('a', 'finished', 't1', { reason: 'server_stop' });
    await flush();
    expect(pane.programs).toEqual([200, undefined]);
    // Started again: the kept terminal has a new shell at its address.
    core.event('a', 'restarted', 't1', FakeCore.term('t1', { pid: 201 }));
    await flush();
    expect(pane.programs).toEqual([200, undefined, 201]);
    // The pane attaches again and says so.
    act(() => pane.o.onReopen());
    expect(host.querySelector('.term-ended')).toBeNull();
    // Other changes of the record tell it nothing new.
    core.event('a', 'title', 't1', { title: 'vim' });
    await flush();
    expect(pane.programs).toEqual([200, undefined, 201]);
    expect(made).toHaveLength(1);
    // Gone, it is told nothing more.
    await act(async () => root.unmount());
    core.event('a', 'restarted', 't1', FakeCore.term('t1', { pid: 202 }));
    await flush();
    expect(pane.programs).toEqual([200, undefined, 201]);
    root = createRoot(host);
  });
});
