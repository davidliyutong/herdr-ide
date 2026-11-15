// @vitest-environment jsdom
//
// VS Code and previews as panes: where each entry point opens them and when
// it reuses one, the windows the page keeps for VS Code panes, the commands
// for a pane's window and where Send to Agent goes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';
import { actions } from '../actions';
import {
  bindWindow,
  FRAME_TTL,
  frameKey,
  frameLoaded,
  mountFrame,
  MAX_HIDDEN_FRAMES,
  nextFrames,
  resetFrames,
  showSlot,
  useFrames,
  windowFocused,
  type Frame,
  type ShownView,
} from '../codeFrames';
import { noteFocusedTerminal, sendTarget } from '../lib/bridge';
import { CodeLayer, CodeSlot } from '../components/CodeLayer';
import { storage } from '../brand';
import { registerPane } from '../state/panes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function machine(id: string, status = 'ready'): MachineState {
  return { id, label: id, kind: 'ssh', status, info: { home: '/home/u' } } as unknown as MachineState;
}

/** Machine a: workspace w1 (/home/u/w1) with a tab of a shell (in src) and
 * an agent; workspace w2 (/home/u/w2) with a tab of a shell. */
function setup(core: FakeCore) {
  core.machine(
    'a',
    [
      FakeCore.term('s1', { cwd: '/home/u/w1/src' }),
      FakeCore.term('g1', { cwd: '/home/u/w1', agent: 'claude', agent_status: 'idle' }),
      FakeCore.term('s2', { cwd: '/home/u/w2' }),
    ],
    {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: '',
          cwd: '/home/u/w1',
          tabs: [{ root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 's1' }, { terminal: 'g1' }] }, focused: 's1' }],
          selected: 0,
        },
        { id: 'w2', name: '', cwd: '/home/u/w2', tabs: [{ root: { terminal: 's2' }, focused: 's2' }], selected: 0 },
      ],
      selected: 0,
    },
  );
}

let core: FakeCore;
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const layout = () => core.model.layout('a')!;
const tabs = (ws = 0) => layout().workspaces[ws].tabs;
const codeIn = (ws: number) => L.codeViews(layout().workspaces[ws]);

beforeEach(async () => {
  posts.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, window: 'from-reply' }), { status: 200 });
  });
  resetFrames();
  core = new FakeCore();
  setup(core);
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([machine('a'), machine('b')]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Open in VS Code', () => {
  it('opens a new tab of the workspace, or selects the one it has for the folder', async () => {
    await actions.openCode('a', '/home/u/w1/src/');
    expect(tabs().length).toBe(2);
    const [view] = codeIn(0);
    expect(view.view.folder).toBe('/home/u/w1/src');
    expect(tabs()[1]).toEqual({ root: { code: { id: view.view.id, folder: '/home/u/w1/src' } }, focused: view.key });
    expect(layout().workspaces[0].selected).toBe(1);
    // From the first tab again: the same folder selects that tab.
    core.model.mutate('a', (l) => L.selectTab(l, 'w1', 0));
    await actions.openCode('a', '/home/u/w1/src');
    expect(tabs().length).toBe(2);
    expect(layout().workspaces[0].selected).toBe(1);
    // Without a folder: the workspace's; another workspace has its own.
    await actions.openCode('a');
    expect(codeIn(0).map((v) => v.view.folder)).toEqual(['/home/u/w1/src', '/home/u/w1']);
    core.model.mutate('a', (l) => L.selectWorkspace(l, 'w2'));
    await actions.openCode('a', '/home/u/w1');
    expect(codeIn(1).map((v) => v.view.folder)).toEqual(['/home/u/w1']);
    // Opening runs no command.
    expect(posts).toEqual([]);
  });
});

