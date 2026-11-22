// @vitest-environment jsdom
// Switching machines mounts the other machine's panes afresh, even when
// both name a terminal alike: a pane's canvas is never handed on, since the
// pane before it gave up its WebGL context, and the terminal drew nothing
// until another tab was shown. A pane is its header, its terminal and what
// plugins draw over it; the terminal keeps its element between shown and
// kept, and one a plugin covers all of is not drawn, from its first frame
// when its tab is shown again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
// Every render of a terminal, with what it was told.
const { renders } = vi.hoisted(() => ({
  renders: [] as Array<{ m: string; terminal: string; shown: boolean; covered: boolean }>,
}));
// Records the machine a pane was mounted for.
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    m,
    terminal,
    shown = true,
    covered = false,
    focused,
  }: {
    m: string;
    terminal: string;
    shown?: boolean;
    covered?: boolean;
    focused: boolean;
  }) => {
    const [first] = useState(m);
    renders.push({ m, terminal, shown, covered });
    return createElement('canvas', {
      'data-mounted-for': first,
      'data-shown': String(shown),
      'data-covered': String(covered),
      'data-focused': String(focused),
    });
  },
}));
vi.mock('../components/PaneHeader', () => ({ PaneHeader: () => createElement('div', { className: 'pane-header' }) }));

