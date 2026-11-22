// @vitest-environment jsdom
//
// Uploads into the file explorer (plugins/files/upload.ts): dropped folders
// read with their contents, the folders made before their files, names
// taken asked about once (replace, keep both, skip, for all), a folder as
// one upload of the uploads panel, the menus' entries, and rows dragged
// out of the page as downloads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeXhr } from './fakeXhr';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));
vi.mock('../plugins/monaco', () => ({ createEditor: vi.fn(), loadMonaco: vi.fn() }));
vi.stubGlobal('XMLHttpRequest', FakeXhr);

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { isItem, type MenuItem } from '../contextMenu';
import { useDialog, type DialogRequest } from '../dialog';
import { t } from '../i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { innerFolders, readEntries, uploadInto, type Picked } from '../plugins/files/upload';
import { menuFor, panelMenu, pasteFiles } from '../plugins/files/ops';
import { dragOutUrl, FilesPanel } from '../plugins/files/FilesPanel';
import { useTree } from '../plugins/files/tree';
import { cancelUpload, uploadPlaced, useTransfers } from '../transfers';
import { UploadCancelled } from '../lib/files';
import { FakeCore, settle } from './fakeTerms';

const file = (name: string, size = 3) => new File([new Uint8Array(size)], name);
const pick = (rel: string, size = 3): Picked => ({ rel, file: file(rel.split('/').pop()!, size) });

/** What the machine has, by path: true for a folder. */
let there: Record<string, boolean>;
const posts: Array<[string, unknown]> = [];

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const action = url.pathname.replace('/api/m/m/p/files/', '');
    posts.push([action, body]);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (action === 'stat')
      return json({ entries: body.paths.map((p: string) => ({ path: p, exists: p in there, is_dir: !!there[p], size: 0, mtime: 1 })) });
    if (action === 'mkdir') {
      let p = body.path;
      for (let i = 1; body.unique && p in there; i++) p = `${body.path}-${i}`;
      there[p] = true;
      return json({ paths: [p] });
    }
    if (action === 'mkdirs') {
      for (const p of body.paths) there[p] = true;
      return json({ paths: body.paths });
    }
    return json({ dir: { path: '/r' }, entries: [] });
  });
}

/** The uploads sent: path and whether they replace. */
const uploads = () =>
  FakeXhr.requests.map((r) => {
    const q = new URL(r.url, 'http://x').searchParams;
    return [q.get('path'), q.get('replace') === '1'];
  });

/** Answers the dialog shown: replace, keep, skip or cancel, with the box. */
async function answer(how: 'replace' | 'keep' | 'skip' | 'cancel', all = false) {
  for (let i = 0; i < 50 && !useDialog.getState().current; i++) await new Promise((r) => setTimeout(r));
  const req = useDialog.getState().current as Extract<DialogRequest, { kind: 'confirm' }>;
  expect(req?.kind).toBe('confirm');
  useDialog.setState({ current: undefined });
  req.resolve(how === 'replace', all, how === 'keep', how === 'skip');
  return req;
}

