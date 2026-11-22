// @vitest-environment jsdom
//
// The Git panel (plugins/git/GitPanel.tsx) with the core's routes stubbed:
// VS Code's groups, their rows and actions, the commit box, the file
// explorer's decorations, and read-only mode.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), createDiffEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { useDialog } from '../dialog';
import { t } from '../i18n';
import { GitPanel, groupFiles, groupRows, rowId } from '../plugins/git/GitPanel';
import { useMenu, isItem, type MenuEntry, type MenuItem } from '../contextMenu';
import { fileMenuEntries } from '../plugins/files/ops';
import { useSettings } from '../settings';
import { isMac } from '../keys';
import { decorate, gitDecorations, IGNORED_COLOR, markOf } from '../plugins/git/decorations';
import { forgetRepos, repoKey, useGit } from '../plugins/git/state';
import { useTree } from '../plugins/files/tree';
import { forgetPanels } from '../plugins/git/memory';
import { ago } from '../plugins/git/shared';
import type { StatusFile } from '../plugins/git/api';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/home/u/repo';
const STASH = 'a'.repeat(40);
const commit = (hash: string, ...parents: string[]) => ({ hash, parents, author: 'A', email: 'a@x', date: 1, subject: `commit ${hash}` });
const files: StatusFile[] = [
  { path: 'src/a.ts', x: 'M', y: 'M', kind: 'changed' },
  { path: 'src/new.ts', x: 'A', y: '.', kind: 'changed' },
  { path: 'old.txt', x: '.', y: 'D', kind: 'changed' },
  { path: 'notes/todo.md', x: '?', y: '?', kind: 'untracked' },
  { path: 'conflict.c', x: 'U', y: 'U', kind: 'unmerged' },
  { path: 'renamed.txt', orig: 'before.txt', x: 'R', y: '.', kind: 'renamed' },
];

