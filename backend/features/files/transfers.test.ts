// The transfers through a core whose machine's agent serves the real file
// system (testdata/agent.ts), behind Bun.serve: what a browser gets.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { sleep, TEST_INFO, waitFor } from '#kernel/testing.ts';
import { offline } from '#kernel/fail.ts';
import { statStatus } from './hub.ts';
import { serveFile, TransferFail } from './serve.ts';
import { filesCore, testPage, type FilesCore } from './testdata/hub.ts';

let dir: string;
let fc: FilesCore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'files-transfers-'));
  mkdirSync(join(dir, 'proj', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'proj', 'a.txt'), 'alpha');
  writeFileSync(join(dir, 'proj', 'sub', 'b.txt'), 'beta');
  writeFileSync(join(dir, 'notes é.md'), '# notes');
  // Sparse: more than the connections buffer.
  writeFileSync(join(dir, 'big.bin'), '');
  truncateSync(join(dir, 'big.bin'), 64 << 20);
  mkdirSync(join(dir, 'bigdir'));
  writeFileSync(join(dir, 'bigdir', 'big.bin'), '');
  truncateSync(join(dir, 'bigdir', 'big.bin'), 64 << 20);
  mkdirSync(join(dir, 'uploads'));
  fc = await filesCore({ info: { ...TEST_INFO, upload_dir: join(dir, 'uploads') } });
});

afterAll(async () => {
  await fc.stop();
  rmSync(dir, { recursive: true, force: true });
});

const query = (o: Record<string, string | string[]>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) q.append(k, x);
  return q.toString();
};
const at = (path: string) => join(dir, path);

const bodyReader = (res: Response) => res.body!.getReader();
type BodyReader = ReturnType<typeof bodyReader>;

/** Reads a body until 1 MiB came, then hands the reader back. */
async function readSome(res: Response): Promise<{ reader: BodyReader; got: number }> {
  const reader = bodyReader(res);
  let got = 0;
  while (got < 1 << 20) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
  }
  return { reader, got };
}

/** Reads the rest slowly: how it ended and how much came. */
async function readRest(reader: BodyReader, got: number): Promise<{ error: boolean; got: number }> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { error: false, got };
      got += value.length;
      await sleep(1);
    }
  } catch {
    return { error: true, got };
  }
}

