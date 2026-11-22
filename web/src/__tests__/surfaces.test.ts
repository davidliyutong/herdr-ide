// @vitest-environment jsdom
//
// What plugins draw over a terminal's pane and add to its header
// (TerminalSurfaces, TerminalHeaderActions): nothing without a plugin that
// has some, each in its error boundary otherwise; what they cover of the
// terminal (state/covers.ts), as they are mounted and as the pane is
// rendered; and the focus a surface takes for its pane while the terminal
// stays the one typed into (state/panes.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Bot } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useSettings } from '../settings';
import { allPlugins, definePlugins, surfacesCover, TerminalHeaderActions, TerminalSurfaces } from '../plugins/registry';
import type { PluginDef, TerminalSurfaceProps } from '../plugins/api';
import { coverOf, setCover, useCover, useCovers, useSetCover, type Cover } from '../state/covers';
import {
  paneHandle,
  registerPane,
  registerSurface,
  surfaceHandle,
  useSurfaceFocus,
  withPane,
  withView,
  type PaneHandle,
  type ViewHandle,
} from '../state/panes';
import { fakeSettingsApi } from './fakeSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let broken = false;
const Surface = ({ m, terminal, leaf, focused }: TerminalSurfaceProps) => {
  if (broken) throw new Error('kaput');
  return createElement('div', { className: 'surface', 'data-for': `${m}/${terminal}/${leaf.terminal}/${focused}` });
};
const Button = ({ terminal }: { terminal: string }) => createElement('button', { className: 'header-button' }, terminal);
const withSurfaces: PluginDef = {
  id: 'over',
  title: 'agents.title',
  icon: Bot,
  terminalSurfaces: [{ id: 'over', component: Surface }],
  headerActions: [Button],
};
const plain: PluginDef = { id: 'plain', title: 'history.title', icon: Bot };
const props = { m: 'a', terminal: 't1', leaf: { terminal: 't1' }, focused: true, onActivate: () => {} };

describe('terminal surfaces', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];

  beforeEach(() => {
    fakeSettingsApi();
    useSettings.setState({ values: {} });
    broken = false;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    definePlugins(saved);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const draw = () =>
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(TerminalSurfaces, props),
          createElement(TerminalHeaderActions, { m: props.m, terminal: props.terminal, leaf: props.leaf }),
        ),
      ),
    );

  it('draw nothing while no plugin that is on has any', async () => {
    definePlugins([plain]);
    await draw();
    expect(host.firstElementChild!.childNodes.length).toBe(0);
    definePlugins([plain, withSurfaces]);
    useSettings.setState({ values: { 'plugins.over.enabled': { value: false, source: 'global' } } });
    await draw();
    expect(host.firstElementChild!.childNodes.length).toBe(0);
  });

  it('draw each plugin’s in one layer over the terminal and its buttons in the header', async () => {
    definePlugins([plain, withSurfaces]);
    await draw();
    const layer = host.querySelector('.pane-surfaces')!;
    expect(layer.children.length).toBe(1);
    expect(layer.querySelector('.surface')!.getAttribute('data-for')).toBe('a/t1/t1/true');
    const actions = host.querySelector('.pane-plugin-actions')!;
    expect(actions.querySelector('.header-button')!.textContent).toBe('t1');
    // A press on a button leaves the keyboard where it is.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    actions.querySelector('button')!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('show a surface that fails in its place, the rest of the page going on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    definePlugins([withSurfaces]);
    broken = true;
    await draw();
    expect(host.querySelector('.pane-surfaces .plugin-error')).not.toBeNull();
    expect(host.querySelector('.header-button')).not.toBeNull();
  });
});

