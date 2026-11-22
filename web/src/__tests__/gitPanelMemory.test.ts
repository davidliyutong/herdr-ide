// @vitest-environment jsdom
//
// The Git panel (plugins/git/GitPanel.tsx) as the directory it follows
// moves and as it goes away and comes back, with the core's routes stubbed
// and the followed directory (files/FilesPanel followedDir) scripted: a
// terminal's cd inside the repository changes nothing in the panel (also
// while the directory's repository is asked or could not be asked); a
// nested repository and a directory outside repositories are shown as
// such; what the view showed (folders collapsed, the selection, the
// commit box, the Amend box, sections, the commit opened in the history,
// scroll positions) is as it was when the panel comes back. The panel
// belongs to the machine and workspace shown: another machine is never
// asked about this one's directories, another workspace never shows this
// one's repository.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let followed: string | undefined;
/** By machine and workspace ("m/ws"), when set: the focused terminal's
 * directory (none while an editor has the focus) and the directory of the
 * terminal focused last. */
let places: Record<string, { focused?: string; recent?: string }> | undefined;
const here = () => {
  const m = useStore.getState().machineId;
  const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
  return places?.[`${m}/${layout?.workspaces[layout.selected]?.id}`];
};
vi.mock('../plugins/files/FilesPanel', () => ({
  followedDir: () => (places ? here()?.focused : followed),
  recentDirectory: () => (places ? here()?.recent : undefined),
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), createDiffEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { Layout } from '../term/layout';
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { useSettings } from '../settings';
import { GitPanel } from '../plugins/git/GitPanel';
import { forgetPanels } from '../plugins/git/memory';
import { forgetRepos, useGit } from '../plugins/git/state';
import type { StatusFile } from '../plugins/git/api';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/home/u/repo';
const INNER = `${ROOT}/vendor/lib`;
const files: StatusFile[] = [
  { path: 'src/a.ts', x: '.', y: 'M', kind: 'changed' },
  { path: 'src/b.ts', x: '.', y: 'M', kind: 'changed' },
  { path: 'top.txt', x: '.', y: 'M', kind: 'changed' },
];

describe('the Git panel', () => {
  let host: HTMLDivElement;
  let root: Root;
  /** Answers of repo held until released, and a failure to answer with. */
  let hold: Promise<void> | undefined;
  let repoError: string | undefined;
  const asked: string[] = [];
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const mount = async () => {
    root = createRoot(host);
    await act(async () => root.render(createElement(GitPanel)));
    await flush();
  };
  /** The followed directory moves (a terminal's cd). */
  const cd = async (dir: string) => {
    followed = dir;
    await act(async () => useTerms.setState({}));
  };
  const button = (label: string, within: ParentNode = host) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === label || b.textContent?.trim() === label);
  const section = (title: string) => host.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
  const row = (text: string) => [...host.querySelectorAll<HTMLElement>('.git-row')].find((r) => r.textContent?.includes(text));
  const box = () => host.querySelector<HTMLTextAreaElement>('.git-message')!;
  const amend = () => host.querySelector<HTMLInputElement>('.git-amend input')!;
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });

  beforeEach(async () => {
    followed = ROOT;
    hold = repoError = undefined;
    asked.length = 0;
    forgetRepos();
    forgetPanels();
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      asked.push(action);
      if (init?.method === 'POST') return new Response('{}');
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      switch (action) {
        case 'repo': {
          await hold;
          if (repoError) return json({ error: repoError, message: repoError }, 502);
          const p = url.searchParams.get('path')!;
          const base = { gitDir: '', commonDir: '', branch: 'main', head: 'h1', ahead: 0, behind: 0, remotes: [] };
          if (p === INNER || p.startsWith(INNER + '/')) return json({ ...base, root: INNER, parents: [ROOT] });
          if (p === ROOT || p.startsWith(ROOT + '/')) return json({ ...base, root: ROOT });
          return json({ error: 'not_a_repo', message: 'no' }, 404);
        }
        case 'status':
          return json({ branch: 'main', head: 'h1', ahead: 0, behind: 0, files: url.searchParams.get('repo') === ROOT ? files : [] });
        case 'log':
          return json({
            commits: [{ hash: 'h1', parents: [], author: 'A', email: 'a@x', date: 1, subject: 'first commit' }],
            more: false,
            refs: [],
          });
        case 'show':
          return json({ base: 'h0', target: 'h1', files: [{ path: 'src/a.ts', status: 'M', added: 1, deleted: 0 }] });
        case 'stashes':
          return json([{ index: 0, hash: 'a'.repeat(40), base: 'h1', date: 1, message: 'WIP on main' }]);
        case 'watch':
          return json({ token: 't' });
      }
      return json({});
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('m');
    host = document.createElement('div');
    document.body.append(host);
    await mount();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    useSettings.setState((st) => {
      const values = { ...st.values };
      delete values['git.changesView'];
      return { values };
    });
  });

  // A terminal's cd inside the repository: the same view, its state
  // untouched, nothing loading, also while the new directory's repository
  // is asked or could not be asked.
  it('stays as it is when the directory moves inside the repository', async () => {
    const view = host.querySelector('.git-toolbar');
    expect(view?.textContent).toContain('repo');
    await type('half a message');
    await act(async () => amend().click());
    await act(async () => row('top.txt')!.click());
    const same = () => {
      expect(host.querySelector('.git-toolbar')).toBe(view);
      expect(host.textContent).not.toContain(t('git.loading'));
      expect(host.textContent).not.toContain(t('git.noRepo'));
      expect(box().value).toBe('half a message');
      expect(amend().checked).toBe(true);
      expect(row('top.txt')!.classList.contains('selected')).toBe(true);
      expect(host.querySelector('.git-repo-pick')).toBeNull();
    };
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    await cd(`${ROOT}/src`);
    await flush();
    same();
    hold = undefined;
    await act(async () => release());
    await flush();
    same();
    await cd(ROOT + '/src/deep/er');
    await flush();
    same();
    // A failure that says nothing about the directory: as it was.
    repoError = 'offline';
    await cd(`${ROOT}/docs`);
    await flush();
    same();
    repoError = undefined;
    await cd(ROOT);
    await flush();
    same();
  });

  // As before: a nested repository is shown, with a picker of the
  // repositories it is in; outside repositories the panel says so.
  it('shows a nested repository and a directory outside repositories', async () => {
    await cd(`${INNER}/src`);
    await flush();
    expect(host.querySelector('.git-title')!.textContent).toBe('lib');
    expect(host.querySelector('.git-repo-pick')).not.toBeNull();
    await cd('/elsewhere');
    await flush();
    expect(host.textContent).toContain(t('git.noRepo'));
    expect(host.textContent).toContain('/elsewhere');
    // Back in the repository, its view as it was.
    await cd(`${ROOT}/src`);
    await flush();
    expect(host.querySelector('.git-title')!.textContent).toBe('repo');
  });

  it('shows the view as it was when the panel comes back', async () => {
    await act(async () =>
      useSettings.setState((st) => ({ values: { ...st.values, 'git.changesView': { value: 'tree', source: 'global' } } })),
    );
    // A folder collapsed (and selected), a message with its box's height,
    // Amend, the stashes opened, a commit of the history opened, the lists
    // scrolled.
    await act(async () => row('src')!.click());
    expect(row('a.ts')).toBeUndefined();
    await type('wip');
    box().style.height = '120px';
    await act(async () => amend().click());
    await act(async () => section(t('git.group.stashes')).querySelector<HTMLElement>('.section-toggle')!.click());
    const history = section(t('git.group.recent'));
    await act(async () => history.querySelector<HTMLElement>('.git-history-row')!.click());
    await flush();
    expect(history.querySelector('.git-history-file')?.textContent).toContain('a.ts');
    const groups = host.querySelector<HTMLElement>('.git-groups')!;
    groups.scrollTop = 40;
    await act(async () => void groups.dispatchEvent(new Event('scroll')));
    const list = host.querySelector<HTMLElement>('.git-history-list')!;
    list.scrollTop = 20;
    await act(async () => void list.dispatchEvent(new Event('scroll')));
    const shows = asked.filter((a) => a === 'show').length;

    // Another panel shown, then this one again.
    await act(async () => root.unmount());
    await mount();
    expect(row('src')!.classList.contains('selected')).toBe(true);
    expect(row('a.ts')).toBeUndefined();
    expect(row('top.txt')).toBeDefined();
    expect(box().value).toBe('wip');
    expect(box().style.height).toBe('120px');
    expect(amend().checked).toBe(true);
    expect(section(t('git.group.stashes')).querySelector('.git-row')?.textContent).toContain('WIP on main');
    expect(section(t('git.group.recent')).querySelector('.git-history-file')?.textContent).toContain('a.ts');
    expect(asked.filter((a) => a === 'show').length).toBe(shows);
    expect(host.querySelector<HTMLElement>('.git-groups')!.scrollTop).toBe(40);
    expect(host.querySelector<HTMLElement>('.git-history-list')!.scrollTop).toBe(20);

    // A commit clears the message and Amend, also for the next time.
    await act(async () => button(t('git.commit.amendButton'))!.click());
    await flush();
    expect([box().value, amend().checked]).toEqual(['', false]);
    await act(async () => root.unmount());
    await mount();
    expect([box().value, amend().checked]).toEqual(['', false]);
    // The stashes closed again (kept per browser).
    await act(async () => section(t('git.group.stashes')).querySelector<HTMLElement>('.section-toggle')!.click());
  });
});