describe('grouping', () => {
  it('puts files in the groups VS Code shows, with the side’s letter', () => {
    const g = groupFiles(files);
    expect(g.merge.map((f) => `${f.letter} ${f.file.path}`)).toEqual(['! conflict.c']);
    expect(g.staged.map((f) => `${f.letter} ${f.file.path}`)).toEqual(['R renamed.txt', 'M src/a.ts', 'A src/new.ts']);
    expect(g.changes.map((f) => `${f.letter} ${f.file.path}`)).toEqual(['U notes/todo.md', 'D old.txt', 'M src/a.ts']);
  });

  it('builds a tree with folders before files, single folders joined', () => {
    const g = groupFiles([
      { path: 'a/b/c/x.ts', x: '.', y: 'M', kind: 'changed' },
      { path: 'a/b/c/y.ts', x: '.', y: 'M', kind: 'changed' },
      { path: 'a/z.ts', x: '.', y: 'M', kind: 'changed' },
      { path: 'top.ts', x: '.', y: 'M', kind: 'changed' },
    ]);
    const show = (rows: ReturnType<typeof groupRows>) =>
      rows.map((r) => (r.kind === 'dir' ? `${r.depth}:${r.label}/` : `${r.depth}:${r.g.file.path}`));
    expect(show(groupRows('changes', g.changes, true))).toEqual(['0:a/', '1:b/c/', '2:a/b/c/x.ts', '2:a/b/c/y.ts', '1:a/z.ts', '0:top.ts']);
    // A collapsed folder hides what is inside; its row stands for its files.
    const rows = groupRows('changes', g.changes, true, new Set([rowId('changes', 'a/b/c', true)]));
    expect(show(rows)).toEqual(['0:a/', '1:b/c/', '1:a/z.ts', '0:top.ts']);
    const bc = rows[1];
    expect(bc.kind === 'dir' && bc.files.map((f) => f.file.path)).toEqual(['a/b/c/x.ts', 'a/b/c/y.ts']);
    expect(show(groupRows('changes', g.changes, false))).toEqual(['0:a/b/c/x.ts', '0:a/b/c/y.ts', '0:a/z.ts', '0:top.ts']);
  });

  it('puts untracked files in a group of their own when asked', () => {
    const g = groupFiles(files, true);
    expect(g.changes.map((f) => f.file.path)).toEqual(['old.txt', 'src/a.ts']);
    expect(g.untracked.map((f) => f.file.path)).toEqual(['notes/todo.md']);
  });

  it('decorates the explorer’s entries and their folders', () => {
    expect(markOf(files[0])).toBe('modified');
    expect(markOf(files[3])).toBe('untracked');
    const d = decorate([{ root: ROOT, files }], ROOT);
    expect(d['conflict.c'].badge).toBe('!');
    expect(d['old.txt'].badge).toBe('D');
    expect(d['src'].badge).toBe('•');
    expect(d['src'].color).toBe('var(--ds-git-modified)');
    expect(d['notes'].color).toBe('var(--ds-git-untracked)');
    // Inside a folder, and from above the repository.
    expect(Object.keys(decorate([{ root: ROOT, files }], `${ROOT}/src`)).sort()).toEqual(['a.ts', 'new.ts']);
    expect(decorate([{ root: ROOT, files }], '/home/u')).toEqual({ repo: expect.objectContaining({ color: 'var(--ds-git-conflict)' }) });
    expect(decorate([{ root: ROOT, files }], '/elsewhere')).toEqual({});
  });

  // What git ignores is muted, without a letter: the paths the status
  // lists and everything inside an ignored folder (git lists the folder
  // alone: the explorer's entries are). The git directory has no color.
  it('mutes what git ignores, not the git directory', () => {
    const dim = { color: IGNORED_COLOR, tooltip: t('git.mark.ignored') };
    const repo = { root: ROOT, files, ignored: ['node_modules/', 'src/debug.log', 'logs/'] };
    const top = decorate([repo], ROOT, () => ['node_modules', 'logs', '.git', 'src', 'README.md']);
    expect([top['node_modules'], top['logs']]).toEqual([dim, dim]);
    expect(top['.git']).toBeUndefined();
    expect(top['README.md']).toBeUndefined();
    // A change marks its folder whatever is ignored in it.
    expect(top['src'].color).toBe('var(--ds-git-modified)');
    expect(decorate([repo], `${ROOT}/src`)['debug.log']).toEqual(dim);
    expect(decorate([repo], `${ROOT}/node_modules/pkg/lib`, () => ['index.js', 'util'])).toEqual({ 'index.js': dim, util: dim });
    expect(decorate([repo], `${ROOT}/.git/refs`, () => ['heads', 'tags'])).toEqual({});
    // A repository inside another rules its own files.
    const dep = { root: `${ROOT}/node_modules/dep`, files: [{ path: 'x.js', x: '.', y: 'M', kind: 'changed' } as StatusFile] };
    expect(decorate([repo, dep], dep.root, () => ['x.js', 'y.js'])).toEqual({
      'x.js': { color: 'var(--ds-git-modified)', badge: 'M', tooltip: t('git.mark.modified') },
    });
    // The provider takes the entries the explorer listed.
    useGit.setState({
      repos: { [repoKey('m', ROOT)]: { status: { ahead: 0, behind: 0, files: [], ignored: ['out/'] }, version: 0, refs: 0, readAt: 0 } },
    });
    useTree.setState({ m: 'm', dirs: { [`${ROOT}/out`]: { entries: [{ name: 'app.js', size: 1, mode: 0, mtime: 0, is_dir: false }] } } });
    expect(gitDecorations('m', `${ROOT}/out`)).toEqual({ 'app.js': dim });
    expect(gitDecorations('other', `${ROOT}/out`)).toBeUndefined();
    useTree.setState({ m: undefined, dirs: {} });
    useGit.setState({ repos: {} });
  });
});