describe('changes and Git Graph', () => {
  it('open beside the pane, reusing the VS Code pane of that tab for the folder, and run there', async () => {
    await actions.openDiff('a', '/home/u/w1', 's1');
    const tab = tabs()[0];
    const [view] = codeIn(0);
    expect(tab.root).toMatchObject({
      split: 'horizontal',
      children: [{ split: 'horizontal', children: [{ terminal: 's1' }, { code: { folder: '/home/u/w1' } }] }, { terminal: 'g1' }],
    });
    expect(tab.focused).toBe(view.key);
    // A new pane's window is the first of its folder to connect.
    expect(posts[0]).toEqual({ url: '/api/m/a/bridge', body: { cmd: 'openDiff', repo: '/home/u/w1', folder: '/home/u/w1', fresh: true } });
    // The reply named the window: the page keeps it for the pane.
    expect(useFrames.getState().windows[frameKey('a', view.view.id)]).toBeUndefined(); // no frame yet on this page
    useFrames.setState({ frames: { [frameKey('a', view.view.id)]: { m: 'a', id: view.view.id, folder: '/home/u/w1', load: 0 } } });
    bindWindow(frameKey('a', view.view.id), 'win-1');
    await actions.openGitGraph('a', '/home/u/w1', 'g1');
    expect(codeIn(0)).toHaveLength(1);
    expect(posts[1].body).toEqual({ cmd: 'gitGraph', repo: '/home/u/w1', folder: '/home/u/w1', window: 'win-1' });
    // Another folder gets a pane of its own, beside the pane it came from.
    await actions.openGitGraph('a', '/home/u/w1/src', 's1');
    expect(codeIn(0).map((v) => v.view.folder)).toEqual(['/home/u/w1/src', '/home/u/w1']);
  });

  it('wait for the window of a pane whose iframe the page has but does not know yet, then go by folder', async () => {
    vi.useFakeTimers();
    const view = { id: 'c1', folder: '/home/u/w1' };
    core.model.mutate('a', (l) => L.splitPane(l, 's1', 'horizontal', { code: view }));
    useFrames.setState({ frames: { [frameKey('a', 'c1')]: { m: 'a', id: 'c1', folder: '/home/u/w1', load: 0 } } });
    const done = actions.openDiff('a', '/home/u/w1', 's1');
    await vi.advanceTimersByTimeAsync(1600);
    await done;
    expect(posts[0].body).toEqual({ cmd: 'openDiff', repo: '/home/u/w1', folder: '/home/u/w1' });
  });
});

describe('a path from a terminal', () => {
  it('opens in a VS Code pane of the workspace, the one of the tab holding the file first, else beside the terminal', async () => {
    // None yet: beside the terminal, for its directory, which holds the file.
    await actions.openPath('a', '/home/u/w1/src/main.go', 12, 3, 's1');
    expect(codeIn(0).map((v) => v.view.folder)).toEqual(['/home/u/w1/src']);
    expect(posts[0].body).toEqual({
      cmd: 'openFile',
      path: '/home/u/w1/src/main.go',
      line: 12,
      col: 3,
      folder: '/home/u/w1/src',
      fresh: true,
    });
    // A file elsewhere in the project: the one pane of the workspace still takes it.
    await actions.openPath('a', '/home/u/w1/README.md', undefined, undefined, 'g1');
    expect(codeIn(0)).toHaveLength(1);
    // A pane in another tab holding the file wins over the tab's pane that does not.
    const other = { id: 'c9', folder: '/home/u/w1' };
    core.model.mutate('a', (l) => L.openPane(l, { code: other }, 'w1'));
    core.model.mutate('a', (l) => L.selectTab(l, 'w1', 0));
    await actions.openPath('a', '/home/u/w1/README.md', 1, undefined, 'g1');
    expect(layout().workspaces[0].selected).toBe(1);
    expect(posts.at(-1)!.body).toMatchObject({ folder: '/home/u/w1', path: '/home/u/w1/README.md' });
  });

  it('opens media in a preview pane beside the terminal, then shows the next file there', async () => {
    await actions.openPath('a', '/home/u/w1/plot.png', undefined, undefined, 'g1');
    const previews = () => L.previewViews(layout().workspaces[0]);
    expect(previews().map((v) => v.view.path)).toEqual(['/home/u/w1/plot.png']);
    expect(tabs()[0].root).toMatchObject({ children: [{ terminal: 's1' }, { split: 'horizontal', children: [{ terminal: 'g1' }, {}] }] });
    await actions.openPreview('a', '/home/u/w1/plot2.png', 's1');
    expect(previews().map((v) => v.view.path)).toEqual(['/home/u/w1/plot2.png']);
    expect(tabs()[0].focused).toBe(previews()[0].key);
    expect(posts).toEqual([]);
  });
});

