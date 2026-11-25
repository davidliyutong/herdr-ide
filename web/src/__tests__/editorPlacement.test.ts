// @vitest-environment jsdom
//
// Where editors and diffs open: in tabs of the workspace, as terminals,
// VS Code and the Git graph do, so opening files never squeezes the panes
// of a tab; a preview reuses its tab; Open to the Side splits beside the
// focused pane; the graph's diffs open beside the graph.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { openEditor, openToSide } from '../plugins/files/ops';
import { openDiff } from '../plugins/git/ops';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hub: FakeHub;
const layout = () => hub.model.layout('a')!;
const ws = () => layout().workspaces[0];
const editorTabs = () =>
  ws().tabs.map((tab) =>
    L.leavesOf(tab.root).map((l) => (L.isTerminalLeaf(l) ? l.terminal : L.isPluginLeaf(l) ? `${l.view.kind}:${String(l.view.path)}` : '?')),
  );

beforeEach(async () => {
  hub = new FakeHub();
  hub.machine('a', [FakeHub.term('s1', { cwd: '/home/u/w1' })], {
    version: 2,
    workspaces: [{ id: 'w1', name: '', cwd: '/home/u/w1', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
    selected: 0,
  });
  hub.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  hub.model.subscribe('a');
  await settle();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening files', () => {
  it('opens editors in tabs of their own, never splitting the tab shown', async () => {
    await openEditor('a', '/home/u/w1/a.go', { preview: true });
    expect(editorTabs()).toEqual([['s1'], ['editor:/home/u/w1/a.go']]);
    expect(ws().selected).toBe(1);
    // The next preview takes the preview's tab.
    hub.model.mutate('a', (l) => L.selectTab(l, 'w1', 0));
    await openEditor('a', '/home/u/w1/b.go', { preview: true });
    expect(editorTabs()).toEqual([['s1'], ['editor:/home/u/w1/b.go']]);
    expect(ws().selected).toBe(1);
    // Kept (a double click): the same tab, no longer a preview.
    await openEditor('a', '/home/u/w1/b.go');
    expect(L.pluginViews(ws(), 'files', 'editor')[0].view.preview).toBe(false);
    // Another file to keep: a tab of its own; the next preview too.
    await openEditor('a', '/home/u/w1/c.go');
    await openEditor('a', '/home/u/w1/d.go', { preview: true });
    expect(editorTabs()).toEqual([['s1'], ['editor:/home/u/w1/b.go'], ['editor:/home/u/w1/c.go'], ['editor:/home/u/w1/d.go']]);
    // A file open already: its tab is shown, nothing opens.
    await openEditor('a', '/home/u/w1/b.go');
    expect(editorTabs()).toHaveLength(4);
    expect(ws().selected).toBe(1);
  });

  it('opens to the side split beside the focused pane', async () => {
    await openToSide('a', '/home/u/w1/a.go');
    expect(editorTabs()).toEqual([['s1', 'editor:/home/u/w1/a.go']]);
    expect(L.pluginViews(ws(), 'files', 'editor')[0].view.preview).toBe(false);
    // Its tab shows it already: that editor is focused.
    hub.model.mutate('a', (l) => L.focusPane(l, 's1'));
    await openToSide('a', '/home/u/w1/a.go');
    expect(editorTabs()).toEqual([['s1', 'editor:/home/u/w1/a.go']]);
  });
});

describe('opening diffs', () => {
  it("opens Source Control's diffs in a tab, reused; the graph's beside the graph", async () => {
    await openDiff('a', { repo: '/home/u/w1', path: 'a.go', mode: 'worktree' });
    await openDiff('a', { repo: '/home/u/w1', path: 'b.go', mode: 'worktree' });
    expect(editorTabs()).toEqual([['s1'], ['diff:b.go']]);
    // A graph in a tab of its own; its files' diffs split beside it, and a
    // diff in another tab is not taken away to it.
    const graph = { id: 'g1', plugin: 'git', kind: 'graph', repo: '/home/u/w1' };
    hub.model.mutate('a', (l) => L.openPane(l, { view: graph }, 'w1'));
    await openDiff('a', { repo: '/home/u/w1', path: 'c.go', mode: 'commit', rev: 'abc' }, L.viewKey('g1'), { beside: true });
    await openDiff('a', { repo: '/home/u/w1', path: 'a.go', mode: 'worktree' }, L.viewKey('g1'), { beside: true });
    expect(editorTabs()).toEqual([['s1'], ['diff:b.go'], ['graph:undefined', 'diff:a.go']]);
  });
});