describe('GitPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
  let status: StatusFile[];
  let parents: string[] | undefined;
  /** The repository's remotes and the branch's upstream. */
  let remotes: string[];
  let upstream: string | undefined;
  /** Answers log requests instead of the two pages below, when set. */
  let logImpl: ((q: URLSearchParams) => Promise<Response>) | undefined;
  const logs: URLSearchParams[] = [];
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const button = (label: string, within: ParentNode = host) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === label || b.textContent?.trim() === label);
  const section = (title: string) => host.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;

  beforeEach(async () => {
    posts.length = 0;
    logs.length = 0;
    status = files.slice(0, 4);
    parents = undefined;
    remotes = ['origin'];
    upstream = 'origin/main';
    logImpl = undefined;
    forgetRepos();
    forgetPanels();
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      if (init?.method === 'POST') {
        posts.push({ action, body: JSON.parse(String(init.body)) });
        return new Response('{}');
      }
      switch (action) {
        case 'repo':
          return new Response(
            JSON.stringify({
              root: ROOT,
              gitDir: ROOT + '/.git',
              commonDir: ROOT + '/.git',
              branch: 'main',
              head: 'h1',
              ahead: 1,
              behind: 0,
              upstream,
              remotes,
              remoteUrls: Object.fromEntries(remotes.map((r) => [r, `https://example.com/${r}.git`])),
              parents,
            }),
          );
        case 'status':
          return new Response(JSON.stringify({ branch: 'main', head: 'h1', upstream, ahead: 1, behind: 0, files: status }));
        case 'log': {
          if (logImpl) return logImpl(url.searchParams);
          logs.push(url.searchParams);
          // Two pages: h1 (more), then h0.
          const second = url.searchParams.get('skip') === '1';
          return new Response(
            JSON.stringify({
              commits: second
                ? [{ hash: 'h0', parents: [], author: 'A', email: 'a@x', date: 1, subject: 'older commit' }]
                : [{ hash: 'h1', parents: ['h0'], author: 'A', email: 'a@x', date: 1, subject: 'first commit' }],
              more: !second,
              refs: second ? undefined : [{ name: 'refs/heads/main', hash: 'h1' }],
            }),
          );
        }
        case 'show':
          return new Response(
            JSON.stringify({ base: 'h0', target: 'h1', files: [{ path: 'src/a.ts', status: 'M', added: 3, deleted: 1 }] }),
          );
        case 'stashes':
          return new Response(JSON.stringify([{ index: 0, hash: STASH, base: 'h1', date: 1, message: 'WIP on main' }]));
        case 'watch':
          return new Response(JSON.stringify({ token: 't' }));
        case 'branches':
          return new Response(
            JSON.stringify([
              {
                name: 'main',
                full: 'refs/heads/main',
                hash: 'h1',
                current: true,
                upstream: 'origin/main',
                ahead: 1,
                date: 1,
                subject: 's',
              },
              { name: 'topic', full: 'refs/heads/topic', hash: 'h0', date: 1, subject: 'older commit' },
              { name: 'origin/main', full: 'refs/remotes/origin/main', hash: 'h1', remote: true, date: 1, subject: 's' },
              { name: 'origin/feature', full: 'refs/remotes/origin/feature', hash: 'h0', remote: true, date: 1, subject: 's' },
            ]),
          );
        case 'tags':
          return new Response(JSON.stringify([{ name: 'v1', hash: 'h0', date: 1 }]));
      }
      return new Response('{}');
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: ROOT } } as unknown as MachineState]);
    s.selectMachine('m');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(GitPanel)));
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    useMenu.setState({ menu: undefined });
    useSettings.setState((st) => {
      const values = { ...st.values };
      delete values['git.changesView'];
      delete values['git.untrackedChanges'];
      return { values };
    });
  });

  const rowOf = (group: string, text: string) =>
    [...section(group).querySelectorAll<HTMLElement>('.git-row')].find((r) => r.textContent?.includes(text))!;
  /** A click that adds a row to the selection (⌘ on macOS, else Ctrl). */
  const toggleClick = (el: HTMLElement) =>
    act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: isMac, ctrlKey: !isMac })));
  const key = (el: HTMLElement, k: string, mod = false) =>
    act(async () =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, metaKey: mod && isMac, ctrlKey: mod && !isMac })),
    );
  const menuItem = (label: string) => useMenu.getState().menu?.entries.find((e): e is MenuItem => isItem(e) && e.label === label);

  it('shows the branch, ahead and behind, and the groups', () => {
    expect(host.querySelector('.git-branch')!.textContent).toContain('main');
    expect(host.querySelector('.git-sync')!.textContent).toContain('0↓ 1↑');
    expect(section(t('git.group.staged')).querySelectorAll('.git-row')).toHaveLength(2);
    expect(section(t('git.group.changes')).querySelectorAll('.git-row')).toHaveLength(3);
    expect(host.querySelector(`section[aria-label="${t('git.group.merge')}"]`)).toBeNull();
    expect(host.textContent).toContain('first commit');
  });

  it('stages, unstages and stages all', async () => {
    const changes = section(t('git.group.changes'));
    const row = [...changes.querySelectorAll('.git-row')].find((r) => r.textContent?.includes('a.ts'))!;
    await act(async () => button(t('git.stage'), row)!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stage', body: { paths: ['src/a.ts'], repo: ROOT } });
    const staged = section(t('git.group.staged'));
    const srow = [...staged.querySelectorAll('.git-row')].find((r) => r.textContent?.includes('new.ts'))!;
    await act(async () => button(t('git.unstage'), srow)!.click());
    await flush();
    expect(posts[1]).toEqual({ action: 'unstage', body: { paths: ['src/new.ts'], repo: ROOT } });
    // The groups' actions name no paths when they act on everything: no
    // limit of paths or of a command line's length.
    await act(async () => button(t('git.stageAll'), changes)!.click());
    await flush();
    expect(posts[2]).toEqual({ action: 'stage', body: { all: true, repo: ROOT } });
    await act(async () => button(t('git.unstageAll'), section(t('git.group.staged')))!.click());
    await flush();
    expect(posts[3]).toEqual({ action: 'unstage', body: { all: true, repo: ROOT } });
  });

  it('stages all changes but the conflicts by their paths', async () => {
    status = [...files.slice(0, 1), files[4]];
    await act(async () => button(t('git.refresh'))!.click());
    await flush();
    await act(async () => button(t('git.stageAll'), section(t('git.group.changes')))!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stage', body: { paths: ['src/a.ts'], repo: ROOT } });
  });

  it('unstages a rename with its old path', async () => {
    status = [files[5]];
    await act(async () => button(t('git.refresh'))!.click());
    await flush();
    const row = section(t('git.group.staged')).querySelector('.git-row')!;
    await act(async () => button(t('git.unstage'), row)!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'unstage', body: { paths: ['renamed.txt', 'before.txt'], repo: ROOT } });
  });

  it('acts on a stash by its index and commit', async () => {
    const stashes = section(t('git.group.stashes'));
    await act(async () => stashes.querySelector<HTMLElement>('.section-toggle')!.click());
    await act(async () => button(t('git.stash.pop'), stashes)!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stashPop', body: { index: 0, hash: STASH, repo: ROOT } });
  });

  it('discards after asking, removing untracked files', async () => {
    const changes = section(t('git.group.changes'));
    const row = [...changes.querySelectorAll('.git-row')].find((r) => r.textContent?.includes('todo.md'))!;
    await act(async () => button(t('git.discard'), row)!.click());
    const req = useDialog.getState().current;
    expect(req?.kind).toBe('confirm');
    await act(async () => (req as { resolve(ok: boolean): void }).resolve(true));
    await flush();
    expect(posts[0]).toEqual({ action: 'discard', body: { paths: [], untracked: ['notes/todo.md'], repo: ROOT } });
  });

  it('commits with Cmd/Ctrl+Enter', async () => {
    const box = host.querySelector<HTMLTextAreaElement>('.git-message')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'Fix the thing');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    await flush();
    expect(posts[0]).toEqual({ action: 'commit', body: { message: 'Fix the thing', amend: false, repo: ROOT } });
    expect(box.value).toBe('');
  });

  it('asks to stage everything when nothing is staged', async () => {
    status = [{ path: 'x', x: '.', y: 'M', kind: 'changed' }];
    await act(async () => button(t('git.refresh'))!.click());
    await flush();
    const box = host.querySelector<HTMLTextAreaElement>('.git-message')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'All');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(t('git.commit.button'))!.click());
    const req = useDialog.getState().current as { resolve(ok: boolean): void };
    await act(async () => req.resolve(true));
    await flush();
    expect(posts.map((p) => p.action)).toEqual(['stage', 'commit']);
    expect(posts[0].body).toEqual({ all: true, repo: ROOT });
  });

  it('hides changes in read-only mode', async () => {
    await act(async () => useStore.getState().setReadOnly(true));
    expect(host.querySelector('.git-message')).toBeNull();
    expect(button(t('git.stage'))).toBeUndefined();
    expect(button(t('git.openFile'))).toBeDefined();
  });

  // The history is docked at the bottom: every commit, a page at a time as
  // it scrolls, the branch at its commit, a commit's files under it.
  it("shows the history, page after page, and a commit's files", async () => {
    const history = section(t('git.group.recent'));
    expect(history.querySelector('.git-history-row')?.textContent).toContain('first commit');
    expect(history.querySelector('.git-ref.current')?.textContent).toBe('main');
    // The list is short: the next page loads at once, after the first.
    await flush();
    expect(logs.map((q) => q.get('skip'))).toContain('1');
    expect([...history.querySelectorAll('.git-history-row')].map((r) => r.textContent)).toEqual([
      expect.stringContaining('first commit'),
      expect.stringContaining('older commit'),
    ]);
    await act(async () => history.querySelector<HTMLElement>('.git-history-row')!.click());
    await flush();
    expect(history.querySelector('.git-history-file')?.textContent).toContain('a.ts');
  });

  // A page asked before the list was read again (new commits) belongs to
  // the old list: it is dropped, not appended after a gap; pages go on
  // from where the machine's pages ended, and stop at the end.
  it("drops a page of the history's earlier list", async () => {
    let server = [commit('h1', 'h0'), commit('h0')];
    let release: (() => void) | undefined;
    logImpl = async (q) => {
      logs.push(q);
      const skip = Number(q.get('skip') ?? 0);
      const page = server.slice(skip, skip + 1);
      const body = JSON.stringify({ commits: page, more: skip + 1 < server.length, refs: [] });
      if (skip === 1 && !release) await new Promise<void>((r) => (release = r));
      return new Response(body);
    };
    useGit.setState({ repos: {} });
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(GitPanel)));
    await flush();
    // The second page of [h1, h0] is on its way; a commit arrives and the
    // list is read again.
    expect(release).toBeDefined();
    server = [commit('h2', 'h1'), ...server];
    const k = Object.keys(useGit.getState().repos).find((x) => x.endsWith(ROOT))!;
    await act(async () => useGit.setState((s) => ({ repos: { ...s.repos, [k]: { ...s.repos[k], refs: s.repos[k].refs + 1 } } })));
    await flush();
    await act(async () => release!());
    await flush();
    await flush();
    const history = section(t('git.group.recent'));
    expect([...history.querySelectorAll('.git-history-row')].map((r) => r.textContent?.match(/commit (h\d)/)?.[1])).toEqual([
      'h2',
      'h1',
      'h0',
    ]);
    expect(logs.length).toBeLessThan(8);
  });

  it('keeps the amend box per repository', async () => {
    parents = ['/home/u'];
    await act(async () => button(t('git.refresh'))!.click());
    await flush();
    const amend = () => host.querySelector<HTMLInputElement>('.git-amend input')!;
    await act(async () => amend().click());
    expect(amend().checked).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('.git-repo-pick')!.click());
    const row = [...document.querySelectorAll<HTMLElement>('.picker-row')].find((r) => r.textContent?.startsWith('u'))!;
    await act(async () => row.click());
    await flush();
    expect(host.querySelector('.git-title')!.textContent).toBe('u');
    expect(amend().checked).toBe(false);
  });

  // The rows behave as the file explorer's: several selected with ⌘/Ctrl
  // and Shift clicks or the keys, every action on the selection.
  it('acts on the selected rows of a group', async () => {
    const changes = t('git.group.changes');
    await toggleClick(rowOf(changes, 'old.txt'));
    await toggleClick(rowOf(changes, 'a.ts'));
    expect(rowOf(changes, 'a.ts').classList.contains('selected')).toBe(true);
    await act(async () => button(t('git.stage'), rowOf(changes, 'a.ts'))!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stage', body: { paths: ['src/a.ts', 'old.txt'], repo: ROOT } });
    // Every row (⌘/Ctrl+A), and the context menu of one of them: the
    // explorer's file entries and Git's, on the group's selected files.
    const list = host.querySelector<HTMLElement>('.git-groups')!;
    list.focus();
    await key(list, 'a', true);
    expect(section(changes).querySelectorAll('.git-row.selected')).toHaveLength(3);
    await act(async () => rowOf(changes, 'todo.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    for (const label of [t('git.openDiff'), t('files.open'), t('files.openToSide'), t('files.copyPath'), t('files.copyRelativePath')])
      expect(menuItem(label)).toBeDefined();
    // One target of several: nothing that opens a single file.
    expect(menuItem(t('files.quickLook'))).toBeUndefined();
    // The explorer's entries, in its order, for the files that are there
    // (old.txt is deleted).
    const labels = (entries: MenuEntry[]) => entries.map((e) => (isItem(e) ? e.label : '-'));
    const entries = useMenu.getState().menu!.entries;
    const shared = fileMenuEntries('m', [`${ROOT}/notes/todo.md`, `${ROOT}/src/a.ts`], { root: ROOT });
    expect(labels(entries.slice(entries.indexOf('sep') + 1))).toEqual(labels(shared));
    await act(async () => menuItem(t('git.stage'))!.run!());
    await flush();
    expect(posts[1]).toEqual({ action: 'stage', body: { paths: ['notes/todo.md', 'old.txt', 'src/a.ts'], repo: ROOT } });
  });

  it('moves through the rows with the keys', async () => {
    const list = host.querySelector<HTMLElement>('.git-groups')!;
    list.focus();
    await key(list, 'ArrowDown');
    await key(list, 'ArrowDown');
    expect(host.querySelector('.git-row.cursor')?.textContent).toContain('new.ts');
    await key(list, 'End');
    expect(host.querySelector('.git-row.cursor')?.textContent).toContain('a.ts');
    await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true })));
    expect(host.querySelectorAll('.git-row.selected')).toHaveLength(2);
  });

  it('shows the changes as a tree of folders, collapsed together', async () => {
    await act(async () => button(t('git.viewTree'))!.click());
    expect(useSettings.getState().values['git.changesView']?.value).toBe('tree');
    const changes = section(t('git.group.changes'));
    expect([...changes.querySelectorAll('.git-dir-row')].map((r) => r.textContent)).toEqual(['notes', 'src']);
    expect(changes.querySelectorAll('.git-row:not(.git-dir-row)')).toHaveLength(3);
    // A folder stands for its files.
    await act(async () => button(t('git.stage'), rowOf(t('git.group.changes'), 'src'))!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stage', body: { paths: ['src/a.ts'], repo: ROOT } });
    await act(async () => button(t('git.collapseAll'))!.click());
    expect(section(t('git.group.changes')).querySelectorAll('.git-row:not(.git-dir-row)')).toHaveLength(1);
  });

  it('stages the tracked changes apart from untracked files', async () => {
    await act(async () =>
      useSettings.setState((st) => ({ values: { ...st.values, 'git.untrackedChanges': { value: 'separate', source: 'global' } } })),
    );
    const untracked = section(t('git.group.untracked'));
    expect(untracked.querySelectorAll('.git-row')).toHaveLength(1);
    await act(async () => button(t('git.stageAll'), section(t('git.group.changes')))!.click());
    await flush();
    expect(posts[0]).toEqual({ action: 'stage', body: { all: true, tracked: true, repo: ROOT } });
    await act(async () => button(t('git.stageAll'), untracked)!.click());
    await flush();
    expect(posts[1]).toEqual({ action: 'stage', body: { paths: ['notes/todo.md'], repo: ROOT } });
  });

  // The branch opens a searchable list of branches, remote branches and
  // tags: one checks out, a name typed creates a branch.
  it('checks out branches from the branch picker', async () => {
    const rows = () => [...document.querySelectorAll<HTMLElement>('.picker-row')];
    const open = async () => {
      await act(async () => host.querySelector<HTMLButtonElement>('.git-branch-pick')!.click());
      await flush();
    };
    await open();
    expect([...document.querySelectorAll('.picker-group')].map((g) => g.textContent)).toEqual([
      t('git.pick.branches'),
      t('git.pick.remote', { remote: 'origin' }),
      t('git.pick.tags'),
    ]);
    expect(rows().find((r) => r.textContent?.startsWith('main'))?.textContent).toContain('origin/main ↑1');
    await act(async () =>
      rows()
        .find((r) => r.textContent?.startsWith('topic'))!
        .click(),
    );
    await flush();
    expect(posts[0]).toEqual({ action: 'checkout', body: { name: 'topic', repo: ROOT } });
    // A remote branch without a local one: a new branch that tracks it.
    await open();
    await act(async () =>
      rows()
        .find((r) => r.textContent?.startsWith('origin/feature'))!
        .click(),
    );
    await flush();
    expect(posts[1]).toEqual({ action: 'branchCreate', body: { name: 'feature', at: 'origin/feature', checkout: true, repo: ROOT } });
    // A tag: detached.
    await open();
    await act(async () =>
      rows()
        .find((r) => r.textContent?.startsWith('v1'))!
        .click(),
    );
    await flush();
    expect(posts[2]).toEqual({ action: 'checkout', body: { rev: 'v1', repo: ROOT } });
    // What is typed names a new branch.
    await open();
    const search = document.querySelector<HTMLInputElement>('.picker-search')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'new-thing');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      rows()
        .find((r) => r.textContent === t('git.pick.createNamed', { name: 'new-thing' }))!
        .click(),
    );
    await flush();
    expect(posts[3]).toEqual({ action: 'branchCreate', body: { name: 'new-thing', checkout: true, repo: ROOT } });
  });

  // Several remotes: the one to push to, fetch from or pull from is asked
  // (with its URL); with one, nothing is asked.
  describe('remotes', () => {
    const rows = () => [...document.querySelectorAll<HTMLElement>('.picker-row')];
    const choose = async (text: string) => {
      await flush();
      await act(async () =>
        rows()
          .find((r) => r.textContent?.startsWith(text))!
          .click(),
      );
      await flush();
    };
    const more = async (label: string) => {
      await act(async () => button(t('git.more'))!.click());
      await act(async () => menuItem(label)!.run!());
    };
    beforeEach(async () => {
      remotes = ['origin', 'upstream'];
      await act(async () => button(t('git.refresh'))!.click());
      await flush();
    });

    it('asks which remote publishes a branch without an upstream', async () => {
      upstream = undefined;
      await act(async () => button(t('git.refresh'))!.click());
      await flush();
      await act(async () => button(t('git.publish'))!.click());
      await flush();
      expect(rows().map((r) => r.textContent)).toEqual([
        'originhttps://example.com/origin.git',
        'upstreamhttps://example.com/upstream.git',
      ]);
      await choose('upstream');
      expect(posts[0]).toEqual({ action: 'push', body: { remote: 'upstream', branch: 'main', setUpstream: true, repo: ROOT } });
    });

    it('fetches from and pulls from a remote chosen', async () => {
      await more(t('git.fetchFrom'));
      await choose('upstream');
      expect(posts[0]).toEqual({ action: 'fetch', body: { remote: 'upstream', prune: true, repo: ROOT } });
      await more(t('git.pullFrom'));
      await choose('origin');
      // The remote's branches, by their names there.
      expect(rows().map((r) => r.textContent?.split(/s|older/)[0])).toEqual(['main', 'feature']);
      await choose('feature');
      expect(posts[1]).toEqual({ action: 'pull', body: { remote: 'origin', branch: 'feature', repo: ROOT } });
    });

    it('lists the remotes with their URLs', async () => {
      const list = section(t('git.group.remotes'));
      await act(async () => list.querySelector<HTMLElement>('.section-toggle')!.click());
      expect([...list.querySelectorAll('.git-row')].map((r) => r.textContent)).toEqual([
        'originhttps://example.com/origin.git',
        'upstreamhttps://example.com/upstream.git',
      ]);
      await act(async () => button(t('git.graph.fetchRemote', { remote: 'upstream' }), list)!.click());
      await flush();
      expect(posts[0]).toEqual({ action: 'fetch', body: { remote: 'upstream', prune: true, repo: ROOT } });
    });
  });

  it('asks before a pull when told to', async () => {
    await act(async () =>
      useSettings.setState((st) => ({ values: { ...st.values, 'git.confirmSync': { value: true, source: 'global' } } })),
    );
    await act(async () => button(t('git.pull'))!.click());
    const req = useDialog.getState().current as { kind: string; message: string; resolve(ok: boolean): void };
    expect(req.message).toBe(t('git.confirm.pull', { target: 'origin/main' }));
    await act(async () => req.resolve(true));
    await flush();
    expect(posts[0]).toEqual({ action: 'pull', body: { repo: ROOT } });
    useSettings.setState((st) => ({ values: { ...st.values, 'git.confirmSync': { value: false, source: 'global' } } }));
  });

  it('fetches every remote now and then when told to', async () => {
    await act(async () => root.unmount());
    useSettings.setState((st) => ({ values: { ...st.values, 'git.autoFetch': { value: 1, source: 'global' } } }));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      root = createRoot(host);
      await act(async () => root.render(createElement(GitPanel)));
      await flush();
      expect(posts).toEqual([]);
      await act(async () => vi.advanceTimersByTime(60_000));
      await flush();
      expect(posts).toEqual([{ action: 'fetch', body: { all: true, prune: true, repo: ROOT } }]);
    } finally {
      vi.useRealTimers();
      useSettings.setState((st) => ({ values: { ...st.values, 'git.autoFetch': { value: 0, source: 'global' } } }));
    }
  });

  it('says how long ago a commit was', () => {
    const now = 1_000_000;
    expect(ago(now - 30, now)).toBe('1m');
    expect(ago(now - 3 * 3600, now)).toBe('3h');
    expect(ago(now - 2 * 86400, now)).toBe('2d');
    expect(ago(now - 30 * 86400, now)).toBe('4w');
    expect(ago(now - 800 * 86400, now)).toBe('2y');
  });
});
