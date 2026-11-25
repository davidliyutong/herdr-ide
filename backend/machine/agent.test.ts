import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { SLUG } from '#shared/lib/brand.ts';
import { Fail } from '#shared/lib/fail.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, MAX_INLINE, Op, readLine, writeLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { defineProtocol } from '#shared/proto/protocol.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { defineMachine } from './feature.ts';
import { rig, until, type Rig } from './testing.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const refusalOf = async (p: Promise<unknown>): Promise<Reply> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError && e.reply) return e.reply;
    throw e;
  }
  throw new Error('not refused');
};

describe('hello and the run directory', () => {
  test("the agent tells its host and the ssh session apart; the run directory is the user's alone", async () => {
    r = await rig({ sshConn: '10.0.0.2 51000 10.0.0.9 22' });
    const rep = await r.session.request({ op: Op.Hello });
    expect(rep.info?.os).toBe(process.platform);
    expect(rep.info?.home).toBe(r.home);
    expect(rep.info?.data_dir).toBe(r.dirs.base);
    expect(rep.ssh).toBe('10.0.0.2 51000 10.0.0.9 22');
    expect(JSON.stringify(rep.info)).not.toContain('51000');
    expect(statSync(r.dirs.run).mode & 0o777).toBe(0o700);
  });
});

describe('file operations', () => {
  test('an upload, its stat, a ranged read and a listing; a missing path is not_found', async () => {
    r = await rig();
    const payload = Buffer.from('0123456789'.repeat(50000));
    const { conn } = await r.session.open({ op: Op.FsWrite, path: '~/up/data.bin', mkdirs: true });
    const cw = new ChunkWriter(conn.stream);
    await cw.write(payload);
    await cw.finish();
    const rep = await readLine<Reply>(conn.reader);
    expect(rep.ok).toBe(true);
    expect(rep.stat?.size).toBe(payload.length);
    closeStream(conn.stream);

    const read = await r.session.open({ op: Op.FsRead, path: join(r.home, 'up', 'data.bin'), offset: 7, length: 12 });
    const parts: Buffer[] = [];
    for (let b = await read.conn.reader.chunk(); b; b = await read.conn.reader.chunk()) parts.push(b);
    expect(Buffer.concat(parts).toString()).toBe('789012345678');
    expect(read.reply.stat?.size).toBe(payload.length);

    const list = await r.session.request({ op: Op.FsList, path: '~/up' });
    expect(list.entries?.map((e) => e.name)).toEqual(['data.bin']);
    const missing = await refusalOf(r.session.request({ op: Op.FsStat, path: '~/missing' }));
    expect(missing.code).toBe('not_found');
  });

  test('a unique upload takes a free name, never replacing a file or a link; nothing temporary is left', async () => {
    r = await rig();
    const proj = join(r.home, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'shot.png'), 'mine');
    symlinkSync('/nonexistent', join(proj, 'shot-1.png'));
    const upload = async (path: string, body: string) => {
      const { conn } = await r!.session.open({ op: Op.FsWrite, path, unique: true });
      const cw = new ChunkWriter(conn.stream);
      await cw.write(Buffer.from(body));
      await cw.finish();
      const rep = await readLine<Reply>(conn.reader);
      closeStream(conn.stream);
      return rep;
    };
    expect((await upload('~/proj/shot.png', 'new')).stat?.path).toBe(join(proj, 'shot-2.png'));
    expect(readFileSync(join(proj, 'shot.png'), 'utf8')).toBe('mine');
    expect(readFileSync(join(proj, 'shot-2.png'), 'utf8')).toBe('new');
    expect((await upload('~/proj/.env', 'x')).stat?.path).toBe(join(proj, '.env'));
    expect((await upload('~/proj/.env', 'y')).stat?.path).toBe(join(proj, '.env-1'));
    await expect(r.session.open({ op: Op.FsWrite, path: '~/missing/a.txt' })).rejects.toThrow();
    expect(readdirSync(proj).filter((n) => n.startsWith(`.${SLUG}-upload-`))).toEqual([]);
  });

  test('a listing too large for the line follows it', async () => {
    r = await rig();
    const dir = join(r.home, 'many');
    mkdirSync(dir);
    for (let i = 0; i < 1500; i++) writeFileSync(join(dir, `file-with-a-long-name-${String(i).padStart(5, '0')}.txt`), '');
    const rep = await r.session.request({ op: Op.FsList, path: dir });
    expect(rep.entries?.length).toBe(1500);
    expect(JSON.stringify(rep.entries).length).toBeGreaterThan(MAX_INLINE);
    expect(rep.entries?.[0].name).toBe('file-with-a-long-name-00000.txt');
  });

  test('only sockets in the run directory are dialed', async () => {
    r = await rig();
    const outside = join(r.home, 'x.sock');
    const srv = createServer((c) => c.end('outside'));
    await new Promise<void>((res) => srv.listen(outside, res));
    try {
      await expect(r.session.request({ op: Op.DialUnix, path: outside })).rejects.toThrow(/outside/);
      await expect(r.session.request({ op: Op.DialUnix, path: `${r.dirs.run}/../x.sock` })).rejects.toThrow(/outside/);
    } finally {
      srv.close();
    }
    const inside = join(r.dirs.run, 'in.sock');
    const srv2 = createServer((c) => c.end('inside'));
    await new Promise<void>((res) => srv2.listen(inside, res));
    try {
      const { conn } = await r.session.open({ op: Op.DialUnix, path: 'in.sock' });
      expect((await conn.reader.line(100)).toString()).toBe('inside');
    } finally {
      srv2.close();
    }
  });
});

