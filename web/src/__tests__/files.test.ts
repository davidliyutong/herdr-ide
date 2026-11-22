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
import { isRenameKey, renameKeyHint } from '../rowKeys';
import { t } from '../i18n';
import { FilesPanel, followedDir } from '../plugins/files/FilesPanel';
import {
  crumbs,
  excluded,
  fromSettings,
  poll,
  polledDirs,
  relativePath,
  setFilter,
  setHidden,
  showRoot,
  shownDirs,
  sortEntries,
  topmost,
  treeRows,
  useTree,
  MAX_EXPANDED,
  MAX_POLLED,
  type SortOrder,
  type TreeState,
} from '../plugins/files/tree';
import { useSettings } from '../settings';
import { badName, fileMenuEntries, menuFor, revealInExplorer, trash } from '../plugins/files/ops';
import { registerQuickDiff } from '../plugins/files/quickDiff';
import { actions } from '../actions';
import { definePlugins } from '../plugins/registry';
import { filesPlugin } from '../plugins/files';
import { MAX_BACKOFF_MS, startPolling } from '../plugins/files/poller';
import { decorationsOf, registerFileDecorations } from '../plugins/files/decorations';
import { FakeCore, settle } from './fakeTerms';
import type { RemoteStat } from '../lib/files';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The explorer is on (Reveal in Explorer asks).
definePlugins([filesPlugin]);

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
/** Directories whose listing fails. */
let failList: Set<string>;
/** Answers of the plugin's changes, by action, instead of {paths: []}. */
let answers: Record<string, (body: unknown) => { status: number; json: unknown }>;
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
      if (failList.has(p)) return json({ error: 'input/output error' }, 404);
      if (!tree[p]) return json({ error: 'no such directory' }, 404);
      // An empty directory's entries came as null.
      return json({ dir: { name: p, path: p, is_dir: true }, entries: tree[p].length ? tree[p] : null });
    }
    if (url.pathname === '/api/m/m/p/files/stat') {
      return json({
        entries: (body as { paths: string[] }).paths.map((p) => ({
          path: p,
          exists: !!tree[p],
          is_dir: !!tree[p],
          size: 0,
          mtime: mtimes[p] ?? 1,
        })),
      });
    }
    const action = url.pathname.replace('/api/m/m/p/files/', '');
    if (answers[action]) {
      const a = answers[action](body);
      return json(a.json, a.status);
    }
    if (url.pathname.startsWith('/api/m/m/p/files/')) return json({ paths: [] });
    return json({});
  });
}

const changes = () =>
  calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/stat')).map((c) => [c.url.replace('/api/m/m/p/files/', ''), c.body]);
