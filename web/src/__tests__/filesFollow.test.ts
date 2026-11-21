// @vitest-environment jsdom
//
// The file explorer's root across workspaces and machines (plugins/files
// FilesPanel rootFor): another workspace or machine takes its own
// directory at once, also while an editor has the focus there, and the tree
// never asks a machine about another machine's directories; within a
// workspace, an editor's focus keeps the tree where it is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FilesPanel } from '../plugins/files/FilesPanel';
import { setFollow, useTree } from '../plugins/files/tree';
import { actions } from '../actions';
import { noteFocus, resetHistory } from '../paneHistory';
import { FakeCore, settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Each machine's directories (by machine), all of them empty. */
const dirs: Record<string, string[]> = {
  a: ['/home/a', '/home/a/proj', '/home/a/other', '/home/a/two'],
  b: ['/home/b', '/srv/b', '/srv/b/app'],
};
/** Paths each machine was asked about. */
let asked: Array<[string, string]>;

const editor = (id: string, path: string) => ({ view: { id, plugin: 'files', kind: 'editor', path } });
/** A workspace with a terminal tab and an editor tab, the editor's shown. */
const workspace = (id: string, cwd: string, terminal: string, file: string) => ({
  id,
  name: id,
  cwd,
  tabs: [
    { root: { terminal }, focused: terminal },
    { root: editor(`e${terminal}`, file), focused: `view:e${terminal}` },
  ],
  selected: 1,
});

describe('the explorer across workspaces and machines', () => {
  let host: HTMLDivElement;
  let root: Root;
  let core: FakeCore;
  const flush = () => act(async () => settle());
  const rootOf = () => [useTree.getState().m, useTree.getState().root];
  const show = async (m: string, ws: string) => {
    await act(async () => actions.selectWorkspace(m, ws));
    await flush();
  };

  beforeEach(async () => {
    asked = [];
    resetHistory();
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const m = url.pathname.split('/')[3];
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/list')) {
        const p = url.searchParams.get('path')!;
        asked.push([m, p]);
        return dirs[m]?.includes(p)
          ? json({ dir: { name: p, path: p, is_dir: true }, entries: [] })
          : json({ error: 'no such directory' }, 404);
      }
      if (url.pathname.endsWith('/p/files/stat')) {
        const paths = (JSON.parse(String(init?.body)) as { paths: string[] }).paths;
        for (const p of paths) asked.push([m, p]);
        return json({ entries: paths.map((p) => ({ path: p, exists: !!dirs[m]?.includes(p), is_dir: true, size: 0, mtime: 1 })) });
      }
      return json({});
    });
    core = new FakeCore();
    core.machine('a', [FakeCore.term('pa', { cwd: '/home/a/proj' }), FakeCore.term('pa2', { cwd: '/home/a/two' })], {
      version: 2,
      workspaces: [
        workspace('wa1wa1wa', '/home/a/other', 'pa', '/home/a/proj/x.txt'),
        workspace('wa2wa2wa', '/home/a/two', 'pa2', '/home/a/two/y.txt'),
      ],
      selected: 0,
    });
    core.machine('b', [FakeCore.term('pb', { cwd: '/srv/b/app' })], {
      version: 2,
      workspaces: [workspace('wb1wb1wb', '/srv/b', 'pb', '/srv/b/app/z.txt')],
      selected: 0,
    });
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([
      { id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/a' } },
      { id: 'b', label: 'b', kind: 'ssh', status: 'ready', info: { home: '/home/b' } },
    ] as unknown as MachineState[]);
    s.selectMachine('a');
    core.model.subscribe('a');
    core.model.subscribe('b');
    await settle();
    useTree.setState({ m: undefined, ws: undefined, root: undefined, follow: true, dirs: {}, expanded: {}, mtimes: {}, selection: [] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(FilesPanel)));
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  /** Every path a machine was asked about is one of its own. */
  const askedOwnOnly = () => {
    for (const [m, p] of asked) expect(dirs[m], `${m} asked about ${p}`).toContain(p);
  };

  it('takes the directory of the workspace shown, also while editors have the focus in both', async () => {
    // An editor has the focus: the workspace's own directory, not home.
    expect(rootOf()).toEqual(['a', '/home/a/other']);
    // Another machine's workspace, its editor focused too.
    await show('b', 'wb1wb1wb');
    expect(rootOf()).toEqual(['b', '/srv/b']);
    await show('a', 'wa1wa1wa');
    expect(rootOf()).toEqual(['a', '/home/a/other']);
    // Another workspace of the same machine.
    await show('a', 'wa2wa2wa');
    expect(rootOf()).toEqual(['a', '/home/a/two']);
    await show('b', 'wb1wb1wb');
    await show('a', 'wa2wa2wa');
    expect(rootOf()).toEqual(['a', '/home/a/two']);
    askedOwnOnly();
  });

  it('takes the terminal focused last in that workspace, and stays put while an editor has the focus', async () => {
    // The terminal of the first workspace: the tree follows it.
    await act(async () => actions.selectTab('a', 'wa1wa1wa', 0));
    await flush();
    expect(rootOf()).toEqual(['a', '/home/a/proj']);
    noteFocus({ m: 'a', pane: 'pa' });
    // Its editor: the tree stays.
    await act(async () => actions.selectTab('a', 'wa1wa1wa', 1));
    await flush();
    expect(rootOf()).toEqual(['a', '/home/a/proj']);
    noteFocus({ m: 'a', pane: 'view:epa' });
    // Away and back: the terminal focused last there, not the workspace's directory.
    await show('b', 'wb1wb1wb');
    expect(rootOf()).toEqual(['b', '/srv/b']);
    await show('a', 'wa1wa1wa');
    expect(rootOf()).toEqual(['a', '/home/a/proj']);
    askedOwnOnly();
  });

  it('keeps a root the user chose on its machine, and starts another machine at its workspace', async () => {
    await act(async () => setFollow(false));
    await act(async () => useTree.setState({ root: '/home/a/proj' }));
    await show('a', 'wa2wa2wa');
    expect(rootOf()).toEqual(['a', '/home/a/proj']);
    await show('b', 'wb1wb1wb');
    expect(rootOf()).toEqual(['b', '/srv/b']);
    askedOwnOnly();
    await act(async () => setFollow(true));
  });
});
