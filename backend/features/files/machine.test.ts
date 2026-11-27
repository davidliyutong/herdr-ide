// The file explorer's machine side, driven through the wire as the hub
// drives it (#kernel/agent.ts call and open), so the hub's schemas check
// what it answers.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { duplexPair } from 'node:stream';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { dirsOf, makeDirs } from '#shared/host/hostdirs.ts';
import { extended } from '#shared/testdata/extended.ts';
import { discard } from '#shared/lib/log.ts';
import { ChunkWriter, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { call, open } from '#kernel/agent.ts';
import { Session } from '#kernel/machines/transport/session.ts';
import { Agent } from '#machine/agent.ts';
import { E, SysError } from '#machine/sys/libc.ts';
import { linkGuard } from '#machine/sys/fs.ts';
import { machineOf, rig, tempHome, until, type Rig } from '#machine/testing.ts';
import { MAX_STAT, MAX_WRITE, filesProtocol, type Entry, type Result } from './protocol.ts';
import { filesMachine, type FilesOptions } from './machine.ts';
import { STAGING_DIR, STAGING_RETENTION_MS, pruneStaged } from './machine/save.ts';

/** An agent with the files feature on home, a session of the hub's. */
interface Files {
  home: string;
  base: string;
  act: <K extends keyof typeof filesProtocol.actions & string>(action: K, params: object) => Promise<Result & Entry[]>;
  /** The code an action fails with, or "ok". */
  code: (action: keyof typeof filesProtocol.actions & string, params: object) => Promise<string>;
  /** Runs write or upload: the reply, the text as chunks (with its end
   * marker unless cut), the second line. */
  send: (action: 'write' | 'upload', params: object, text: string | Buffer, cut?: boolean) => Promise<Reply>;
  close(): Promise<void>;
}

const opened: Files[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) await f.close();
});

function wrap(home: string, base: string, s: Session, close: () => Promise<void>): Files {
  const m = machineOf(s);
  const act = (async (action: string, params: object) => call(m, filesProtocol, action as 'stat', params as never)) as Files['act'];
  const f: Files = {
    home,
    base,
    act,
    async code(action, params) {
      try {
        await act(action, params);
        return 'ok';
      } catch (e) {
        return e instanceof Fail ? e.code : String(e);
      }
    },
    async send(action, params, text, cut = false) {
      let conn;
      try {
        ({ conn } = await open(m, filesProtocol, action, params as never));
      } catch (e) {
        if (e instanceof Fail) return { ok: false, code: e.code, error: e.message };
        throw e;
      }
      const cw = new ChunkWriter(conn.stream);
      await cw.write(Buffer.from(text));
      if (cut) {
        conn.stream.destroy();
        return { ok: false, code: 'cut' };
      }
      await cw.finish();
      const rep = await readLine<Reply>(conn.reader);
      conn.reader.release();
      closeStream(conn.stream);
      return rep;
    },
    close,
  };
  opened.push(f);
  return f;
}

/** The feature on a new home (its data directory ~/.veldr). */
async function files(o: FilesOptions = {}): Promise<Files & { r: Rig }> {
  const r = await rig({ features: [filesMachine({ platform: 'linux', dataHome: '', ...o })] });
  return Object.assign(
    wrap(r.home, r.dirs.base, r.session, () => r.close()),
    { r },
  );
}

/** The feature on a given home (which may be a link), its data directory
 * .agent-base in it. */
function filesAt(home: string, o: FilesOptions = {}): Files {
  const dirs = dirsOf(join(home, '.agent-base'));
  makeDirs(dirs);
  const agent = new Agent({ instance: '', dirs, logger: discard, features: [filesMachine({ platform: 'linux', dataHome: '', ...o })] });
  const [a, b] = duplexPair();
  void agent.serve(a, 'hub', '');
  const s = new Session(b, () => b.destroy());
  return wrap(home, dirs.base, s, async () => {
    s.close();
    await agent.close();
  });
}

const write = (p: string, s: string) => writeFileSync(p, s);
const read = (p: string) => readFileSync(p, 'utf8');
const loaded = (p: string): Entry => {
  const fi = statSync(p);
  return { path: p, exists: true, size: fi.size, mtime: Math.floor(fi.mtimeMs) };
};
const ok = (rep: Reply): Result => {
  if (!rep.ok) throw new Error(`failed: ${rep.code} ${rep.error}`);
  return (rep.plugin ?? {}) as Result;
};
const inode = (p: string) => statSync(p).ino;