const lists = (p?: string) =>
  calls.filter((c) => c.url.startsWith('/api/m/m/list') && (!p || c.url.endsWith(new URLSearchParams({ path: p }).toString()))).length;

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

  it('shows (and polls) only the folders not in a collapsed or hidden one', () => {
    const dirs: TreeState['dirs'] = {};
    for (const p of ['/r', '/r/a', '/r/a/b', '/r/c/d', '/r/.git', '/r/.git/x', '/r/e']) dirs[p] = { entries: [] };
    // /r/c is collapsed, /r/.git hidden.
    const expanded: TreeState['expanded'] = {
      '/r/a': true,
      '/r/a/b': true,
      '/r/c/d': true,
      '/r/.git': true,
      '/r/.git/x': true,
      '/r/e': true,
    };
    expect(shownDirs(state({ expanded }))).toEqual(['/r', '/r/a', '/r/a/b', '/r/e']);
    expect(polledDirs(state({ dirs, expanded }))).toEqual(['/r', '/r/a', '/r/a/b', '/r/e']);
    expect(shownDirs(state({ expanded, hidden: true }))).toEqual(['/r', '/r/a', '/r/a/b', '/r/.git', '/r/.git/x', '/r/e']);
  });

  it('polls one at a time, and less often after failures', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let fail = false;
      let done = () => {};
      const stop = startPolling(1000, () => {
        calls++;
        if (fail) return Promise.reject(new Error('offline'));
        return new Promise<void>((r) => (done = r));
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      // Still running: no other poll starts.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(1);
      done();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      // Failures double the wait: 2 s, then 4 s.
      fail = true;
      done();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(1999);
      expect(calls).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(4);
      await vi.advanceTimersByTimeAsync(3999);
      expect(calls).toBe(4);
      fail = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(5);
      done();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(6);
      stop();
      done();
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
      expect(calls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges decorations of providers', () => {
    const off1 = registerFileDecorations((_m, dir) => (dir === '/r' ? { a: { color: 'red', badge: 'M' } } : undefined));
    const off2 = registerFileDecorations(() => ({ a: { badge: 'U' } }));
    expect(decorationsOf('m', '/r')).toEqual({ a: { color: 'red', badge: 'U' } });
    off1();
    off2();
    expect(decorationsOf('m', '/r')).toEqual({});
  });

  it('sorts in the order set', () => {
    const entries = [f('b.txt', { mtime: 3 }), d('z'), f('a.md', { mtime: 5 }), d('c'), f('a10.txt', { mtime: 1 })];
    const names = (o: SortOrder) => sortEntries(entries, o).map((e) => e.name);
    expect(names('default')).toEqual(['c', 'z', 'a.md', 'a10.txt', 'b.txt']);
    expect(names('mixed')).toEqual(['a.md', 'a10.txt', 'b.txt', 'c', 'z']);
    expect(names('filesFirst')).toEqual(['a.md', 'a10.txt', 'b.txt', 'c', 'z']);
    expect(names('type')).toEqual(['c', 'z', 'a.md', 'a10.txt', 'b.txt']);
    expect(names('modified')).toEqual(['c', 'z', 'a.md', 'b.txt', 'a10.txt']);
  });

  it('leaves out the names excluded, and does not poll in excluded folders', () => {
    const exclude = ['.git', '**/node_modules', '*.pyc', '[Tt]humbs.db', 'x?'];
    for (const [name, out] of [
      ['.git', true],
      ['node_modules', true],
      ['a.pyc', true],
      ['thumbs.db', true],
      ['xy', true],
      ['xyz', false],
      ['.github', false],
      ['a.pyc.txt', false],
    ] as const)
      expect(excluded(exclude, name), name).toBe(out);
    const dirs = { '/r': { entries: [d('node_modules'), d('src'), f('Thumbs.db')] }, '/r/node_modules': { entries: [f('x')] } };
    const s = state({ dirs, exclude, expanded: { '/r/node_modules': true, '/r/src': true } });
    expect(treeRows(s).map((r) => r.name)).toEqual(['src']);
    expect(shownDirs(s)).toEqual(['/r', '/r/src']);
  });

  it('takes its switches from the settings unless this browser chose', () => {
    const values = useSettings.getState().values;
    try {
      localStorage.clear();
      useSettings.setState({
        values: {
          ...values,
          'files.showHidden': { value: true, source: 'global' },
          'files.followFocus': { value: false, source: 'global' },
        },
      });
      expect(fromSettings()).toMatchObject({ hidden: true, follow: false, sort: 'default' });
      expect(useTree.getState()).toMatchObject({ hidden: true, follow: false });
      setHidden(false);
      useSettings.setState({ values: { ...useSettings.getState().values, 'files.sortOrder': { value: 'mixed', source: 'global' } } });
      expect(useTree.getState()).toMatchObject({ hidden: false, follow: false, sort: 'mixed' });
    } finally {
      localStorage.clear();
      useSettings.setState({ values });
    }
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
    failList = new Set();
    answers = {};
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
    await act(async () => treeEl().dispatchEvent(new Event('paste', { bubbles: true, cancelable: true })));
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

  it('asks for the times in the body of a POST', async () => {
    await act(async () => poll());
    const stat = calls.find((c) => c.url.startsWith('/api/m/m/p/files/stat'))!;
    expect(stat).toMatchObject({ method: 'POST', url: '/api/m/m/p/files/stat', body: { paths: ['/home/u/src'] } });
  });

  it('keeps a folder listed when listing it again fails, and tries again', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    await act(async () => poll());
    await flush();
    mtimes['/home/u/src/lib'] = 2;
    failList.add('/home/u/src/lib');
    await act(async () => poll());
    await flush();
    expect(rows()).toContain('/home/u/src/lib/a.go');
    expect(useTree.getState().dirs['/home/u/src/lib'].error).toBeTruthy();
    // The time is recorded only once a listing succeeds: the next poll lists again.
    expect(useTree.getState().mtimes['/home/u/src/lib']).not.toBe(2);
    const before = lists('/home/u/src/lib');
    failList.clear();
    tree['/home/u/src/lib'] = [...tree['/home/u/src/lib'], f('c.go')];
    await act(async () => poll());
    await flush();
    expect(lists('/home/u/src/lib')).toBe(before + 1);
    expect(rows()).toContain('/home/u/src/lib/c.go');
    expect(useTree.getState().mtimes['/home/u/src/lib']).toBe(2);
    await act(async () => poll());
    await flush();
    expect(lists('/home/u/src/lib')).toBe(before + 1);
  });

  it('says nothing of a listing that failed once, and why one failed again or left nothing to show', async () => {
    const note = () => host.querySelector('.files-note.error')?.textContent;
    await act(async () => poll());
    await flush();
    // The root changes (an archive unpacked into it) and its listing fails
    // once: the entries stay, without a word.
    mtimes['/home/u/src'] = 2;
    failList.add('/home/u/src');
    await act(async () => poll());
    await flush();
    expect(rows()).toContain('/home/u/src/main.go');
    expect(note()).toBeUndefined();
    // Again: it says why, the entries still there.
    await act(async () => poll());
    await flush();
    expect(rows()).toContain('/home/u/src/main.go');
    expect(note()).toBe('input/output error');
    // Once it answers, the error goes: the folder unchanged since is listed
    // again, as a failed listing forgot its time.
    failList.clear();
    await act(async () => poll());
    await flush();
    expect(note()).toBeUndefined();
    expect(useTree.getState().mtimes['/home/u/src']).toBe(2);
    // A listing started otherwise (Refresh) that fails is tried again by the next poll.
    failList.add('/home/u/src');
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t('files.refresh')}"]`)!.click());
    await flush();
    failList.clear();
    const before = lists('/home/u/src');
    await act(async () => poll());
    await flush();
    expect(lists('/home/u/src')).toBe(before + 1);
    expect(useTree.getState().dirs['/home/u/src'].error).toBeUndefined();
  });

  it('polls a folder whose first listing failed, and an empty one', async () => {
    failList.add('/home/u/src/lib');
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    expect(rows()).toEqual(['/home/u/src/lib', '/home/u/src/main.go']);
    failList.clear();
    await act(async () => poll());
    await flush();
    expect(rows()).toEqual(['/home/u/src/lib', '/home/u/src/lib/a.go', '/home/u/src/lib/b.go', '/home/u/src/main.go']);
    // Emptied (its entries come as null), then filled again: still polled.
    tree['/home/u/src/lib'] = [];
    mtimes['/home/u/src/lib'] = 2;
    await act(async () => poll());
    await flush();
    expect(useTree.getState().dirs['/home/u/src/lib'].entries).toEqual([]);
    tree['/home/u/src/lib'] = [f('out.txt')];
    mtimes['/home/u/src/lib'] = 3;
    await act(async () => poll());
    await flush();
    expect(rows()).toContain('/home/u/src/lib/out.txt');
  });

  it('says that an empty root is empty', async () => {
    tree['/home/u/src'] = [];
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t('files.refresh')}"]`)!.click());
    await flush();
    expect(host.textContent).toContain(t('files.emptyDir'));
  });

  it('refreshes the folders shown, not every folder seen', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    await act(async () => row('/home/u/src/lib').click()); // collapsed again
    await flush();
    calls.length = 0;
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t('files.refresh')}"]`)!.click());
    await flush();
    expect(lists()).toBe(1);
    expect(lists('/home/u/src')).toBe(1);
  });

  it('keeps what is below a new root only, and clears the selection', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    useTree.setState((s) => ({ dirs: { ...s.dirs, '/elsewhere': { entries: [] } }, mtimes: { '/elsewhere': 1, '/home/u/src': 1 } }));
    await key('End');
    expect(useTree.getState().selection).toEqual(['/home/u/src/main.go']);
    // The root moves (a crumb): what was selected is no longer acted on.
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.files-crumb button')[0].click());
    await flush();
    const s = useTree.getState();
    expect(s).toMatchObject({ root: '/home/u', selection: [], cursor: undefined });
    expect(Object.keys(s.dirs).sort()).toEqual(['/home/u', '/home/u/src/lib']);
    expect(Object.keys(s.mtimes)).toEqual([]);
    await key('Delete');
    await flush();
    expect(changes()).toEqual([]);
    // Many folders opened elsewhere: the oldest outside the root are forgotten.
    const expanded: TreeState['expanded'] = {};
    for (let i = 0; i < MAX_EXPANDED + 10; i++) expanded[`/other/d${i}`] = true;
    useTree.setState({ expanded: { ...expanded, '/home/u/x': true } });
    await act(async () => showRoot('m', '/home'));
    const kept = Object.keys(useTree.getState().expanded);
    expect(kept).toHaveLength(MAX_EXPANDED);
    expect(kept).toContain('/home/u/x');
    expect(kept).not.toContain('/other/d0');
  });

  it('acts on a selection of several rows: opens its files, and takes what applies to them all', async () => {
    const open = vi.spyOn(actions, 'openView').mockResolvedValue('view:x');
    try {
      await act(async () => row('/home/u/src/lib').click());
      await flush();
      useTree.setState({
        selection: ['/home/u/src/lib/a.go', '/home/u/src/main.go', '/home/u/src/lib'],
        cursor: '/home/u/src/main.go',
      });
      await key('Enter');
      await flush();
      expect(open.mock.calls.map((c) => c[1].path)).toEqual(['/home/u/src/lib/a.go', '/home/u/src/main.go']);
      const isDir = (p: string) => p === '/home/u/src/lib';
      const labels = menuFor('m', ['/home/u/src/main.go', '/home/u/src/lib'], isDir)
        .filter(isItem)
        .map((e) => e.label);
      for (const l of [
        'files.open',
        'files.openToSide',
        'files.cut',
        'files.copy',
        'files.copyPath',
        'files.download',
        'files.trash',
        'files.newFile',
      ] as const)
        expect(labels).toContain(t(l));
      for (const l of ['files.quickLook', 'files.openInTerminal', 'files.rename'] as const) expect(labels).not.toContain(t(l));
    } finally {
      open.mockRestore();
    }
  });

  it('asks before moving to the trash when the setting says so', async () => {
    const values = useSettings.getState().values;
    useSettings.setState({ values: { ...values, 'files.confirmTrash': { value: true, source: 'global' } } });
    try {
      let done = act(async () => trash('m', ['/home/u/src/main.go']));
      await flush();
      expect((useDialog.getState().current as { title?: string })?.title).toBe(t('files.confirm.trashTitle'));
      await confirm(false);
      await done;
      expect(changes()).toEqual([]);
      done = act(async () => trash('m', ['/home/u/src/main.go']));
      await flush();
      await confirm(true);
      await done;
      expect(changes()).toEqual([['trash', { paths: ['/home/u/src/main.go'] }]]);
    } finally {
      useSettings.setState({ values });
    }
  });

  it('offers Open Changes for a file version control marks as changed', async () => {
    const opened: string[] = [];
    const offDiff = registerQuickDiff({ follow: () => () => {}, original: async () => undefined, openChanges: (_m, p) => opened.push(p) });
    const offDeco = registerFileDecorations((_m, dir) =>
      dir === '/home/u/src' ? { 'main.go': { badge: 'M' }, lib: { badge: '•' } } : undefined,
    );
    try {
      const item = (p: string) =>
        menuFor('m', [p], () => false).find((e): e is MenuItem => isItem(e) && e.label === t('files.openChangesItem'));
      expect(item('/home/u/src/lib/a.go')).toBeUndefined();
      item('/home/u/src/main.go')!.run!();
      expect(opened).toEqual(['/home/u/src/main.go']);
    } finally {
      offDeco();
      offDiff();
    }
  });

  it('shares its file entries and reveals a path in the tree', async () => {
    const labels = fileMenuEntries('m', ['/home/u/src/lib/b.go'])
      .filter(isItem)
      .map((e) => e.label);
    expect(labels).toEqual(
      [
        'files.open',
        'files.openToSide',
        'files.quickLook',
        'files.openInTerminal',
        'files.copyPath',
        'files.copyRelativePath',
        'files.download',
        'files.revealInExplorer',
      ].map((k) => t(k as Parameters<typeof t>[0])),
    );
    expect(
      fileMenuEntries('m', ['/a', '/b'], { reveal: false })
        .filter(isItem)
        .map((e) => e.label),
    ).not.toContain(t('files.quickLook'));
    useStore.getState().setPanel(undefined);
    await act(async () => revealInExplorer('m', '/home/u/src/lib/b.go'));
    await flush();
    expect(useStore.getState().panel).toBe('files');
    expect(useTree.getState()).toMatchObject({ root: '/home/u/src', cursor: '/home/u/src/lib/b.go', selection: ['/home/u/src/lib/b.go'] });
    expect(rows()).toContain('/home/u/src/lib/b.go');
    // Outside the root: the tree stops following and shows its folder.
    await act(async () => revealInExplorer('m', '/home/u/src'));
    await flush();
    expect(useTree.getState()).toMatchObject({ root: '/home/u', follow: false, selection: ['/home/u/src'] });
  });

  it('pastes into the root when the cursor is not a row', async () => {
    await key('End');
    await key('c', { metaKey: true, ctrlKey: true });
    useTree.setState({ cursor: '/elsewhere/gone', selection: [] });
    const kev = new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => treeEl().dispatchEvent(kev));
    expect(kev.defaultPrevented).toBe(false);
    await act(async () => treeEl().dispatchEvent(new Event('paste', { bubbles: true, cancelable: true })));
    await flush();
    expect(changes()).toEqual([['copy', { paths: ['/home/u/src/main.go'], dir: '/home/u/src' }]]);
  });

  it('draws file-type icons, indent guides and the filter’s match', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    expect(row('/home/u/src/lib').querySelector('svg.file-icon')?.getAttribute('data-icon')).toBe('folder.lib');
    expect(row('/home/u/src/main.go').querySelector('svg.file-icon')?.getAttribute('data-icon')).toBe('go');
    expect(row('/home/u/src/lib/a.go').querySelectorAll('.tree-guide')).toHaveLength(1);
    await act(async () => setFilter('ai'));
    expect(row('/home/u/src/main.go').querySelector('mark')?.textContent).toBe('ai');
  });

  it('pages, selects all and goes to a row by typing its name', async () => {
    await act(async () => row('/home/u/src/lib').click());
    await flush();
    await key('PageDown');
    expect(useTree.getState().cursor).toBe('/home/u/src/main.go');
    await key('a', { metaKey: true, ctrlKey: false });
    await key('a', { ctrlKey: true, metaKey: false });
    expect(useTree.getState().selection).toEqual([
      '/home/u/src/lib',
      '/home/u/src/lib/a.go',
      '/home/u/src/lib/b.go',
      '/home/u/src/main.go',
    ]);
    await key('b');
    expect(useTree.getState()).toMatchObject({ cursor: '/home/u/src/lib/b.go', selection: ['/home/u/src/lib/b.go'] });
  });

  it('keeps a cut on the clipboard until it is moved', async () => {
    const main = '/home/u/src/main.go';
    await key('End');
    await key('x', { metaKey: true, ctrlKey: true });
    // The move fails: the clipboard stays.
    answers.move = () => ({ status: 400, json: { error: 'failed', message: 'cross-device' } });
    await act(async () => row('/home/u/src/lib').click());
    await act(async () => treeEl().dispatchEvent(new Event('paste', { bubbles: true, cancelable: true })));
    await flush();
    expect(changes()).toEqual([['move', { paths: [main], dir: '/home/u/src/lib' }]]);
    expect(useTree.getState().clipboard).toEqual({ m: 'm', paths: [main], cut: true });
    // Some fail: those stay.
    useTree.setState({ clipboard: { m: 'm', paths: [main, '/home/u/src/.hidden'], cut: true } });
    answers.move = () => ({ status: 200, json: { paths: ['/home/u/src/lib/main.go'], failed: { '/home/u/src/.hidden': 'exists' } } });
    await act(async () => treeEl().dispatchEvent(new Event('paste', { bubbles: true, cancelable: true })));
    await flush();
    expect(useTree.getState().clipboard).toEqual({ m: 'm', paths: ['/home/u/src/.hidden'], cut: true });
  });

  it('auto-reveals, highlights and scrolls to the active editor file within the root', async () => {
    tree['/home/u/src/lib/deep'] = [f('target.ts')];
    tree['/home/u/src/lib'] = [d('deep'), f('a.go'), f('b.go')];
    const items = Array.from({ length: 30 }, (_, i) => f(`z${i}.txt`));
    tree['/home/u/src'] = [d('lib'), ...items, f('main.go')];
    await act(async () => showRoot('m', '/home/u'));
    await act(async () => showRoot('m', '/home/u/src'));
    await flush();

    const el = treeEl();
    Object.defineProperty(el, 'clientHeight', { value: 110, configurable: true });

    // Switch to a tab showing a nested editor file: parent dirs expand, row is highlighted & scrolled into view.
    core.model.mutate('m', (l) => ({
      ...l,
      workspaces: [
        {
          ...l.workspaces[0],
          tabs: [
            l.workspaces[0].tabs[0],
            { root: { view: { id: 'ed1', plugin: 'files', kind: 'editor', path: '/home/u/src/lib/deep/target.ts' } }, focused: 'view:ed1' },
            { root: { view: { id: 'ed2', plugin: 'files', kind: 'editor', path: '/home/u/src/main.go' } }, focused: 'view:ed2' },
            { root: { view: { id: 'ed3', plugin: 'files', kind: 'editor', path: '/etc/hosts' } }, focused: 'view:ed3' },
          ],
          selected: 1,
        },
      ],
    }));
    await flush();
    await flush();

    expect(useTree.getState().expanded['/home/u/src/lib']).toBe(true);
    expect(useTree.getState().expanded['/home/u/src/lib/deep']).toBe(true);
    expect(useTree.getState().selection).toEqual(['/home/u/src/lib/deep/target.ts']);
    expect(row('/home/u/src/lib/deep/target.ts').dataset.active).toBe('true');
    expect(row('/home/u/src/lib/deep/target.ts').className).toContain('active');

    // Switch to another editor tab further down the list: scrolls into view and moves highlight.
    await act(async () => actions.selectTab('m', 'w1w1w1w1', 2));
    await flush();
    expect(useTree.getState().selection).toEqual(['/home/u/src/main.go']);
    expect(row('/home/u/src/main.go').dataset.active).toBe('true');
    expect(el.scrollTop).toBeGreaterThan(0);

    // An editor file outside the current root does not hijack the root.
    await act(async () => actions.selectTab('m', 'w1w1w1w1', 3));
    await flush();
    expect(useTree.getState().root).toBe('/home/u/src');
    expect(useTree.getState().follow).toBe(true);

    // If the user later navigates root into an ancestor of that active file, it auto-reveals.
    tree['/etc'] = [f('hosts')];
    await act(async () => showRoot('m', '/etc'));
    await flush();
    expect(useTree.getState().selection).toEqual(['/etc/hosts']);
    expect(row('/etc/hosts').dataset.active).toBe('true');
  });

  it('persists and restores File Explorer UI state across tab and panel switches', async () => {
    const many = Array.from({ length: 40 }, (_, i) => f(`f${String(i).padStart(2, '0')}.txt`));
    tree['/home/u/src'] = [d('lib'), ...many, f('main.go')];
    tree['/home/u/other'] = [f('o.txt')];
    await act(async () => showRoot('m', '/home/u'));
    await act(async () => showRoot('m', '/home/u/src'));
    await flush();

    await act(async () => row('/home/u/src/lib').click());
    await flush();
    await act(async () => setFilter('f2'));
    await key('End');
    const selectedBefore = useTree.getState().selection;
    expect(selectedBefore).toEqual(['/home/u/src/f29.txt']);

    // Simulate user scrolling in the tree.
    const el = treeEl();
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    el.scrollTop = 180;
    await act(async () => el.dispatchEvent(new Event('scroll', { bubbles: true })));

    // 1) Unmount and remount on the same root (e.g. panel switch or pane-mounted explorer tab switch).
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(FilesPanel)));
    await flush();
    expect(useTree.getState()).toMatchObject({
      expanded: { '/home/u/src/lib': true },
      selection: selectedBefore,
      cursor: '/home/u/src/f29.txt',
      filter: 'f2',
    });
    expect(treeEl().scrollTop).toBe(180);

    // 2) Switch to a terminal tab in a different directory, then switch back to the first tab.
    const t2 = FakeCore.term('p2', { cwd: '/home/u/other' });
    core.machines.get('m')!.terminals.push(t2);
    await act(async () => {
      core.push({ t: 'snapshot', m: 'm', terminals: core.machines.get('m')!.terminals });
      core.model.mutate('m', (l) => ({
        ...l,
        workspaces: [
          {
            ...l.workspaces[0],
            tabs: [l.workspaces[0].tabs[0], { root: { terminal: 'p2' }, focused: 'p2' }],
            selected: 1,
          },
        ],
      }));
    });
    await flush();
    expect(useTree.getState().root).toBe('/home/u/other');
    expect(useTree.getState().selection).toEqual([]);
    expect(useTree.getState().filter).toBe('');

    // Switch back to Tab 0 (/home/u/src): expanded dirs, selection, cursor, filter and scroll are restored.
    await act(async () => actions.selectTab('m', 'w1w1w1w1', 0));
    await flush();
    expect(useTree.getState()).toMatchObject({
      root: '/home/u/src',
      expanded: { '/home/u/src/lib': true },
      selection: selectedBefore,
      cursor: '/home/u/src/f29.txt',
      filter: 'f2',
    });
    expect(treeEl().scrollTop).toBe(180);
  });

  it('uses platform-native rename keys: Enter on macOS and F2 on Windows/Linux', () => {
    expect(renameKeyHint(true)).toBe('↩');
    expect(renameKeyHint(false)).toBe('F2');
    expect(isRenameKey({ key: 'Enter' }, true)).toBe(true);
    expect(isRenameKey({ key: 'F2' }, true)).toBe(false);
    expect(isRenameKey({ key: 'F2' }, false)).toBe(true);
    expect(isRenameKey({ key: 'Enter' }, false)).toBe(false);
    expect(isRenameKey({ key: 'Enter', metaKey: true }, true)).toBe(false);
  });
});
