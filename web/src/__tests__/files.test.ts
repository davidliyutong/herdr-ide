// @vitest-environment jsdom
//
// The file explorer's panel (plugins/files): the tree's rows, its root
// following the focused terminal, expanding, the filter, the keyboard, the
// context menu's changes (the core's routes they call), polling, and
// read-only mode.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { useMenu, isItem, type MenuItem } from '../contextMenu';
import { useDialog } from '../dialog';
import { t } from '../i18n';
import { FilesPanel, followedDir } from '../plugins/files/FilesPanel';
import {
  crumbs,
  poll,
  polledDirs,
  relativePath,
  setFilter,
  topmost,
  treeRows,
  useTree,
  MAX_POLLED,
  type TreeState,
} from '../plugins/files/tree';
import { badName, menuFor } from '../plugins/files/ops';
import { decorationsOf, registerFileDecorations } from '../plugins/files/decorations';
import { FakeCore, settle } from './fakeTerms';
import type { RemoteStat } from '../lib/files';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const f = (name: string, extra: Partial<RemoteStat> = {}): RemoteStat => ({
  name,
  size: 1,
  mode: 0o644,
  mtime: 1,
  is_dir: false,
  ...extra,
});
const d = (name: string) => f(name, { is_dir: true });

/** The machine's files, by directory. */
let tree: Record<string, RemoteStat[]>;
let mtimes: Record<string, number>;
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.pathname + url.search, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/m/m/list') {
      const p = url.searchParams.get('path')!;
      if (!tree[p]) return json({ error: 'no such directory' }, 404);
      return json({ dir: { name: p, path: p, is_dir: true }, entries: tree[p] });
    }
    if (url.pathname === '/api/m/m/p/files/stat') {
      return json({
        entries: url.searchParams
          .getAll('path')
          .map((p) => ({ path: p, exists: !!tree[p], is_dir: !!tree[p], size: 0, mtime: mtimes[p] ?? 1 })),
      });
    }
    if (url.pathname.startsWith('/api/m/m/p/files/')) return json({ paths: [] });
    return json({});
  });
}

const changes = () => calls.filter((c) => c.method === 'POST').map((c) => [c.url.replace('/api/m/m/p/files/', ''), c.body]);

describe('file tree rows', () => {
  const state = (over: Partial<TreeState>): TreeState => ({
    follow: true,
    hidden: false,
    filter: '',
    expanded: {},
    dirs: {},
    mtimes: {},
    selection: [],
    root: '/r',
    ...over,
  });

  it('lists folders first, by name as people sort, without hidden files unless shown', () => {
    const dirs = { '/r': { entries: [f('b10'), f('b2'), d('z'), f('.env'), d('a')] }, '/r/a': { entries: [f('x')] } };
    expect(treeRows(state({ dirs })).map((r) => r.name)).toEqual(['a', 'z', 'b2', 'b10']);
    const rows = treeRows(state({ dirs, hidden: true, expanded: { '/r/a': true } }));
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ['/r/a', 0],
      ['/r/a/x', 1],
      ['/r/z', 0],
      ['/r/.env', 0],
      ['/r/b2', 0],
      ['/r/b10', 0],
    ]);
  });

  it('filters names, keeping the folders that lead to a match', () => {
    const dirs = {
      '/r': { entries: [d('src'), d('docs'), f('main.go')] },
      '/r/src': { entries: [f('app.go'), f('util.ts')] },
      '/r/docs': { entries: [f('readme.md')] },
    };
    expect(treeRows(state({ dirs, filter: '.GO' })).map((r) => [r.path, r.expanded])).toEqual([
      ['/r/src', true],
      ['/r/src/app.go', false],
      ['/r/main.go', false],
    ]);
  });

  it('shows the row of a new file being named in its folder', () => {
    const dirs = { '/r': { entries: [d('a')] }, '/r/a': { entries: [f('x')] } };
    const rows = treeRows(state({ dirs, expanded: { '/r/a': true }, edit: { kind: 'file', path: '/r/a' } }));
    expect(rows.map((r) => [r.path, r.creating])).toEqual([
      ['/r/a', undefined],
      ['/r/a', 'file'],
      ['/r/a/x', undefined],
    ]);
  });

  it('has paths for the breadcrumb, relative paths and the topmost of a selection', () => {
    expect(crumbs('/home/u/src/app', '/home/u')).toEqual([
      ['/home/u', '~'],
      ['/home/u/src', 'src'],
      ['/home/u/src/app', 'app'],
    ]);
    expect(crumbs('/etc/ssh')).toEqual([
      ['/', '/'],
      ['/etc', 'etc'],
      ['/etc/ssh', 'ssh'],
    ]);
    expect(relativePath('/r', '/r/a/b')).toBe('a/b');
    expect(relativePath('/r', '/r')).toBe('.');
    expect(relativePath('/r', '/other')).toBe('/other');
    expect(topmost(['/r/a', '/r/a/b', '/r/c'])).toEqual(['/r/a', '/r/c']);
    expect(badName('a/b')).toBeDefined();
    expect(badName('..')).toBeDefined();
    expect(badName('ok.txt')).toBeUndefined();
  });

  it('polls the root and the expanded folders below it, at most MAX_POLLED', () => {
    const dirs: TreeState['dirs'] = { '/r': { entries: [] }, '/r/a': { entries: [] }, '/other': { entries: [] } };
    const expanded: TreeState['expanded'] = { '/r/a': true, '/other': true, '/r/unlisted': true };
    expect(polledDirs(state({ dirs, expanded }))).toEqual(['/r', '/r/a']);
    for (let i = 0; i < 300; i++) {
      dirs[`/r/d${i}`] = { entries: [] };
      expanded[`/r/d${i}`] = true;
    }
    expect(polledDirs(state({ dirs, expanded }))).toHaveLength(MAX_POLLED);
  });

  it('merges decorations of providers', () => {
    const off1 = registerFileDecorations((_m, dir) => (dir === '/r' ? { a: { color: 'red', badge: 'M' } } : undefined));
    const off2 = registerFileDecorations(() => ({ a: { badge: 'U' } }));
    expect(decorationsOf('m', '/r')).toEqual({ a: { color: 'red', badge: 'U' } });
    off1();
    off2();
    expect(decorationsOf('m', '/r')).toEqual({});
  });
});