describe('what features see of the sessions', () => {
  // A feature's op learns its session; the agent's sessions count their
  // pipes to each socket (VS Code keeps code-server for the hubs that
  // show it); the node's hand-over and the agent's end reach the features.
  test('sessions, their pipes, the hand-over and the end', async () => {
    const seen: Array<{ id: number; client: string; sessions: number[] }> = [];
    const events: string[] = [];
    const side = defineMachine(defineProtocol('s', {}), () => ({
      actions: {},
      ops: {
        [Op.GUI]: async (conn, _h, ctx) => {
          seen.push({ id: ctx.session.id, client: ctx.session.client, sessions: ctx.sessions().map((s) => s.id) });
          await writeLine(conn.stream, { ok: true });
        },
      },
      handOver: (next) => void events.push(`hand over to ${next.pid}`),
      close: async () => {
        await new Promise((res) => setTimeout(res, 10));
        events.push('closed');
      },
    }));
    r = await rig({ features: [side], client: 'hub-1' });
    const second = r.connect('hub-2');
    await r.session.request({ op: Op.GUI });
    await second.request({ op: Op.GUI });
    expect(seen).toEqual([
      { id: 1, client: 'hub-1', sessions: [1, 2] },
      { id: 2, client: 'hub-2', sessions: [1, 2] },
    ]);

    const sock = join(r.dirs.run, 'p.sock');
    const srv = createServer((c) => c.on('error', () => {}));
    await new Promise<void>((res) => srv.listen(sock, res));
    try {
      const [one, two] = r.agent.liveSessions();
      expect(one.dialed(sock)).toEqual({ open: 0, last: 0 });
      const { conn } = await second.open({ op: Op.DialUnix, path: 'p.sock' });
      await until(() => two.dialed(sock).open === 1, 'the pipe to count');
      expect(two.dialed(sock).last).toBeGreaterThan(0);
      expect(one.dialed(sock).open).toBe(0);
      conn.stream.destroy();
      await until(() => two.dialed(sock).open === 0, 'the pipe to end');
      expect(two.dialed(sock).last).toBeGreaterThan(0);
    } finally {
      srv.close();
    }

    r.agent.drain({ build: 'b', version: 'v', exe_time: 0, pid: 4321 });
    expect(events).toEqual(['hand over to 4321']);
    await r.agent.close();
    expect(events).toEqual(['hand over to 4321', 'closed']);
  });
});

describe('ops this build does not serve', () => {
  test('are refused as an unknown plugin is; an unknown op fails', async () => {
    r = await rig();
    for (const op of [Op.CodeServer, Op.GUI, Op.Detect]) {
      const rep = await refusalOf(r.session.request({ op, action: 'status' }));
      expect(rep.code).toBe('unknown_plugin');
    }
    for (const plugin of ['agents', 'usage', 'chat']) {
      const rep = await refusalOf(r.session.request({ op: Op.Plugin, plugin, action: 'open', params: {} }));
      expect(rep).toEqual({ ok: false, code: 'unknown_plugin', error: `unknown_plugin: unknown plugin "${plugin}"` });
    }
    const rep = await refusalOf(r.session.request({ op: 'nope' as Op }));
    expect(rep.error).toContain('unknown op');
    // The agent still answers.
    expect((await r.session.request({ op: Op.Hello })).ok).toBe(true);
  });
});

const testProto = defineProtocol('t', {
  echo: { params: z.object({ text: z.string() }), result: z.object({ text: z.string() }) },
  big: { params: z.object({ n: z.int() }), result: z.object({ data: z.string() }) },
  fail: { params: z.object({ code: z.string() }), result: z.object({}) },
  boom: { params: z.object({}), result: z.object({}) },
  wait: { params: z.object({}), result: z.object({}) },
  pipe: { params: z.object({}), result: z.object({}), stream: true },
});

