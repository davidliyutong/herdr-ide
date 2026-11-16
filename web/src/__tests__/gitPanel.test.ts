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
import { GitPanel, groupFiles, treeRows } from '../plugins/git/GitPanel';
import { decorate, markOf } from '../plugins/git/decorations';
import { forgetRepos, useGit } from '../plugins/git/state';
import { ago } from '../plugins/git/History';
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
    const rows = treeRows(g.changes).map((r) => ('dir' in r ? `${r.depth}:${r.dir}/` : `${r.depth}:${r.f.file.path}`));
    expect(rows).toEqual(['0:a/', '1:a/b/c/', '2:a/b/c/x.ts', '2:a/b/c/y.ts', '1:a/z.ts', '0:top.ts']);
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
});

describe('GitPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
  let status: StatusFile[];
  let parents: string[] | undefined;
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
    logImpl = undefined;
    forgetRepos();
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
              upstream: 'origin/main',
              remotes: ['origin'],
              parents,
            }),
          );
        case 'status':
          return new Response(JSON.stringify({ branch: 'main', head: 'h1', upstream: 'origin/main', ahead: 1, behind: 0, files: status }));
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
  });

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
    await act(async () => stashes.querySelector<HTMLElement>('.git-group-head')!.click());
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
    const pick = host.querySelector<HTMLSelectElement>('.git-repo-pick')!;
    await act(async () => {
      pick.value = '/home/u';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(host.querySelector('.git-title')!.textContent).toBe('u');
    expect(amend().checked).toBe(false);
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
