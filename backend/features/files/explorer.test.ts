// The file explorer's routes: their guards, their parameters, and what
// reaches the machine's side of the plugin (a fake of the Go agent's) and
// comes back.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { ChunkReader, writeLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { checkGuarded, localSpec, sshSpec, testHub, testMachines, waitFor } from '#kernel/testing.ts';
import { auditTargets, conflictOf, fileTransfersFeature, filesFeature, uploadParams, writeParams } from './hub.ts';
import { MAX_STAT, MAX_UPLOAD, MAX_WRITE } from './protocol.ts';
import type { PluginHandler } from './testdata/agent.ts';
import { filesHub, type FilesHub } from './testdata/hub.ts';

const ON = { 'plugins.files.enabled': true };
const core = (o: { readOnly?: boolean; platform?: string } = {}) =>
  testHub({
    features: [fileTransfersFeature(), filesFeature({ platform: o.platform ?? 'linux' })],
    machines: testMachines([localSpec('here', false), sshSpec('far', 'far', 'far', false)]),
    readOnly: o.readOnly,
    settings: { ...ON },
  });

// Everything but the stat (a POST for the length of its paths) changes
// files or runs a program: refused to other sites and in read-only mode.
test('the routes that change things are guarded', async () => {
  const { problems, checked } = await checkGuarded(core(), core({ readOnly: true }), {
    machine: 'local',
    readOnlyAllowed: ['POST /api/m/:id/p/files/stat'],
  });
  expect(problems).toEqual([]);
  const want = ['stat', 'mkdir', 'mkdirs', 'create', 'rename', 'move', 'copy', 'trash', 'remove', 'write', 'upload', 'reveal'];
  expect(checked.sort()).toEqual(['POST /api/m/:id/upload', ...want.map((a) => `POST /api/m/:id/p/files/${a}`)].sort());
});

test('switched off, the explorer answers plugin_disabled; the transfers stay', async () => {
  const tc = core();
  tc.settings['plugins.files.enabled'] = false;
  let res = await tc.request('POST', '/api/m/local/p/files/stat', { body: '{"paths":["/"]}' });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([404, 'plugin_disabled']);
  // Here the machine is not connected: the listing's own failure.
  res = await tc.request('GET', '/api/m/local/list?path=/');
  expect(await res.json()).toEqual({ error: 'machine not connected', message: 'machine not connected' });
});

// Reveal in Finder only for the core's own machine and a client on the
// core's host: anything else is refused before the machine is asked.
test('reveal gate', async () => {
  const run = async (tc: ReturnType<typeof core>, m: string, remote: string) => {
    const res = await tc.request('POST', `/api/m/${m}/p/files/reveal`, { body: '{"path":"/tmp"}', remote });
    const body = (await res.json()) as { error: string };
    const avail = (await (await tc.request('GET', `/api/m/${m}/p/files/reveal`, { remote })).json()) as { available: boolean };
    const rec = tc.audit.records().at(-1)!;
    expect([rec.event, rec.path, rec.plugin, rec.error]).toEqual(['files.reveal', '/tmp', 'files', body.error]);
    return [res.status, body.error, avail.available];
  };
  const tc = core();
  expect(await run(tc, 'far', '127.0.0.1')).toEqual([400, 'remote_machine', false]);
  expect(await run(tc, 'local', '10.0.0.5')).toEqual([403, 'local_only', false]);
  // Past the gate, the local machine's agent is asked (here not connected).
  expect(await run(tc, 'local', '127.0.0.1')).toEqual([409, 'offline', true]);
  expect(await run(core({ platform: 'win32' }), 'local', '127.0.0.1')).toEqual([400, 'reveal_unavailable', false]);
});

// The stat's paths are a JSON body: 1 to MAX_STAT of them.
test('stat params', async () => {
  const tc = core();
  for (const body of [
    '',
    '{}',
    '{"paths": []}',
    'not json',
    '{"paths": "/"}',
    JSON.stringify({ paths: Array<string>(MAX_STAT + 1).fill('/') }),
  ]) {
    const res = await tc.request('POST', '/api/m/local/p/files/stat', { body });
    expect([body.slice(0, 20), res.status, ((await res.json()) as { error: string }).error]).toEqual([
      body.slice(0, 20),
      400,
      'bad_request',
    ]);
  }
});

test('write params', () => {
  const q = (s: string) => new URLSearchParams(s);
  expect(writeParams(q('path=/a&mtime=12&size=3'))).toEqual({ path: '/a', expect: { path: '/a', exists: true, size: 3, mtime: 12 } });
  expect(writeParams(q('path=/a&new=1'))).toEqual({ path: '/a' });
  expect(writeParams(q('path=/a&force=1'))).toEqual({ path: '/a', force: true });
  for (const bad of ['mtime=1&size=1', 'path=/a', 'path=/a&mtime=x&size=1', 'path=/a&mtime=1'])
    expect(() => writeParams(q(bad))).toThrow(expect.objectContaining({ code: 'bad_request', status: 400 }));
});