describe('changes', () => {
  test('mkdir, create and rename; a rename never replaces', async () => {
    const f = await files();
    const d = join(f.home, 'src');
    await f.act('mkdir', { path: '~/src' });
    expect(statSync(d).isDirectory()).toBe(true);
    expect(await f.code('mkdir', { path: d })).toBe('exists');
    expect((await f.act('mkdir', { path: d, unique: true })).paths).toEqual([`${d}-1`]);
    await f.act('create', { path: `${d}/a.txt` });
    write(`${d}/a.txt`, 'a');
    expect(await f.code('create', { path: `${d}/a.txt` })).toBe('exists');
    expect(read(`${d}/a.txt`)).toBe('a');
    write(`${d}/b.txt`, 'b');
    expect(await f.code('rename', { path: `${d}/a.txt`, to: `${d}/b.txt` })).toBe('exists');
    expect([read(`${d}/a.txt`), read(`${d}/b.txt`)]).toEqual(['a', 'b']);
    expect((await f.act('rename', { path: `${d}/a.txt`, to: `${d}/c.txt` })).paths).toEqual([`${d}/c.txt`]);
    expect(read(`${d}/c.txt`)).toBe('a');
    expect(await f.code('rename', { path: d, to: `${d}/inner` })).toBe('bad_params');
    expect(await f.code('rename', { path: `${d}/nope`, to: `${d}/x` })).toBe('not_found');
    // Folders with their parents; a file in the way is exists.
    expect((await f.act('mkdirs', { paths: [`${d}/x/y`, `${d}/x`] })).paths).toEqual([`${d}/x/y`, `${d}/x`]);
    expect(await f.code('mkdirs', { paths: [`${d}/c.txt/z`] })).toBe('exists');
  });

  test('copies get new names beside their source; a move replaces nothing; links are copied as links', async () => {
    const f = await files();
    const src = join(f.home, 'src');
    const dst = join(f.home, 'dst');
    mkdirSync(`${src}/dir/sub`, { recursive: true });
    mkdirSync(dst);
    write(`${src}/a.txt`, 'a');
    write(`${src}/dir/sub/f`, 'f');
    symlinkSync('f', `${src}/dir/sub/link`);
    write(`${dst}/a.txt`, 'taken');
    expect((await f.act('copy', { paths: [`${src}/a.txt`, `${src}/a.txt`], dir: src })).paths).toEqual([
      `${src}/a copy.txt`,
      `${src}/a copy 2.txt`,
    ]);
    expect((await f.act('copy', { paths: [`${src}/dir`], dir: dst })).paths).toEqual([`${dst}/dir`]);
    expect(read(`${dst}/dir/sub/f`)).toBe('f');
    expect(readlinkSync(`${dst}/dir/sub/link`)).toBe('f');
    expect(await f.code('copy', { paths: [`${src}/dir`], dir: `${src}/dir/sub` })).toBe('bad_params');

    write(`${src}/b.txt`, 'b');
    const r = await f.act('move', { paths: [`${src}/a.txt`, `${src}/b.txt`], dir: dst });
    expect(r.paths).toEqual([`${dst}/b.txt`]);
    expect(r.failed).toEqual({ [`${src}/a.txt`]: 'exists' });
    expect([read(`${dst}/a.txt`), read(`${src}/a.txt`)]).toEqual(['taken', 'a']);
  });

  test('a folder is not copied or moved into a link that leads inside it; the home directory takes copies', async () => {
    const f = await files();
    const proj = join(f.home, 'proj');
    mkdirSync(`${proj}/sub`, { recursive: true });
    write(`${proj}/f`, 'f');
    symlinkSync(`${proj}/sub`, `${f.home}/l`);
    for (const action of ['copy', 'move'] as const) expect(await f.code(action, { paths: [proj], dir: `${f.home}/l` })).toBe('bad_params');
    expect(readdirSync(`${proj}/sub`)).toEqual([]);
    symlinkSync(f.home, `${proj}/up`);
    await f.act('copy', { paths: [proj], dir: f.home });
    expect(readlinkSync(`${f.home}/proj copy/up`)).toBe(f.home);
    await f.act('move', { paths: [`${proj}/f`], dir: '~' });
    expect(read(`${f.home}/f`)).toBe('f');
  });

  test('across file systems a move copies and removes, still replacing nothing', async () => {
    const exdev = (from: string) => {
      throw Object.assign(new Error(`EXDEV: rename '${from}'`), { code: 'EXDEV' });
    };
    const f = await files({ rename: exdev });
    const src = join(f.home, 'src');
    const dst = join(f.home, 'dst');
    mkdirSync(`${src}/d/sub`, { recursive: true });
    mkdirSync(dst);
    write(`${src}/d/sub/f`, 'f');
    write(`${src}/a.txt`, 'a');
    write(`${dst}/a.txt`, 'taken');
    const r = await f.act('move', { paths: [`${src}/d`, `${src}/a.txt`], dir: dst });
    expect(r.paths).toEqual([`${dst}/d`]);
    expect(r.failed).toEqual({ [`${src}/a.txt`]: 'exists' });
    expect([read(`${dst}/d/sub/f`), read(`${dst}/a.txt`), read(`${src}/a.txt`)]).toEqual(['f', 'taken', 'a']);
    expect(existsSync(`${src}/d`)).toBe(false);
  });

  test('remove: a tree, then not_found', async () => {
    const f = await files();
    const d = join(f.home, 'd');
    mkdirSync(`${d}/x/y`, { recursive: true });
    write(`${d}/x/y/f`, 'f');
    await f.act('remove', { paths: [`${d}/x`] });
    expect(existsSync(`${d}/x`)).toBe(false);
    expect(await f.code('remove', { paths: [`${d}/x`] })).toBe('not_found');
    expect(await f.code('remove', { paths: [] })).toBe('bad_params');
  });

  test("the trash takes a file also where the data directory is missing (a server's account)", async () => {
    const f = await files();
    const p = join(f.home, 'gone.txt');
    write(p, 'x');
    const r = await f.act('trash', { paths: [p] });
    expect(r.paths?.[0].startsWith(join(f.home, '.local', 'share', 'Trash', 'files') + '/')).toBe(true);
    expect(read(r.paths![0])).toBe('x');
    expect(existsSync(p)).toBe(false);
  });
});