describe('a VS Code pane', () => {
  it('closes without ending anything, and splits into a terminal of its folder', async () => {
    const view = { id: 'c1', folder: '/home/u/w1/docs' };
    core.model.mutate('a', (l) => L.splitPane(l, 'g1', 'vertical', { code: view }));
    await actions.split('a', 'code:c1', 'right');
    await settle();
    expect(core.calls.find((c) => c.method === 'terminal.run')?.params).toEqual({
      keep: false,
      cwd: '/home/u/w1/docs',
      display: expect.any(Object),
    });
    expect(L.leafOf(tabs()[0].root, 'code:c1')).not.toBeNull();
    expect(tabs()[0].root).toMatchObject({
      children: [
        { terminal: 's1' },
        { split: 'vertical', children: [{ terminal: 'g1' }, { split: 'horizontal', children: [{ code: view }, {}] }] },
      ],
    });
    await actions.closePane('a', 'code:c1');
    await settle();
    expect(L.findLeaf(layout(), 'code:c1')).toBeNull();
    expect(core.calls.filter((c) => c.method === 'terminal.kill')).toEqual([]);
  });

  it('stops and starts its machine’s code-server, and reloads', async () => {
    useFrames.setState({ frames: { [frameKey('a', 'c1')]: { m: 'a', id: 'c1', folder: '/x', load: 0 } } });
    actions.reloadCode('a', 'c1');
    expect(useFrames.getState().frames[frameKey('a', 'c1')].load).toBe(1);
    await actions.stopCode('a');
    expect(useFrames.getState().stopped).toEqual({ a: true });
    expect(posts).toEqual([{ url: '/api/m/a/code/stop', body: {} }]);
  });
});