test('upload params', () => {
  const q = (s: string) => new URLSearchParams(s);
  expect(uploadParams(q('path=/a/b.txt'))).toEqual({ path: '/a/b.txt' });
  expect(uploadParams(q('path=/a/b.txt&replace=1'))).toEqual({ path: '/a/b.txt', replace: true });
  expect(() => uploadParams(q('replace=1'))).toThrow(expect.objectContaining({ code: 'bad_request' }));
});

// A change's audit record names the paths it acts on, at most 50 of them
// with their count.
test('audit targets', () => {
  let f: Record<string, unknown> = {};
  auditTargets(f, { path: '/a', to: '/b' });
  expect(f).toEqual({ path: '/a', to: '/b' });
  f = {};
  const many = Array.from({ length: 60 }, (_, i) => `/d/${i}`);
  auditTargets(f, { paths: many, dir: '/to' });
  expect(f).toEqual({ paths: many.slice(0, 50), count: 60, dir: '/to' });
});

test('conflictOf', () => {
  expect(conflictOf('conflict: {"path":"/a","exists":true,"size":3,"mtime":7}')).toEqual({ path: '/a', exists: true, size: 3, mtime: 7 });
  expect(conflictOf('conflict: nonsense')).toEqual({ path: '', exists: false, size: 0, mtime: 0 });
});