describe('the Git panel across machines and workspaces', () => {
  let host: HTMLDivElement;
  let root: Root;
  let hold: Promise<void> | undefined;
  /** The reads asked: machine, action, directory or repository. */
  const asked: Array<{ m: string; action: string; path: string }> = [];
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const title = () => host.querySelector('.git-title')?.textContent;
  const layout = (...ids: string[]): Layout => ({
    version: 2,
    workspaces: ids.map((id) => ({ id, name: '', cwd: '', tabs: [], selected: 0 })),
    selected: 0,
  });
  const show = async (m: string, ws = 0) => {
    await act(async () => {
      useStore.getState().selectMachine(m);
      useTerms.setState((s) => ({
        machines: { ...s.machines, [m]: { ...s.machines[m], layout: { ...s.machines[m].layout!, selected: ws } } },
      }));
    });
    await flush();
  };

  beforeEach(async () => {
    hold = undefined;
    asked.length = 0;
    forgetRepos();
    forgetPanels();
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const parts = url.pathname.split('/');
      const action = parts.pop()!;
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (init?.method === 'POST') return json({});
      const path = url.searchParams.get('path') ?? url.searchParams.get('repo') ?? '';
      asked.push({ m: decodeURIComponent(parts[3]), action, path });
      switch (action) {
        case 'repo': {
          await hold;
          const top = ['/a/repo', '/a/other', '/b/proj'].find((r) => path === r || path.startsWith(r + '/'));
          if (!top) return json({ error: 'not_a_repo', message: 'no' }, 404);
          return json({ root: top, gitDir: '', commonDir: '', branch: 'main', head: 'h1', ahead: 0, behind: 0, remotes: [] });
        }
        case 'status':
          return json({ branch: 'main', head: 'h1', ahead: 0, behind: 0, files: [] });
        case 'log':
          return json({ commits: [], more: false, refs: [] });
        case 'stashes':
          return json([]);
        case 'watch':
          return json({ token: 't' });
      }
      return json({});
    });
    places = {
      'A/a1': { focused: '/a/repo/src', recent: '/a/repo/src' },
      'A/a2': { focused: '/a/other', recent: '/a/other' },
      // An editor has the focus on B; its terminal focused last is in /b/proj.
      'B/b1': { recent: '/b/proj/lib' },
    };
    useTerms.setState({ machines: { A: { terminals: {}, layout: layout('a1', 'a2') }, B: { terminals: {}, layout: layout('b1') } } });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([
      { id: 'A', label: 'A', kind: 'ssh', status: 'ready', info: { home: '/a' } },
      { id: 'B', label: 'B', kind: 'ssh', status: 'ready', info: { home: '/b' } },
    ] as unknown as MachineState[]);
    s.selectMachine('A');
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
    places = undefined;
    useTerms.setState({ machines: {} });
  });

  // An editor focused on each machine while going back and forth: each
  // machine is asked about its own directories only.
  it('asks each machine about its own directories only', async () => {
    expect(title()).toBe('repo');
    // An editor takes the focus on A: the panel stays.
    places!['A/a1'] = { recent: '/a/repo/src' };
    await act(async () => useTerms.setState({}));
    await flush();
    expect(title()).toBe('repo');
    for (let i = 0; i < 2; i++) {
      await show('B');
      expect(title()).toBe('proj');
      await show('A');
      expect(title()).toBe('repo');
    }
    const of = (m: string) => asked.filter((a) => a.m === m).map((a) => a.path);
    expect(of('B').length).toBeGreaterThan(0);
    expect(of('A').filter((p) => !p.startsWith('/a/'))).toEqual([]);
    expect(of('B').filter((p) => !p.startsWith('/b/'))).toEqual([]);
  });

  // Another workspace of the machine: never the first one's repository,
  // also while its own is asked; back in the first, its own at once.
  it('shows each workspace its own repository', async () => {
    expect(title()).toBe('repo');
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    await show('A', 1);
    expect(title()).not.toBe('repo');
    expect(host.textContent).toContain(t('git.loading'));
    hold = undefined;
    await act(async () => release());
    await flush();
    expect(title()).toBe('other');
    hold = new Promise<void>((r) => (release = r));
    // a1's terminal went elsewhere in its repository meanwhile.
    places!['A/a1'] = { focused: '/a/repo/docs', recent: '/a/repo/docs' };
    await show('A', 0);
    expect(title()).toBe('repo');
    hold = undefined;
    await act(async () => release());
    await flush();
    expect(title()).toBe('repo');
    expect(asked.filter((a) => a.m !== 'A')).toEqual([]);
  });
});

