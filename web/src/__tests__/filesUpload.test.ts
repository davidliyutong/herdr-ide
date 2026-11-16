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
import { innerFolders, readEntries, uploadInto, type Picked } from '../plugins/files/upload';
import { menuFor, panelMenu } from '../plugins/files/ops';
import { dragOutUrl } from '../plugins/files/FilesPanel';
import { useTree } from '../plugins/files/tree';
import { cancelUpload, uploadPlaced, useTransfers } from '../transfers';
import { UploadCancelled } from '../lib/files';

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

/** Answers the dialog shown: replace, keep or skip, with the box. */
async function answer(how: 'replace' | 'keep' | 'skip', all = false) {
  for (let i = 0; i < 50 && !useDialog.getState().current; i++) await new Promise((r) => setTimeout(r));
  const req = useDialog.getState().current as Extract<DialogRequest, { kind: 'confirm' }>;
  expect(req?.kind).toBe('confirm');
  useDialog.setState({ current: undefined });
  req.resolve(how === 'replace', all, how === 'keep');
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

  it('asks about names taken: replace, keep both, skip, once for all', async () => {
    there = { '/r/a.txt': false, '/r/b.txt': false, '/r/c.txt': false, '/r/d.txt': false, '/r/dir': false };
    const done = uploadInto('m', '/r', [pick('a.txt'), pick('b.txt'), pick('c.txt'), pick('d.txt'), pick('dir/x'), pick('new.txt')]);
    const first = await answer('replace');
    expect(first.title).toBe(t('files.upload.conflictTitle'));
    expect(first.cancel).toBe(t('files.upload.skip'));
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