describe('protected paths', () => {
  test('the root, the home directory and what holds it, and the data directory are refused, also through links', async () => {
    const f = await files();
    const inBase = join(f.base, 'state.json');
    write(inBase, '{}');
    for (const p of ['/', '~', f.home, join(f.home, '..'), f.base, inBase]) {
      for (const action of ['trash', 'remove'] as const)
        expect(`${action} ${p} ${await f.code(action, { paths: [p] })}`).toBe(`${action} ${p} refused`);
      expect(await f.code('rename', { path: p, to: `${f.home}/x` })).toBe('refused');
    }
    expect(await f.code('create', { path: `${f.base}/x` })).toBe('refused');
    write(`${f.home}/f`, 'f');
    expect(await f.code('rename', { path: `${f.home}/f`, to: `${f.base}/f` })).toBe('refused');
    // A link to a protected file is not written through.
    symlinkSync(inBase, `${f.home}/link`);
    expect((await f.send('write', { path: `${f.home}/link`, force: true }, '[]')).code).toBe('refused');
    // Nor copied into through a link to the data directory.
    symlinkSync(f.base, `${f.home}/base-link`);
    expect(await f.code('copy', { paths: [`${f.home}/f`], dir: `${f.home}/base-link` })).toBe('refused');
    expect(existsSync(`${f.base}/f`)).toBe(false);
    expect((await f.send('upload', { path: join(f.base, 'x') }, 'x')).code).toBe('refused');
    expect(read(inBase)).toBe('{}');
  });

  test('a home directory that is a link: its real path, what holds it and the data directory there are refused too', async () => {
    const t = tempHome();
    try {
      const real = join(t.home, 'real', 'me');
      mkdirSync(real, { recursive: true });
      mkdirSync(join(t.home, 'link'));
      const home = join(t.home, 'link', 'me');
      symlinkSync(real, home);
      const f = filesAt(home);
      write(`${real}/.agent-base/state.json`, '{}');
      write(`${real}/f`, 'f');
      for (const p of [real, join(real, '..'), `${real}/.agent-base`, `${real}/.agent-base/state.json`, home, `${home}/.agent-base`]) {
        for (const action of ['trash', 'remove'] as const)
          expect(`${action} ${p} ${await f.code(action, { paths: [p] })}`).toBe(`${action} ${p} refused`);
        expect(await f.code('rename', { path: p, to: `${real}/x` })).toBe('refused');
      }
      expect(read(`${real}/.agent-base/state.json`)).toBe('{}');
      // What is in the home directory is the user's to change.
      await f.act('remove', { paths: [`${real}/f`] });
      expect(existsSync(`${real}/f`)).toBe(false);
      await f.close();
    } finally {
      t.remove();
    }
  });

  test('on a case-insensitive volume another case names the same directories', async () => {
    const t = tempHome();
    try {
      const home = join(t.home, 'me');
      mkdirSync(home);
      const upper = join(t.home, 'ME');
      if (!existsSync(upper)) return; // case-sensitive
      const f = filesAt(home);
      write(`${f.base}/state.json`, '{}');
      for (const p of [upper, `${upper}/.AGENT-BASE`, `${upper}/.Agent-Base/state.json`])
        expect(await f.code('remove', { paths: [p] })).toBe('refused');
      expect(await f.code('create', { path: `${upper}/.AGENT-BASE/new` })).toBe('refused');
      expect(read(`${f.base}/state.json`)).toBe('{}');
      await f.close();
    } finally {
      t.remove();
    }
  });
});