describe('FilesPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  let core: FakeCore;
  const rows = () => [...host.querySelectorAll<HTMLElement>('.files-row')].map((r) => r.dataset.path ?? '(new)');
  const row = (p: string) => host.querySelector<HTMLElement>(`.files-row[data-path="${p}"]`)!;
  const treeEl = () => host.querySelector<HTMLElement>('.files-tree')!;
  const key = (k: string, o: KeyboardEventInit = {}) =>
    act(async () => {
      treeEl().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
    });
  const flush = () => act(async () => settle());
  const menuItem = (label: string) => useMenu.getState().menu?.entries.find((e): e is MenuItem => isItem(e) && e.label === label);
  const confirm = async (ok: boolean) => {
    const req = useDialog.getState().current;
    expect(req?.kind).toBe('confirm');
    await act(async () => (req as { resolve(ok: boolean): void }).resolve(ok));
    await flush();
  };

  beforeEach(async () => {
    tree = {
      '/home/u/src': [d('lib'), f('main.go'), f('.hidden')],
      '/home/u/src/lib': [f('a.go'), f('b.go')],
      '/home/u': [d('src')],
    };
    mtimes = {};
    calls.length = 0;
    stubFetch();
    core = new FakeCore();
    core.machine('m', [FakeCore.term('p1', { cwd: '/home/u/src' })], {
      version: 2,
      workspaces: [{ id: 'w1w1w1w1', name: 'one', cwd: '', tabs: [{ root: { terminal: 'p1' }, focused: 'p1' }], selected: 0 }],
      selected: 0,
    });
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
    useTree.setState({
      m: undefined,
      root: undefined,
      follow: true,
      hidden: false,
      filter: '',
      expanded: {},
      dirs: {},
      mtimes: {},
      selection: [],
      clipboard: undefined,
      edit: undefined,
      cursor: undefined,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(FilesPanel)));
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useMenu.setState({ menu: undefined });
    useDialog.setState({ current: undefined });
    vi.unstubAllGlobals();
  });

  it("is rooted at the focused terminal's directory, and expands folders", async () => {
    expect(followedDir()).toBe('/home/u/src');
    expect(useTree.getState().root).toBe('/home/u/src');
    expect(rows()).toEqual(['/home/u/src/lib', '/home/u/src/main.go']);
    expect([...host.querySelectorAll('.files-crumb button')].map((b) => b.textContent)).toEqual(['~', 'src']);
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    expect(rows()).toEqual(['/home/u/src/lib', '/home/u/src/lib/a.go', '/home/u/src/lib/b.go', '/home/u/src/main.go']);
    // Hidden files on.
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t('files.showHidden')}"]`)!.click());
    expect(rows()).toContain('/home/u/src/.hidden');
    // A crumb roots the tree there and stops following.
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.files-crumb button')[0].click());
    await flush();
    expect(useTree.getState()).toMatchObject({ root: '/home/u', follow: false });
    expect(rows()[0]).toBe('/home/u/src');
    await act(async () => setFilter('zzz'));
    expect(host.textContent).toContain(t('files.noMatch'));
  });

  it('moves with the keyboard and renames with F2', async () => {
    await key('ArrowDown');
    expect(useTree.getState().cursor).toBe('/home/u/src/lib');
    await key('ArrowRight');
    await flush();
    expect(rows()).toHaveLength(4);
    await key('ArrowDown');
    expect(useTree.getState().selection).toEqual(['/home/u/src/lib/a.go']);
    await key('ArrowDown', { shiftKey: true });
    expect(useTree.getState().selection).toEqual(['/home/u/src/lib/a.go', '/home/u/src/lib/b.go']);
    await key('ArrowLeft');
    expect(useTree.getState().cursor).toBe('/home/u/src/lib');
    await key('ArrowLeft');
    expect(rows()).toHaveLength(2);
    await key('ArrowDown');
    await key('F2');
    const input = host.querySelector<HTMLInputElement>('.files-row input')!;
    expect(input.value).toBe('main.go');
    await act(async () => {
      input.value = 'app.go';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(changes()).toEqual([['rename', { path: '/home/u/src/main.go', to: '/home/u/src/app.go' }]]);
  });

  it('moves to the trash with Delete, and deletes for good with Shift+Delete after asking', async () => {
    await key('End');
    await key('Delete');
    await flush();
    expect(changes()).toEqual([['trash', { paths: ['/home/u/src/main.go'] }]]);
    await key('Delete', { shiftKey: true });
    await confirm(false);
    expect(changes()).toHaveLength(1);
    await key('Delete', { shiftKey: true });
    await confirm(true);
    expect(changes()[1]).toEqual(['remove', { paths: ['/home/u/src/main.go'] }]);
  });

  it("offers the context menu's changes, which call the core", async () => {
    await act(async () => {
      row('/home/u/src/main.go').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    });
    expect(menuItem(t('files.rename'))).toBeDefined();
    await act(async () => menuItem(t('files.copy'))!.run!());
    expect(useTree.getState().clipboard).toEqual({ m: 'm', paths: ['/home/u/src/main.go'], cut: false });
    // Paste into a folder.
    await act(async () => {
      row('/home/u/src/lib').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => menuItem(t('files.paste'))!.run!());
    await flush();
    expect(changes()).toEqual([['copy', { paths: ['/home/u/src/main.go'], dir: '/home/u/src/lib' }]]);
    // A new folder in it, named in the tree.
    await act(async () => menuItem(t('files.newFolder'))!.run!());
    await flush();
    const input = host.querySelector<HTMLInputElement>('.files-row.editing input')!;
    await act(async () => {
      input.value = 'pkg';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(changes()[1]).toEqual(['mkdir', { path: '/home/u/src/lib/pkg' }]);
    // Cut and paste is a move.
    await act(async () => {
      row('/home/u/src/main.go').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => menuItem(t('files.cut'))!.run!());
    await key('ArrowUp');
    await key('v', { metaKey: true, ctrlKey: true });
    await flush();
    expect(changes()[2]).toEqual(['move', { paths: ['/home/u/src/main.go'], dir: '/home/u/src/lib' }]);
    expect(useTree.getState().clipboard).toBeUndefined();
    // Delete Permanently asks first.
    await act(async () => {
      row('/home/u/src/main.go').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => menuItem(t('files.deletePermanently'))!.run!());
    await confirm(true);
    expect(changes()[3]).toEqual(['remove', { paths: ['/home/u/src/main.go'] }]);
  });

  it('offers no changes in read-only mode', async () => {
    useStore.getState().setReadOnly(true);
    const labels = menuFor('m', ['/home/u/src/main.go'], () => false)
      .filter(isItem)
      .map((e) => e.label);
    expect(labels).toContain(t('files.copyPath'));
    for (const l of ['files.rename', 'files.trash', 'files.deletePermanently', 'files.newFile', 'files.cut', 'files.paste'] as const) {
      expect(labels).not.toContain(t(l));
    }
    await key('ArrowDown');
    await key('Delete');
    await key('F2');
    expect(changes()).toEqual([]);
    expect(host.querySelector('.files-row input')).toBeNull();
  });

  it('lists a folder again when a poll sees it changed', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    const lists = () => calls.filter((c) => c.url.startsWith('/api/m/m/list')).length;
    await act(async () => poll());
    await flush();
    // The first poll sets the times and lists once more (the listing may be older).
    const after = lists();
    await act(async () => poll());
    await flush();
    expect(lists()).toBe(after);
    tree['/home/u/src/lib'] = [...tree['/home/u/src/lib'], f('c.go')];
    mtimes['/home/u/src/lib'] = 2;
    await act(async () => poll());
    await flush();
    expect(rows()).toContain('/home/u/src/lib/c.go');
    // A folder removed is dropped.
    delete tree['/home/u/src/lib'];
    await act(async () => poll());
    await flush();
    expect(useTree.getState().expanded['/home/u/src/lib']).toBeUndefined();
  });
});
