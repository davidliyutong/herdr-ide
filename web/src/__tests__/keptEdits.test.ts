// @vitest-environment jsdom
//
// Unsaved text outlives its pane's component (unsaved.ts keepEdit): a pane
// unmounts while it stays in the layout when another tab, workspace or
// machine is shown or another pane is zoomed. Its text, dirty state and the
// version it was edited from come back with the pane; closing still asks,
// and Save saves it without the component; it goes once the layout no
// longer has the pane.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));

class FakeModel {
  version = 1;
  disposed = false;
  private listeners: Array<() => void> = [];
  constructor(public value = '') {}
  getValue() {
    return this.value;
  }
  setValue(v: string) {
    this.value = v;
    this.version++;
    this.listeners.forEach((l) => l());
  }
  getAlternativeVersionId() {
    return this.version;
  }
  onDidChangeContent(l: () => void) {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  }
  dispose() {
    this.disposed = true;
  }
}

const editor = {
  model: undefined as FakeModel | undefined,
  setModel(m: FakeModel) {
    this.model = m;
  },
  getModel() {
    return this.model;
  },
  getValue() {
    return this.model!.getValue();
  },
  onKeyDown: () => ({ dispose() {} }),
  updateOptions() {},
  focus() {},
  dispose() {},
  onDidChangeModelContent() {
    return { dispose() {} };
  },
  createDecorationsCollection() {
    return { clear() {} };
  },
};
const side = () => ({
  onKeyDown: () => ({ dispose() {} }),
  onDidFocusEditorText() {},
  getSelections: () => [],
  updateOptions() {},
  focus() {},
});
const diffEditor = {
  model: undefined as { original: FakeModel; modified: FakeModel } | undefined,
  modifiedSide: side(),
  originalSide: side(),
  setModel(m: { original: FakeModel; modified: FakeModel }) {
    this.model = m;
  },
  getModel() {
    return this.model;
  },
  getModifiedEditor() {
    return this.modifiedSide;
  },
  getOriginalEditor() {
    return this.originalSide;
  },
  onDidUpdateDiff() {},
  getLineChanges: () => [],
  updateOptions() {},
  dispose() {},
};
const monaco = {
  Uri: { from: (o: unknown) => o },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  Range: class {},
  editor: { getModel: () => null, createModel: (v: string) => new FakeModel(v), OverviewRulerLane: { Left: 1 } },
};
vi.mock('../plugins/monaco', () => ({
  setLanguage: vi.fn(),
  createEditor: vi.fn(async () => ({ monaco, editor })),
  createDiffEditor: vi.fn(async () => ({ monaco, editor: diffEditor })),
}));

import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import type { Layout } from '../term/layout';
import { anyUnsaved, unsavedPanes } from '../state/panes';
import { confirmUnsaved, dropEdit, dropGoneEdits, keptEdit } from '../unsaved';
import { useDialog } from '../dialog';
import { EditorPane } from '../plugins/files/EditorPane';
import { DiffPane } from '../plugins/git/DiffPane';
import { dirtyDiffs } from '../plugins/git/ops';
import { useGit } from '../plugins/git/state';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The file on the machine, and what was written. */
let file: { text: string; size: number; mtime: number };
const writes: Array<{ q: URLSearchParams; body: string }> = [];

/** A layout of one tab with the panes of these views. */
function layoutWith(...views: string[]): Layout {
  const leaf = (id: string) => ({ view: { id, plugin: 'files', kind: 'editor' } });
  const root = views.length === 2 ? { split: 'horizontal', ratio: 0.5, children: views.map(leaf) } : leaf(views[0] ?? 'other');
  return {
    workspaces: [{ id: 'w', tabs: [{ root, focused: `view:${views[0] ?? 'other'}` }], selected: 0 }],
    selected: 0,
  } as unknown as Layout;
}

