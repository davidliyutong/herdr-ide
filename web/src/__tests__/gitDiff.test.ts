// @vitest-environment jsdom
//
// The Git plugin's diff pane (plugins/git/DiffPane.tsx) with Monaco
// replaced: which versions each mode compares, staging and unstaging the
// selected ranges as patches, and saving the working tree's side through
// the file explorer's save.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));

class FakeModel {
  version = 1;
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
  }
  dispose() {}
}

const side = () => ({
  selections: [] as { startLineNumber: number; endLineNumber: number; endColumn: number }[],
  commands: [] as Array<() => void>,
  focusListener: undefined as (() => void) | undefined,
  readOnly: undefined as boolean | undefined,
  addCommand(_k: number, f: () => void) {
    this.commands.push(f);
  },
  onDidFocusEditorText(f: () => void) {
    this.focusListener = f;
  },
  getSelections() {
    return this.selections;
  },
  updateOptions(o: { readOnly?: boolean }) {
    this.readOnly = o.readOnly;
  },
  focus() {},
});

const editor = {
  model: undefined as { original: FakeModel; modified: FakeModel } | undefined,
  lineChanges: [] as unknown[],
  modifiedSide: side(),
  originalSide: side(),
  diffListener: undefined as (() => void) | undefined,
  opts: {} as Record<string, unknown>,
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
  onDidUpdateDiff(f: () => void) {
    this.diffListener = f;
  },
  getLineChanges() {
    return this.lineChanges;
  },
  goToDiff() {},
  updateOptions(o: Record<string, unknown>) {
    Object.assign(this.opts, o);
  },
  dispose() {},
};
const monaco = {
  Uri: { from: (o: unknown) => o },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  editor: { getModel: () => null, createModel: () => new FakeModel() },
};
vi.mock('../plugins/monaco', () => ({
  createDiffEditor: vi.fn(async (_el: HTMLElement, o: Record<string, unknown>) => {
    editor.opts = { ...o };
    return { monaco, editor };
  }),
}));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { DiffPane, diffTitle } from '../plugins/git/DiffPane';
import { useGit } from '../plugins/git/state';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/r';
/** The versions of f.txt by source. */
const blobs: Record<string, { text: string; mtime?: number }> = {
  index: { text: 'a\nb\nc\n' },
  worktree: { text: 'a\nB\nc\nD\n', mtime: 5000 },
  head: { text: 'a\nb\n' },
  abc1234: { text: 'new\n' },
  'abc1234^1': { text: 'old\n' },
};

describe('DiffPane', () => {
  let host: HTMLDivElement;
  let root: Root;
  const posts: Array<{ path: string; body: unknown; q?: URLSearchParams }> = [];
  const gets: string[] = [];
  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => settle());
  };
  const render = async (view: Record<string, unknown>) => {
    await act(async () =>
      root.render(
        createElement(DiffPane, {
          m: 'm',
          pane: 'view:d1',
          view: { id: 'd1', plugin: 'git', kind: 'diff', repo: ROOT, path: 'f.txt', ...view },
          focused: true,
        }),
      ),
    );
    await flush();
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === label || b.textContent?.trim() === label);

  beforeEach(() => {
    posts.length = 0;
    gets.length = 0;
    editor.model = undefined;
    editor.lineChanges = [];
    editor.modifiedSide = side();
    editor.originalSide = side();
    useGit.setState({ repos: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const action = url.pathname.split('/').pop()!;
      if (init?.method === 'POST') {
        const body = action === 'write' ? new TextDecoder().decode(init.body as Uint8Array) : JSON.parse(String(init.body));
        posts.push({ path: url.pathname, body, q: url.searchParams });
        if (action === 'write')
          return new Response(JSON.stringify({ entry: { path: url.searchParams.get('path'), exists: true, size: 3, mtime: 6000 } }));
        return new Response('{}');
      }
      if (action === 'blob') {
        const q = url.searchParams;
        const k = q.get('source')! + (q.get('parent') ? `^${q.get('parent')}` : '');
        gets.push(`${k}:${q.get('path')}`);
        const b = blobs[k];
        return new Response(
          JSON.stringify(b ? { exists: true, text: b.text, size: b.text.length, mtime: b.mtime } : { exists: false, text: '', size: 0 }),
        );
      }
      if (action === 'status') return new Response(JSON.stringify({ ahead: 0, behind: 0, files: [] }));
      if (action === 'repo') return new Response(JSON.stringify({ root: ROOT, ahead: 0, behind: 0, remotes: [] }));
      return new Response(JSON.stringify({ token: 't' }));
    });
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('compares the index with the working tree, editable', async () => {
    await render({ mode: 'worktree' });
    expect(editor.model!.original.getValue()).toBe('a\nb\nc\n');
    expect(editor.model!.modified.getValue()).toBe('a\nB\nc\nD\n');
    expect(editor.opts.readOnly).toBe(false);
    expect(diffTitle({ repo: ROOT, path: 'd/f.txt', mode: 'worktree' })).toBe(t('git.diff.worktreeTitle', { name: 'f.txt' }));
  });

  it('stages the selected ranges as a patch into the index', async () => {
    await render({ mode: 'worktree' });
    editor.lineChanges = [
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
      { originalStartLineNumber: 3, originalEndLineNumber: 0, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
    ];
    await act(async () => editor.diffListener!());
    editor.modifiedSide.selections = [{ startLineNumber: 4, endLineNumber: 4, endColumn: 2 }];
    await act(async () => button(t('git.diff.stageRanges'))!.click());
    await flush();
    const apply = posts.find((p) => p.path.endsWith('/applyPatch'))!;
    expect(apply.body).toEqual({
      patch: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n b\n c\n+D\n',
      cached: true,
      repo: ROOT,
    });
  });

  it('unstages the selected ranges from the index (HEAD left)', async () => {
    await render({ mode: 'staged' });
    expect(editor.model!.original.getValue()).toBe('a\nb\n');
    expect(editor.model!.modified.getValue()).toBe('a\nb\nc\n');
    expect(editor.opts.readOnly).toBe(true);
    editor.lineChanges = [{ originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }];
    await act(async () => editor.diffListener!());
    editor.modifiedSide.selections = [{ startLineNumber: 3, endLineNumber: 3, endColumn: 1 }];
    await act(async () => button(t('git.diff.unstageRanges'))!.click());
    await flush();
    const apply = posts.find((p) => p.path.endsWith('/applyPatch'))!;
    expect(apply.body).toEqual({
      patch: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,2 @@\n a\n b\n-c\n',
      cached: true,
      repo: ROOT,
    });
  });

  it('shows a commit against its parent and a compare', async () => {
    await render({ mode: 'commit', rev: 'abc1234' });
    expect(gets).toEqual(expect.arrayContaining(['abc1234^1:f.txt', 'abc1234:f.txt']));
    expect(editor.model!.original.getValue()).toBe('old\n');
    expect(editor.model!.modified.getValue()).toBe('new\n');
    expect(button(t('git.diff.stageRanges'))).toBeUndefined();
  });

  it('saves the working tree with the version it loaded', async () => {
    await render({ mode: 'worktree' });
    editor.model!.modified.setValue('a\n');
    await act(async () => editor.modifiedSide.commands[0]());
    await flush();
    const w = posts.find((p) => p.path.endsWith('/p/files/write'))!;
    expect(w.q!.get('path')).toBe('/r/f.txt');
    expect(w.q!.get('mtime')).toBe('5000');
    expect(w.q!.get('size')).toBe(String('a\nB\nc\nD\n'.length));
    expect(w.body).toBe('a\n');
  });
});