beforeEach(() => {
  FakeXhr.reset();
  FakeXhr.reply = (url) => [200, { paths: [new URL(url, 'http://x').searchParams.get('path')] }];
  there = {};
  posts.length = 0;
  stubFetch();
  localStorage.clear();
  useTransfers.setState({ active: [], history: [], panel: false });
  useDialog.setState({ current: undefined });
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'm', label: 'box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  useTree.setState({ m: 'm', root: '/r', dirs: { '/r': { entries: [] } }, expanded: {}, selection: [], cursor: undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

describe('reading a drop', () => {
  /** A folder entry whose reader answers in batches of two. */
  const dirEntry = (name: string, children: FileSystemEntry[]): FileSystemEntry =>
    ({
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let at = 0;
        return {
          readEntries: (ok: (b: FileSystemEntry[]) => void) => {
            const batch = children.slice(at, at + 2);
            at += 2;
            setTimeout(() => ok(batch));
          },
        };
      },
    }) as unknown as FileSystemEntry;
  const fileEntry = (name: string, fail = false): FileSystemEntry =>
    ({
      name,
      isFile: true,
      isDirectory: false,
      file: (ok: (f: File) => void, err: (e: Error) => void) => (fail ? err(new Error('denied')) : ok(file(name))),
    }) as unknown as FileSystemEntry;

  it('takes folders with everything in them, read in batches', async () => {
    const tree = dirEntry('photos', [
      fileEntry('a.jpg'),
      dirEntry('2024', [fileEntry('b.jpg'), fileEntry('c.jpg'), fileEntry('d.jpg')]),
      dirEntry('empty', []),
      fileEntry('secret', true),
    ]);
    const { picked, unreadable } = await readEntries([tree, file('top.txt')]);
    expect(picked.map((p) => [p.rel, !!p.file])).toEqual([
      ['photos', false],
      ['photos/a.jpg', true],
      ['photos/2024', false],
      ['photos/2024/b.jpg', true],
      ['photos/2024/c.jpg', true],
      ['photos/2024/d.jpg', true],
      ['photos/empty', false],
      ['top.txt', true],
    ]);
    expect(unreadable).toBe(1);
  });

  it('makes only the deepest folders, which make those above', () => {
    expect(innerFolders([{ rel: 'p' }, pick('p/a/b/x'), { rel: 'p/a' }, { rel: 'p/e' }, pick('p/y')])).toEqual(['a/b', 'e']);
  });
});

describe('uploading into a folder', () => {
  it('sends files, and folders as one upload each after making their folders', async () => {
    await uploadInto('m', '/r', [
      pick('a.txt'),
      { rel: 'photos' },
      pick('photos/2024/b.jpg', 5),
      pick('photos/c.jpg', 7),
      { rel: 'photos/empty' },
    ]);
    expect(posts.filter(([a]) => a === 'mkdir' || a === 'mkdirs')).toEqual([
      ['mkdir', { path: '/r/photos', unique: true }],
      ['mkdirs', { paths: ['/r/photos/2024', '/r/photos/empty'] }],
    ]);
    expect(uploads()).toEqual([
      ['/r/a.txt', false],
      ['/r/photos/2024/b.jpg', false],
      ['/r/photos/c.jpg', false],
    ]);
    const h = useTransfers.getState().history;
    expect(h.map((x) => [x.name, x.status, x.size, x.path])).toEqual([
      ['photos', 'done', 12, '/r/photos'],
      ['a.txt', 'done', 3, '/r/a.txt'],
    ]);
  });

  it('asks about names taken: replace, keep both, skip, once for all; cancel stops it all', async () => {
    there = { '/r/a.txt': false, '/r/b.txt': false, '/r/c.txt': false, '/r/d.txt': false, '/r/dir': false };
    const done = uploadInto('m', '/r', [pick('a.txt'), pick('b.txt'), pick('c.txt'), pick('d.txt'), pick('dir/x'), pick('new.txt')]);
    const first = await answer('replace');
    expect(first.title).toBe(t('files.upload.conflictTitle'));
    expect(first.cancel).toBeUndefined(); // Cancel
    expect(first.extra).toBe(t('files.upload.skip'));
    expect(first.check).toBe(t('files.upload.applyAll', { n: 3 }));
    await answer('keep');
    await answer('skip', true);
    await done;
    // d.txt skipped with the box; dir is a file there: the folder goes beside it.
    expect(uploads()).toEqual([
      ['/r/a.txt', true],
      ['/r/b.txt', false],
      ['/r/dir-1/x', false],
      ['/r/new.txt', false],
    ]);
    expect(useDialog.getState().current).toBeUndefined();

    // Cancelled at the second name: nothing goes, not even the names free.
    FakeXhr.reset();
    const again = uploadInto('m', '/r', [pick('a.txt'), pick('b.txt'), pick('new.txt')]);
    await answer('replace');
    await answer('cancel');
    await again;
    expect(uploads()).toEqual([]);
    expect(useDialog.getState().current).toBeUndefined();
  });

  it('offers no Skip when the name taken is all that goes', async () => {
    there = { '/r/a.txt': false };
    const done = uploadInto('m', '/r', [pick('a.txt')]);
    const req = await answer('cancel');
    expect(req.extra).toBeUndefined();
    expect(req.check).toBeUndefined();
    await done;
    expect(uploads()).toEqual([]);
  });

  it('merges a folder replaced: its files replace those of the same names', async () => {
    there = { '/r/photos': true };
    const done = uploadInto('m', '/r', [{ rel: 'photos' }, pick('photos/sub/a.jpg')]);
    const req = await answer('replace');
    expect(req.message).toBe(t('files.upload.folderExists', { name: 'photos', dir: '/r' }));
    await done;
    expect(posts.some(([a]) => a === 'mkdir')).toBe(false);
    expect(posts.find(([a]) => a === 'mkdirs')).toEqual(['mkdirs', { paths: ['/r/photos/sub'] }]);
    expect(uploads()).toEqual([['/r/photos/sub/a.jpg', true]]);
  });
});

describe('a folder as one upload', () => {
  it('adds up its files, fails once its files went, and stops when cancelled', async () => {
    FakeXhr.reply = undefined;
    const files = [file('a', 10), file('b', 20), file('c', 30)];
    const sent: number[] = [];
    let fail = 1;
    const done = uploadPlaced('m', [
      {
        name: 'dir',
        dir: '/r',
        files,
        path: '/r/dir',
        send: async (k, o) => {
          sent.push(k);
          o.onProgress?.(files[k].size / 2);
          if (k === fail) throw new Error('nope');
          return `/r/dir/${files[k].name}`;
        },
      },
    ]);
    await done;
    expect(sent).toEqual([0, 1, 2]);
    const x = useTransfers.getState().history[0];
    expect(x).toMatchObject({ name: 'dir', status: 'failed', size: 60 });
    expect(x.error).toBe(t('transfers.someFailed', { n: 1, total: 3, name: 'b', error: 'nope' }));

    // Cancelled: the files after it are not sent.
    sent.length = 0;
    fail = -1;
    let id = '';
    const second = uploadPlaced('m', [
      {
        name: 'dir2',
        dir: '/r',
        files,
        send: (k, o) =>
          new Promise((resolve, reject) => {
            sent.push(k);
            id = useTransfers.getState().active[0].id;
            o.signal?.addEventListener('abort', () => reject(new UploadCancelled()));
            if (k === 0) resolve('/r/dir2/a');
          }),
      },
    ]);
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((r) => setTimeout(r));
    cancelUpload(id);
    await second;
    expect(sent).toEqual([0, 1]);
    expect(useTransfers.getState().history[0]).toMatchObject({ name: 'dir2', status: 'cancelled' });
  });
});

describe('menus', () => {
  const labels = (entries: ReturnType<typeof menuFor>) => entries.filter(isItem).map((e: MenuItem) => e.label);

  it('offer uploads on folders and the empty space, transfers, and nothing that writes in read-only mode', () => {
    const isDir = (p: string) => p === '/r/dir';
    expect(labels(menuFor('m', ['/r/dir'], isDir))).toEqual(expect.arrayContaining([t('files.uploadFiles'), t('files.uploadFolder')]));
    expect(labels(menuFor('m', ['/r/a.txt'], isDir))).not.toContain(t('files.uploadFiles'));
    const empty = labels(menuFor('m', [], isDir));
    expect(empty).toEqual(expect.arrayContaining([t('files.uploadFiles'), t('files.showUploads'), t('files.showDownloads')]));
    useTree.setState({ selection: ['/r/a.txt', '/r/dir'] });
    expect(labels(panelMenu('m', isDir))).toEqual(
      expect.arrayContaining([t('files.uploadFiles'), t('files.uploadFolder'), t('files.download'), t('files.showUploads')]),
    );
    useStore.getState().setReadOnly(true);
    expect(labels(menuFor('m', [], isDir))).not.toContain(t('files.uploadFiles'));
    expect(labels(panelMenu('m', isDir))).not.toContain(t('files.uploadFolder'));
    expect(labels(panelMenu('m', isDir))).toContain(t('files.download'));
  });

  it('show the uploads and downloads panels', () => {
    const item = menuFor('m', [], () => false).find((e): e is MenuItem => isItem(e) && e.label === t('files.showUploads'))!;
    item.run!();
    expect(useTransfers.getState().panel).toBe(true);
  });
});

describe('pasting locally copied files', () => {
  const dirEntry = (name: string, children: FileSystemEntry[]): FileSystemEntry =>
    ({
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let done = false;
        return {
          readEntries: (ok: (b: FileSystemEntry[]) => void) => {
            const batch = done ? [] : children;
            done = true;
            setTimeout(() => ok(batch));
          },
        };
      },
    }) as unknown as FileSystemEntry;
  const fileEntry = (name: string): FileSystemEntry =>
    ({
      name,
      isFile: true,
      isDirectory: false,
      file: (ok: (f: File) => void) => ok(file(name)),
    }) as unknown as FileSystemEntry;

  it('uploads pasted clipboard files and folders onto a remote machine', async () => {
    const folder = dirEntry('assets', [fileEntry('logo.png')]);
    const items = [
      { kind: 'file', type: '', webkitGetAsEntry: () => folder, getAsFile: () => null },
      { kind: 'file', type: 'text/plain', webkitGetAsEntry: () => null, getAsFile: () => file('note.txt', 5) },
    ] as unknown as DataTransferItemList;
    await pasteFiles('m', '/r/sub', { items, files: [] as unknown as FileList });
    expect(posts.filter(([a]) => a === 'mkdir')).toEqual([['mkdir', { path: '/r/sub/assets', unique: true }]]);
    expect(uploads()).toEqual([
      ['/r/sub/assets/logo.png', false],
      ['/r/sub/note.txt', false],
    ]);
    expect(useTree.getState().expanded['/r/sub']).toBe(true);
    expect(
      useStore.getState().toasts.some((toast) => toast.msg.includes(t('surface.uploadingInto', { n: 2, machine: 'box', dir: '/r/sub' }))),
    ).toBe(true);
  });

  it('falls back to clipboardData.files and handles unnamed clipboard images', async () => {
    const img = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' });
    await pasteFiles('m', '/r', {
      items: [] as unknown as DataTransferItemList,
      files: [img, file('doc.pdf', 4)] as unknown as FileList,
    });
    expect(uploads()).toEqual([
      ['/r/paste.png', false],
      ['/r/doc.pdf', false],
    ]);
  });

  it('reports unreadable pasted items with an error toast', async () => {
    const badEntry = {
      name: 'secret',
      isFile: true,
      isDirectory: false,
      file: (_ok: (f: File) => void, err: (e: Error) => void) => err(new Error('denied')),
    } as unknown as FileSystemEntry;
    const items = [{ kind: 'file', type: '', webkitGetAsEntry: () => badEntry, getAsFile: () => null }] as unknown as DataTransferItemList;
    await pasteFiles('m', '/r', { items, files: [] as unknown as FileList });
    expect(uploads()).toEqual([]);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      msg: t('files.paste.unreadable', { n: 1 }),
      kind: 'error',
    });
  });

  it('uploads when Electron desktopShell.pathForFile is present for a remote machine, and copies on local', async () => {
    const prevShell = (globalThis as { desktopShell?: unknown }).desktopShell;
    (globalThis as { desktopShell?: { pathForFile: (f: File) => string } }).desktopShell = {
      pathForFile: (f: File) => `/Users/me/Desktop/${f.name}`,
    };
    vi.resetModules();
    try {
      const { pasteFiles: pasteWithShell } = await import('../plugins/files/ops');
      const { useStore: storeWithShell } = await import('../state/store');
      storeWithShell.getState().setReadOnly(false);
      storeWithShell
        .getState()
        .setMachines([
          { id: 'm', label: 'box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState,
          { id: 'local', label: 'mac', kind: 'local', status: 'ready', info: { home: '/Users/me' } } as unknown as MachineState,
        ]);

      // Remote machine: still uploads rather than copying local paths on the remote host.
      const f1 = file('remote.txt', 6);
      await pasteWithShell('m', '/r', {
        items: [{ kind: 'file', type: 'text/plain', webkitGetAsEntry: () => null, getAsFile: () => f1 }] as unknown as DataTransferItemList,
        files: [f1] as unknown as FileList,
      });
      expect(uploads()).toEqual([['/r/remote.txt', false]]);
      expect(posts.some(([a]) => a === 'copy')).toBe(false);

      // Local machine: copies local file paths directly.
      const copied: Array<{ paths: string[]; dir: string }> = [];
      vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://x');
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (url.pathname === '/api/m/local/p/files/copy') copied.push(body);
        return new Response(JSON.stringify({ paths: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const f2 = file('local.txt', 6);
      await pasteWithShell('local', '/Users/me/dest', {
        items: [{ kind: 'file', type: 'text/plain', webkitGetAsEntry: () => null, getAsFile: () => f2 }] as unknown as DataTransferItemList,
        files: [f2] as unknown as FileList,
      });
      expect(copied).toEqual([{ paths: ['/Users/me/Desktop/local.txt'], dir: '/Users/me/dest' }]);
    } finally {
      if (prevShell === undefined) delete (globalThis as { desktopShell?: unknown }).desktopShell;
      else (globalThis as { desktopShell?: unknown }).desktopShell = prevShell;
      vi.resetModules();
    }
  });

  it('handles paste events on a focused folder/node in FilesPanel and ignores inputs and read-only mode', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('p1', { cwd: '/home/u/src' })], {
      version: 2,
      workspaces: [{ id: 'w1w1w1w1', name: 'one', cwd: '', tabs: [{ root: { terminal: 'p1' }, focused: 'p1' }], selected: 0 }],
      selected: 0,
    });
    core.install();
    useStore.getState().selectMachine('m');
    core.model.subscribe('m');
    await settle();

    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/m/m/list') {
        const p = url.searchParams.get('path')!;
        if (p === '/home/u/src')
          return json({
            dir: { path: p },
            entries: [
              { name: 'sub', is_dir: true, size: 0, mode: 0o755, mtime: 1 },
              { name: 'a.txt', is_dir: false, size: 1, mode: 0o644, mtime: 1 },
            ],
          });
        return json({ dir: { path: p }, entries: [] });
      }
      if (url.pathname === '/api/m/m/p/files/stat') {
        return json({ entries: body.paths.map((p: string) => ({ path: p, exists: false, is_dir: false, size: 0, mtime: 1 })) });
      }
      return json({ paths: [] });
    });

    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    try {
      await act(async () => root.render(createElement(FilesPanel)));
      await act(async () => settle());

      // Focus the 'sub' folder row and paste a file.
      await act(async () => host.querySelector<HTMLElement>('.files-row[data-path="/home/u/src/sub"]')!.click());
      await act(async () => settle());
      const tree = host.querySelector<HTMLElement>('.files-tree')!;
      const dispatchPaste = async (target: HTMLElement, files: File[]) => {
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: { files, items: [] } });
        await act(async () => target.dispatchEvent(ev));
        await act(async () => settle());
        return ev;
      };

      const ev1 = await dispatchPaste(tree, [file('pasted.txt', 4)]);
      expect(ev1.defaultPrevented).toBe(true);
      expect(uploads()).toEqual([['/home/u/src/sub/pasted.txt', false]]);

      // Focusing a file row pastes into its parent directory (/home/u/src).
      FakeXhr.reset();
      await act(async () => host.querySelector<HTMLElement>('.files-row[data-path="/home/u/src/a.txt"]')!.click());
      await act(async () => settle());
      await dispatchPaste(tree, [file('sibling.txt', 4)]);
      expect(uploads()).toEqual([['/home/u/src/sibling.txt', false]]);

      // Pasting inside an inline edit input does not trigger file upload.
      FakeXhr.reset();
      await act(async () => tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
      const input = host.querySelector<HTMLInputElement>('.files-row input')!;
      const evInput = await dispatchPaste(input, [file('ignored.txt', 4)]);
      expect(evInput.defaultPrevented).toBe(false);
      expect(uploads()).toEqual([]);

      // Read-only mode ignores file paste.
      await act(async () => useStore.getState().setReadOnly(true));
      const evRo = await dispatchPaste(tree, [file('ro.txt', 4)]);
      expect(evRo.defaultPrevented).toBe(false);
      expect(uploads()).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe('dragging rows out of the page', () => {
  it('downloads a file as itself and anything else as a zip', () => {
    const isDir = (p: string) => p.endsWith('dir');
    const url = (paths: string[]) => dragOutUrl('m', paths, isDir)!;
    expect(url(['/r/a:b.txt'])).toBe(`application/octet-stream:a_b.txt:${location.origin}/api/m/m/download?path=%2Fr%2Fa%3Ab.txt`);
    expect(url(['/r/dir']).split(':')[1]).toBe('dir.zip');
    expect(url(['/r/x/a', '/r/y/b']).split(':')[1]).toBe('r.zip');
    expect(url(['/a', '/b']).split(':')[1]).toBe('download.zip');
  });
});