describe('the plugin op', () => {
  const ended: string[] = [];
  const side = defineMachine(testProto, () => ({
    actions: {
      echo: (p) => ({ text: p.text }),
      big: (p) => ({ data: 'x'.repeat(p.n) }),
      fail: (p) => {
        throw new Fail(p.code, 400, 'it went wrong');
      },
      boom: () => {
        throw new TypeError('a bug');
      },
      wait: (_, ctx) =>
        new Promise((res) => {
          ctx.signal.addEventListener('abort', () => {
            ended.push('wait');
            res({});
          });
        }),
      pipe: async (_, _ctx, s) => {
        await s.reply();
        const line = await s.reader.line(100);
        await writeLine(s.stream, { got: line });
      },
    },
  }));

  test('params in the header or after it, results inline or after the reply', async () => {
    r = await rig({ features: [side] });
    const call = async (action: string, params: unknown) => {
      const raw = Buffer.from(JSON.stringify(params));
      const h =
        raw.length > MAX_INLINE
          ? { op: Op.Plugin, plugin: 't', action, params_length: raw.length }
          : { op: Op.Plugin, plugin: 't', action, params };
      const { conn, reply } = await r!.session.open(h, { body: raw.length > MAX_INLINE ? raw : undefined });
      let result = reply.plugin;
      if (reply.plugin_length) result = JSON.parse((await conn.reader.exactly(reply.plugin_length)).toString());
      closeStream(conn.stream);
      return result;
    };
    expect(await call('echo', { text: 'hi' })).toEqual({ text: 'hi' });
    const long = 'y'.repeat(MAX_INLINE + 10);
    expect(await call('echo', { text: long })).toEqual({ text: long });
    expect(((await call('big', { n: MAX_INLINE * 2 })) as { data: string }).data.length).toBe(MAX_INLINE * 2);
  });

  test('refusals carry codes; a throwing handler fails its action, not the agent', async () => {
    r = await rig({ features: [side] });
    const ask = (action: string, params: unknown) => refusalOf(r!.session.request({ op: Op.Plugin, plugin: 't', action, params }));
    expect(await ask('fail', { code: 'conflict' })).toEqual({ ok: false, code: 'conflict', error: 'conflict: it went wrong' });
    expect((await ask('boom', {})).code).toBe('failed');
    expect((await ask('echo', { text: 7 })).code).toBe('bad_params');
    expect((await ask('nope', {})).code).toBe('bad_params');
    expect((await ask('toString', {})).code).toBe('bad_params');
    expect((await refusalOf(r.session.request({ op: Op.Plugin, plugin: 't' }))).code).toBe('bad_params');
    expect((await r.session.request({ op: Op.Hello })).ok).toBe(true);
  });

  test('an action ends when the hub gives up on it; a streaming one goes on after its reply', async () => {
    r = await rig({ features: [side] });
    const ac = new AbortController();
    const p = r.session.request({ op: Op.Plugin, plugin: 't', action: 'wait', params: {} }, { signal: ac.signal, timeoutMs: 60_000 });
    p.catch(() => {});
    await new Promise((res) => setTimeout(res, 100));
    ac.abort();
    await until(() => ended.includes('wait'), 'the action to end');

    const { conn } = await r.session.open({ op: Op.Plugin, plugin: 't', action: 'pipe', params: {} });
    await writeLine(conn.stream, 'ping');
    expect(await readLine(conn.reader)).toEqual({ got: '"ping"' });
    closeStream(conn.stream);
  });
});