describe('through the machine', () => {
  interface Call {
    action: string;
    params: Record<string, unknown>;
    body?: string;
    cut?: boolean;
  }
  const calls: Call[] = [];
  const plugin: PluginHandler = async (action, params, conn) => {
    const call: Call = { action, params };
    calls.push(call);
    const reply = (r: Reply) => writeLine(conn.stream, r);
    const path = String(params.path ?? '');
    if (action === 'write' || action === 'upload') {
      if (path === '/conflict')
        return reply({ ok: false, code: 'conflict', error: `conflict: ${JSON.stringify({ path, exists: true, size: 3, mtime: 7 })}` });
      await reply({ ok: true });
      const parts: Buffer[] = [];
      const cr = new ChunkReader(conn.reader);
      try {
        for (let b = await cr.read(); b !== null; b = await cr.read()) parts.push(b);
      } catch {
        call.cut = true;
        return;
      }
      call.body = Buffer.concat(parts).toString();
      if (path === '/full') return reply({ ok: false, code: 'partial_write', error: 'partial_write: no_space' });
      return reply({ ok: true, plugin: { paths: [path], entry: { path, exists: true, size: call.body.length, mtime: 1 } } });
    }
    if (action === 'stat')
      return reply({ ok: true, plugin: (params.paths as string[]).map((p) => ({ path: p, exists: p !== '/gone', size: 0, mtime: 0 })) });
    if (path === '/exists') return reply({ ok: false, code: 'exists', error: 'exists: /exists' });
    if (path === '/missing') return reply({ ok: false, code: 'not_found', error: 'not_found: /missing' });
    return reply({ ok: true, plugin: { paths: [path || String(params.dir)] } });
  };
  let fc: FilesHub;
  beforeAll(async () => {
    fc = await filesHub({ plugin });
  });
  afterAll(() => fc.stop());
  const post = (action: string, body: RequestInit['body'], query = '') =>
    fetch(`${fc.url}/api/m/local/p/files/${action}${query}`, { method: 'POST', body });
  const lastAudit = () => fc.tc.audit.records().at(-1)!;

  test('changes', async () => {
    // Only the action's own parameters reach the machine.
    let res = await post(
      'mkdir',
      JSON.stringify({ path: '/a', unique: true, force: true, expect: { path: '/a', exists: true, size: 1, mtime: 1 } }),
    );
    expect([res.status, await res.json(), calls.at(-1)]).toEqual([
      200,
      { paths: ['/a'] },
      { action: 'mkdir', params: { path: '/a', unique: true } },
    ]);
    expect(lastAudit()).toMatchObject({ event: 'files.mkdir', plugin: 'files', machine: 'local', path: '/a', status: 200 });

    const many = Array.from({ length: 60 }, (_, i) => `/d/${i}`);
    res = await post('copy', JSON.stringify({ paths: many, dir: '/to' }));
    expect([res.status, calls.at(-1)!.params]).toEqual([200, { paths: many, dir: '/to' }]);
    expect(lastAudit()).toMatchObject({ event: 'files.copy', count: 60, dir: '/to' });
    expect(lastAudit().paths).toHaveLength(50);

    // The machine's codes, with the statuses the UI knows.
    res = await post('create', JSON.stringify({ path: '/exists' }));
    expect([res.status, await res.json()]).toEqual([400, { error: 'exists', message: 'exists: /exists' }]);
    expect(lastAudit()).toMatchObject({ event: 'files.create', error: 'exists', status: 400 });
    res = await post('rename', JSON.stringify({ path: '/missing', to: '/b' }));
    expect(res.status).toBe(404);
    res = await post('rename', JSON.stringify({ path: 7 }));
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'bad_request']);

    res = await post('stat', JSON.stringify({ paths: ['/x', '/gone'] }));
    expect(await res.json()).toEqual({
      entries: [
        { path: '/x', exists: true, size: 0, mtime: 0 },
        { path: '/gone', exists: false, size: 0, mtime: 0 },
      ],
    });
  });

  test('write', async () => {
    let res = await post('write', 'héllo', '?path=/f.txt&mtime=12&size=3');
    expect([res.status, await res.json()]).toEqual([
      200,
      { paths: ['/f.txt'], entry: { path: '/f.txt', exists: true, size: 5, mtime: 1 } },
    ]);
    expect(calls.at(-1)).toEqual({
      action: 'write',
      params: { path: '/f.txt', expect: { path: '/f.txt', exists: true, size: 3, mtime: 12 } },
      body: 'héllo',
    });
    res = await post('write', 'x', '?path=/f.txt&force=1');
    expect(calls.at(-1)!.params).toEqual({ path: '/f.txt', force: true });
    expect(lastAudit()).toMatchObject({ event: 'files.write', path: '/f.txt', force: true, status: 200 });

    // A file changed since the editor loaded it: its state now.
    res = await post('write', 'x', '?path=/conflict&new=1');
    expect([res.status, await res.json()]).toEqual([
      409,
      { error: 'conflict', message: 'file changed', current: { path: '/conflict', exists: true, size: 3, mtime: 7 } },
    ]);
    expect(lastAudit()).toMatchObject({ error: 'conflict', status: 409 });
    // A failure after the text: the machine's code and message.
    res = await post('write', 'x', '?path=/full&new=1');
    expect([res.status, await res.json()]).toEqual([400, { error: 'partial_write', message: 'partial_write: no_space' }]);

    res = await post('write', new Uint8Array(MAX_WRITE + 1), '?path=/big&new=1');
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([413, 'too_large']);
    res = await post('write', 'x', '?path=/f.txt');
    expect(res.status).toBe(400);
  });

  test('upload', async () => {
    const before = calls.length;
    let res = await post('upload', 'file bytes', '?path=/in/f.bin&replace=1');
    expect([res.status, ((await res.json()) as { paths: string[] }).paths]).toEqual([200, ['/in/f.bin']]);
    expect(calls.at(-1)).toEqual({ action: 'upload', params: { path: '/in/f.bin', replace: true }, body: 'file bytes' });
    expect(lastAudit()).toMatchObject({ event: 'files.upload', path: '/in/f.bin', replace: true, size: 10, status: 200 });

    // Over the limit: refused before anything reaches the machine.
    const raw = async (head: string, body: Buffer, keep = false) => {
      const s = connect(Number(new URL(fc.url).port), '127.0.0.1');
      s.on('error', () => {});
      let out = '';
      s.on('data', (d) => (out += d.toString()));
      s.write(head + body.toString('latin1'));
      return { s, out: () => out, keep };
    };
    const big = await raw(
      `POST /api/m/local/p/files/upload?path=/in/big HTTP/1.1\r\nHost: ${new URL(fc.url).host}\r\nContent-Length: ${MAX_UPLOAD + 1}\r\n\r\n`,
      Buffer.alloc(10),
    );
    await waitFor('an answer', () => big.out().includes('\r\n\r\n'));
    expect(big.out()).toStartWith('HTTP/1.1 413');
    expect(big.out()).toContain('too_large');
    big.s.destroy();
    expect(calls.slice(before + 1).filter((c) => c.params.path === '/in/big')).toEqual([]);

    // A request that ends early leaves nothing: the machine sees no end.
    const cut = await raw(
      `POST /api/m/local/p/files/upload?path=/in/cut HTTP/1.1\r\nHost: ${new URL(fc.url).host}\r\nContent-Length: 100000\r\n\r\n`,
      Buffer.alloc(1000),
    );
    await waitFor('the upload at the machine', () => calls.some((c) => c.params.path === '/in/cut'));
    cut.s.destroy();
    await waitFor('the machine saw it cut', () => calls.find((c) => c.params.path === '/in/cut')!.cut === true);
  });

  test('read-only mode refuses changes and polls', async () => {
    const ro = await filesHub({ plugin, readOnly: true });
    try {
      let res = await fetch(`${ro.url}/api/m/local/p/files/write?path=/f&new=1`, { method: 'POST', body: 'x' });
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([403, 'read_only']);
      res = await fetch(`${ro.url}/api/m/local/p/files/stat`, { method: 'POST', body: '{"paths":["/x"]}' });
      expect(res.status).toBe(200);
    } finally {
      await ro.stop();
    }
  });
});
