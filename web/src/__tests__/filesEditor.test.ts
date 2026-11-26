// @vitest-environment jsdom
//
// The file explorer's editor pane (plugins/files/EditorPane.tsx) with
// Monaco replaced: it loads a file with the version in its ETag, saves with
// that version, and on a conflict offers to load the file again or to
// overwrite it; files that are not text are offered for download; media
// show as in Quick Look; a preview is kept by its first edit; the gutter
// marks lines that differ from the quick diff provider's text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));

/** Monaco's model: its line ends are of one kind, which its text decides
 * (eolOf); setValue drops the undo history. */
class FakeModel {
  value = '';
  eol: '\n' | '\r\n' = '\n';
  version = 1;
  /** setValue calls after the model was made. */
  sets = 0;
  private listeners: Array<() => void> = [];
  constructor(v = '') {
    this.take(v);
  }
  private take(v: string) {
    this.eol = eolOf(v) ?? this.eol;
    this.value = v.replace(/\r\n|\r|\n/g, this.eol);
  }
  getValue() {
    return this.value;
  }
  setValue(v: string) {
    this.take(v);
    this.sets++;
    this.version++;
    this.listeners.forEach((l) => l());
  }
  getEOL() {
    return this.eol;
  }
  pushEOL(seq: number) {
    this.eol = seq === 1 ? '\r\n' : '\n';
    this.value = this.value.replace(/\r\n|\r|\n/g, this.eol);
    this.edits++;
    this.version++;
    this.listeners.forEach((l) => l());
  }
  getAlternativeVersionId() {
    return this.version;
  }
  onDidChangeContent(l: () => void) {
    this.listeners.push(l);
  }
  dispose() {
    models.delete(this.uri);
  }
  uri = '';
  getVersionId() {
    return this.version;
  }
  /** Changes made as edits undo takes back (pushEditOperations). */
  edits = 0;
  getLineCount() {
    return this.value.split('\n').length;
  }
  getLineMaxColumn(line: number) {
    const lines = this.value.split('\n');
    return (lines[line - 1]?.length ?? 0) + 1;
  }
  getPositionAt(offset: number) {
    const lines = this.value.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  private offsetAt(line: number, column: number) {
    const lines = this.value.split('\n');
    return lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  }
  pushStackElement() {}
  pushEditOperations(
    _selections: unknown,
    ops: Array<{ range: { start: number; startColumn: number; end: number; endColumn: number }; text: string }>,
  ) {
    for (const op of ops) {
      const a = this.offsetAt(op.range.start, op.range.startColumn);
      const b = this.offsetAt(op.range.end, op.range.endColumn);
      this.value = this.value.slice(0, a) + op.text + this.value.slice(b);
    }
    this.edits++;
    this.version++;
    this.listeners.forEach((l) => l());
    return null;
  }
}

type FakeDecoration = { range: { start: number; end: number }; options: { linesDecorationsClassName: string } };

const focusSpy = vi.fn();
const editor = {
  model: undefined as FakeModel | undefined,
  save: undefined as (() => void) | undefined,
  readOnly: undefined as boolean | undefined,
  setModel(m: FakeModel) {
    this.model = m;
  },
  getModel() {
    return this.model;
  },
  getValue() {
    return this.model!.getValue();
  },
  /** The key listeners of this editor: the save chord runs `save`. */
  onKeyDown(
    l: (e: { equals(k: number): boolean; browserEvent: { repeat: boolean }; preventDefault(): void; stopPropagation(): void }) => void,
  ) {
    this.save = () => l({ equals: (k) => k === (2048 | 49), browserEvent: { repeat: false }, preventDefault() {}, stopPropagation() {} });
    return { dispose() {} };
  },
  updateOptions(o: { readOnly?: boolean }) {
    this.readOnly = o.readOnly;
  },
  focus: focusSpy,
  /** Where the cursor was put and which lines/ranges were shown (revealAt). */
  positions: [] as Array<{ lineNumber: number; column: number }>,
  selections: [] as Array<{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }>,
  revealed: [] as number[],
  revealedRanges: [] as Array<{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }>,
  setPosition(p: { lineNumber: number; column: number }) {
    this.positions.push(p);
  },
  setSelection(r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) {
    this.selections.push(r);
  },
  revealLineInCenter(line: number) {
    this.revealed.push(line);
  },
  revealRangeInCenter(r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) {
    this.revealedRanges.push(r);
  },
  dispose() {},
  savedState: undefined as unknown,
  restoredStates: [] as unknown[],
  layout() {},
  saveViewState() {
    return this.savedState ?? null;
  },
  restoreViewState(s: unknown) {
    this.restoredStates.push(s);
  },
  onDidChangeModelContent(l: () => void) {
    this.model?.onDidChangeContent(l);
    return { dispose() {} };
  },
  /** Active decoration collections (quick diff, target line ranges, etc.). */
  _decorationSets: new Set<FakeDecoration[]>(),
  get decorations(): FakeDecoration[] {
    return [...this._decorationSets].flat();
  },
  createDecorationsCollection(d: FakeDecoration[]) {
    const entry = [...d];
    editor._decorationSets.add(entry);
    return {
      clear: () => {
        editor._decorationSets.delete(entry);
      },
    };
  },
};
let separate = false;
/** The models not disposed, by their URI. */
const models = new Map<string, FakeModel>();
const monaco = {
  Uri: { from: (o: unknown) => o },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  Range: class {
    constructor(
      public start: number,
      public startColumn: number,
      public end: number,
      public endColumn = 1,
    ) {}
  },
  editor: {
    getModel: (uri: unknown) => models.get(JSON.stringify(uri)) ?? null,
    createModel: vi.fn((v: string, _language: unknown, uri: unknown) => {
      const model = new FakeModel(v);
      model.uri = JSON.stringify(uri);
      models.set(model.uri, model);
      return model;
    }),
    OverviewRulerLane: { Left: 1 },
    EndOfLineSequence: { LF: 0, CRLF: 1 },
  },
};
vi.mock('../plugins/monaco', () => ({
  setLanguage: vi.fn(),
  createEditor: vi.fn(async (_el: HTMLElement, o: { readOnly?: boolean }) => {
    // With `separate`, each editor is its own (as in Monaco): own model and key listener.
    const e = separate ? Object.create(editor) : editor;
    e.readOnly = o.readOnly;
    return { monaco, editor: e };
  }),
}));

import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import type { Layout } from '../term/layout';
import { t } from '../i18n';
import {
  CHECK_MS,
  EditorPane,
  eolOf,
  keepViewState,
  keptViewState,
  loadText,
  resetViewStates,
  versionOf,
} from '../plugins/files/EditorPane';
import { dropEdit } from '../unsaved';
import { registerQuickDiff } from '../plugins/files/quickDiff';
import { useGoneFiles } from '../plugins/files/gone';
import { useSettings } from '../settings';
import { MIXED_LINE_ENDINGS } from '../eol';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The file on the machine. */
let file: { text: string | Uint8Array<ArrayBuffer>; size: number; mtime: number } | undefined;
/** The status /file answers with instead of the file (a stat that failed). */
let fileStatus: number | undefined;
let fileErrorBody: string | undefined;
/** While set, reading the file's contents waits for it. */
let hold: Promise<void> | undefined;
const writes: Array<{ q: URLSearchParams; body: string; raw: Uint8Array }> = [];
const fileRequests: Array<{ method: string; path: string; maxSize: string | null }> = [];
const statRequests: string[][] = [];
/** The next write stops partway (the machine's disk is full). */
let failWrite = false;

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/m/m/file') {
      fileRequests.push({ method, path: url.searchParams.get('path') ?? '', maxSize: url.searchParams.get('max_size') });
      if (fileStatus) return new Response(fileErrorBody ?? 'lstat: input/output error', { status: fileStatus });
      if (!file) return new Response('not found', { status: 404 });
      const etag = `W/"${file.size.toString(16)}-${file.mtime.toString(16)}"`;
      const headers = { ETag: etag, 'Content-Length': String(file.size) };
      if (method !== 'HEAD' && hold) await hold;
      return new Response(method === 'HEAD' ? null : file.text, { status: 200, headers });
    }
    if (url.pathname === '/api/m/m/p/files/stat') {
      const { paths } = JSON.parse(init!.body as string) as { paths: string[] };
      statRequests.push(paths);
      return new Response(
        JSON.stringify({
          entries: paths.map((path) => (file ? { path, exists: true, size: file.size, mtime: file.mtime } : { path, exists: false })),
        }),
      );
    }
    if (url.pathname === '/api/m/m/p/files/write') {
      const raw = init!.body as Uint8Array;
      const body = new TextDecoder().decode(raw);
      writes.push({ q: url.searchParams, body, raw });
      const q = url.searchParams;
      const cur = file ? { path: q.get('path'), exists: true, size: file.size, mtime: file.mtime } : { path: q.get('path'), exists: false };
      const matches =
        q.get('force') === '1' ||
        (file && +q.get('mtime')! === file.mtime && +q.get('size')! === file.size) ||
        (!file && q.get('new') === '1');
      if (!matches) return new Response(JSON.stringify({ error: 'conflict', current: cur }), { status: 409 });
      if (failWrite) {
        failWrite = false;
        file = { text: body.slice(0, 2), size: 2, mtime: (file?.mtime ?? 0) + 500 };
        return new Response(JSON.stringify({ error: 'partial_write', message: 'partial_write: no_space' }), { status: 400 });
      }
      file = { text: body, size: body.length, mtime: (file?.mtime ?? 0) + 1000 };
      return new Response(
        JSON.stringify({ paths: [q.get('path')], entry: { path: q.get('path'), exists: true, size: file.size, mtime: file.mtime } }),
      );
    }
    return new Response('{}');
  });
}