describe('the terminal core', () => {
  test('a build that carries herdr-core reports it and installs it from its own copy, checked by its digest', async () => {
    const { gzipSync } = await import('node:zlib');
    const { createHash } = await import('node:crypto');
    const exe = Buffer.from('#!/bin/sh\necho carried\n');
    const digest = createHash('sha256').update(exe).digest('hex');
    r = await rig({ carryHC: () => ({ gz: gzipSync(exe), digest }) });
    const st = await r.session.request({ op: Op.HC, action: 'status' });
    expect(st.hc?.embedded).toBe(digest);
    expect(st.hc?.digest).toBeUndefined();
    expect((await refusalOf(r.session.request({ op: Op.HC, action: 'install-embedded', digest: 'c'.repeat(64) }))).code).toBe('bad_digest');
    const done = await r.session.request({ op: Op.HC, action: 'install-embedded', digest });
    expect(done.hc?.digest).toBe(digest);
    expect(readFileSync(join(r.dirs.host, 'hc', 'herdr-core'))).toEqual(exe);
  });

  test('a build that carries none refuses install-embedded', async () => {
    r = await rig();
    expect((await r.session.request({ op: Op.HC, action: 'status' })).hc?.embedded).toBeUndefined();
    expect((await refusalOf(r.session.request({ op: Op.HC, action: 'install-embedded', digest: 'a'.repeat(64) }))).code).toBe(
      'not_installed',
    );
  });

  test('a start needs the executable the hub expects; status names the session and socket', async () => {
    r = await rig();
    const st = await r.session.request({ op: Op.HC, action: 'status' });
    expect(st.hc?.running).toBe(false);
    expect(st.hc?.socket).toBe(join(r.dirs.run, 'hc.sock'));
    expect(st.hc?.session).toMatch(new RegExp(`^${SLUG}-[0-9a-z_.-]+$`));
    const rep = await refusalOf(r.session.request({ op: Op.HC, action: 'start', digest: 'a'.repeat(64) }));
    expect(rep.code).toBe('not_installed');
    expect(existsSync(join(r.dirs.host, 'hc', 'herdr-core'))).toBe(false);
  });

  test('an install is checked against its digest before it replaces anything', async () => {
    r = await rig();
    const { gzipSync } = await import('node:zlib');
    const { createHash } = await import('node:crypto');
    const exe = Buffer.from('#!/bin/sh\necho "$HC_SESSION $*" >> "\${0%/*}/hc.log"\n');
    const digest = createHash('sha256').update(exe).digest('hex');
    const install = async (d: string) => {
      const { conn } = await r!.session.open({ op: Op.HC, action: 'install', digest: d });
      const cw = new ChunkWriter(conn.stream);
      await cw.write(gzipSync(exe));
      await cw.finish();
      const rep = await readLine<Reply>(new Reader(conn.reader.release()));
      closeStream(conn.stream);
      return rep;
    };
    const bad = await install('b'.repeat(64));
    expect(bad.code).toBe('bad_digest');
    expect(existsSync(join(r.dirs.host, 'hc', 'herdr-core'))).toBe(false);
    const good = await install(digest);
    expect(good.ok).toBe(true);
    expect(good.hc?.digest).toBe(digest);
    expect(statSync(join(r.dirs.host, 'hc', 'herdr-core')).mode & 0o777).toBe(0o700);
    // It runs once it is the one expected, for the instance's session.
    const started = await r.session.request({ op: Op.HC, action: 'start', digest });
    expect(started.ok).toBe(true);
    expect(readFileSync(join(r.dirs.host, 'hc', 'hc.log'), 'utf8')).toContain('server start --json');
    expect(readdirSync(join(r.dirs.host, 'hc')).filter((n) => n.startsWith('.fetch-'))).toEqual([]);
  });
});

describe('through the hub', () => {
  test("the kernel's call runs an action and checks its result by the protocol", async () => {
    const { call } = await import('#kernel/agent.ts');
    const { machineOf } = await import('./testing.ts');
    const proto = defineProtocol('k', { add: { params: z.object({ a: z.int(), b: z.int() }), result: z.object({ sum: z.int() }) } });
    r = await rig({ features: [defineMachine(proto, () => ({ actions: { add: (p) => ({ sum: p.a + p.b }) } }))] });
    expect(await call(machineOf(r.session), proto, 'add', { a: 2, b: 3 })).toEqual({ sum: 5 });
  });
});

describe('one thread for every hub', () => {
  test('fs.read of a FIFO fails at once, and another session is answered meanwhile', async () => {
    r = await rig();
    const fifo = join(r.home, 'fifo');
    Bun.spawnSync(['mkfifo', fifo]);
    const other = r.connect('hub-2');
    const started = Date.now();
    const read = await refusalOf(r.session.request({ op: Op.FsRead, path: fifo }, { timeoutMs: 5000 }));
    expect(read.error).toContain('not a regular file');
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await other.request({ op: Op.Hello }, { timeoutMs: 2000 })).ok).toBe(true);
    // An archive that meets a FIFO leaves it out without waiting for it.
    const dir = join(r.home, 'with-fifo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.txt'), 'a');
    Bun.spawnSync(['mkfifo', join(dir, 'p')]);
    const { conn } = await r.session.open({ op: Op.FsArchive, paths: [dir] }, { timeoutMs: 5000 });
    let n = 0;
    for (let b = await conn.reader.chunk(); b; b = await conn.reader.chunk()) n += b.length;
    expect(n).toBeGreaterThan(0);
  });

  test('a stat that does not return (a mount that stopped answering) holds its own request only', async () => {
    let stuck = 0;
    r = await rig({ fs: { lstat: () => (stuck++, new Promise(() => {})) } });
    const other = r.connect('hub-2');
    const pending = r.session.request({ op: Op.FsStat, path: '~' }, { timeoutMs: 60_000 });
    pending.catch(() => {});
    await until(() => stuck === 1, 'the stat to start');
    const t0 = Date.now();
    expect((await other.request({ op: Op.Hello }, { timeoutMs: 2000 })).ok).toBe(true);
    expect((await r.session.request({ op: Op.Hello }, { timeoutMs: 2000 })).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