describe('download', () => {
  const download = (...paths: string[]) => fetch(`${fc.url}/api/m/local/download?${query({ path: paths })}`);

  // One file comes as itself, a directory or several paths as a zip, both as
  // attachments that cannot run script.
  test('files and archives', async () => {
    let res = await download(at('notes é.md'));
    expect([res.status, await res.text(), res.headers.get('Content-Disposition')]).toEqual([
      200,
      '# notes',
      "attachment; filename*=utf-8''notes%20%C3%A9.md",
    ]);

    res = await download(at('proj'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename=proj.zip');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('proj/a.txt\nalphaproj/sub/b.txt\nbeta');

    res = await download(at('proj/a.txt'), at('proj/sub'));
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename=proj.zip');
    expect(await res.text()).toBe('a.txt\nalphasub/b.txt\nbeta');

    for (const [paths, status] of [
      [[at('missing')], 404],
      [[at('proj'), at('missing')], 404],
      [['relative/path'], 400],
    ] as const) {
      res = await download(...paths);
      expect([paths, res.status, res.headers.get('Content-Type')]).toEqual([paths, status, 'text/plain; charset=utf-8']);
    }
    // The page checks a path found in a pane before downloading it.
    const head = async (p: string) => (await fetch(`${fc.url}/api/m/local/download?${query({ path: p })}`, { method: 'HEAD' })).status;
    expect([await head(at('proj')), await head(at('proj/a.txt')), await head(at('nope'))]).toEqual([200, 200, 404]);
    const records = fc.tc.audit.records().filter((r) => r.event === 'file.download');
    expect(records).toContainEqual(expect.objectContaining({ machine: 'local', paths: [at('proj')] }));
    // HEAD requests are not downloads.
    expect(records.filter((r) => (r.paths as string[])[0] === at('nope'))).toEqual([]);
  });

  test('read-only mode downloads, as it shows files', async () => {
    const ro = await filesCore({ readOnly: true });
    try {
      const res = await fetch(`${ro.url}/api/m/local/download?${query({ path: at('proj/a.txt') })}`);
      expect([res.status, await res.text()]).toEqual([200, 'alpha']);
    } finally {
      await ro.stop();
    }
  });

  test('an unknown machine', async () => {
    const res = await fetch(`${fc.url}/api/m/nope/download?${query({ path: at('proj') })}`);
    expect([res.status, await res.text()]).toEqual([404, 'unknown machine\n']);
  });
});

describe('file', () => {
  const file = (p: string, init?: RequestInit, extra = '') => fetch(`${fc.url}/api/m/local/file?${query({ path: p })}${extra}`, init);

  // 404 only for a path that is not there: a file the agent cannot stat for
  // another reason is not taken for a new one (the editor would offer to
  // create it).
  test.skipIf(process.getuid?.() === 0)('stat failures', async () => {
    const locked = at('locked');
    mkdirSync(locked, { mode: 0o700 });
    writeFileSync(join(locked, 'f'), 'f');
    chmodSync(locked, 0);
    try {
      const want: Record<string, number> = { 'proj/a.txt': 200, missing: 404, 'proj/a.txt/below': 404, 'locked/f': 403 };
      for (const [p, status] of Object.entries(want)) expect([p, (await file(at(p), { method: 'HEAD' })).status]).toEqual([p, status]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('ranges, validators and headers', async () => {
    let res = await file(at('proj/a.txt'), { method: 'HEAD' });
    // The editor reads the size of a file before it loads it.
    expect(res.headers.get('Content-Length')).toBe('5');
    const etag = res.headers.get('ETag')!;
    expect(etag).toMatch(/^W\/"5-[0-9a-f]+"$/);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('Content-Disposition')).toBeNull();

    res = await file(at('proj/a.txt'), { headers: { Range: 'bytes=1-2' } });
    expect([res.status, res.headers.get('Content-Range'), await res.text()]).toEqual([206, 'bytes 1-2/5', 'lp']);
    res = await file(at('proj/a.txt'), { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(304);
    res = await file(at('proj/a.txt'), {}, '&download=1');
    expect([await res.text(), res.headers.get('Content-Disposition')]).toEqual(['alpha', 'attachment; filename=a.txt']);
    res = await file(at('notes é.md'));
    expect([res.headers.get('Content-Type'), await res.text()]).toEqual(['text/markdown; charset=utf-8', '# notes']);
    res = await file(at('proj'));
    expect([res.status, await res.text(), res.headers.get('Content-Type')]).toEqual([400, 'is a directory\n', 'text/plain; charset=utf-8']);
    res = await fetch(`${fc.url}/api/m/local/file`);
    expect(res.status).toBe(400);
  });

  test('statStatus', () => {
    const refused = (code: string | undefined, error: string) =>
      new AgentError('agent fs.stat: failed', { ok: false, error, ...(code ? { code } : {}) });
    const cases: Array<[unknown, number]> = [
      [offline(), 502],
      [new Error('timeout'), 502],
      [refused('not_found', ''), 404],
      [refused('denied', ''), 403],
      [refused(undefined, 'lstat /x: input/output error'), 502],
      // Agents from before the codes.
      [refused(undefined, 'lstat /x: no such file or directory'), 404],
      [refused(undefined, 'lstat /x/y: not a directory'), 404],
      [refused(undefined, 'lstat /x: permission denied'), 403],
    ];
    for (const [e, want] of cases) expect([String(e), statStatus(e)]).toEqual([String(e), want]);
  });
});

// /list: a directory of more names than a reply line holds (an archive just
// unpacked) is listed in full, its entries after the line; an empty one has
// an empty list.
test('list', async () => {
  const big = at('many');
  mkdirSync(big);
  mkdirSync(at('empty'));
  const prefix = 'extracted-file-with-a-long-name-'.repeat(7);
  for (let i = 0; i < 300; i++) writeFileSync(join(big, `${prefix}${String(i).padStart(6, '0')}.txt`), '');
  const list = async (p: string) => {
    const res = await fetch(`${fc.url}/api/m/local/list?${query({ path: p })}`);
    return { status: res.status, body: (await res.json()) as { entries: Array<{ name: string }>; dir: { path: string }; error?: string } };
  };
  let r = await list(big);
  expect([r.status, r.body.entries.length, r.body.entries[0].name, r.body.dir.path]).toEqual([200, 300, `${prefix}000000.txt`, big]);
  r = await list(at('empty'));
  expect([r.status, r.body.entries]).toEqual([200, []]);
  r = await list(at('missing'));
  // The UI matches the agent's text (dialog.ts folderProblem).
  expect(r.status).toBe(404);
  expect(r.body.error).toContain('no such file or directory');
});

describe('upload', () => {
  const upload = (q: Record<string, string>, body: RequestInit['body']) =>
    fetch(`${fc.url}/api/m/local/upload?${query(q)}`, { method: 'POST', body });

  test('into a directory and into the upload directory', async () => {
    mkdirSync(at('up'));
    let res = await upload({ name: 'shot.png', dir: at('up') }, 'whole');
    expect([res.status, ((await res.json()) as { path: string }).path]).toEqual([200, at('up/shot.png')]);
    res = await upload({ name: 'shot.png', dir: at('up') }, 'again');
    expect(((await res.json()) as { path: string }).path).toBe(at('up/shot-1.png'));
    expect([readFileSync(at('up/shot.png'), 'utf8'), readFileSync(at('up/shot-1.png'), 'utf8')]).toEqual(['whole', 'again']);

    res = await upload({ name: 'image.png' }, 'pasted');
    const st = (await res.json()) as { path: string };
    expect(st.path).toMatch(new RegExp(`^${at('uploads')}/\\d{8}-\\d{6}-[0-9a-f]{8}-image\\.png$`));
    expect(readFileSync(st.path, 'utf8')).toBe('pasted');
    expect(fc.tc.audit.records()).toContainEqual(
      expect.objectContaining({ event: 'file.upload', machine: 'local', path: st.path, size: 6 }),
    );

    res = await upload({ name: 'a', dir: 'proj' }, 'x');
    expect([res.status, await res.json()]).toEqual([400, { error: 'dir must be absolute', message: 'dir must be absolute' }]);
  });

  test('a cancelled upload leaves no file', async () => {
    const into = at('cancel');
    mkdirSync(into);
    const target = `/api/m/local/upload?${query({ name: 'big.bin', dir: into })}`;
    const s = connect(Number(new URL(fc.url).port), '127.0.0.1');
    s.on('error', () => {});
    s.write(`POST ${target} HTTP/1.1\r\nHost: ${new URL(fc.url).host}\r\nContent-Length: ${1 << 20}\r\n\r\n`);
    s.write(Buffer.alloc(64 << 10));
    await waitFor('the private file of the upload', () => readdirSync(into).some((n) => n.startsWith(`.${SLUG}-upload-`)));
    expect(readdirSync(into)).toHaveLength(1);
    s.destroy();
    await waitFor('no file left', () => readdirSync(into).length === 0);

    const res = await fetch(`${fc.url}${target}`, { method: 'POST', body: 'whole' });
    expect([res.status, readFileSync(join(into, 'big.bin'), 'utf8')]).toEqual([200, 'whole']);
  });

  test('refused in read-only mode', async () => {
    const ro = await filesCore({ readOnly: true });
    try {
      const res = await fetch(`${ro.url}/api/m/local/upload?${query({ name: 'x', dir: at('up') })}`, { method: 'POST', body: 'x' });
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([403, 'read_only']);
      expect(existsSync(at('up/x'))).toBe(false);
    } finally {
      await ro.stop();
    }
  });
});

// A download the page gave an id reports its progress and how it ended to
// the page following it, and can be cancelled from the downloads panel.
describe('downloads panel', () => {
  const get = (id: string, paths: string[], init?: RequestInit) =>
    fetch(`${fc.url}/api/m/local/download?${query({ path: paths, ...(id ? { dl: id } : {}) })}`, init);
  const fetchAll = async (id: string, ...paths: string[]) => {
    const res = await get(id, paths);
    await res.arrayBuffer().catch(() => {});
    return res;
  };

  test('progress, ends and cancels', async () => {
    const page = testPage(fc.tc.core);
    const other = testPage(fc.tc.core);
    // The page says it follows id before it downloads; the core has not
    // seen it yet.
    const follow = async (id: string) => {
      page.send({ t: 'download.watch', ids: [id] });
      expect((await page.next(id)).state).toBe('unknown');
    };

    // One file: its name and size, then done with every byte.
    await follow('file-0001');
    await fetchAll('file-0001', at('proj/a.txt'));
    let ev = await page.ending('file-0001');
    expect(ev[0].state).toBe('running');
    expect(ev.at(-1)).toEqual({ t: 'download', id: 'file-0001', state: 'done', sent: 5, total: 5, name: 'a.txt' });
    // An archive has no size in advance.
    await follow('dir-00001');
    await fetchAll('dir-00001', at('proj'));
    ev = await page.ending('dir-00001');
    expect(ev.at(-1)).toMatchObject({ state: 'done', name: 'proj.zip' });
    expect(ev.at(-1)!.total).toBeUndefined();
    expect(ev.at(-1)!.sent).toBeGreaterThan(0);
    // Failures carry a code the page translates.
    await follow('missing01');
    await fetchAll('missing01', at('missing'));
    expect((await page.ending('missing01')).at(-1)).toMatchObject({ state: 'failed', error: 'not_found' });
    await follow('invalid01');
    await fetchAll('invalid01', 'relative');
    expect((await page.ending('invalid01')).at(-1)).toMatchObject({ state: 'failed', error: 'invalid' });

    // A page that asks after the end (its request came first, or it
    // reconnected) learns how it ended; an id the core never saw is unknown.
    await fetchAll('late-0001', at('proj/a.txt'));
    page.send({ t: 'download.watch', ids: ['late-0001', 'never-001', 'bad id!'] });
    expect(await page.next('late-0001')).toMatchObject({ state: 'done', sent: 5 });
    expect((await page.next('never-001')).state).toBe('unknown');
    expect(page.events('bad id!')).toEqual([]);

    // Cancelled from the panel while the browser keeps reading: the
    // download breaks off, without the rest of the file.
    await follow('cancel-01');
    let res = await get('cancel-01', [at('big.bin')]);
    let some = await readSome(res);
    page.send({ t: 'download.cancel', id: 'cancel-01' });
    let rest = await readRest(some.reader, some.got);
    expect([rest.error, rest.got < 64 << 20]).toEqual([true, true]);
    expect((await page.ending('cancel-01')).at(-1)!.state).toBe('cancelled');
    expect(fc.tc.audit.records()).toContainEqual(expect.objectContaining({ event: 'file.download.cancel', id: 'cancel-01' }));
    // Cancelling one that ended answers how it ended.
    page.send({ t: 'download.cancel', id: 'cancel-01' });
    expect((await page.next('cancel-01')).state).toBe('cancelled');

    // Cancelled in the browser.
    await follow('browser-1');
    res = await get('browser-1', [at('big.bin')]);
    some = await readSome(res);
    await some.reader.cancel();
    expect((await page.ending('browser-1')).at(-1)!.state).toBe('cancelled');

    // Without an id, with a malformed one, or a HEAD check: no events.
    const before = page.sent.length;
    await fetchAll('', at('proj/a.txt'));
    await fetchAll('bad id!', at('proj/a.txt'));
    await get('head-0001', [at('proj')], { method: 'HEAD' });
    await sleep(100);
    expect(page.sent.slice(before).filter((m) => m.t === 'download')).toEqual([]);
    // Other pages hear nothing of downloads they do not follow.
    expect(other.sent.filter((m) => m.t === 'download')).toEqual([]);
    await waitFor('no download followed', () => fc.downloads.sizes.running === 0);

    // The machine goes away in the middle of an archive: the browser's
    // download fails instead of keeping a short archive, and so does the
    // panel's.
    await follow('dropped-1');
    res = await get('dropped-1', [at('bigdir')]);
    some = await readSome(res);
    fc.dial.agents.at(-1)!.kill();
    rest = await readRest(some.reader, some.got);
    expect(rest.error).toBe(true);
    expect((await page.ending('dropped-1')).at(-1)).toMatchObject({ state: 'failed', error: 'interrupted' });
    await waitFor('the machine back', () => fc.machines.get('local')!.ready);

    // A page that leaves stops following.
    page.send({ t: 'download.watch', ids: ['gone-0001'] });
    page.close();
    other.close();
    expect(fc.downloads.sizes.watched).toBe(0);
  }, 60_000);

  // One cancelled before its request came is refused, and a download
  // answered with an error says why instead of breaking off.
  test('edges', async () => {
    const page = testPage(fc.tc.core);
    // Cancelled while the browser still held it back: done at once, and
    // the request that comes after all is refused.
    page.send({ t: 'download.cancel', id: 'early-001' });
    expect((await page.next('early-001')).state).toBe('cancelled');
    let res = await fetchAll('early-001', at('proj/a.txt'));
    expect(res.status).toBe(410);

    // A resumed download of a file that shrank: 416, not a broken
    // connection, and the panel says the file changed.
    page.send({ t: 'download.watch', ids: ['range-001'] });
    expect((await page.next('range-001')).state).toBe('unknown');
    res = await get('range-001', [at('proj/a.txt')], { headers: { Range: 'bytes=100-' } });
    expect([res.status, res.headers.get('Content-Range'), res.headers.get('Content-Disposition')]).toEqual([416, 'bytes */5', null]);
    expect((await page.ending('range-001')).at(-1)).toMatchObject({ state: 'failed', error: 'changed' });

    // A file removed between its stat and its read is not found.
    const failed: string[] = [];
    const m = fc.machines.get('local')!;
    const req = new Request('http://x/');
    const e = await serveFile(m, req, { name: 'gone.txt', path: at('gone.txt'), size: 10, mode: 0, mtime: 0, is_dir: false }, true, {
      request: req.signal,
      fail: (c) => void failed.push(c),
    }).catch((e) => e);
    expect([e instanceof TransferFail, e.status, e.code, failed]).toEqual([true, 404, 'not_found', ['not_found']]);

    // Cancelled in the browser before the machine answered: cancelled, not a
    // failure of the machine.
    page.send({ t: 'download.watch', ids: ['left-0001'] });
    expect((await page.next('left-0001')).state).toBe('unknown');
    const gone = new AbortController();
    gone.abort();
    await fc.tc.core
      .fetch(
        new Request(`${fc.url}/api/m/local/download?${query({ path: at('proj/a.txt'), dl: 'left-0001' })}`, {
          signal: gone.signal,
          headers: { Host: new URL(fc.url).host },
        }),
        { remote: '127.0.0.1', desktop: false },
      )
      .catch(() => {});
    expect((await page.ending('left-0001')).at(-1)!.state).toBe('cancelled');
    page.close();
  });
});