describe('the windows of VS Code panes', () => {
  const view = (m: string, id: string, folder = `/${id}`): ShownView => ({ m, id, folder });
  const shown = (...vs: ShownView[]) => Object.fromEntries(vs.map((v) => [frameKey(v.m, v.id), v]));
  const alive = () => true;
  const on = () => false;

  it('are one per pane on screen and stay a while off screen, in their order', () => {
    let f = nextFrames({}, shown(view('a', 'x')), alive, on, 1000);
    expect(f).toEqual({ 'a|x': { m: 'a', id: 'x', folder: '/x', load: 0 } });
    f = nextFrames(f, shown(view('a', 'y')), alive, on, 2000);
    expect(f).toEqual({
      'a|x': { m: 'a', id: 'x', folder: '/x', load: 0, hidden: 2000 },
      'a|y': { m: 'a', id: 'y', folder: '/y', load: 0 },
    });
    f = nextFrames(f, shown(view('a', 'x'), view('a', 'y')), alive, on, 3000);
    expect(f['a|x'].hidden).toBeUndefined();
    // The order stays, or the iframes would move and reload.
    expect(Object.keys(f)).toEqual(['a|x', 'a|y']);
  });

  it('go when off screen too long, beyond the most recent few, when their pane closed or their machine has no VS Code', () => {
    let f: Record<string, Frame> = {};
    for (let i = 0; i <= MAX_HIDDEN_FRAMES + 1; i++) f = nextFrames(f, shown(view('a', `${i}`)), alive, on, i * 1000);
    expect(Object.keys(f)).toEqual(['a|1', 'a|2', 'a|3', 'a|4']);
    // 2 went off screen at 3000.
    f = nextFrames(f, shown(view('b', 'z')), alive, on, FRAME_TTL + 3500);
    expect(Object.keys(f)).toEqual(['a|3', 'a|4', 'b|z']);
    // Closed in the layout (by any client): at once; unknown layout: kept.
    f = nextFrames(f, shown(view('b', 'z')), (fr) => (fr.id === '3' ? false : undefined), on, FRAME_TTL + 3600);
    expect(Object.keys(f)).toEqual(['a|4', 'b|z']);
    expect(nextFrames(f, shown(view('b', 'z')), alive, (m) => m === 'b', FRAME_TTL + 3600)).toEqual({ 'a|4': f['a|4'] });
  });

  it('are placed over their panes by a layer, and say why a machine has none', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    core.model.mutate('a', (l) => L.splitPane(l, 's1', 'horizontal', { code: { id: 'c1', folder: '/home/u/w1' } }));
    const box = { left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220, x: 10, y: 20, toJSON: () => ({}) };
    const proto = HTMLElement.prototype as unknown as { getBoundingClientRect(): DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () {
      return (this as HTMLElement).classList.contains('code-slot') ? (box as DOMRect) : original.call(this);
    };
    const render = (slot: boolean) =>
      act(async () =>
        root.render(
          createElement(
            'div',
            null,
            createElement(CodeLayer),
            slot && createElement(CodeSlot, { m: 'a', pane: 'code:c1', view: { id: 'c1', folder: '/home/u/w1' } }),
          ),
        ),
      );
    try {
      await render(true);
      const frame = () => host.querySelector<HTMLIFrameElement>('iframe.code-frame');
      expect(frame()?.getAttribute('src')).toBe('/m/a/code/?folder=%2Fhome%2Fu%2Fw1');
      expect(frame()?.style.cssText).toContain('left: 10px');
      expect(frame()?.style.display).toBe('block');
      // Off screen (another tab): hidden, not unmounted.
      await render(false);
      expect(frame()?.style.display).toBe('none');
      await render(true);
      expect(frame()?.style.display).toBe('block');
      // The machine disabled: the window goes and the pane says why.
      await act(async () => useStore.getState().upsertMachine(machine('a', 'disabled')));
      expect(frame()).toBeNull();
      expect(host.querySelector('.code-off')?.textContent).toContain('a is disabled');
      await act(async () => useStore.getState().upsertMachine(machine('a')));
      expect(frame()).not.toBeNull();
      // The pane closed in the layout: its window goes.
      await act(async () => void core.model.mutate('a', (l) => L.closePane(l, 'code:c1')));
      await render(false);
      expect(frame()).toBeNull();
    } finally {
      proto.getBoundingClientRect = original;
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('give the keyboard back when VS Code takes it by itself as it starts, and keep it when asked', () => {
    core.model.mutate('a', (l) => L.splitPane(l, 's1', 'horizontal', { code: { id: 'c1', folder: '/home/u/w1' } }));
    core.model.mutate('a', (l) => L.focusPane(l, 's1'));
    useFrames.setState({ frames: { 'a|c1': { m: 'a', id: 'c1', folder: '/home/u/w1', load: 0 } } });
    const el = document.createElement('iframe');
    document.body.append(el);
    const unmount = mountFrame('a|c1', el);
    frameLoaded('a|c1', el);
    const terminal = vi.fn();
    const off = registerPane('a', 's1', { focus: terminal });
    try {
      el.contentWindow!.dispatchEvent(new Event('focus'));
      expect(L.focusedPane(layout())).toBe('s1');
      expect(terminal).toHaveBeenCalled();
      // A press in VS Code: its pane is the focused one.
      el.contentWindow!.dispatchEvent(new Event('pointerdown'));
      el.contentWindow!.dispatchEvent(new Event('focus'));
      expect(L.focusedPane(layout())).toBe('code:c1');
    } finally {
      off();
      unmount();
      el.remove();
    }
  });

  it('are known by the window that reports the keyboard while their iframe has it', () => {
    useFrames.setState({
      frames: {
        'a|c1': { m: 'a', id: 'c1', folder: '/home/u/w1', load: 0 },
        'a|c2': { m: 'a', id: 'c2', folder: '/home/u/w1', load: 0 },
      },
    });
    const iframe = document.createElement('iframe');
    iframe.className = 'code-frame';
    iframe.dataset.frame = 'a|c2';
    document.body.append(iframe);
    iframe.focus();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      // Another machine's window, or a window of other folders: not this one.
      expect(windowFocused('b', 'w9', ['/home/u/w1'])).toBeUndefined();
      expect(windowFocused('a', 'w9', ['/elsewhere'])).toBeUndefined();
      expect(windowFocused('a', 'w2', ['/home/u/w1/'])).toBe('a|c2');
      expect(useFrames.getState().windows).toEqual({ 'a|c2': 'w2' });
      // A window shows in one frame only.
      bindWindow('a|c1', 'w2');
      expect(useFrames.getState().windows).toEqual({ 'a|c1': 'w2' });
    } finally {
      focus.mockRestore();
      iframe.remove();
    }
  });
});

describe('Send to Agent', () => {
  it("goes to an agent of the sending pane's tab or workspace, else its terminal used last, never another workspace's", async () => {
    // w2's tab: a shell and a VS Code pane; w1 has the agent.
    core.model.mutate('a', (l) => L.splitPane(l, 's2', 'horizontal', { code: { id: 'c2', folder: '/home/u/w2' } }));
    core.model.mutate('a', (l) => L.splitPane(l, 's1', 'vertical', { code: { id: 'c1', folder: '/home/u/w1' } }));
    useFrames.setState({
      frames: {
        'a|c1': { m: 'a', id: 'c1', folder: '/home/u/w1', load: 0 },
        'a|c2': { m: 'a', id: 'c2', folder: '/home/u/w2', load: 0 },
      },
      windows: { 'a|c1': 'w1win', 'a|c2': 'w2win' },
    });
    expect(sendTarget('a', 'w1win', ['/home/u/w1'])).toEqual({ terminal: 'g1' });
    // w2 has no agent: nothing, the workspace named; once a shell there was used, that shell.
    expect(sendTarget('a', 'w2win', ['/home/u/w2'])).toEqual({ workspace: 'w2' });
    core.model.mutate('a', (l) => L.focusPane(l, 's2'));
    noteFocusedTerminal('a', layout());
    expect(sendTarget('a', 'w2win', ['/home/u/w2'])).toEqual({ terminal: 's2' });
    // A window this page does not show, without the keyboard here: another page's.
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(sendTarget('a', 'elsewhere', ['/home/u/w1'])).toBeUndefined();
    // With the keyboard here: the focused terminal.
    focus.mockReturnValue(true);
    try {
      expect(sendTarget('a', 'elsewhere', ['/srv'])).toEqual({ terminal: 's2' });
      // Unknown window of a folder a pane shows: that pane's workspace.
      expect(sendTarget('a', undefined, ['/home/u/w1'])).toEqual({ terminal: 'g1' });
    } finally {
      focus.mockRestore();
    }
  });
});

describe('the VS Code panel of earlier versions', () => {
  it('leaves nothing behind in the browser', async () => {
    storage.set('docks', JSON.stringify({ 'a|w1': { m: 'a', ws: 'w1' } }));
    storage.set('dockWidth', '640');
    vi.resetModules();
    await import('../state/store');
    expect(storage.get('docks')).toBeNull();
    expect(storage.get('dockWidth')).toBeNull();
  });
});

describe('a shown slot', () => {
  it('is a pane on screen until it goes', () => {
    const el = document.createElement('div');
    const off = showSlot({ m: 'a', id: 'c1', folder: '/x' }, el);
    expect(Object.keys(useFrames.getState().shown)).toEqual(['a|c1']);
    off();
    expect(useFrames.getState().shown).toEqual({});
  });
});