describe('kept edits', () => {
  let host: HTMLDivElement;
  let root: Root;
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const mount = async (el: ReturnType<typeof createElement>) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(el));
    await flush();
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const editorPane = () =>
    createElement(EditorPane, {
      m: 'm',
      pane: 'view:v1',
      view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/notes.txt', preview: false },
      focused: true,
    });

  beforeEach(() => {
    file = { text: 'hello', size: 5, mtime: 7000 };
    writes.length = 0;
    editor.model = undefined;
    diffEditor.model = undefined;
    useGit.setState({ repos: {} });
    useTerms.setState({ machines: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      if (url.pathname === '/api/m/m/file') {
        const headers = { ETag: `W/"${file.size.toString(16)}-${file.mtime.toString(16)}"`, 'Content-Length': String(file.size) };
        return new Response(init?.method === 'HEAD' ? null : file.text, { status: 200, headers });
      }
      if (url.pathname === '/api/m/m/p/files/write') {
        const body = new TextDecoder().decode(init!.body as Uint8Array);
        writes.push({ q: url.searchParams, body });
        file = { text: body, size: body.length, mtime: file.mtime + 1000 };
        return new Response(
          JSON.stringify({ entry: { path: url.searchParams.get('path'), exists: true, size: file.size, mtime: file.mtime } }),
        );
      }
      if (url.pathname.endsWith('/blob')) {
        const source = url.searchParams.get('source');
        const text = source === 'worktree' ? 'a\nB\n' : 'a\nb\n';
        return new Response(JSON.stringify({ exists: true, text, size: text.length, mtime: 5000 }));
      }
      return new Response('{}');
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  });
  afterEach(() => {
    dropEdit('m', 'view:v1');
    dropEdit('m', 'view:d1');
    vi.unstubAllGlobals();
  });

  it("keeps an editor's unsaved text while its pane is away, and closing still asks", async () => {
    await mount(editorPane());
    const model = editor.model!;
    await act(async () => model.setValue('hello world'));
    expect(host.querySelector('.files-dirty')).not.toBeNull();
    // Another pane zoomed, another tab shown: the component goes.
    await unmount();
    expect(model.disposed).toBe(false);
    expect(unsavedPanes('m', ['view:v1']).map((u) => u.name)).toEqual(['notes.txt']);
    expect(anyUnsaved()).toBe(true);
    // Closing its tab asks; Cancel keeps it.
    const closing = confirmUnsaved('m', ['view:v1']);
    await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
    const req = useDialog.getState().current!;
    if (req.kind !== 'confirm') throw new Error(req.kind);
    expect(req.message).toContain('notes.txt');
    useDialog.setState({ current: undefined });
    req.resolve(false, undefined, false);
    expect(await closing).toBe(false);
    // Back: the text, its unsaved mark and the version it was edited from.
    file = { text: 'changed on disk', size: 15, mtime: 9000 };
    await mount(editorPane());
    expect(editor.model).toBe(model);
    expect(model.getValue()).toBe('hello world');
    expect(host.querySelector('.files-dirty')).not.toBeNull();
    expect(keptEdit('m', 'view:v1')).toBeUndefined();
    expect(unsavedPanes('m', ['view:v1']).length).toBe(1);
    await unmount();
    // Saved without its component (Save in the question before closing),
    // with the version it was loaded in.
    file = { text: 'hello', size: 5, mtime: 7000 };
    expect(await unsavedPanes('m', ['view:v1'])[0].save()).toBe(true);
    expect(writes.at(-1)).toMatchObject({ body: 'hello world' });
    expect(writes.at(-1)!.q.get('mtime')).toBe('7000');
    expect(anyUnsaved()).toBe(false);
    expect(model.disposed).toBe(true);
  });

  it('frees a clean editor at once, and a kept edit once the layout no longer has its pane', async () => {
    await mount(editorPane());
    const clean = editor.model!;
    await unmount();
    expect(clean.disposed).toBe(true);
    expect(anyUnsaved()).toBe(false);

    await mount(editorPane());
    const model = editor.model!;
    await act(async () => model.setValue('edited'));
    await unmount();
    // The machine's layout still has the pane, or is not read: kept.
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1', 'v2') } } });
    dropGoneEdits();
    expect(keptEdit('m', 'view:v1')).toBeDefined();
    useTerms.setState({ machines: {} });
    expect(keptEdit('m', 'view:v1')).toBeDefined();
    // Closed (Don't Save): gone with its unsaved mark.
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v2') } } });
    expect(keptEdit('m', 'view:v1')).toBeUndefined();
    expect(model.disposed).toBe(true);
    expect(anyUnsaved()).toBe(false);
  });

  // Closing a pane with unsaved text asks first; the layout loses the
  // pane, then its component unmounts: nothing is kept for it.
  it('keeps nothing for a pane closed with unsaved text', async () => {
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1', 'v2') } } });
    await mount(editorPane());
    const model = editor.model!;
    await act(async () => model.setValue('edited'));
    expect(anyUnsaved()).toBe(true);
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v2') } } });
    await unmount();
    expect(keptEdit('m', 'view:v1')).toBeUndefined();
    expect(model.disposed).toBe(true);
    expect(anyUnsaved()).toBe(false);
    useTerms.setState({ machines: {} });
  });

  it('keeps the edit of a pane in another tab, and a closed diff’s none', async () => {
    // The pane's tab is not the one shown: still in the layout.
    const twoTabs = {
      workspaces: [
        {
          id: 'w',
          tabs: [
            { root: { view: { id: 'other', plugin: 'files', kind: 'editor' } }, focused: 'view:other' },
            { root: { view: { id: 'v1', plugin: 'files', kind: 'editor' } }, focused: 'view:v1' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    } as unknown as Layout;
    useTerms.setState({ machines: { m: { terminals: {}, layout: twoTabs } } });
    await mount(editorPane());
    await act(async () => editor.model!.setValue('edited'));
    await unmount();
    expect(keptEdit('m', 'view:v1')).toBeDefined();
    expect(anyUnsaved()).toBe(true);
    dropEdit('m', 'view:v1');
    // A diff closed with unsaved text: neither kept nor marked dirty.
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('d1') } } });
    await mount(
      createElement(DiffPane, {
        m: 'm',
        pane: 'view:d1',
        view: { id: 'd1', plugin: 'git', kind: 'diff', repo: '/r', path: 'f.txt', mode: 'worktree' },
        focused: true,
      }),
    );
    const { modified } = diffEditor.model!;
    await act(async () => modified.setValue('a\nB\nmine\n'));
    useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith() } } });
    await unmount();
    expect(keptEdit('m', 'view:d1')).toBeUndefined();
    expect(dirtyDiffs.has('view:d1')).toBe(false);
    expect(modified.disposed).toBe(true);
    expect(anyUnsaved()).toBe(false);
    useTerms.setState({ machines: {} });
  });

  it("keeps a diff's unsaved working tree while its pane is away", async () => {
    const diff = () =>
      createElement(DiffPane, {
        m: 'm',
        pane: 'view:d1',
        view: { id: 'd1', plugin: 'git', kind: 'diff', repo: '/r', path: 'f.txt', mode: 'worktree' },
        focused: true,
      });
    await mount(diff());
    const { original, modified } = diffEditor.model!;
    expect(modified.getValue()).toBe('a\nB\n');
    await act(async () => modified.setValue('a\nB\nmine\n'));
    await unmount();
    expect(modified.disposed).toBe(false);
    expect(dirtyDiffs.has('view:d1')).toBe(true);
    expect(unsavedPanes('m', ['view:d1']).map((u) => u.name)).toEqual(['f.txt']);
    await mount(diff());
    expect(diffEditor.model).toEqual({ original, modified });
    expect(modified.getValue()).toBe('a\nB\nmine\n');
    expect(host.querySelector('.git-dirty')).not.toBeNull();
    await unmount();
    // Saved without the component, from the version it was edited from.
    expect(await unsavedPanes('m', ['view:d1'])[0].save()).toBe(true);
    expect(writes.at(-1)).toMatchObject({ body: 'a\nB\nmine\n' });
    expect(writes.at(-1)!.q.get('mtime')).toBe('5000');
    expect(dirtyDiffs.has('view:d1')).toBe(false);
    expect(modified.disposed).toBe(true);
  });
});