describe('stat', () => {
  test('the entries of paths in their order; a path not there is not an error', async () => {
    const f = await files();
    write(`${f.home}/f`, 'abc');
    const es = (await f.act('stat', { paths: ['~/f', '~/nope'] })) as Entry[];
    expect(es).toEqual([
      { path: '~/f', exists: true, size: 3, mtime: Math.floor(statSync(`${f.home}/f`).mtimeMs) },
      { path: '~/nope', exists: false, size: 0, mtime: 0 },
    ]);
    await expect(f.act('stat', { paths: Array.from({ length: MAX_STAT + 1 }, () => '~') })).rejects.toThrow();
  });

  test('a mount that does not answer: one stat per path, at most max waiting, answers in time with the state unknown', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const calls = new Map<string, number>();
    const real = (p: string) => import('node:fs/promises').then((m) => m.stat(p));
    const f = await files({
      statWaitMs: 100,
      maxStatting: 8,
      stat: async (p) => {
        calls.set(p, (calls.get(p) ?? 0) + 1);
        await released;
        return real(p);
      },
    });
    const stat = (paths: string[]) => f.act('stat', { paths }) as Promise<Entry[]>;
    for (const es of await Promise.all([1, 2, 3].map(() => stat(['~/dead']))))
      expect(es).toEqual([{ path: '~/dead', exists: false, size: 0, mtime: 0, error: 'timeout' }]);
    const n = 8 + 2;
    const all = await Promise.all(Array.from({ length: n }, (_, i) => stat([`~/dead${i}`, '~/after'])));
    const codes: Record<string, number> = {};
    for (const es of all) {
      expect(es[0].exists).toBe(false);
      expect(es[1].error).toBeTruthy();
      codes[es[0].error!] = (codes[es[0].error!] ?? 0) + 1;
    }
    // The shared second path starts alongside the first, using one of the slots.
    expect(codes).toEqual({ busy: 4, timeout: 6 });
    expect(calls.get(join(f.home, 'dead'))).toBe(1);
    expect(calls.size).toBe(8);
    // Once the mount answers the places are free again.
    release();
    await until(async () => {
      write(`${f.home}/g`, 'abc');
      const es = await stat(['~/g']);
      return es[0].exists && es[0].size === 3;
    }, 'the stats to end');
  });

  test('briefly queues transient stat bursts beyond max slots instead of returning busy immediately', async () => {
    const real = (p: string) => import('node:fs/promises').then((m) => m.stat(p));
    const f = await files({
      statWaitMs: 2000,
      maxStatting: 2,
      stat: async (p) => {
        await Bun.sleep(15);
        return real(p);
      },
    });
    for (let i = 0; i < 6; i++) write(`${f.home}/q${i}`, `v${i}`);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.act('stat', { paths: [`~/q${i}`] }) as Promise<Entry[]>));
    expect(results.every((es) => es[0].exists && !es[0].error)).toBe(true);
  });
});