describe('EditorPane', () => {
  let host: HTMLDivElement;
  let root: Root;
  const flush = () => act(async () => settle());
  const render = async (path = '/home/u/notes.txt') => {
    await act(async () =>
      root.render(
        createElement(EditorPane, { m: 'm', pane: 'view:v1', view: { id: 'v1', plugin: 'files', kind: 'editor', path }, focused: true }),
      ),
    );
    await flush();
    await flush();
  };
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.title === label);

  beforeEach(() => {
    file = { text: 'hello', size: 5, mtime: 7000 };
    fileStatus = undefined;
    fileErrorBody = undefined;
    hold = undefined;
    writes.length = 0;
    fileRequests.length = 0;
    statRequests.length = 0;
    failWrite = false;
    useStore.setState({ toasts: [] });
    editor.model = undefined;
    editor.save = undefined;
    editor.savedState = undefined;
    editor.restoredStates = [];
    editor.positions = [];
    editor.selections = [];
    editor.revealed = [];
    editor.revealedRanges = [];
    editor._decorationSets.clear();
    useTerms.setState({ machines: {} });
    resetViewStates();
    stubFetch();
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

  // The model's URI is the file's, which Monaco keeps the undo history of
  // when its model is disposed; a second pane of the file has one of its own.
  it('gives a file’s model the file’s URI unless another pane has it', async () => {
    separate = true;
    try {
      const hosts = [document.createElement('div'), document.createElement('div')];
      const roots = hosts.map((h) => {
        document.body.append(h);
        return createRoot(h);
      });
      const created = () => vi.mocked(monaco.editor.createModel).mock.calls.map((c) => (c[2] as { query: string }).query);
      vi.mocked(monaco.editor.createModel).mockClear();
      const render = async (i: number) => {
        await act(async () =>
          roots[i].render(
            createElement(EditorPane, {
              m: 'm',
              pane: `view:v${i}`,
              view: { id: `v${i}`, plugin: 'files', kind: 'editor', path: '/home/u/notes.txt' },
              focused: false,
            }),
          ),
        );
        await flush();
        await flush();
      };
      await render(0);
      await render(1);
      expect(created()).toEqual(['m=m', 'm=m&pane=view:v1']);
      for (const r of roots) await act(async () => r.render(null));
      expect(models.size).toBe(0);
      await render(1);
      expect(created()).toEqual(['m=m', 'm=m&pane=view:v1', 'm=m']);
      for (const r of roots) await act(async () => r.unmount());
      hosts.forEach((h) => h.remove());
    } finally {
      separate = false;
    }
  });

  // The chord is each editor's own: with two panes mounted, Cmd+S in one
  // saves its file, not the one of the editor created last.
  it('saves each pane’s own file on the save chord, and on the chord outside the editor', async () => {
    separate = true;
    try {
      const editors: Array<{ model?: FakeModel; save?: () => void }> = [];
      const hosts = [document.createElement('div'), document.createElement('div')];
      const roots = hosts.map((h) => {
        document.body.append(h);
        return createRoot(h);
      });
      const paths = ['/home/u/a.txt', '/home/u/b.txt'];
      const { createEditor } = await import('../plugins/monaco');
      const spy = vi.mocked(createEditor);
      for (const i of [0, 1]) {
        await act(async () =>
          roots[i].render(
            createElement(EditorPane, {
              m: 'm',
              pane: `view:v${i}`,
              view: { id: `v${i}`, plugin: 'files', kind: 'editor', path: paths[i] },
              focused: true,
            }),
          ),
        );
        await flush();
        await flush();
        editors.push((await spy.mock.results[spy.mock.results.length - 1].value).editor);
      }
      await act(async () => editors[0].model!.setValue('first'));
      await act(async () => editors[0].save!());
      await flush();
      expect(writes.map((w) => [w.q.get('path'), w.body])).toEqual([['/home/u/a.txt', 'first']]);

      // On the toolbar, outside Monaco: Ctrl+S (Cmd+S on macOS) of the pane at hand.
      await act(async () => editors[1].model!.setValue('second'));
      const bar = hosts[1].querySelector<HTMLElement>('.files-editor')!;
      const key = (init: KeyboardEventInit) => {
        const ev = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true, ...init });
        bar.dispatchEvent(ev);
        return ev;
      };
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      const chord = mac ? { metaKey: true } : { ctrlKey: true };
      expect(key({ ...chord, shiftKey: true }).defaultPrevented).toBe(false);
      expect(key({ ...chord, repeat: true }).defaultPrevented).toBe(true);
      expect(writes).toHaveLength(1);
      expect(key(chord).defaultPrevented).toBe(true);
      await flush();
      expect(writes.map((w) => [w.q.get('path'), w.body])).toEqual([
        ['/home/u/a.txt', 'first'],
        ['/home/u/b.txt', 'second'],
      ]);
      for (const r of roots) await act(async () => r.unmount());
      hosts.forEach((h) => h.remove());
    } finally {
      separate = false;
    }
  });

  // A search's match: the editor shows its line with the cursor at its
  // column once the text is there, and again when asked again (reveal).
  it('shows the line and column the view asks for', async () => {
    editor.positions = [];
    editor.revealed = [];
    file = { text: 'a\nb\nneedle here\n', size: 16, mtime: 7000 };
    const view = (reveal: number) => ({ id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/n.txt', line: 3, col: 2, reveal });
    await act(async () => root.render(createElement(EditorPane, { m: 'm', pane: 'view:v1', view: view(1), focused: true })));
    await flush();
    await flush();
    expect(editor.positions).toEqual([{ lineNumber: 3, column: 2 }]);
    expect(editor.revealed).toEqual([3]);
    // The same request, drawn again: nothing moves; a new one shows it again.
    await act(async () => root.render(createElement(EditorPane, { m: 'm', pane: 'view:v1', view: view(1), focused: false })));
    expect(editor.revealed).toEqual([3]);
    await act(async () => root.render(createElement(EditorPane, { m: 'm', pane: 'view:v1', view: view(2), focused: false })));
    expect(editor.revealed).toEqual([3, 3]);
  });

  it('reads the version from the ETag', () => {
    expect(versionOf('W/"1a-ff"')).toEqual({ size: 26, mtime: 255 });
    expect(versionOf('"x"')).toBeUndefined();
  });

  it('saves with the version it loaded, and keeps a file changed meanwhile unless told', async () => {
    await render();
    expect(editor.model?.getValue()).toBe('hello');
    expect(host.querySelector('.files-dirty')).toBeNull();
    await act(async () => editor.model!.setValue('hello world'));
    expect(host.querySelector('.files-dirty')).not.toBeNull();
    await act(async () => editor.save!());
    await flush();
    expect(writes[0].q.get('mtime')).toBe('7000');
    expect(writes[0].q.get('size')).toBe('5');
    expect(file?.text).toBe('hello world');
    expect(host.querySelector('.files-dirty')).toBeNull();

    // Changed on the machine since: a conflict, nothing written.
    file = { text: 'theirs', size: 6, mtime: 99000 };
    await act(async () => editor.model!.setValue('mine'));
    await act(async () => editor.save!());
    await flush();
    expect(file.text).toBe('theirs');
    expect(host.querySelector('.files-conflict')?.textContent).toContain(t('files.conflict.changed', { name: 'notes.txt' }));
    // Overwrite.
    await act(async () => button(t('files.conflict.overwrite'))!.click());
    await flush();
    expect(writes[writes.length - 1].q.get('force')).toBe('1');
    expect(file.text).toBe('mine');
    expect(host.querySelector('.files-conflict')).toBeNull();

    // Again, and this time load theirs.
    file = { text: 'theirs again', size: 12, mtime: 123000 };
    await act(async () => editor.model!.setValue('mine again'));
    await act(async () => editor.save!());
    await flush();
    await act(async () => button(t('files.conflict.reload'))!.click());
    await flush();
    expect(editor.model!.getValue()).toBe('theirs again');
    expect(host.querySelector('.files-conflict')).toBeNull();
    expect(host.querySelector('.files-dirty')).toBeNull();
    // Saving now goes with the version loaded.
    await act(async () => editor.model!.setValue('merged'));
    await act(async () => editor.save!());
    await flush();
    expect(file.text).toBe('merged');
  });

  it('creates a file that is not there yet, refusing one made meanwhile', async () => {
    file = undefined;
    await render('/home/u/new.txt');
    expect(editor.model?.getValue()).toBe('');
    await act(async () => editor.model!.setValue('first'));
    file = { text: 'other', size: 5, mtime: 1000 };
    await act(async () => editor.save!());
    await flush();
    expect(writes[0].q.get('new')).toBe('1');
    expect(host.querySelector('.files-conflict')).not.toBeNull();
  });

  it('keeps the text after a write that stopped partway, and saves it again over what is there', async () => {
    await render();
    await act(async () => editor.model!.setValue('hello world'));
    failWrite = true;
    await act(async () => editor.save!());
    await flush();
    expect(file?.text).toBe('he');
    expect(host.querySelector('.files-dirty')).not.toBeNull();
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.kind).toBe('error');
    expect(toast.msg).toBe(t('files.saveFailed', { error: t('files.error.partial_write.no_space') }));
    expect(toast.action?.label).toBe(t('files.saveAgain'));
    await act(async () => toast.action!.run());
    await flush();
    expect(writes.at(-1)!.q.get('force')).toBe('1');
    expect(file?.text).toBe('hello world');
    expect(host.querySelector('.files-dirty')).toBeNull();
  });

  it('edits nothing in read-only mode', async () => {
    useStore.getState().setReadOnly(true);
    await render();
    expect(editor.readOnly).toBe(true);
    expect(button(t('files.save'))).toBeUndefined();
    await act(async () => editor.save!());
    expect(writes).toEqual([]);
  });

  it('offers files that are not text for download', async () => {
    file = { text: new Uint8Array([0x89, 0x50, 0, 1]), size: 4, mtime: 1 };
    expect((await loadText('m', '/a.bin')).kind).toBe('binary');
    file = { text: new Uint8Array([0xff, 0xfe, 0x41]), size: 3, mtime: 1 };
    expect((await loadText('m', '/a.txt')).kind).toBe('notUtf8');
    file = { text: 'x', size: 9 << 20, mtime: 1 };
    expect((await loadText('m', '/big.log')).kind).toBe('tooLarge');
    file = { text: new Uint8Array([0, 0]), size: 2, mtime: 1 };
    await render('/home/u/a.bin');
    expect(host.textContent).toContain(t('files.binary', { name: 'a.bin' }));
    expect(host.querySelector('a.btn')?.getAttribute('href')).toContain('download=1');
  });

  it("marks the lines that differ from the quick diff provider's text", async () => {
    const stop = registerQuickDiff({ follow: () => () => {}, original: async () => 'hello\nold\n' });
    try {
      file = { text: 'hello\nnew\nmore\n', size: 15, mtime: 1 };
      await render();
      await flush();
      expect(editor.decorations.map((d) => [d.range.start, d.range.end, d.options.linesDecorationsClassName])).toEqual([
        [2, 3, 'qd-modified'],
      ]);
    } finally {
      stop();
    }
  });

  it('says a file it cannot read is not readable, rather than opening it empty', async () => {
    fileStatus = 403;
    await render();
    expect(host.querySelector('.files-editor-note.error')?.textContent).toBe(t('files.error.denied'));
    expect(editor.model).toBeUndefined();
    fileStatus = 502;
    expect(await loadText('m', '/a.txt')).toEqual({ kind: 'error', message: t('files.error.transport') });
    fileStatus = 500;
    expect(await loadText('m', '/a.txt')).toEqual({
      kind: 'error',
      message: t('files.readFailed', { error: 'lstat: input/output error' }),
    });
    fileErrorBody = '';
    expect(await loadText('m', '/a.txt')).toEqual({ kind: 'error', message: t('files.readFailed', { error: 'HTTP 500' }) });
    expect(writes).toEqual([]);
  });

  it('keeps a byte order mark it does not show', async () => {
    file = { text: new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), size: 5, mtime: 1000 };
    await render();
    expect(editor.model?.getValue()).toBe('hi');
    await act(async () => editor.model!.setValue('ho'));
    await act(async () => editor.save!());
    await flush();
    expect([...writes[0].raw]).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x6f]);
    // A file without one gets none.
    file = { text: 'plain', size: 5, mtime: 1000 };
    expect(await loadText('m', '/b.txt')).toMatchObject({ text: 'plain', version: { bom: false } });
  });

  describe('changes on disk', () => {
    /** Runs the timers by ms (the pane's checks), and what they started. */
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const renderNow = async () => {
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/notes.txt' },
            focused: false,
          }),
        ),
      );
      await advance(0);
      await advance(0);
    };

    it('loads a changed file again by an edit undo takes back', async () => {
      await renderNow();
      expect(editor.model?.getValue()).toBe('hello');
      file = { text: 'hello there', size: 11, mtime: 8000 };
      await advance(CHECK_MS);
      expect(editor.model?.getValue()).toBe('hello there');
      expect(editor.model?.edits).toBe(1);
      expect(host.querySelector('.files-dirty')).toBeNull();
    });

    it('makes the model with the file’s text, for Monaco to give it back the undo history it kept', async () => {
      await renderNow();
      expect(monaco.editor.createModel).toHaveBeenLastCalledWith('hello', undefined, expect.anything());
      expect(editor.model?.sets).toBe(0);
    });

    it('loads a file again whose line ends changed by edits undo takes back', async () => {
      await renderNow();
      file = { text: 'hello\r\nthere\nyou\r\n', size: 19, mtime: 8000 };
      await advance(CHECK_MS);
      expect(editor.model?.getValue()).toBe('hello\r\nthere\r\nyou\r\n');
      expect(editor.model?.edits).toBe(2);
      expect(editor.model?.sets).toBe(0);
      file = { text: 'hello\r\nthere\r\nyou\n', size: 19, mtime: 9000 };
      await advance(CHECK_MS);
      expect(editor.model?.edits).toBe(2);
      expect(editor.model?.sets).toBe(0);
    });

    it('keeps the text of a file removed on the machine, and marks it gone until it is back', async () => {
      const gone = () => !!useGoneFiles.getState().gone['m\n/home/u/notes.txt'];
      await renderNow();
      expect(gone()).toBe(false);
      file = undefined;
      await advance(CHECK_MS);
      expect(gone()).toBe(true);
      expect(editor.model?.getValue()).toBe('hello');
      expect(host.querySelector('.files-conflict')).toBeNull();
      file = { text: 'hello', size: 5, mtime: 7000 };
      await advance(CHECK_MS);
      expect(gone()).toBe(false);
      expect(editor.model?.getValue()).toBe('hello');
    });

    it('keeps unsaved changes of a file removed, and says when it is back as loaded', async () => {
      const gone = () => !!useGoneFiles.getState().gone['m\n/home/u/notes.txt'];
      await renderNow();
      await act(async () => editor.model!.setValue('typed'));
      file = undefined;
      await advance(CHECK_MS);
      expect(gone()).toBe(true);
      expect(host.querySelector('.files-conflict')?.textContent).toContain(t('files.conflict.removed', { name: 'notes.txt' }));
      expect(editor.model?.getValue()).toBe('typed');
      // Back with other text: the bar says so.
      file = { text: 'other', size: 5, mtime: 9000 };
      await advance(CHECK_MS);
      expect(gone()).toBe(false);
      expect(host.querySelector('.files-conflict')?.textContent).toContain(t('files.conflict.changed', { name: 'notes.txt' }));
      // Back as it was loaded (from the trash): nothing to resolve, the changes still unsaved.
      file = { text: 'hello', size: 5, mtime: 7000 };
      await advance(CHECK_MS);
      expect(host.querySelector('.files-conflict')).toBeNull();
      expect(host.querySelector('.files-dirty')).not.toBeNull();
      expect(editor.model?.getValue()).toBe('typed');
      // Removed again and saved over: the file is made again, the mark goes.
      file = undefined;
      await advance(CHECK_MS);
      expect(gone()).toBe(true);
      await act(async () => button(t('files.conflict.overwrite'))!.click());
      await advance(0);
      expect(writes.at(-1)?.q.get('force')).toBe('1');
      expect(gone()).toBe(false);
    });

    it('keeps what was typed while the file was loading again, and offers the change', async () => {
      await renderNow();
      file = { text: 'theirs', size: 6, mtime: 8000 };
      let release = () => {};
      hold = new Promise((r) => (release = r));
      await advance(CHECK_MS);
      // The pane is reading the new text; the user types meanwhile.
      await act(async () => editor.model!.setValue('typed'));
      hold = undefined;
      release();
      await advance(0);
      expect(editor.model?.getValue()).toBe('typed');
      expect(host.querySelector('.files-conflict')?.textContent).toContain(t('files.conflict.changed', { name: 'notes.txt' }));
      // Keep Editing: not offered again for the same change…
      await act(async () => button(t('files.conflict.keep'))!.click());
      await advance(CHECK_MS);
      await advance(CHECK_MS);
      expect(host.querySelector('.files-conflict')).toBeNull();
      // …but for a newer one.
      file = { text: 'newer', size: 5, mtime: 9000 };
      await advance(CHECK_MS);
      expect(host.querySelector('.files-conflict')).not.toBeNull();
      expect(editor.model?.getValue()).toBe('typed');
    });
  });

  it('shows media as Quick Look does, without the text editor', async () => {
    await render('/home/u/cat.png');
    expect(host.querySelector('img')?.getAttribute('src')).toContain('cat.png');
    expect(host.querySelector('.files-editor-host')).toBeNull();
  });

  // A file that mixes line endings: the editor gives its text back with one
  // kind (as Monaco does); the setting git.mixedLineEndings says whether a
  // save keeps each line's own, unifies them, or the file is read-only.
  describe('mixed line endings', () => {
    const mixed = 'one\r\ntwo\nthree\r\nfour\n';
    const setMode = (v: string) =>
      useSettings.setState((s) => ({ values: { ...s.values, [MIXED_LINE_ENDINGS]: { value: v, source: 'global' } } }));
    beforeEach(() => {
      file = { text: mixed, size: mixed.length, mtime: 1000 };
    });
    afterEach(() => setMode('keep'));

    it('keeps each line’s own ending when saved', async () => {
      await render('/home/u/mixed.txt');
      expect(host.querySelector('.eol-note')?.textContent).toBe(t('eol.keep', { name: 'mixed.txt' }));
      await act(async () => editor.model!.setValue('one\ntwo\nTHREE\nfour\nfive\n'));
      await act(async () => editor.save!());
      await flush();
      expect(writes[0].body).toBe('one\r\ntwo\nTHREE\r\nfour\nfive\n');
      // Saved again, from what was saved.
      await act(async () => editor.model!.setValue('one\ntwo\nTHREE\nfour\nfive\nsix\n'));
      await act(async () => editor.save!());
      await flush();
      expect(writes[1].body).toBe('one\r\ntwo\nTHREE\r\nfour\nfive\nsix\n');
    });

    it('writes the editor’s endings when told to unify them', async () => {
      setMode('unify');
      await render('/home/u/mixed.txt');
      expect(host.querySelector('.eol-note')?.textContent).toBe(t('eol.unify', { name: 'mixed.txt' }));
      await act(async () => editor.model!.setValue('one\ntwo\nthree\nfour\n'));
      await act(async () => editor.save!());
      await flush();
      expect(writes[0].body).toBe('one\ntwo\nthree\nfour\n');
      expect(host.querySelector('.eol-note')).toBeNull();
    });

    it('opens such a file read-only when told', async () => {
      setMode('readOnly');
      await render('/home/u/mixed.txt');
      expect(editor.readOnly).toBe(true);
      expect(host.querySelector('.eol-note')?.textContent).toBe(t('eol.readOnly', { name: 'mixed.txt' }));
      await act(async () => editor.model!.setValue('changed\n'));
      await act(async () => editor.save!());
      await flush();
      expect(writes).toEqual([]);
      // A file that does not mix them is edited as any.
      file = { text: 'a\nb\n', size: 4, mtime: 2000 };
      await render('/home/u/other.txt');
      expect(editor.readOnly).toBe(false);
    });
  });

  describe('view state across tab switches', () => {
    const layoutWith = (...views: string[]): Layout => {
      const leaf = (id: string) => ({ view: { id, plugin: 'files', kind: 'editor' } });
      const root = views.length === 2 ? { split: 'horizontal', ratio: 0.5, children: views.map(leaf) } : leaf(views[0] ?? 'other');
      return {
        workspaces: [{ id: 'w', tabs: [{ root, focused: `view:${views[0] ?? 'other'}` }], selected: 0 }],
        selected: 0,
      } as unknown as Layout;
    };

    afterEach(() => {
      dropEdit('m', 'view:v1');
      resetViewStates();
    });

    it('persists and restores ICodeEditorViewState across tab switches for clean and dirty files', async () => {
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1', 'v2') } } });
      const viewState = {
        cursorState: [{ inSelectionMode: true, selectionStart: { lineNumber: 12, column: 3 }, position: { lineNumber: 12, column: 8 } }],
        viewState: {
          scrollTop: 340,
          scrollTopWithoutViewZones: 340,
          firstPosition: { lineNumber: 10, column: 1 },
          firstPositionDeltaTop: 0,
        },
        contributionsState: {},
      };
      await render('/home/u/notes.txt');
      editor.savedState = viewState;

      // Switch away to another tab (pane unmounts, stays in layout).
      await act(async () => root.unmount());
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toEqual(viewState);

      // Switch back: view state is restored once ready.
      root = createRoot(host);
      await render('/home/u/notes.txt');
      expect(editor.restoredStates).toEqual([viewState]);
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toBeUndefined();

      // Dirty file also preserves view state alongside kept unsaved text.
      const dirtyViewState = {
        ...viewState,
        viewState: { ...viewState.viewState, scrollTop: 620, scrollTopWithoutViewZones: 620 },
      };
      await act(async () => editor.model!.setValue('unsaved edit'));
      editor.savedState = dirtyViewState;
      await act(async () => root.unmount());
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toEqual(dirtyViewState);

      root = createRoot(host);
      await render('/home/u/notes.txt');
      expect(editor.model?.getValue()).toBe('unsaved edit');
      expect(editor.restoredStates).toEqual([viewState, dirtyViewState]);
    });

    it('cleans up view state when the tab or pane closes', async () => {
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1', 'v2') } } });
      const viewState = { cursorState: [], viewState: { scrollTop: 150 }, contributionsState: {} };
      await render('/home/u/notes.txt');
      editor.savedState = viewState;

      // Unmount while still in layout -> kept.
      await act(async () => root.unmount());
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toEqual(viewState);

      // Closing the inactive tab/pane removes it from layout -> view state is cleaned up.
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v2') } } });
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toBeUndefined();

      // Closing while mounted does not save view state.
      root = createRoot(host);
      await render('/home/u/notes.txt');
      editor.savedState = viewState;
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v2') } } });
      await act(async () => root.unmount());
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toBeUndefined();
    });

    it('does not restore a previous file’s view state when a preview pane opens another file', async () => {
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1') } } });
      const viewState = { cursorState: [], viewState: { scrollTop: 220 }, contributionsState: {} };
      await render('/home/u/notes.txt');
      editor.savedState = viewState;
      await act(async () => root.unmount());
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toEqual(viewState);

      root = createRoot(host);
      await render('/home/u/other.txt');
      expect(editor.restoredStates).toEqual([]);
      expect(keptViewState('m', 'view:v1', '/home/u/notes.txt')).toBeUndefined();
    });

    it('restores view state when a mounted TextEditor changes path while status remains ready', async () => {
      useTerms.setState({ machines: { m: { terminals: {}, layout: layoutWith('v1') } } });
      await render('/home/u/notes.txt');
      const otherState = { cursorState: [], viewState: { scrollTop: 410 }, contributionsState: {} };
      keepViewState('m', 'view:v1', '/home/u/other.txt', otherState as unknown as Parameters<typeof keepViewState>[3]);

      // Same mounted root switches directly to /home/u/other.txt while status.kind was already 'ready'.
      await render('/home/u/other.txt');
      expect(editor.restoredStates).toEqual([otherState]);
    });
  });

  it('forwards focus on the editor root into Monaco so escaping back to the pane works', async () => {
    await render();
    focusSpy.mockClear();
    const rootEl = host.querySelector<HTMLElement>('.files-editor')!;
    await act(async () => {
      rootEl.focus();
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('selects and highlights target line ranges when endLine is provided', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
    file = { text: lines, size: lines.length, mtime: 7000 };
    await act(async () =>
      root.render(
        createElement(EditorPane, {
          m: 'm',
          pane: 'view:v1',
          view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/mvtrack.yaml', line: 17, col: 1, endLine: 20, reveal: 1 },
          focused: true,
        }),
      ),
    );
    await flush();
    await flush();
    expect(editor.positions).toEqual([{ lineNumber: 17, column: 1 }]);
    expect(editor.selections).toEqual([{ startLineNumber: 17, startColumn: 1, endLineNumber: 20, endColumn: 8 }]);
    expect(editor.revealedRanges).toEqual([{ startLineNumber: 17, startColumn: 1, endLineNumber: 20, endColumn: 8 }]);
    expect(editor.decorations).toMatchObject([{ range: { start: 17, end: 20 }, options: { className: 'files-target-range' } }]);
  });

  describe('Markdown preview view', () => {
    it('opens .md, .mdx and .markdown files in Preview mode by default without creating Monaco until toggled', async () => {
      const { createEditor } = await import('../plugins/monaco');
      vi.mocked(createEditor).mockClear();
      const md = '# Hello Preview\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] shipped\n\n<script>alert(1)</script>';
      file = { text: md, size: md.length, mtime: 7000 };
      await render('/home/u/README.md');
      await vi.waitFor(() => expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Hello Preview'), { timeout: 5000 });
      expect(host.querySelector('.files-md-preview table td')?.textContent).toBe('1');
      expect(host.querySelector('.files-md-preview script')).toBeNull();
      // Preview-first did not initialize Monaco.
      expect(createEditor).not.toHaveBeenCalled();
      expect(button(t('files.markdown.preview'))?.getAttribute('aria-pressed')).toBe('true');

      // Switch to Split mode: creates Monaco and updates the live preview on edit.
      await act(async () => button(t('files.markdown.split'))!.click());
      await flush();
      await flush();
      expect(createEditor).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.files-editor-body.split')).not.toBeNull();
      expect(host.querySelector('.files-md-preview')).not.toBeNull();

      await act(async () => editor.model!.setValue('# Live Updated\n\nBody text'));
      await flush();
      await vi.waitFor(() => expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Live Updated'), { timeout: 5000 });

      // Switch to Source mode: hides preview.
      await act(async () => button(t('files.markdown.source'))!.click());
      await flush();
      expect(host.querySelector('.files-md-preview')).toBeNull();

      // Switch back to Preview mode: keeps live unsaved edit without re-creating Monaco.
      await act(async () => button(t('files.markdown.preview'))!.click());
      await flush();
      await vi.waitFor(() => expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Live Updated'), { timeout: 5000 });
      expect(createEditor).toHaveBeenCalledTimes(1);
    });

    it('hides HTML comments, renders safe HTML and relative <img>, and strips XSS in File Preview', async () => {
      const md = [
        '<!-- single-line note -->',
        '<!--',
        'multi-line',
        '',
        'comment',
        '-->',
        '# Safe Preview',
        '',
        '<details open><summary>Summary</summary>',
        '',
        'Press <kbd>Cmd</kbd>+<kbd>S</kbd>',
        '',
        '</details>',
        '',
        '<img src="./diagram.png" alt="Diagram" width="200" onerror="alert(1)">',
        '',
        '<script>alert(1)</script>',
        '<style>body{display:none}</style>',
        '<iframe src="javascript:alert(1)"></iframe>',
      ].join('\n');
      file = { text: md, size: md.length, mtime: 7000 };
      await render('/home/u/docs/README.md');
      await vi.waitFor(() => expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Safe Preview'), { timeout: 5000 });
      const preview = host.querySelector('.files-md-preview')!;
      expect(preview.querySelector('.markdown')?.classList.contains('markdown-document')).toBe(true);
      expect(preview.textContent).not.toContain('single-line note');
      expect(preview.textContent).not.toContain('multi-line');
      expect(preview.querySelector('details summary')?.textContent).toBe('Summary');
      expect([...preview.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Cmd', 'S']);
      const img = preview.querySelector('img')!;
      expect(img.getAttribute('src')).toBe('/api/m/m/file?path=%2Fhome%2Fu%2Fdocs%2Fdiagram.png');
      expect(img.getAttribute('width')).toBe('200');
      expect(img.getAttribute('onerror')).toBeNull();
      expect(preview.querySelector('script')).toBeNull();
      expect(preview.querySelector('style')).toBeNull();
      expect(preview.querySelector('iframe')).toBeNull();
      expect(preview.textContent).not.toContain('display:none');
    });

    it('opens .mdx files with a target line in Source mode and reveals the line range', async () => {
      const mdx = 'line 1\nline 2\n# Heading\nline 4\nline 5';
      file = { text: mdx, size: mdx.length, mtime: 7000 };
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/doc.mdx', line: 3, col: 1, endLine: 4, reveal: 1 },
            focused: true,
          }),
        ),
      );
      await flush();
      await flush();
      expect(button(t('files.markdown.source'))?.getAttribute('aria-pressed')).toBe('true');
      expect(host.querySelector('.files-md-preview')).toBeNull();
      expect(editor.selections).toEqual([{ startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 7 }]);
    });

    it('live-updates Markdown Preview when the file changes on disk even before Monaco is created', async () => {
      const { createEditor } = await import('../plugins/monaco');
      vi.mocked(createEditor).mockClear();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        file = { text: '# Initial Title\n', size: 16, mtime: 7000 };
        await act(async () =>
          root.render(
            createElement(EditorPane, {
              m: 'm',
              pane: 'view:v1',
              view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/live.markdown' },
              focused: true,
            }),
          ),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Initial Title');
        expect(createEditor).not.toHaveBeenCalled();

        // File updates on disk while still in Preview-only mode.
        file = { text: '# Updated From Disk\n', size: 20, mtime: 8000 };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(CHECK_MS);
        });
        expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Updated From Disk');
        expect(createEditor).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('remote file performance & tab-switch caching', () => {
    it('revalidates stale cache silently in the background on tab switch without flashing "Loading…"', async () => {
      const { REVALIDATE_MS, putCachedFile } = await import('../plugins/files/fileCache');
      file = { text: 'v2 from disk', size: 12, mtime: 9000 };
      // Seed cache with an older (stale) version verified > REVALIDATE_MS ago.
      putCachedFile('m', '/home/u/stale.txt', 'v1 cached', { size: 9, mtime: 7000, bom: false }, Date.now() - REVALIDATE_MS - 500);
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/stale.txt' },
            focused: true,
          }),
        ),
      );
      // Immediately hydrated without flashing "Loading…".
      expect(host.textContent).not.toContain(t('files.loading'));
      await flush();
      await flush();
      // Background stat detected mtime change and reloaded smoothly to v2.
      expect(statRequests).toEqual([['/home/u/stale.txt']]);
      expect(fileRequests).toHaveLength(1);
      expect(editor.model?.getValue()).toBe('v2 from disk');
      expect(host.textContent).not.toContain(t('files.loading'));
    });
    it('loads in a single GET request (no HEAD) and hydrates immediately without "Loading…" on tab switch', async () => {
      file = { text: 'cached content', size: 14, mtime: 7000 };
      await render('/home/u/remote.yaml');
      // Single GET with max_size — zero HEAD round-trips!
      expect(fileRequests).toHaveLength(1);
      expect(fileRequests[0].method).toBe('GET');
      expect(fileRequests[0].maxSize).toBe(String(8 << 20));
      expect(editor.model?.getValue()).toBe('cached content');

      // Switch away (unmount) and return (remount): NO "Loading…" and NO extra /file fetch!
      fileRequests.length = 0;
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/remote.yaml' },
            focused: true,
          }),
        ),
      );
      // Immediately rendered without "Loading…".
      expect(host.textContent).not.toContain(t('files.loading'));
      await flush();
      await flush();
      expect(fileRequests).toHaveLength(0);
      expect(editor.model?.getValue()).toBe('cached content');
    });

    it('hydrates dirty kept files immediately on tab switch without waiting for GET /file', async () => {
      useTerms.setState({
        machines: {
          m: {
            terminals: {},
            layout: {
              workspaces: [
                { id: 'w', tabs: [{ root: { view: { id: 'v1', plugin: 'files', kind: 'editor' } }, focused: 'view:v1' }], selected: 0 },
              ],
              selected: 0,
            } as unknown as Layout,
          },
        },
      });
      await render('/home/u/dirty.txt');
      await act(async () => editor.model!.setValue('unsaved work'));
      await act(async () => root.unmount());

      // Block GET /file indefinitely — tab switch back must NOT wait on it or show "Loading…".
      fileRequests.length = 0;
      hold = new Promise(() => {});
      root = createRoot(host);
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/dirty.txt' },
            focused: true,
          }),
        ),
      );
      expect(host.textContent).not.toContain(t('files.loading'));
      await flush();
      await flush();
      expect(fileRequests).toHaveLength(0);
      expect(editor.model?.getValue()).toBe('unsaved work');
      dropEdit('m', 'view:v1');
    });

    it('pauses disk polling while a kept pane is hidden (shown=false)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        await act(async () =>
          root.render(
            createElement(EditorPane, {
              m: 'm',
              pane: 'view:v1',
              view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/bg.txt' },
              focused: false,
              shown: false,
            }),
          ),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(CHECK_MS * 3);
        });
        expect(statRequests).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows a folder notice with Show in Explorer when /file reports a directory', async () => {
      fileStatus = 400;
      fileErrorBody = 'is a directory\n';
      await render('/home/u/configs');
      expect(host.textContent).toContain(t('files.isDir', { name: 'configs' }));
      expect(button(t('files.reveal'))).toBeDefined();
    });

    it('switches a mounted preview pane from file A to delayed cold-loaded file B without showing A’s content', async () => {
      const { createEditor } = await import('../plugins/monaco');
      file = { text: 'content of A', size: 12, mtime: 7000 };
      await render('/home/u/a.ts');
      expect(editor.model?.getValue()).toBe('content of A');

      // Switch the same mounted pane to cold-loaded file B whose remote fetch is slow.
      vi.mocked(createEditor).mockClear();
      file = { text: 'content of B', size: 12, mtime: 8000 };
      let release = () => {};
      hold = new Promise<void>((r) => (release = r));
      await act(async () =>
        root.render(
          createElement(EditorPane, {
            m: 'm',
            pane: 'view:v1',
            view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/b.ts', preview: true },
            focused: true,
          }),
        ),
      );
      await flush();
      // Monaco must NOT mount with A's stale text while B is still loading.
      expect(createEditor).not.toHaveBeenCalled();
      expect(host.textContent).toContain(t('files.loading'));

      // Once B finishes loading, Monaco mounts with B's text (never A's).
      hold = undefined;
      release();
      await flush();
      await flush();
      expect(createEditor).toHaveBeenCalledTimes(1);
      expect(editor.model?.getValue()).toBe('content of B');
    });

    it('switches a mounted preview pane from .ts to .md in Preview mode without mounting Monaco', async () => {
      const { createEditor } = await import('../plugins/monaco');
      file = { text: 'const x = 1;\n', size: 13, mtime: 7000 };
      await render('/home/u/app.ts');
      expect(editor.model?.getValue()).toBe('const x = 1;\n');

      vi.mocked(createEditor).mockClear();
      file = { text: '# Switched Markdown\n', size: 20, mtime: 8000 };
      await render('/home/u/doc.md');
      await vi.waitFor(() => expect(host.querySelector('.files-md-preview h1')?.textContent).toBe('Switched Markdown'), { timeout: 5000 });
      expect(createEditor).not.toHaveBeenCalled();
      expect(button(t('files.markdown.preview'))?.getAttribute('aria-pressed')).toBe('true');
    });

    it('mounts Monaco when reloading after an initial read error (both text and missing file)', async () => {
      const { createEditor } = await import('../plugins/monaco');
      vi.mocked(createEditor).mockClear();
      fileStatus = 500;
      await render('/home/u/flaky.ts');
      expect(host.querySelector('.files-editor-note.error')).not.toBeNull();
      expect(createEditor).not.toHaveBeenCalled();

      // Reload succeeds with text: Monaco mounts and displays it.
      fileStatus = undefined;
      file = { text: 'recovered text', size: 14, mtime: 9000 };
      await act(async () => button(t('files.revert'))!.click());
      await flush();
      await flush();
      expect(createEditor).toHaveBeenCalledTimes(1);
      expect(editor.model?.getValue()).toBe('recovered text');

      // Reload after initial error into a missing (404) file opens an empty editable buffer.
      vi.mocked(createEditor).mockClear();
      fileStatus = 500;
      await render('/home/u/missing-after-err.ts');
      expect(createEditor).not.toHaveBeenCalled();
      fileStatus = undefined;
      file = undefined;
      await act(async () => button(t('files.revert'))!.click());
      await flush();
      await flush();
      expect(createEditor).toHaveBeenCalledTimes(1);
      expect(editor.model?.getValue()).toBe('');
    });

    it('pauses audio/video playback when a media pane is hidden (shown=false)', async () => {
      const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
      try {
        await act(async () =>
          root.render(
            createElement(EditorPane, {
              m: 'm',
              pane: 'view:v1',
              view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/track.mp3' },
              focused: true,
              shown: true,
            }),
          ),
        );
        expect(host.querySelector('audio')).not.toBeNull();
        pauseSpy.mockClear();
        await act(async () =>
          root.render(
            createElement(EditorPane, {
              m: 'm',
              pane: 'view:v1',
              view: { id: 'v1', plugin: 'files', kind: 'editor', path: '/home/u/track.mp3' },
              focused: false,
              shown: false,
            }),
          ),
        );
        expect(pauseSpy).toHaveBeenCalled();
      } finally {
        pauseSpy.mockRestore();
      }
    });
  });
});

describe('eolOf', () => {
  it('gives the line end Monaco makes a model’s', () => {
    expect(eolOf('one line')).toBeUndefined();
    expect(eolOf('a\nb\n')).toBe('\n');
    expect(eolOf('a\r\nb\r\n')).toBe('\r\n');
    expect(eolOf('a\r\nb\n')).toBe('\n');
    expect(eolOf('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(eolOf('a\rb\r')).toBe('\r\n');
  });
});
