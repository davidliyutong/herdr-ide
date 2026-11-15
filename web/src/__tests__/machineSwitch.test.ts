// @vitest-environment jsdom
// Switching machines mounts the other machine's panes afresh, even when
// both name a terminal alike: a pane's canvas is never handed on, since the
// pane before it gave up its WebGL context, and the terminal drew nothing
// until another tab was shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// Records the machine a pane was mounted for.
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ m }: { m: string }) => {
    const [first] = useState(m);
    return createElement('canvas', { 'data-mounted-for': first });
  },
}));
vi.mock('../components/PaneHeader', () => ({ PaneHeader: () => null }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FakeCore, settle } from './fakeTerms';
import { Workspace } from '../components/Workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('switching machines', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    const core = new FakeCore();
    const layout = {
      version: 2,
      workspaces: [{ id: 'wwwwwwww', name: '', cwd: '/home/u', tabs: [{ root: { terminal: 't1' }, focused: 't1' }], selected: 0 }],
      selected: 0,
    };
    core.machine('local', [FakeCore.term('t1', { title: 'claude' })], layout);
    core.machine('remote', [FakeCore.term('t1', { title: 'nvitop' })], layout);
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([
      { id: 'local', label: 'local', kind: 'local', status: 'ready', info: { home: '/home/u' } },
      { id: 'remote', label: 'nus-ws-1', kind: 'ssh', status: 'ready', info: { home: '/home/u' } },
    ] as unknown as MachineState[]);
    s.selectMachine('local');
    core.model.subscribe('local');
    core.model.subscribe('remote');
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

  const mounted = () => Array.from(host.querySelectorAll('canvas')).map((c) => c.dataset.mountedFor);

  it('gives a terminal of the same name on another machine a pane of its own', async () => {
    await act(async () => root.render(createElement(Workspace)));
    expect(mounted()).toEqual(['local']);
    await act(async () => useStore.getState().selectMachine('remote'));
    expect(mounted()).toEqual(['remote']);
    await act(async () => useStore.getState().selectMachine('local'));
    expect(mounted()).toEqual(['local']);
  });
});