describe('focused editor and diff pane tracking for nested repositories', () => {
  let host: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };

  beforeEach(async () => {
    places = undefined;
    followed = undefined;
    forgetRepos();
    forgetPanels();
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      switch (action) {
        case 'repo': {
          const p = url.searchParams.get('path')!;
          const base = { gitDir: '', commonDir: '', branch: 'main', head: 'h1', ahead: 0, behind: 0, remotes: [] };
          if (p === INNER || p.startsWith(INNER + '/')) return json({ ...base, root: INNER, parents: [ROOT] });
          if (p === ROOT || p.startsWith(ROOT + '/')) return json({ ...base, root: ROOT, nested: [INNER] });
          return json({ error: 'not_a_repo', message: 'no' }, 404);
        }
        case 'status':
          return json({ branch: 'main', head: 'h1', ahead: 0, behind: 0, files: [] });
        case 'log':
          return json({ commits: [], more: false, refs: [] });
        case 'stashes':
          return json([]);
        case 'watch':
          return json({ token: 't' });
      }
      return json({});
    });
    useTerms.setState({
      machines: {
        E: {
          terminals: {},
          layout: {
            version: 2,
            workspaces: [
              {
                id: 'ew1',
                name: '',
                cwd: ROOT,
                tabs: [
                  {
                    root: {
                      split: 'horizontal',
                      ratio: 0.5,
                      children: [
                        { view: { id: 'ed1', plugin: 'files', kind: 'editor', path: `${INNER}/src/file.ts` } },
                        { view: { id: 'df1', plugin: 'git', kind: 'diff', repo: ROOT, path: 'top.txt', mode: 'worktree' } },
                      ],
                    },
                    focused: 'view:ed1',
                  },
                ],
                selected: 0,
              },
            ],
            selected: 0,
          },
        },
      },
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'E', label: 'E', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('E');
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
    useTerms.setState({ machines: {} });
  });

  it('tracks the innermost repository of a focused editor or diff pane', async () => {
    // Editor in INNER is focused -> GitPanel shows INNER and offers ROOT in picker.
    expect(host.querySelector('.git-title')!.textContent).toBe('lib');
    expect(host.querySelector('.git-repo-pick')).not.toBeNull();
    // Switch focus to the diff pane targeting ROOT -> GitPanel switches to ROOT.
    await act(async () =>
      useTerms.setState((s) => ({
        machines: {
          ...s.machines,
          E: {
            ...s.machines.E,
            layout: {
              ...s.machines.E.layout!,
              workspaces: [
                {
                  ...s.machines.E.layout!.workspaces[0],
                  tabs: [{ ...s.machines.E.layout!.workspaces[0].tabs[0], focused: 'view:df1' }],
                },
              ],
            },
          },
        },
      })),
    );
    await flush();
    expect(host.querySelector('.git-title')!.textContent).toBe('repo');
  });
});