import { Bot } from 'lucide-react';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FakeCore, settle } from './fakeTerms';
import { Workspace } from '../components/Workspace';
import { allPlugins, definePlugins } from '../plugins/registry';
import { setCover, useCovers, useSetCover } from '../state/covers';
import { terms } from '../state/terms';
import * as L from '../term/layout';
import type { PluginDef, TerminalSurfaceProps } from '../plugins/api';
import { useSettings } from '../settings';

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
    // t2 is in no tab: a test opens it in one.
    core.machine('local', [FakeCore.term('t1', { title: 'claude' }), FakeCore.term('t2')], layout);
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
  const saved = [...allPlugins()];
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    definePlugins(saved);
    useCovers.setState({ covers: {} });
    useSettings.setState({ values: {} });
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
  const surfacePlugin: PluginDef = {
    id: 'over',
    title: 'agents.title',
    icon: Bot,
    terminalSurfaces: [{ id: 'over', component: ({ terminal }) => createElement('div', { className: 'surface' }, terminal) }],
  };

  it('draws a terminal pane as its header and its terminal while no plugin draws over it', async () => {
    await act(async () => root.render(createElement(Workspace)));
    expect(children(host.querySelector('.pane:not(.kept)'))).toEqual(['div.pane-header', 'canvas.']);
    expect(host.querySelector('.pane-surfaces')).toBeNull();
  });

  it('draws what a plugin draws over a terminal third, and keeps the terminal’s element between shown and kept', async () => {
    definePlugins([surfacePlugin]);
    await act(async () => root.render(createElement(Workspace)));
    const shown = () => host.querySelector('.pane:not(.kept)');
    expect(children(shown())).toEqual(['div.pane-header', 'canvas.', 'div.pane-surfaces']);
    expect(shown()!.querySelector('.surface')!.textContent).toBe('t1');
    const canvas = shown()!.querySelector('canvas');
    await act(async () => useStore.getState().selectMachine('remote'));
    // Kept: the terminal alone, the same element; no surface over it.
    const kept = host.querySelector('.pane.kept');
    expect(children(kept)).toEqual(['canvas.']);
    expect(kept!.querySelector('canvas')).toBe(canvas);
    await act(async () => useStore.getState().selectMachine('local'));
    expect(shown()!.querySelector('canvas')).toBe(canvas);
    expect(children(shown())).toEqual(['div.pane-header', 'canvas.', 'div.pane-surfaces']);
  });

  it('draws a terminal covered all as one not drawn, and one covered in part as before', async () => {
    await act(async () => root.render(createElement(Workspace)));
    const canvas = () => host.querySelector<HTMLCanvasElement>('.pane:not(.kept) canvas')!;
    const state = () => [canvas().dataset.shown, canvas().dataset.covered, canvas().dataset.focused];
    const first = canvas();
    expect(state()).toEqual(['true', 'false', 'true']);
    await act(async () => setCover('local', 't1', 'all', 'over'));
    // Shown (not kept: it attaches and keeps the pane's size), covered, without the focus.
    expect(state()).toEqual(['true', 'true', 'false']);
    // Another machine's terminal of that name is not covered.
    await act(async () => setCover('remote', 't1', 'all', 'over'));
    await act(async () => setCover('local', 't1', 'part', 'over'));
    expect(state()).toEqual(['true', 'false', 'true']);
    await act(async () => setCover('local', 't1', undefined, 'over'));
    expect(state()).toEqual(['true', 'false', 'true']);
    // The same element throughout.
    expect(canvas()).toBe(first);
  });

  /** A surface that covers all of a terminal whose leaf says render
   * native, as it is mounted (useSetCover) and, with render, also as the
   * pane is rendered (covers). */
  const nativeSurface = (render: boolean): PluginDef => {
    const covers = (leaf: L.TerminalLeaf) => (leaf.render === 'native' ? 'all' : undefined);
    const Native = ({ m, terminal, leaf }: TerminalSurfaceProps) => {
      useSetCover(m, terminal, covers(leaf), 'native');
      return leaf.render === 'native' ? createElement('div', { className: 'surface' }) : null;
    };
    return {
      id: 'native',
      title: 'agents.title',
      icon: Bot,
      terminalSurfaces: [{ id: 'native', component: Native, ...(render ? { covers: (_m, _t, leaf) => covers(leaf) } : {}) }],
    };
  };

  /** Shows a covered terminal's tab, another tab, and its tab again: the
   * renders of t1 while its tab came back. */
  const tabBack = async () => {
    await act(async () => {
      terms.mutate('local', (l) => L.selectTab(L.setTerminalFields(L.openTerminal(l, 't2'), 't1', { render: 'native' }), 'wwwwwwww', 0));
    });
    await act(async () => root.render(createElement(Workspace)));
    const shown = () => host.querySelector<HTMLCanvasElement>('.pane:not(.kept) canvas')!;
    expect([shown().dataset.shown, shown().dataset.covered]).toEqual(['true', 'true']);
    await act(async () => void terms.mutate('local', (l) => L.selectTab(l, 'wwwwwwww', 1)));
    // t1 is kept, hidden, no surface over it.
    expect(host.querySelector<HTMLCanvasElement>('.pane.kept canvas')!.dataset.shown).toBe('false');
    expect(host.querySelector('.surface')).toBeNull();
    renders.length = 0;
    await act(async () => void terms.mutate('local', (l) => L.selectTab(l, 'wwwwwwww', 0)));
    expect([shown().dataset.shown, shown().dataset.covered]).toEqual(['true', 'true']);
    return renders.filter((r) => r.m === 'local' && r.terminal === 't1');
  };

  it('covers a terminal from the first frame its tab is shown again', async () => {
    definePlugins([nativeSurface(true)]);
    const back = await tabBack();
    expect(back.length).toBeGreaterThan(0);
    // Never drawn on the way: no frame shown and not covered (which would
    // make a renderer that the cover then takes away).
    expect(back.filter((r) => r.shown && !r.covered)).toEqual([]);
  });

  it('draws a terminal for a frame when its surface says its cover only once mounted', async () => {
    // What covers is for: without it, the tab shown again draws the
    // terminal until the surface's layout effect covers it.
    definePlugins([nativeSurface(false)]);
    const back = await tabBack();
    expect(back.filter((r) => r.shown && !r.covered).length).toBeGreaterThan(0);
  });

  it('takes no cover from a surface of a plugin that is off', async () => {
    definePlugins([nativeSurface(true)]);
    useSettings.setState({ values: { 'plugins.native.enabled': { value: false, source: 'global' } } });
    await act(async () => void terms.mutate('local', (l) => L.setTerminalFields(l, 't1', { render: 'native' })));
    await act(async () => root.render(createElement(Workspace)));
    const canvas = host.querySelector<HTMLCanvasElement>('.pane:not(.kept) canvas')!;
    expect([canvas.dataset.shown, canvas.dataset.covered, canvas.dataset.focused]).toEqual(['true', 'false', 'true']);
    expect(host.querySelector('.pane-surfaces')).toBeNull();
  });
});