describe('find concurrency gate', () => {
  test('caps concurrent files.find walks, returns busy when wait expires, and frees slots after completion', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const f = await files({
      maxFinding: 2,
      findSlotWaitMs: 60,
      find: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
        return { matches: [] };
      },
    });
    const p1 = f.act('find', { dir: '~', query: 'a' });
    const p2 = f.act('find', { dir: '~', query: 'b' });
    await until(() => releases.length === 2, 'two finds active');
    expect(peak).toBe(2);

    // A third concurrent find waits findSlotWaitMs and then fails with busy.
    expect(await f.code('find', { dir: '~', query: 'c' })).toBe('busy');
    expect(peak).toBe(2);

    // Releasing active walks allows subsequent finds to run cleanly.
    for (const r of releases.splice(0)) r();
    await Promise.all([p1, p2]);
    const p4 = f.act('find', { dir: '~', query: 'd' });
    await until(() => releases.length === 1, 'fourth find active');
    releases.shift()!();
    await p4;
    expect(active).toBe(0);
  });
});

describe('saving', () => {
  test('the precondition: a conflict says how the file is now; new files must not exist; force writes; links lead to their target', async () => {
    const f = await files();
    const p = join(f.home, 'f.txt');
    write(p, 'one');
    chmodSync(p, 0o600);
    const r = ok(await f.send('write', { path: p, expect: loaded(p) }, 'two'));
    expect(read(p)).toBe('two');
    expect(r.entry?.size).toBe(3);
    expect(r.paths).toEqual([p]);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    write(p, 'changed elsewhere');
    const rep = await f.send('write', { path: p, expect: r.entry }, 'three');
    expect(rep.code).toBe('conflict');
    expect(read(p)).toBe('changed elsewhere');
    expect(rep.error?.startsWith('conflict: ')).toBe(true);
    expect((JSON.parse(rep.error!.slice('conflict: '.length)) as Entry).size).toBe(17);
    rmSync(p);
    const gone = await f.send('write', { path: p, expect: r.entry }, 'x');
    expect(gone.code).toBe('conflict');
    expect(JSON.parse(gone.error!.slice('conflict: '.length))).toEqual({ path: p, exists: false, size: 0, mtime: 0 });
    ok(await f.send('write', { path: p }, 'new'));
    expect((await f.send('write', { path: p }, 'again')).code).toBe('conflict');
    ok(await f.send('write', { path: p, force: true }, 'forced'));
    expect(read(p)).toBe('forced');
    symlinkSync('f.txt', `${f.home}/link`);
    ok(await f.send('write', { path: `${f.home}/link`, force: true }, 'via link'));
    expect(readlinkSync(`${f.home}/link`)).toBe('f.txt');
    expect(read(p)).toBe('via link');
    expect((await f.send('write', { path: p, force: true }, 'x'.repeat(MAX_WRITE + 1))).code).toBe('too_large');
    expect(read(p)).toBe('via link');
    expect(readdirSync(f.home).filter((n) => n.includes('-save-') || n.includes('upload'))).toEqual([]);
  });

  test('a save rewrites the file itself: inode, hard links and mode stay, nothing appears beside it', async () => {
    const f = await files();
    const p = join(f.home, 'f.txt');
    const other = join(f.home, 'other.txt');
    write(p, 'one');
    chmodSync(p, 0o640);
    linkSync(p, other);
    const ino = inode(p);
    const before = readdirSync(f.home).sort();
    const r = ok(await f.send('write', { path: p, expect: loaded(p) }, 'two, longer'));
    expect([read(p), read(other), inode(p)]).toEqual(['two, longer', 'two, longer', ino]);
    expect(r.entry).toEqual(loaded(p));
    expect(statSync(p).mode & 0o777).toBe(0o640);
    ok(await f.send('write', { path: p, force: true }, '3'));
    expect(read(other)).toBe('3');
    symlinkSync('f.txt', join(f.home, 'link'));
    ok(await f.send('write', { path: join(f.home, 'link'), force: true }, 'via link'));
    expect([readlinkSync(join(f.home, 'link')), read(other), inode(p)]).toEqual(['f.txt', 'via link', ino]);
    expect(readdirSync(f.home).sort()).toEqual([...before, 'link'].sort());
  });

  test('a new file gets the mode the umask leaves', async () => {
    const f = await files();
    const old = process.umask(0o027);
    try {
      ok(await f.send('write', { path: join(f.home, 'new.txt') }, 'new'));
    } finally {
      process.umask(old);
    }
    expect(statSync(join(f.home, 'new.txt')).mode & 0o777).toBe(0o640);
  });

  test('a file in a directory that takes no new file is saved; a read-only file is left alone', async () => {
    if (process.geteuid?.() === 0) return;
    const f = await files();
    const dir = join(f.home, 'ro');
    mkdirSync(dir);
    const p = join(dir, 'f.txt');
    write(p, 'one');
    chmodSync(dir, 0o555);
    try {
      ok(await f.send('write', { path: p, expect: loaded(p) }, 'two'));
      expect(read(p)).toBe('two');
      expect((await f.send('write', { path: join(dir, 'new.txt') }, 'x')).code).toBe('denied');
    } finally {
      chmodSync(dir, 0o755);
    }
    chmodSync(p, 0o444);
    expect((await f.send('write', { path: p, force: true }, 'three')).code).toBe('denied');
    expect(read(p)).toBe('two');
    expect(statSync(p).mode & 0o777).toBe(0o444);
  });

  test('a FIFO or a directory is not written, and a FIFO does not hold the save', async () => {
    const f = await files();
    const fifo = join(f.home, 'fifo');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0) return;
    expect((await f.send('write', { path: fifo, force: true }, 'x')).code).toBe('bad_params');
    mkdirSync(join(f.home, 'dir'));
    expect((await f.send('write', { path: join(f.home, 'dir'), force: true }, 'x')).code).toBe('bad_params');
  });

  test('a file swapped for a link, or a directory above it swapped for one, after the path was resolved is a conflict, also forced', async () => {
    const f = await files();
    // The file itself is a link when the save opens it.
    const shared = join(f.home, 'shared');
    const other = join(f.home, 'other');
    mkdirSync(shared);
    mkdirSync(other);
    const p = join(shared, 'notes.txt');
    write(p, 'notes');
    write(join(other, 'notes.txt'), 'secret');
    const was = loaded(p);
    const { writeFile, bufferSource } = await import('./machine/save.ts');
    const conflictOf = (e: unknown) => (e instanceof Fail ? e.code : String(e));
    rmSync(p);
    symlinkSync(join(other, 'notes.txt'), p);
    for (const w of [{ expect: was }, { force: true }]) {
      expect(await writeFile(p, bufferSource(Buffer.from('mine')), w).then(() => 'ok', conflictOf)).toBe('conflict');
      expect(read(join(other, 'notes.txt'))).toBe('secret');
    }
    rmSync(p);
    write(p, 'notes');
    // A directory above the file.
    renameSync(shared, `${shared}.old`);
    symlinkSync(other, shared);
    if (!linkGuard.refusedEverywhere) return; // this system's open cannot refuse links above the file
    for (const w of [{ expect: was }, { force: true }]) {
      expect(await writeFile(p, bufferSource(Buffer.from('mine')), w).then(() => 'ok', conflictOf)).toBe('conflict');
      expect(read(join(other, 'notes.txt'))).toBe('secret');
    }
  });

  test('a new file is made in its directory as its path names it, a link above included', async () => {
    const f = await files();
    const real = join(f.home, 'real');
    mkdirSync(real);
    symlinkSync(real, join(f.home, 'via'));
    ok(await f.send('write', { path: join(f.home, 'via', 'new.txt') }, 'n'));
    expect(read(join(real, 'new.txt'))).toBe('n');
  });

  test('a write that fails after the file was cut says so (partial_write with the cause); a new file it failed for is removed', async () => {
    let failures = 0;
    let errno: 'ENOSPC' | 'EIO' = 'ENOSPC';
    const { copyInto } = await import('./machine/save.ts');
    const f = await files({
      fill: async (fd, src) => {
        if (failures <= 0) return copyInto(fd, src);
        failures--;
        const buf = Buffer.alloc(src.size);
        await src.read(buf, 0);
        writeFileSync(fd, buf.subarray(0, buf.length >> 1));
        throw new SysError(E(errno), 'write');
      },
    });
    const p = join(f.home, 'f.txt');
    write(p, 'the old text');
    failures = 1;
    const rep = await f.send('write', { path: p, expect: loaded(p) }, 'the new text');
    expect(rep.code).toBe('partial_write');
    expect(rep.error).toBe('partial_write: no_space');
    expect(read(p)).toBe('the ne');
    ok(await f.send('write', { path: p, force: true }, 'the new text'));
    expect(read(p)).toBe('the new text');
    errno = 'EIO';
    failures = 1;
    const n = join(f.home, 'new.txt');
    const rep2 = await f.send('write', { path: n }, 'new');
    expect(rep2.ok).toBe(false);
    expect(rep2.code).not.toBe('partial_write');
    expect(existsSync(n)).toBe(false);
  });
});

