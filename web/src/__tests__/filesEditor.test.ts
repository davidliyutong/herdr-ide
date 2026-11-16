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
}

type FakeDecoration = { range: { start: number; end: number }; options: { linesDecorationsClassName: string } };

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
  addCommand(_key: number, f: () => void) {
    this.save = f;
  },
  updateOptions(o: { readOnly?: boolean }) {
    this.readOnly = o.readOnly;
  },
  focus() {},
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
const monaco = {
  Uri: { from: (o: unknown) => o },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  Range: class {
    constructor(
      public start: number,
      _c: number,
      public end: number,
    ) {}
  },
  editor: { getModel: () => null, createModel: () => new FakeModel(), OverviewRulerLane: { Left: 1 } },
};
vi.mock('../plugins/monaco', () => ({
  createEditor: vi.fn(async (_el: HTMLElement, o: { readOnly?: boolean }) => {
    editor.readOnly = o.readOnly;
    return { monaco, editor };
  }),
}));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { EditorPane, loadText, versionOf } from '../plugins/files/EditorPane';
import { registerQuickDiff } from '../plugins/files/quickDiff';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The file on the machine. */
let file: { text: string | Uint8Array<ArrayBuffer>; size: number; mtime: number } | undefined;
const writes: Array<{ q: URLSearchParams; body: string }> = [];

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/m/m/file') {
      if (!file) return new Response('not found', { status: 404 });
      const etag = `W/"${file.size.toString(16)}-${file.mtime.toString(16)}"`;
      const headers = { ETag: etag, 'Content-Length': String(file.size) };
      return new Response(method === 'HEAD' ? null : file.text, { status: 200, headers });
    }
    if (url.pathname === '/api/m/m/p/files/write') {
      const body = new TextDecoder().decode(init!.body as Uint8Array);
      writes.push({ q: url.searchParams, body });
      const q = url.searchParams;
      const cur = file ? { path: q.get('path'), exists: true, size: file.size, mtime: file.mtime } : { path: q.get('path'), exists: false };
      const matches =
        q.get('force') === '1' ||
        (file && +q.get('mtime')! === file.mtime && +q.get('size')! === file.size) ||
        (!file && q.get('new') === '1');
      if (!matches) return new Response(JSON.stringify({ error: 'conflict', current: cur }), { status: 409 });
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
    writes.length = 0;
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

  it('shows media as Quick Look does, without the text editor', async () => {
    await render('/home/u/cat.png');
    expect(host.querySelector('img')?.getAttribute('src')).toContain('cat.png');
    expect(host.querySelector('.files-editor-host')).toBeNull();
  });
});