describe('covers', () => {
  afterEach(() => useCovers.setState({ covers: {} }));

  it('take the strongest of the surfaces over a terminal', () => {
    expect(coverOf('a', 't1')).toBeUndefined();
    setCover('a', 't1', 'part', 'history');
    expect(coverOf('a', 't1')).toBe('part');
    setCover('a', 't1', 'all', 'agents');
    expect(coverOf('a', 't1')).toBe('all');
    // Another machine's terminal of that name is not covered.
    expect(coverOf('b', 't1')).toBeUndefined();
    setCover('a', 't1', undefined, 'agents');
    expect(coverOf('a', 't1')).toBe('part');
    setCover('a', 't1', undefined, 'history');
    expect(coverOf('a', 't1')).toBeUndefined();
    expect(useCovers.getState().covers).toEqual({});
    // Nothing changes: the same state.
    const before = useCovers.getState();
    setCover('a', 't2', undefined, 'agents');
    expect(useCovers.getState()).toBe(before);
  });

  // Workspace.tsx gives the plugins that are on (machineSwitch.test.ts).
  it('are said at render time by the surfaces of the plugins given', () => {
    const leaf = { terminal: 't1', render: 'native' as const };
    const part: PluginDef = {
      id: 'part',
      title: 'history.title',
      icon: Bot,
      terminalSurfaces: [
        { id: 'part', component: Surface, covers: (m, terminal, l) => (m === 'a' && terminal === 't1' && l === leaf ? 'part' : undefined) },
        { id: 'part.none', component: Surface },
      ],
    };
    const all: PluginDef = {
      id: 'all',
      title: 'agents.title',
      icon: Bot,
      terminalSurfaces: [{ id: 'all', component: Surface, covers: (_m, _t, l) => (l.render === 'native' ? 'all' : undefined) }],
    };
    expect(surfacesCover([], 'a', 't1', leaf)).toBeUndefined();
    expect(surfacesCover([part], 'a', 't1', leaf)).toBe('part');
    expect(surfacesCover([part, all], 'a', 't1', leaf)).toBe('all');
    expect(surfacesCover([part, all], 'a', 't1', { terminal: 't1' })).toBeUndefined();
    // One that fails covers nothing; the others still do.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: PluginDef = {
      id: 'failing',
      title: 'agents.title',
      icon: Bot,
      terminalSurfaces: [
        {
          id: 'failing',
          component: Surface,
          covers: () => {
            throw new Error('kaput');
          },
        },
      ],
    };
    expect(surfacesCover([failing], 'a', 't1', leaf)).toBeUndefined();
    expect(surfacesCover([failing, part], 'a', 't1', leaf)).toBe('part');
    expect(console.error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('have owners: a surface id is one plugin’s', () => {
    const saved = [...allPlugins()];
    try {
      const twice: PluginDef = { ...plain, id: 'twice', terminalSurfaces: [{ id: 'over', component: Surface }] };
      expect(() => definePlugins([withSurfaces, twice])).toThrow(/terminal surface id over/);
      const inOne: PluginDef = {
        ...plain,
        id: 'inone',
        terminalSurfaces: [
          { id: 'inone', component: Surface },
          { id: 'inone', component: Surface },
        ],
      };
      expect(() => definePlugins([inOne])).toThrow(/terminal surface id inone/);
      expect(() => definePlugins([{ ...plain, id: 'blank', terminalSurfaces: [{ id: '', component: Surface }] }])).toThrow();
      // Refused whole: the plugins are as they were.
      expect(allPlugins()).toEqual(saved);
      definePlugins([withSurfaces, { ...twice, terminalSurfaces: [{ id: 'twice', component: Surface }] }]);
      expect(allPlugins().map((p) => p.id)).toEqual(['over', 'twice']);
    } finally {
      definePlugins(saved);
    }
  });

  it('follow a surface while it is mounted', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const seen: (Cover | undefined)[] = [];
    const Reader = () => {
      seen.push(useCover('a', 't1'));
      return null;
    };
    const Covering = ({ cover }: { cover?: Cover }) => {
      useSetCover('a', 't1', cover, 'agents');
      return null;
    };
    await act(async () => root.render(createElement('div', null, createElement(Reader), createElement(Covering, { cover: 'all' }))));
    expect(seen.at(-1)).toBe('all');
    await act(async () => root.render(createElement('div', null, createElement(Reader), createElement(Covering, { cover: 'part' }))));
    expect(seen.at(-1)).toBe('part');
    await act(async () => root.render(createElement('div', null, createElement(Reader))));
    expect(seen.at(-1)).toBeUndefined();
    await act(async () => root.unmount());
  });
});

describe('a surface’s focus', () => {
  const terminal = (): PaneHandle & { typed: string[] } => {
    const typed: string[] = [];
    return { typed, focus: vi.fn(), type: (s) => typed.push(s), paste: (s) => typed.push(s), openFind: () => {}, screenText: () => '' };
  };

  it('is the pane’s while it is registered; the terminal is still typed into', () => {
    const term = terminal();
    const offPane = registerPane('a', 't1', term);
    const surface = { focus: vi.fn() };
    const offSurface = registerSurface('a', 't1', surface);
    expect(surfaceHandle('a', 't1')).toBe(surface);
    withView('a', 't1', (h) => h.focus());
    expect(surface.focus).toHaveBeenCalledTimes(1);
    expect(term.focus).not.toHaveBeenCalled();
    expect(paneHandle('a', 't1')).toBe(term);
    withPane('a', 't1', (h) => h.paste('text'));
    expect(term.typed).toEqual(['text']);
    offSurface();
    withView('a', 't1', (h) => h.focus());
    expect(term.focus).toHaveBeenCalledTimes(1);
    offPane();
    expect(paneHandle('a', 't1')).toBeUndefined();
  });

  it('is given to those waiting for the pane, the terminal to those waiting for it', () => {
    vi.useFakeTimers();
    try {
      const views: unknown[] = [];
      const terms: unknown[] = [];
      withView('a', 't2', (h) => views.push(h));
      withPane('a', 't2', (h) => terms.push(h));
      const surface = { focus: () => {} };
      const offSurface = registerSurface('a', 't2', surface);
      expect(views).toEqual([surface]);
      expect(terms).toEqual([]);
      const term = terminal();
      const offPane = registerPane('a', 't2', term);
      expect(terms).toEqual([term]);
      expect(views).toEqual([surface]);
      offSurface();
      offPane();
      expect(surfaceHandle('a', 't2')).toBeUndefined();
      // A pane registered first: the view's waiter gets the pane, as before.
      withView('a', 't3', (h) => views.push(h));
      const other = { focus: () => {} };
      const off = registerPane('a', 't3', other);
      expect(views.at(-1)).toBe(other);
      off();
      // Waiters give up after their time.
      withView('a', 't4', (h) => views.push(h), 100);
      vi.advanceTimersByTime(200);
      const late = registerPane('a', 't4', other);
      expect(views.at(-1)).toBe(other);
      expect(views.filter((h) => h === other)).toHaveLength(1);
      late();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a surface’s focus as its pane mounts', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const terminalHandle = (focus: () => void): PaneHandle => ({
    focus,
    type: () => {},
    paste: () => {},
    openFind: () => {},
    screenText: () => '',
  });
  /** A terminal registering itself as TerminalView does: in a passive effect. */
  const Terminal = ({ pane, focus }: { pane: string; focus: () => void }) => {
    useEffect(() => registerPane('a', pane, terminalHandle(focus)), [pane]);
    return null;
  };
  /** A surface taking the pane's focus with useSurfaceFocus (a layout effect). */
  const Over = ({ pane, handle }: { pane: string; handle?: ViewHandle }) => {
    useSurfaceFocus('a', pane, handle);
    return null;
  };
  /** A surface registering itself in a passive effect, after the terminal before it. */
  const LateOver = ({ pane, handle }: { pane: string; handle: ViewHandle }) => {
    useEffect(() => registerSurface('a', pane, handle), [pane, handle]);
    return null;
  };

  it('is the surface’s when both mount in one commit, the terminal first', async () => {
    const got: string[] = [];
    // A new pane focused: the caller waits for it (actions.ts focusDom).
    withView('a', 'p1', (h) => h.focus());
    withPane('a', 'p1', () => got.push('typed'));
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Terminal, { pane: 'p1', focus: () => got.push('terminal') }),
          createElement(Over, { pane: 'p1', handle: { focus: () => got.push('surface') } }),
        ),
      ),
    );
    // The surface registered in its layout effect, the terminal after it.
    expect(got).toEqual(['surface', 'typed']);
    // Focused later, it is still the surface's; the handle may change between renders.
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Terminal, { pane: 'p1', focus: () => got.push('terminal') }),
          createElement(Over, { pane: 'p1', handle: { focus: () => got.push('surface again') } }),
        ),
      ),
    );
    withView('a', 'p1', (h) => h.focus());
    expect(got.at(-1)).toBe('surface again');
    // A surface that takes no focus leaves it to the terminal.
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Terminal, { pane: 'p1', focus: () => got.push('terminal') }),
          createElement(Over, { pane: 'p1' }),
        ),
      ),
    );
    withView('a', 'p1', (h) => h.focus());
    expect(got.at(-1)).toBe('terminal');
  });

  it('is the surface’s also when it registers in a passive effect after the terminal', async () => {
    const got: string[] = [];
    withView('a', 'p2', (h) => h.focus());
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Terminal, { pane: 'p2', focus: () => got.push('terminal') }),
          createElement(LateOver, { pane: 'p2', handle: { focus: () => got.push('surface') } }),
        ),
      ),
    );
    expect(got).toEqual(['surface']);
  });

  it('is the terminal’s when nothing draws over it', async () => {
    const got: string[] = [];
    withView('a', 'p3', (h) => h.focus());
    await act(async () => root.render(createElement(Terminal, { pane: 'p3', focus: () => got.push('terminal') })));
    expect(got).toEqual(['terminal']);
  });
});