describe('uploads', () => {
  const left = (base: string) => (existsSync(join(base, STAGING_DIR)) ? readdirSync(join(base, STAGING_DIR)) : []);

  test('an upload takes a free name, or replaces the file in place as a save does', async () => {
    const f = await files();
    const p = join(f.home, 'a.txt');
    let r = ok(await f.send('upload', { path: p }, 'first'));
    expect([r.paths, read(p), r.entry?.size]).toEqual([[p], 'first', 5]);
    r = ok(await f.send('upload', { path: p }, 'second'));
    expect(r.paths).toEqual([join(f.home, 'a-1.txt')]);
    expect([read(p), read(r.paths![0])]).toEqual(['first', 'second']);
    write(join(f.home, '.env'), 'x');
    expect(ok(await f.send('upload', { path: join(f.home, '.env') }, 'y')).paths).toEqual([join(f.home, '.env-1')]);
    const other = join(f.home, 'other.txt');
    linkSync(p, other);
    const ino = inode(p);
    r = ok(await f.send('upload', { path: p, replace: true }, 'replaced'));
    expect([r.paths, read(p), read(other), inode(p)]).toEqual([[realpathSync(p)], 'replaced', 'replaced', ino]);
    mkdirSync(join(f.home, 'dir'));
    expect((await f.send('upload', { path: join(f.home, 'dir'), replace: true }, 'x')).code).toBe('bad_params');
    expect(left(f.base)).toEqual([]);
    expect((statSync(join(f.base, STAGING_DIR)).mode & 0o777).toString(8)).toBe('700');
  });

  test('an upload cut short leaves nothing, the file there as it was', async () => {
    const f = await files();
    const p = join(f.home, 'big.bin');
    write(p, 'old');
    for (const replace of [false, true]) {
      await f.send('upload', { path: p, replace }, 'x'.repeat(1000), true);
      await until(() => left(f.base).length === 0, 'the staged file to go');
      expect(read(p)).toBe('old');
      expect(existsSync(join(f.home, 'big-1.bin'))).toBe(false);
    }
    // The agent still serves.
    expect(ok(await f.send('upload', { path: p }, 'new')).paths).toEqual([join(f.home, 'big-1.bin')]);
  });

  test('a session that ends during an upload is served until the upload removed what it staged', async () => {
    const t = tempHome();
    const dirs = dirsOf(join(t.home, '.agent-base'));
    makeDirs(dirs);
    const agent = new Agent({ instance: '', dirs, logger: discard, features: [filesMachine({ platform: 'linux', dataHome: '' })] });
    try {
      const [a, b] = duplexPair();
      const served = agent.serve(a, 'hub', '');
      const s = new Session(b, () => b.destroy());
      const { conn } = await open(machineOf(s), filesProtocol, 'upload', { path: join(t.home, 'big.bin') } as never);
      await new ChunkWriter(conn.stream).write(Buffer.from('x'.repeat(1000)));
      await until(() => left(dirs.base).length === 1, 'the upload to stage its file');
      s.close();
      await served;
      expect(left(dirs.base)).toEqual([]);
      expect(existsSync(join(t.home, 'big.bin'))).toBe(false);
    } finally {
      await agent.close();
      t.remove();
    }
  });

  test("old files of broken-off uploads go; recent ones and other directories' files stay", async () => {
    const t = tempHome();
    try {
      const d = join(t.home, STAGING_DIR);
      mkdirSync(d);
      const now = new Date();
      const old = join(d, 'upload-00000001');
      const recent = join(d, 'upload-00000002');
      write(old, 'x');
      write(recent, 'y');
      const past = new Date(now.getTime() - STAGING_RETENTION_MS - 3600_000);
      utimesSync(old, past, past);
      const elsewhere = join(t.home, 'keep');
      write(elsewhere, 'z');
      utimesSync(elsewhere, past, past);
      await pruneStaged(t.home, now);
      expect([existsSync(old), existsSync(recent), existsSync(elsewhere)]).toEqual([false, true, true]);
      await pruneStaged(join(t.home, 'missing-staging'), now);
    } finally {
      t.remove();
    }
  });
});

