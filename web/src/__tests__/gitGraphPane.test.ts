// @vitest-environment jsdom
//
// The Git graph pane (plugins/git/GraphPane.tsx) with the core's routes
// stubbed: rows with badges, a commit's details with its files, compare
// with a Cmd/Ctrl-click, and the commit's context menu.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), createDiffEditor: vi.fn(), loadMonaco: vi.fn() }));

import { loadPref, savePref, useStore } from '../state/store';
import { useSettings } from '../settings';
import type { MachineState } from '../lib/machine';
import { useMenu, isItem } from '../contextMenu';
import { t } from '../i18n';
import { filterKey, GraphPane } from '../plugins/git/GraphPane';
import { useGit } from '../plugins/git/state';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/r';
const commit = (hash: string, date: number, subject: string, ...parents: string[]) => ({
  hash,
  parents,
  author: 'Ann',
  email: 'a@x',
  date,
  subject,
});

describe('GraphPane', () => {
  let host: HTMLDivElement;
  let root: Root;
  const shows: URLSearchParams[] = [];
  const logs: URLSearchParams[] = [];
  const posts: Array<{ action: string; body: unknown }> = [];
  /** Answers log requests instead of the page below, when set. */
  let logImpl: ((q: URLSearchParams) => Promise<Response>) | undefined;
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const rows = () => [...host.querySelectorAll<HTMLElement>('.git-graph-row')];
  const pickerRow = (text: string) => [...document.querySelectorAll<HTMLElement>('.picker-row')].find((r) => r.textContent === text)!;
  const mount = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(GraphPane, { m: 'm', pane: 'view:g', view: { id: 'g', plugin: 'git', kind: 'graph', repo: ROOT }, focused: true }),
      ),
    );
    await flush();
  };

  beforeEach(async () => {
    shows.length = 0;
    logs.length = 0;
    posts.length = 0;
    savePref(filterKey('m', ROOT), []);
    logImpl = undefined;
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      if (init?.method === 'POST') {
        posts.push({ action, body: JSON.parse(String(init.body)) });
        return new Response('{}');
      }
      switch (action) {
        case 'log':
          logs.push(url.searchParams);
          if (logImpl) return logImpl(url.searchParams);
          return new Response(
            JSON.stringify({
              commits: [commit('m1', 30, 'Merge feature', 'b1', 'f1'), commit('f1', 20, 'feature work', 'b1'), commit('b1', 10, 'base')],
              more: false,
              refs: [
                { name: 'refs/heads/main', hash: 'm1' },
                { name: 'refs/heads/feature', hash: 'f1' },
                { name: 'refs/tags/v1', hash: 'b1' },
              ],
              stashes: [],
              head: 'm1',
              branch: 'main',
            }),
          );
        case 'show':
          shows.push(url.searchParams);
          return new Response(
            JSON.stringify({
              commit: {
                ...commit('f1', 20, 'feature work', 'b1'),
                committer: 'Ann',
                committerEmail: 'a@x',
                commitDate: 20,
                message: 'feature work\n\nbody',
              },
              base: 'b1',
              target: 'f1',
              files: [{ path: 'x.go', status: 'M', added: 3, deleted: 1 }],
            }),
          );
        case 'status':
          return new Response(
            JSON.stringify({ branch: 'main', head: 'm1', ahead: 0, behind: 0, files: [{ path: 'w', x: '.', y: 'M', kind: 'changed' }] }),
          );
        case 'repo':
          return new Response(JSON.stringify({ root: ROOT, branch: 'main', head: 'm1', ahead: 0, behind: 0, remotes: [] }));
      }
      return new Response(JSON.stringify({ token: 't' }));
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(GraphPane, { m: 'm', pane: 'view:g', view: { id: 'g', plugin: 'git', kind: 'graph', repo: ROOT }, focused: true }),
      ),
    );
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows the working tree, the commits and their badges', () => {
    const r = rows();
    expect(r.map((x) => x.querySelector('.git-graph-desc')!.textContent)).toEqual([
      t('git.graph.uncommitted', { n: 1 }),
      'mainMerge feature',
      'featurefeature work',
      'v1base',
    ]);
    expect(r[1].querySelector('.git-badge.current')!.textContent).toBe('main');
    // The merge opens a second lane.
    expect(r[1].querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a commit’s details and compares two commits', async () => {
    await act(async () => rows()[2].click());
    await flush();
    expect(shows[0].get('rev')).toBe('f1');
    expect(host.querySelector('.git-detail-message')!.textContent).toBe('feature work\n\nbody');
    expect(host.querySelector('.git-detail-files')!.textContent).toContain('x.go');
    await act(async () => rows()[3].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
    await flush();
    const last = shows[shows.length - 1];
    expect([last.get('rev'), last.get('rev2')]).toEqual(['b1', 'f1']);
  });

  // A page of another filter's list, asked before the filter changed, is
  // dropped: the new filter's rows have none of its commits, and no hash
  // twice.
  it("drops a page of the previous filter's list", async () => {
    let release: (() => void) | undefined;
    const refs = [
      { name: 'refs/heads/main', hash: 'm1' },
      { name: 'refs/heads/feature', hash: 'f1' },
    ];
    logImpl = async (q) => {
      const skip = Number(q.get('skip') ?? 0);
      if (q.get('branch') === 'refs/heads/feature')
        return new Response(
          JSON.stringify({ commits: [commit('f1', 20, 'feature work', 'b1')], more: false, refs, head: 'm1', branch: 'main' }),
        );
      if (skip === 0)
        return new Response(
          JSON.stringify({
            commits: [commit('m1', 30, 'Merge', 'b1', 'f1'), commit('f1', 20, 'feature work', 'b1')],
            more: true,
            refs,
            head: 'm1',
            branch: 'main',
          }),
        );
      const body = JSON.stringify({ commits: [commit('b1', 10, 'base'), commit('x0', 5, 'old main')], more: false });
      await new Promise<void>((r) => (release = r));
      return new Response(body);
    };
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(GraphPane, { m: 'm', pane: 'view:g', view: { id: 'g', plugin: 'git', kind: 'graph', repo: ROOT }, focused: true }),
      ),
    );
    await flush();
    expect(release).toBeDefined();
    await act(async () => host.querySelector<HTMLButtonElement>('.git-graph-filter')!.click());
    await act(async () => pickerRow('feature').click());
    await flush();
    await act(async () => release!());
    await flush();
    expect(rows().map((r) => r.querySelector('.git-graph-hash')!.textContent)).toEqual(['f1']);
  });

  it('cherry-picks and creates branches from the commit’s menu', async () => {
    await act(async () => rows()[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 })));
    const items = (useMenu.getState().menu?.entries ?? []).filter(isItem);
    expect(items.map((i) => i.label)).toContain(t('git.branch.createHere'));
    await act(async () => items.find((i) => i.label === t('git.graph.cherryPick'))!.run!());
    await flush();
    expect(posts[0]).toEqual({ action: 'cherryPick', body: { rev: 'f1', repo: ROOT } });
  });

  // The filter: several branches and tags (their full names) from a
  // searchable list, none for every branch, kept per repository.
  it('shows the history of the branches chosen, remembered', async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('.git-graph-filter')!.click());
    expect([...document.querySelectorAll('.picker-group')].map((g) => g.textContent)).toEqual([t('git.pick.branches'), t('git.pick.tags')]);
    await act(async () => pickerRow('feature').click());
    await act(async () => pickerRow('v1').click());
    await flush();
    expect(logs[logs.length - 1].getAll('branch')).toEqual(['refs/heads/feature', 'refs/tags/v1']);
    expect(loadPref(filterKey('m', ROOT), [])).toEqual(['refs/heads/feature', 'refs/tags/v1']);
    // The working tree and the stashes are not shown with a filter.
    expect(rows()[0].querySelector('.git-graph-desc')!.textContent).toBe('mainMerge feature');
    await mount();
    expect(logs[logs.length - 1].getAll('branch')).toEqual(['refs/heads/feature', 'refs/tags/v1']);
    expect(host.querySelector('.git-graph-filter')!.textContent).toBe(t('picker.selected', { count: 2 }));
  });

  it('filters from a branch’s badge', async () => {
    const badgeMenu = async (name: string) => {
      const badge = [...host.querySelectorAll<HTMLElement>('.git-badge')].find((b) => b.textContent === name)!;
      await act(async () => badge.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 })));
      return (useMenu.getState().menu?.entries ?? []).filter(isItem);
    };
    let items = await badgeMenu('feature');
    // With every branch shown, adding one is not offered (it would show it only).
    expect(items.find((i) => i.label === t('git.graph.addToFilter'))?.disabled).toBe(true);
    await act(async () => items.find((i) => i.label === t('git.graph.showOnly'))!.run!());
    await flush();
    expect(logs[logs.length - 1].getAll('branch')).toEqual(['refs/heads/feature']);
    items = await badgeMenu('main');
    await act(async () => items.find((i) => i.label === t('git.graph.addToFilter'))!.run!());
    await flush();
    expect(logs[logs.length - 1].getAll('branch')).toEqual(['refs/heads/feature', 'refs/heads/main']);
    items = await badgeMenu('feature');
    await act(async () => items.find((i) => i.label === t('git.graph.removeFromFilter'))!.run!());
    await flush();
    expect(logs[logs.length - 1].getAll('branch')).toEqual(['refs/heads/main']);
  });

  it('reads pages of the size the settings give', async () => {
    useSettings.setState((st) => ({ values: { ...st.values, 'git.graphPageSize': { value: 100, source: 'global' } } }));
    try {
      await mount();
      expect(logs[logs.length - 1].get('limit')).toBe('100');
    } finally {
      useSettings.setState((st) => ({ values: { ...st.values, 'git.graphPageSize': { value: 300, source: 'global' } } }));
    }
  });
});
