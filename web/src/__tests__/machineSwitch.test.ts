// @vitest-environment jsdom
// Switching machines mounts the other machine's panes afresh, even when
// both name a terminal alike: a pane's canvas is never handed on, since the
// pane before it gave up its WebGL context, and the terminal drew nothing
// until another tab was shown. A pane is its header and its terminal; the
// terminal keeps its element between shown and kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// Records the machine a pane was mounted for, and what it was told.
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ m, shown = true, focused }: { m: string; shown?: boolean; focused: boolean }) => {
    const [first] = useState(m);
    return createElement('canvas', { 'data-mounted-for': first, 'data-shown': String(shown), 'data-focused': String(focused) });
  },
}));
vi.mock('../components/PaneHeader', () => ({ PaneHeader: () => createElement('div', { className: 'pane-header' }) }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FakeHub, settle } from './fakeTerms';
import { Workspace } from '../components/Workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('switching machines', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    const hub = new FakeHub();
    const layout = {
      version: 2,
      workspaces: [{ id: 'wwwwwwww', name: '', cwd: '/home/u', tabs: [{ root: { terminal: 't1' }, focused: 't1' }], selected: 0 }],
      selected: 0,
    };
    hub.machine('local', [FakeHub.term('t1', { title: 'claude' })], layout);
    hub.machine('remote', [FakeHub.term('t1', { title: 'nvitop' })], layout);
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([
      { id: 'local', label: 'local', kind: 'local', status: 'ready', info: { home: '/home/u' } },
      { id: 'remote', label: 'nus-ws-1', kind: 'ssh', status: 'ready', info: { home: '/home/u' } },
    ] as unknown as MachineState[]);
    s.selectMachine('local');
    hub.model.subscribe('local');
    hub.model.subscribe('remote');
    await settle();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const mounted = () => Array.from(host.querySelectorAll<HTMLCanvasElement>('.pane:not(.kept) canvas')).map((c) => c.dataset.mountedFor);
  const kept = () => Array.from(host.querySelectorAll<HTMLCanvasElement>('.pane.kept canvas')).map((c) => c.dataset.mountedFor);

  it('gives a terminal of the same name on another machine a pane of its own', async () => {
    await act(async () => root.render(createElement(Workspace)));
    expect(mounted()).toEqual(['local']);
    const canvas = host.querySelector('canvas');
    await act(async () => useStore.getState().selectMachine('remote'));
    expect(mounted()).toEqual(['remote']);
    // The terminal shown before stays mounted, hidden, with its own canvas.
    expect(kept()).toEqual(['local']);
    expect(host.querySelector('.pane.kept canvas')).toBe(canvas);
    await act(async () => useStore.getState().selectMachine('local'));
    expect(mounted()).toEqual(['local']);
    // Shown again, it is the element it was: nothing attached anew.
    expect(host.querySelector('.pane:not(.kept) canvas')).toBe(canvas);
  });

  /** The tags (and class) of a pane's children, in order. */
  const children = (pane: Element | null) => Array.from(pane?.children ?? []).map((c) => `${c.tagName.toLowerCase()}.${c.className}`);

  it('draws a terminal pane as its header and its terminal, the terminal the second child, shown or kept', async () => {
    await act(async () => root.render(createElement(Workspace)));
    const shown = () => host.querySelector('.pane:not(.kept)');
    expect(children(shown())).toEqual(['div.pane-header', 'canvas.']);
    const canvas = shown()!.querySelector<HTMLCanvasElement>('canvas')!;
    expect([canvas.dataset.shown, canvas.dataset.focused]).toEqual(['true', 'true']);
    await act(async () => useStore.getState().selectMachine('remote'));
    // Kept: the terminal alone, the same element, not shown.
    const kept = host.querySelector('.pane.kept');
    expect(children(kept)).toEqual(['canvas.']);
    expect(kept!.querySelector('canvas')).toBe(canvas);
    expect([canvas.dataset.shown, canvas.dataset.focused]).toEqual(['false', 'false']);
    await act(async () => useStore.getState().selectMachine('local'));
    expect(shown()!.querySelector('canvas')).toBe(canvas);
    expect(children(shown())).toEqual(['div.pane-header', 'canvas.']);
  });
});