// The fake file managers are scripts the tests write, which macOS
// assesses on their first run.
describe('reveal', () => {
  extended(
    'runs the file manager with the path, a folder or a file, and nothing for a path not there',
    async () => {
      const t = tempHome();
      const out = join(t.home, 'args');
      const script = join(t.home, 'reveal');
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\nexit 0\n`, { mode: 0o755 });
      try {
        const f = await files({ revealCommand: (_os, p, dir) => [script, dir ? 'dir' : 'file', p] });
        mkdirSync(join(f.home, 'proj'));
        write(join(f.home, 'proj', 'a.txt'), '');
        const args = () => {
          const s = existsSync(out) ? read(out).trim() : '';
          rmSync(out, { force: true });
          return s;
        };
        for (const [p, want] of [
          [join(f.home, 'proj', 'a.txt'), `file\n${join(f.home, 'proj', 'a.txt')}`],
          ['~/proj', `dir\n${join(f.home, 'proj')}`],
          ['proj/a.txt', `file\n${join(f.home, 'proj', 'a.txt')}`],
          ['~', `dir\n${f.home}`],
        ]) {
          expect((await f.act('reveal', { path: p })).paths?.length).toBe(1);
          expect(args()).toBe(want);
        }
        for (const [p, code] of [
          [join(f.home, 'missing'), 'not_found'],
          ['', 'bad_params'],
          ['a\0b', 'bad_params'],
        ]) {
          expect(await f.code('reveal', { path: p })).toBe(code);
          expect(args()).toBe('');
        }
      } finally {
        t.remove();
      }
    },
    30_000,
  );

  extended(
    'a failing command, a missing one, and more at once than allowed',
    async () => {
      const t = tempHome();
      try {
        const failing = join(t.home, 'failing');
        writeFileSync(failing, '#!/bin/sh\necho nope >&2\nexit 3\n', { mode: 0o755 });
        const f1 = await files({ revealCommand: () => [failing] });
        const e = await f1.act('reveal', { path: '~' }).catch((x) => x as Fail);
        expect((e as Fail).code).toBe('reveal_failed');
        expect((e as Fail).message).toContain('exit status 3');
        const f2 = await files({ revealCommand: () => [join(t.home, 'no-such-program')] });
        expect(await f2.code('reveal', { path: '~' })).toBe('reveal_unavailable');
        // Commands that do not exit: answered after the wait, beyond the
        // bound busy; a file manager left running holds no place.
        const release = join(t.home, 'release');
        const hang = join(t.home, 'hang');
        // It also ends once the home is gone (a test that timed out).
        writeFileSync(hang, `#!/bin/sh\nwhile [ ! -e ${release} ] && [ -d ${t.home} ]; do sleep 0.02; done\n`, { mode: 0o755 });
        const f3 = await files({ revealCommand: () => [hang], revealWaitMs: 100, maxRevealing: 2 });
        const start = Date.now();
        await f3.act('reveal', { path: '~' });
        expect(Date.now() - start).toBeLessThan(5000);
        const f4 = await files({ revealCommand: () => [hang], revealWaitMs: 30_000, maxRevealing: 2 });
        const waiting = [f4.act('reveal', { path: '~' }), f4.act('reveal', { path: '~' })];
        await new Promise((r) => setTimeout(r, 1000));
        expect(await f4.code('reveal', { path: '~' })).toBe('busy');
        writeFileSync(release, '');
        await Promise.all(waiting);
        expect(await f4.code('reveal', { path: '~' })).toBe('ok');
      } finally {
        writeFileSync(join(t.home, 'release'), '');
        t.remove();
      }
    },
    30_000,
  );
});
