// @vitest-environment jsdom
//
// Discarding files (plugins/git/ops.ts discard): the panes that show them
// (diffs of the working tree, the explorer's editors) close once their
// changes are gone; those with unsaved text are asked about first, as
// closing them would.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), createDiffEditor: vi.fn(), loadMonaco: vi.fn() }));

import { useStore } from '../state/store';
import { setUnsaved } from '../state/panes';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { useDialog } from '../dialog';
import { discard, panesOfFiles } from '../plugins/git/ops';
import { useGit } from '../plugins/git/state';
import type { StatusFile } from '../plugins/git/api';
import { FakeCore, settle } from './fakeTerms';

const ROOT = '/home/u/repo';
const diff = (id: string, path: string, mode = 'worktree') => ({ view: { id, plugin: 'git', kind: 'diff', repo: ROOT, path, mode } });
const editor = (id: string, path: string) => ({ view: { id, plugin: 'files', kind: 'editor', path } });
const pair = (a: unknown, b: unknown) => ({ split: 'horizontal', ratio: 0.5, children: [a, b] });

/** A workspace with three tabs: a.ts's diff and editor; its staged diff
 * and an untracked file's editor; another file's editor. */
const LAYOUT = {
  version: 2,
  workspaces: [
    {
      id: 'w',
      name: '',
      cwd: ROOT,
      tabs: [
        { root: pair(diff('d1', 'src/a.ts'), editor('e1', `${ROOT}/src/a.ts`)), focused: 'view:d1' },
        { root: pair(diff('d2', 'src/a.ts', 'staged'), editor('e2', `${ROOT}/notes/todo.md`)), focused: 'view:d2' },
        { root: editor('e3', `${ROOT}/other.txt`), focused: 'view:e3' },
      ],
      selected: 0,
    },
  ],
  selected: 0,
};

const files: StatusFile[] = [
  { path: 'src/a.ts', x: '.', y: 'M', kind: 'changed' },
  { path: 'notes/', x: '?', y: '?', kind: 'untracked' },
];

describe('discarding files', () => {
  let core: FakeCore;
  const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
  const panes = () => core.model.layout('m')!.workspaces.flatMap((ws) => ws.tabs.flatMap((tb) => L.tabPanes(tb)));
  const answer = async (ok: boolean, alt = false) => {
    await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
    const req = useDialog.getState().current as { resolve(ok: boolean, checked?: boolean, alt?: boolean): void };
    useDialog.setState({ current: undefined });
    req.resolve(ok, false, alt);
    await settle();
  };

  beforeEach(async () => {
    posts.length = 0;
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      if (init?.method === 'POST') posts.push({ action, body: JSON.parse(String(init.body)) });
      if (action === 'status') return new Response(JSON.stringify({ ahead: 0, behind: 0, files: [] }));
      if (action === 'watch') return new Response(JSON.stringify({ token: 't' }));
      return new Response('{}');
    });
    core = new FakeCore();
    core.machine('m', [], JSON.parse(JSON.stringify(LAYOUT)));
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
    await settle();
  });
  afterEach(() => {
    setUnsaved('m', 'view:e1', undefined);
    vi.unstubAllGlobals();
  });

  it('finds the working tree diffs and editors of the files', () => {
    const layout = LAYOUT as unknown as L.Layout;
    expect(panesOfFiles(layout, ROOT, ['src/a.ts'])).toEqual(['view:d1', 'view:e1']);
    expect(panesOfFiles(layout, ROOT, ['notes/'])).toEqual(['view:e2']);
    expect(panesOfFiles(layout, '/elsewhere', ['src/a.ts'])).toEqual([]);
  });

  it('closes their panes once discarded', async () => {
    const done = discard('m', ROOT, files);
    await answer(true);
    expect(await done).toBe(true);
    expect(posts).toEqual([{ action: 'discard', body: { paths: ['src/a.ts'], untracked: ['notes/'], repo: ROOT } }]);
    expect(panes()).toEqual(['view:d2', 'view:e3']);
  });

  it('asks about unsaved text first, as closing would', async () => {
    setUnsaved('m', 'view:e1', { name: 'a.ts', save: async () => true });
    // Cancel: nothing discarded, nothing closed.
    let done = discard('m', ROOT, files.slice(0, 1));
    await answer(true);
    await answer(false);
    expect(await done).toBe(false);
    expect(posts).toEqual([]);
    expect(panes()).toEqual(['view:d1', 'view:e1', 'view:d2', 'view:e2', 'view:e3']);
    // Don't Save: discarded and closed.
    done = discard('m', ROOT, files.slice(0, 1));
    await answer(true);
    await answer(false, true);
    expect(await done).toBe(true);
    expect(posts.map((p) => p.action)).toEqual(['discard']);
    expect(panes()).toEqual(['view:d2', 'view:e2', 'view:e3']);
  });

  it('closes nothing when the discard is not confirmed', async () => {
    const done = discard('m', ROOT, files);
    await answer(false);
    expect(await done).toBe(false);
    expect(posts).toEqual([]);
    expect(panes()).toHaveLength(5);
  });
});
