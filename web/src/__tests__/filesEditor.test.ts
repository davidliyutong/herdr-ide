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

class FakeModel {
  value = '';
  version = 1;
  private listeners: Array<() => void> = [];
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
  getVersionId() {
    return this.version;
  }
  /** Changes made as edits undo takes back (pushEditOperations). */
  edits = 0;
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
  dispose() {},
  onDidChangeModelContent(l: () => void) {
    this.model?.onDidChangeContent(l);
    return { dispose() {} };
  },
  /** The quick diff's decorations shown last. */
  decorations: [] as FakeDecoration[],
  createDecorationsCollection(d: FakeDecoration[]) {
    editor.decorations = d;
    return { clear: () => (editor.decorations = []) };
  },
};
let separate = false;
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
  editor: { getModel: () => null, createModel: () => new FakeModel(), OverviewRulerLane: { Left: 1 } },
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
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { CHECK_MS, EditorPane, loadText, versionOf } from '../plugins/files/EditorPane';
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
/** While set, reading the file's contents waits for it. */
let hold: Promise<void> | undefined;
const writes: Array<{ q: URLSearchParams; body: string; raw: Uint8Array }> = [];
/** The next write stops partway (the machine's disk is full). */
let failWrite = false;

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/m/m/file') {
      if (fileStatus) return new Response('lstat: input/output error', { status: fileStatus });
      if (!file) return new Response('not found', { status: 404 });
      const etag = `W/"${file.size.toString(16)}-${file.mtime.toString(16)}"`;
      const headers = { ETag: etag, 'Content-Length': String(file.size) };
      if (method !== 'HEAD' && hold) await hold;
      return new Response(method === 'HEAD' ? null : file.text, { status: 200, headers });
    }
    if (url.pathname === '/api/m/m/p/files/stat') {
      const { paths } = JSON.parse(init!.body as string) as { paths: string[] };
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
    hold = undefined;
    writes.length = 0;
    failWrite = false;
    useStore.setState({ toasts: [] });
    editor.model = undefined;
    editor.save = undefined;
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

  it('forwards focus on the editor root into Monaco so escaping back to the pane works', async () => {
    await render();
    focusSpy.mockClear();
    const rootEl = host.querySelector<HTMLElement>('.files-editor')!;
    await act(async () => {
      rootEl.focus();
    });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});
