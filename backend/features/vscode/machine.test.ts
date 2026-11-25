// VS Code's machine side through the wire, as the core's provision.ts
// drives it (op code-server), with a stand-in for code-server
// (testdata/fakecs.ts, run by Bun) in test releases built here: the
// executable a request names, releases uploaded and downloaded and checked
// against their digest before anything is unpacked, archives that would
// leave the release refused, code-server started on its socket only and
// ended by its owner (stop, release, the node's end, a node taking over, an
// orphan), a broken one replaced, extensions and markers, the bridge's
// socket tunnelled to the core that last opened VS Code, the releases'
// retention, and unpacking that leaves the node's thread free.
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header as TarHeader } from 'tar';
import { DATA_DIR_NAME, env as brandEnv } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, Op, readLine, writeLine, type CSStatus, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { AgentError, type Session } from '#kernel/machines/transport/session.ts';
import { Agent } from '#machine/agent.ts';
import { inode } from '#machine/sockets.ts';
import { rig, until, type Rig } from '#machine/testing.ts';
import { vscodeMachine, type VscodeMachineOptions } from './machine.ts';
import { bridgeSession } from './machine/bridge.ts';
import { goPlatform, layoutOf, releaseDir, type Layout } from './machine/layout.ts';
import { alive } from './machine/process.ts';
import { entryMode, pruneReleases, refusal, RELEASE_RETENTION_MS, STAGING_RETENTION_MS, unpack } from './machine/release.ts';
import { serveArgs } from './machine/server.ts';

// Each test starts Bun processes (the stand-in) and runs real tools.
setDefaultTimeout(30_000);

const VERSION = '9.9.9';
const FAKE = posix.join(import.meta.dir, 'testdata', 'fakecs.ts');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let r: Rig | undefined;
const extra: Agent[] = [];
const children: ChildProcess[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.pid && alive(c.pid)) process.kill(-c.pid, 'SIGKILL');
  for (const a of extra.splice(0)) await a.close();
  if (r) {
    // Whatever the test left running is ended with its pid file's group.
    const pid = readPid(r);
    await r.close();
    if (pid && alive(pid.pid)) process.kill(-pid.pid, 'SIGKILL');
  }
  r = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary directory of the test's (records of the fake code-server). */
function tempDir(): string {
  const d = realpathSync(mkdtempSync('/tmp/vsc-'));
  temps.push(d);
  return d;
}

async function newRig(o: VscodeMachineOptions = {}): Promise<Rig> {
  r = await rig({
    features: [
      vscodeMachine({ socketWatchMs: 50, timing: { termMs: 2000 }, installedDirs: (h) => [posix.join(h, '.local', 'bin')], ...o }),
    ],
  });
  return r;
}

const layout = (rr: Rig): Layout => layoutOf({ home: rr.home, run: rr.dirs.run, host: rr.dirs.host });

function readPid(rr: Rig): { pid: number; owner: number; version: string; started: number } | null {
  try {
    return JSON.parse(readFileSync(layout(rr).pidFile, 'utf8'));
  } catch {
    return null;
  }
}

/** One entry of a tar archive. */
interface Entry {
  path: string;
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO' | 'CharacterDevice';
  mode?: number;
  body?: string | Buffer;
  linkpath?: string;
}

function tarEntry(e: Entry): Buffer {
  const body = Buffer.from(e.body ?? '');
  const hb = Buffer.alloc(512);
  new TarHeader({
    path: e.path,
    type: e.type ?? 'File',
    mode: e.mode ?? (e.type === 'Directory' ? 0o755 : 0o644),
    size: body.length,
    linkpath: e.linkpath,
    mtime: new Date(1_000_000_000_000),
    uid: 1234,
    gid: 1234,
  }).encode(hb, 0);
  return Buffer.concat([hb, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tarGz = (entries: Entry[], level = 6) => gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]), { level });

/** The wrapper a test release's bin/code-server is: the fake, recording
 * into record. */
const wrapper = (record: string, extraArgs = '') => `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' '${record}' "$@"${extraArgs}\n`;

/** A release tarball as code-server's are: its files below one directory;
 * bin/code-server is the fake, lib/node says its version (or fails). */
function release(record: string, o: { node?: string; more?: Entry[]; bin?: boolean; level?: number } = {}): Buffer {
  const top = `code-server-${VERSION}-linux-amd64`;
  return tarGz(
    [
      { path: `${top}/`, type: 'Directory' },
      { path: `${top}/bin/`, type: 'Directory' },
      ...(o.bin === false ? [] : [{ path: `${top}/bin/code-server`, mode: 0o755, body: wrapper(record) } as Entry]),
      { path: `${top}/lib/`, type: 'Directory' },
      { path: `${top}/lib/node`, mode: 0o755, body: o.node ?? '#!/bin/sh\necho v22.0.0\n' },
      { path: `${top}/out/`, type: 'Directory' },
      { path: `${top}/out/main.js`, body: 'console.log(1)\n' },
      ...(o.more ?? []),
    ],
    o.level,
  );
}

const refusalOf = async (p: Promise<unknown>): Promise<Reply> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError && e.reply) return e.reply;
    throw e;
  }
  throw new Error('not refused');
};

/** A code-server request as provision.ts makes it. */
const cs = (s: Session, h: Partial<Header>, timeoutMs = 20_000) =>
  s.request({ op: Op.CodeServer, version: VERSION, ...h } as Header, { timeoutMs });

/** An upload as provision.ts sends it: a first reply, the chunks, the
 * second reply. */
async function upload(s: Session, h: Partial<Header>, body: Buffer): Promise<Reply> {
  const { conn } = await s.open({ op: Op.CodeServer, version: VERSION, ...h } as Header, { timeoutMs: 20_000 });
  const cw = new ChunkWriter(conn.stream);
  for (let off = 0; off < body.length; off += 64 << 10) await cw.write(body.subarray(off, off + (64 << 10)));
  await cw.finish();
  const rep = await readLine<Reply>(conn.reader);
  conn.reader.release();
  closeStream(conn.stream);
  return rep;
}

/** Installs a test release through the wire (the platform of the rig's
 * layout is this machine's). */
async function installRelease(rr: Rig, record: string): Promise<CSStatus> {
  const tb = release(record);
  const rep = await upload(rr.session, { action: 'install', digest: sha(tb) }, tb);
  expect(rep.error).toBeUndefined();
  expect(rep.cs?.installed).toBe(true);
  return rep.cs!;
}

describe('the executable a request names', () => {
  // An installed code-server is found by its path, a "~/" path or a search
  // of PATH and the usual places; without bin, only the release counts.
  test('a release, a path or a search', async () => {
    const rr = await newRig();
    const was = process.env.PATH;
    process.env.PATH = tempDir();
    try {
      expect((await cs(rr.session, { action: 'status', bin: 'auto' })).cs).toMatchObject({ installed: false, running: false });
      expect((await cs(rr.session, { action: 'status', bin: 'auto' })).cs!.error).toContain('no code-server on PATH or in');
      const local = posix.join(rr.home, '.local', 'bin', 'code-server');
      mkdirSync(posix.dirname(local), { recursive: true });
      writeFileSync(local, '#!/bin/sh\necho v1\n', { mode: 0o755 });
      for (const bin of ['auto', '~/.local/bin/code-server', local]) {
        const st = (await cs(rr.session, { action: 'status', bin })).cs!;
        expect(st).toMatchObject({ installed: true, bin: local, version: VERSION, socket: layout(rr).socket });
      }
      for (const bin of ['relative/code-server', posix.join(rr.home, 'missing')]) {
        const st = (await cs(rr.session, { action: 'status', bin })).cs!;
        expect(st.installed).toBe(false);
        expect(st.error).toBeTruthy();
      }
      // A file without an execute bit is no executable.
      chmodSync(local, 0o644);
      expect((await cs(rr.session, { action: 'status', bin: local })).cs!.installed).toBe(false);
      // Without bin, only the release in the releases' directory counts.
      expect((await cs(rr.session, { action: 'status' })).cs).toEqual({
        installed: false,
        version: VERSION,
        running: false,
        socket: layout(rr).socket,
      });
    } finally {
      process.env.PATH = was;
    }
  });

  test('a version that names no release directory is refused', async () => {
    const rr = await newRig();
    for (const version of ['', '../x', 'a/b', 'a\\b', '..']) {
      const rep = await refusalOf(cs(rr.session, { action: 'status', version }));
      expect(rep.error).toBe('code-server: bad version');
    }
    expect((await refusalOf(cs(rr.session, { action: 'nope' }))).error).toBe('code-server: unknown action "nope"');
  });
});

describe('code-server listens on its socket only', () => {
  // Its port proxy would serve whatever listens on the machine with the
  // UI's origin; nothing listens on TCP.
  test('its arguments', () => {
    const l = layoutOf({ home: '/h', run: '/run/x', host: '/h/.veldr/hosts/a' });
    const args = serveArgs(l);
    const joined = args.join(' ');
    for (const want of [
      '--disable-proxy',
      '--auth none',
      '--socket-mode 600',
      '--socket /run/x/cs.sock',
      '--disable-telemetry',
      '--disable-update-check',
    ])
      expect(joined).toContain(want);
    for (const tcp of ['--bind-addr', '--port', '--host', '--cert', '--link']) expect(args).not.toContain(tcp);
    expect(args.slice(-4)).toEqual(['--user-data-dir', '/h/.veldr/hosts/a/cs-data', '--extensions-dir', '/h/.veldr/hosts/a/cs-ext']);
  });

  test('the layout is the Go build’s', () => {
    expect(goPlatform('linux', 'x64')).toBe('linux-amd64');
    expect(goPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    const l = layoutOf({ home: '/h', run: '/r', host: '/h/.veldr-dev/hosts/a' }, 'linux-amd64');
    expect(l).toEqual({
      root: `/h/${DATA_DIR_NAME}/code-server`,
      platform: 'linux-amd64',
      socket: '/r/cs.sock',
      pidFile: '/r/cs.pid',
      bridge: '/r/bridge.sock',
      data: '/h/.veldr-dev/hosts/a/cs-data',
      ext: '/h/.veldr-dev/hosts/a/cs-ext',
      log: '/h/.veldr-dev/hosts/a/code-server.log',
    });
    expect(releaseDir(l, '4.144.0')).toBe(`/h/${DATA_DIR_NAME}/code-server/4.144.0-linux-amd64`);
  });
});

describe('releases', () => {
  // An upload is checked against the digest the core sends before
  // anything is unpacked: a wrong digest names both, whatever the bytes.
  test('an upload is checked against its digest before it is unpacked', async () => {
    const rr = await newRig();
    const garbage = Buffer.from('not a tarball at all');
    const bad = await upload(rr.session, { action: 'install', digest: '0'.repeat(64) }, garbage);
    expect(bad).toEqual({ ok: false, error: `the tarball: sha256 ${sha(garbage)} does not match expected ${'0'.repeat(64)}` });
    const record = tempDir();
    const tb = release(record);
    const wrong = await upload(rr.session, { action: 'install', digest: sha('other') }, tb);
    expect(wrong.error).toContain('does not match expected');
    expect((await cs(rr.session, { action: 'status' })).cs!.installed).toBe(false);
    // Nothing staged is left, nothing was unpacked.
    expect(readdirSync(layout(rr).root)).toEqual([]);
    // The right digest installs it, the top directory stripped, modes kept
    // but others' write bits, files the user's, times of the install.
    const st = await installRelease(rr, record);
    const dir = releaseDir(layout(rr), VERSION);
    expect(st).toMatchObject({ installed: true, bin: posix.join(dir, 'bin', 'code-server'), running: false });
    expect(readdirSync(dir).sort()).toEqual(['bin', 'lib', 'out']);
    expect(statSync(posix.join(dir, 'lib', 'node')).mode & 0o777).toBe(0o755);
    expect(statSync(posix.join(dir, 'out', 'main.js')).uid).toBe(process.getuid!());
    expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000);
    expect(readdirSync(layout(rr).root)).toEqual([posix.basename(dir)]);
  });

  test('an upload without a digest (an older core) is installed', async () => {
    const rr = await newRig();
    const tb = release(tempDir());
    expect((await upload(rr.session, { action: 'install' }, tb)).cs?.installed).toBe(true);
  });

  test('a release without its executable, or whose Node does not run here, is refused', async () => {
    const rr = await newRig();
    const record = tempDir();
    const noBin = release(record, { bin: false });
    expect((await upload(rr.session, { action: 'install', digest: sha(noBin) }, noBin)).error).toBe(
      'tarball does not contain bin/code-server',
    );
    const oldGlibc = release(record, { node: '#!/bin/sh\necho "GLIBC_2.28 not found" >&2\nexit 1\n' });
    const rep = await upload(rr.session, { action: 'install', digest: sha(oldGlibc) }, oldGlibc);
    expect(rep.error).toContain("code-server's node cannot run on this machine (glibc too old?): exit status 1");
    expect(rep.error).toContain('GLIBC_2.28 not found');
    expect(readdirSync(layout(rr).root)).toEqual([]);
  });

  test('an upload larger than its bound is refused, and the core still gets the reply', async () => {
    const rr = await newRig({ limits: { maxTarball: 4096 } });
    const big = Buffer.alloc(64 << 10, 1);
    const rep = await upload(rr.session, { action: 'install', digest: sha(big) }, big);
    expect(rep.error).toBe('the tarball is larger than 4096 bytes');
    expect(readdirSync(layout(rr).root)).toEqual([]);
  });

  test('a release replaces the one of its version; others unused for long go', async () => {
    const rr = await newRig();
    const l = layout(rr);
    const old = posix.join(l.root, `1.0.0-${l.platform}`);
    const recent = posix.join(l.root, `2.0.0-${l.platform}`);
    const otherHost = posix.join(l.root, `2.0.0-linux-riscv64`);
    for (const d of [old, recent, otherHost]) mkdirSync(d, { recursive: true });
    const longAgo = new Date(Date.now() - RELEASE_RETENTION_MS - 60_000);
    utimesSync(old, longAgo, longAgo);
    const record = tempDir();
    await installRelease(rr, record);
    writeFileSync(posix.join(releaseDir(l, VERSION), 'stale'), '');
    await installRelease(rr, record);
    expect(existsSync(posix.join(releaseDir(l, VERSION), 'stale'))).toBe(false);
    expect(readdirSync(l.root).sort()).toEqual([`2.0.0-${l.platform}`, `2.0.0-linux-riscv64`, `${VERSION}-${l.platform}`].sort());
  });
});

describe('archives that would leave the release', () => {
  const top = 'code-server-1-linux-amd64';
  const cases: Array<[string, Entry[], string]> = [
    ['an absolute path', [{ path: '/tmp/evil', body: 'x' }], 'an absolute path'],
    ['a path with ..', [{ path: `${top}/../../evil`, body: 'x' }], 'a path with ".."'],
    ['a link to an absolute path', [{ path: `${top}/lnk`, type: 'SymbolicLink', linkpath: '/etc' }], 'a link to an absolute path'],
    ['a link leaving the release', [{ path: `${top}/a/lnk`, type: 'SymbolicLink', linkpath: '../../x' }], 'a link leaving the release'],
    ['a hard link leaving the release', [{ path: `${top}/hl`, type: 'Link', linkpath: `${top}/../../x` }], 'a link leaving the release'],
    ['a FIFO', [{ path: `${top}/fifo`, type: 'FIFO' }], 'an entry of type FIFO'],
    ['a device', [{ path: `${top}/dev`, type: 'CharacterDevice' }], 'an entry of type CharacterDevice'],
  ];
  for (const [what, entries, why] of cases)
    test(`refuse it: ${what}`, async () => {
      const dir = tempDir();
      const outside = posix.join(dir, 'outside');
      const dest = posix.join(dir, 'a', 'b', 'dest');
      mkdirSync(dest, { recursive: true });
      mkdirSync(outside);
      const tgz = posix.join(dir, 'r.tgz');
      writeFileSync(tgz, tarGz([{ path: `${top}/`, type: 'Directory' }, { path: `${top}/ok`, body: 'fine' }, ...entries]));
      await expect(unpack(tgz, dest)).rejects.toThrow(why);
      expect(existsSync(posix.join(dir, 'evil'))).toBe(false);
      expect(existsSync(posix.join(dir, 'a', 'evil'))).toBe(false);
      expect(existsSync('/tmp/evil')).toBe(false);
    });

  // A link inside the release is kept; writing through it is refused
  // (node-tar's strict mode), so nothing lands where it points.
  test('links inside are kept; nothing is written through one', async () => {
    const dir = tempDir();
    const dest = posix.join(dir, 'dest');
    mkdirSync(dest);
    const tgz = posix.join(dir, 'r.tgz');
    writeFileSync(
      tgz,
      tarGz([
        { path: `${top}/`, type: 'Directory' },
        { path: `${top}/node_modules/x/bin.js`, body: 'bin' },
        { path: `${top}/node_modules/.bin/x`, type: 'SymbolicLink', linkpath: '../x/bin.js' },
        { path: `${top}/hard`, type: 'Link', linkpath: `${top}/node_modules/x/bin.js` },
      ]),
    );
    await unpack(tgz, dest);
    expect(readFileSync(posix.join(dest, 'node_modules/.bin/x'), 'utf8')).toBe('bin');
    expect(lstatSync(posix.join(dest, 'node_modules/.bin/x')).isSymbolicLink()).toBe(true);
    expect(readFileSync(posix.join(dest, 'hard'), 'utf8')).toBe('bin');

    const dest2 = posix.join(dir, 'dest2');
    mkdirSync(dest2);
    writeFileSync(
      tgz,
      tarGz([
        { path: `${top}/`, type: 'Directory' },
        { path: `${top}/real/`, type: 'Directory' },
        { path: `${top}/lnk`, type: 'SymbolicLink', linkpath: 'real' },
        { path: `${top}/lnk/through`, body: 'x' },
      ]),
    );
    await expect(unpack(tgz, dest2)).rejects.toThrow();
    expect(existsSync(posix.join(dest2, 'real', 'through'))).toBe(false);
  });

  test('the policy, entry by entry; modes lose setuid and others’ write', () => {
    expect(refusal('t/a/b', 'File')).toBe('');
    expect(refusal('t/', 'Directory')).toBe('');
    expect(refusal('t/a/l', 'SymbolicLink', '../b')).toBe('');
    expect(refusal('t/a/l', 'SymbolicLink', '../../b')).toContain('a link leaving the release');
    expect(refusal('t/l', 'SymbolicLink', '..')).toContain('a link leaving the release');
    expect(refusal('t/h', 'Link', 't/a')).toBe('');
    expect(refusal('/t/a', 'File')).toContain('an absolute path');
    expect(entryMode(0o4777, false)).toBe(0o755);
    expect(entryMode(0o000, false)).toBe(0o600);
    expect(entryMode(0o555, true)).toBe(0o755);
  });

  test('a tarball that unpacks to more than its bound is refused', async () => {
    const dir = tempDir();
    const tgz = posix.join(dir, 'bomb.tgz');
    writeFileSync(
      tgz,
      tarGz([
        { path: `${top}/`, type: 'Directory' },
        { path: `${top}/zeros`, body: Buffer.alloc(1 << 20) },
      ]),
    );
    mkdirSync(posix.join(dir, 'dest'));
    await expect(unpack(tgz, posix.join(dir, 'dest'), 64 << 10)).rejects.toThrow('unpacks to more than 65536 bytes');
  });
});

describe('downloads made by the machine', () => {
  const hasTool = ['curl', 'wget'].some((t) => (process.env.PATH ?? '').split(':').some((d) => existsSync(posix.join(d, t))));
  const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  let saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    // The tools would ask the user's proxy for loopback.
    saved = Object.fromEntries(proxyVars.map((k) => [k, process.env[k]]));
  });
  const noProxy =
    <T>(f: () => Promise<T>) =>
    async () => {
      for (const k of proxyVars) delete process.env[k];
      try {
        return await f();
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      }
    };

  // The machine's download is checked against the digest the core knows;
  // with none, it is installed and its digest reported for the core to
  // record. Only http(s) URLs are fetched; nothing staged is left.
  test.skipIf(!hasTool)(
    'is verified before it is installed',
    noProxy(async () => {
      const tb = release(tempDir());
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req) => (new URL(req.url).pathname === '/missing' ? new Response('no', { status: 404 }) : new Response(tb)),
      });
      try {
        const rr = await newRig();
        const url = `http://127.0.0.1:${server.port}/code-server.tar.gz`;
        const bad = await refusalOf(cs(rr.session, { action: 'download', url, digest: '0'.repeat(64) }));
        expect(bad.error).toBe(`${url}: sha256 ${sha(tb)} does not match expected ${'0'.repeat(64)}`);
        expect((await cs(rr.session, { action: 'status' })).cs!.installed).toBe(false);
        const ok = await cs(rr.session, { action: 'download', url, digest: '' });
        expect(ok.cs).toMatchObject({ installed: true, digest: sha(tb) });
        expect(readdirSync(layout(rr).root).filter((n) => n.startsWith('.'))).toEqual([]);
        for (const bad of ['file:///etc/passwd', 'ftp://x/y', 'notaurl', '']) {
          const rep = await refusalOf(cs(rr.session, { action: 'download', url: bad }));
          expect(rep.error).toContain('bad download URL');
        }
        const missing = await refusalOf(cs(rr.session, { action: 'download', url: `http://127.0.0.1:${server.port}/missing`, digest: '' }));
        expect(missing.error).toContain(`download http://127.0.0.1:${server.port}/missing: exit status`);
      } finally {
        server.stop(true);
      }
    }),
  );

  // A download ends when the core gives up on it (its stream closes), and
  // one larger than its bound ends too; neither leaves its file.
  test.skipIf(!hasTool)(
    'ends with the core’s interest and within its bound',
    noProxy(async () => {
      let served = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (req) =>
          new Response(
            new ReadableStream({
              async pull(c) {
                served++;
                if (req.url.endsWith('/big')) c.enqueue(new Uint8Array(64 << 10));
                else {
                  await new Promise((res) => setTimeout(res, 200));
                  c.enqueue(new Uint8Array(16));
                }
              },
            }),
          ),
      });
      try {
        const rr = await newRig({ limits: { maxTarball: 1 << 20 } });
        const root = layout(rr).root;
        await expect(
          cs(rr.session, { action: 'download', url: `http://127.0.0.1:${server.port}/slow`, digest: '' }, 1500),
        ).rejects.toThrow();
        await until(() => existsSync(root) && readdirSync(root).length === 0, 'the partial download to go', 10_000);
        const big = await refusalOf(cs(rr.session, { action: 'download', url: `http://127.0.0.1:${server.port}/big`, digest: '' }));
        expect(big.error).toContain('larger than 1048576 bytes');
        expect(readdirSync(root)).toEqual([]);
        expect(served).toBeGreaterThan(0);
      } finally {
        server.stop(true);
      }
    }),
  );
});

describe('the process', () => {
  // Started on its socket (and the agent's bridge in its environment), the
  // pid file naming this node; a start finds it serving and starts none.
  test('starts once, ended by stop', async () => {
    const rr = await newRig();
    const record = tempDir();
    await installRelease(rr, record);
    const l = layout(rr);
    const st = (await cs(rr.session, { action: 'start' })).cs!;
    expect(st).toMatchObject({ installed: true, running: true, socket: l.socket });
    const serve = JSON.parse(readFileSync(posix.join(record, 'serve.json'), 'utf8')) as {
      pid: number;
      args: string[];
      env: Record<string, string>;
    };
    expect(serve.args).toEqual(serveArgs(l));
    expect(serve.env[brandEnv('BRIDGE_SOCKET')]).toBe(l.bridge);
    expect(serve.env.VSCODE_PROXY_URI).toBe('');
    const pid = readPid(rr)!;
    expect(pid).toMatchObject({ owner: process.pid, version: VERSION });
    expect(statSync(l.pidFile).mode & 0o777).toBe(0o600);
    expect(statSync(l.data).mode & 0o777).toBe(0o700);
    expect(statSync(l.log).mode & 0o777).toBe(0o600);
    // A second start finds it serving.
    await cs(rr.session, { action: 'start' });
    expect(readPid(rr)!.pid).toBe(pid.pid);
    expect((await cs(rr.session, { action: 'stop' })).cs!.running).toBe(false);
    expect(alive(pid.pid)).toBe(false);
    expect(existsSync(l.pidFile)).toBe(false);
  });

  test('a start of code-server that exits says why', async () => {
    const rr = await newRig();
    const l = layout(rr);
    const dir = releaseDir(l, VERSION);
    mkdirSync(posix.join(dir, 'bin'), { recursive: true });
    writeFileSync(posix.join(dir, 'bin', 'code-server'), '#!/bin/sh\necho "cannot listen: EADDRINUSE"\nexit 3\n', { mode: 0o755 });
    const rep = await refusalOf(cs(rr.session, { action: 'start' }));
    expect(rep.error).toContain('code-server exited: exit status 3: cannot listen: EADDRINUSE');
    expect(existsSync(l.pidFile)).toBe(false);
    expect((await refusalOf(cs(rr.session, { action: 'start', version: '1.2.3' }))).error).toBe('code-server is not installed');
  });

  // A core's idle end keeps the code-server another core's session has a
  // connection to; once that one is gone, it ends.
  test('release keeps it for another core', async () => {
    const rr = await newRig();
    await installRelease(rr, tempDir());
    await cs(rr.session, { action: 'start' });
    const other = rr.connect('core-2');
    const { conn } = await other.open({ op: Op.DialUnix, path: 'cs.sock' });
    await until(() => rr.agent.liveSessions().some((s) => s.dialed(layout(rr).socket).open > 0), 'the pipe');
    expect((await cs(rr.session, { action: 'release' })).cs!.running).toBe(true);
    // Its own connection does not keep it.
    conn.stream.destroy();
    await until(() => rr.agent.liveSessions().every((s) => s.dialed(layout(rr).socket).open === 0), 'the pipe to close');
    const { conn: mine } = await rr.session.open({ op: Op.DialUnix, path: 'cs.sock' });
    await until(() => rr.agent.liveSessions().some((s) => s.dialed(layout(rr).socket).open > 0), 'its own pipe');
    expect((await cs(rr.session, { action: 'release' })).cs!.running).toBe(false);
    mine.stream.destroy();
  });

  // The node's end ends the code-server it owns; one it handed over to the
  // node that took over is left running.
  test('the node’s end, and a node taking over', async () => {
    const rr = await newRig();
    await installRelease(rr, tempDir());
    await cs(rr.session, { action: 'start' });
    const first = readPid(rr)!;
    rr.agent.drain({ build: 'next', version: 'v9', exe_time: 0, pid: 424242 });
    await until(() => readPid(rr)?.owner === 424242, 'the hand over');
    await rr.close();
    r = undefined;
    expect(alive(first.pid)).toBe(true);
    process.kill(-first.pid, 'SIGKILL');

    const rr2 = await newRig();
    await installRelease(rr2, tempDir());
    await cs(rr2.session, { action: 'start' });
    const owned = readPid(rr2)!;
    await rr2.close();
    r = undefined;
    expect(alive(owned.pid)).toBe(false);
  });

  // A code-server whose node is gone is ended by the next node; one found
  // serving at a start is adopted.
  test('an orphan is ended, a serving one adopted', async () => {
    const rr = await newRig();
    const record = tempDir();
    await installRelease(rr, record);
    const l = layout(rr);
    await cs(rr.session, { action: 'start' });
    const orphan = readPid(rr)!;
    const dead = spawn('/bin/sh', ['-c', 'exit 0']);
    await new Promise((res) => dead.once('exit', res));
    writeFileSync(l.pidFile, JSON.stringify({ ...orphan, owner: dead.pid }));
    const next = new Agent({
      instance: '',
      dirs: rr.dirs,
      logger: discard,
      features: [vscodeMachine({ socketWatchMs: 50, timing: { termMs: 2000 } })],
      socketWatchMs: 50,
    });
    extra.push(next);
    await until(() => !alive(orphan.pid), 'the orphan to end');
    expect(existsSync(l.pidFile)).toBe(false);

    // Adopted: started again, its owner then gone.
    await cs(rr.session, { action: 'start' });
    const running = readPid(rr)!;
    writeFileSync(l.pidFile, JSON.stringify({ ...running, owner: dead.pid }));
    await cs(rr.session, { action: 'start' });
    expect(readPid(rr)).toEqual({ ...running, owner: process.pid });
  });

  // A process on the socket that does not serve VS Code (its installation
  // moved away) is replaced, even without a pid file: found as the socket's
  // peer.
  test('a broken listener is replaced', async () => {
    const rr = await newRig();
    const record = tempDir();
    await installRelease(rr, record);
    const l = layout(rr);
    const broken = spawn(process.execPath, [FAKE, record, '--socket', l.socket, '--broken'], { detached: true, stdio: 'ignore' });
    children.push(broken);
    await until(() => existsSync(posix.join(record, 'broken.json')) && existsSync(l.socket), 'the broken listener');
    await cs(rr.session, { action: 'start' });
    await until(() => !alive(broken.pid!), 'the broken listener to end');
    const serve = JSON.parse(readFileSync(posix.join(record, 'serve.json'), 'utf8')) as { pid: number };
    expect(readPid(rr)!.pid).not.toBe(broken.pid);
    expect(alive(serve.pid)).toBe(true);
  });
});

describe('extensions', () => {
  test('a VSIX and ids installed by code-server, markers remembered', async () => {
    const rr = await newRig();
    const record = tempDir();
    await installRelease(rr, record);
    const l = layout(rr);
    const vsix = Buffer.from('a vsix');
    const rep = await upload(rr.session, { action: 'install-ext', path: 'veldr-bridge.vsix', args: ['pub.other'] }, vsix);
    expect(rep.ok).toBe(true);
    expect(rep.exec?.stdout).toContain('installed');
    const got = JSON.parse(readFileSync(posix.join(record, 'extensions.json'), 'utf8')) as {
      args: string[];
      exts: Array<{ target: string; content?: string }>;
    };
    expect(got.exts[0].content).toBe('a vsix');
    expect(got.exts[1]).toEqual({ target: 'pub.other' });
    expect(got.args.slice(0, 4)).toEqual(['--user-data-dir', l.data, '--extensions-dir', l.ext]);
    expect(got.args.at(-1)).toBe('--force');
    // The staged VSIX is gone.
    expect(existsSync(got.exts[0].target)).toBe(false);
    // The installer's failure is the error, with its output.
    const failed = await upload(rr.session, { action: 'install-ext', path: 'x.vsix', args: ['fail'] }, vsix);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('exit status 1: installed');

    expect((await refusalOf(cs(rr.session, { action: 'marker', path: '.veldr-ext-a' }))).ok).toBe(false);
    expect((await cs(rr.session, { action: 'marker', path: '.veldr-ext-a', args: ['set'] })).ok).toBe(true);
    expect((await cs(rr.session, { action: 'marker', path: '../../.veldr-ext-a' })).ok).toBe(true);
    expect(existsSync(posix.join(l.ext, '.veldr-ext-a'))).toBe(true);
    for (const path of ['', '.', '..']) expect((await refusalOf(cs(rr.session, { action: 'marker', path, args: ['set'] }))).ok).toBe(false);
  });

  test('without code-server the VSIX is read on and the error comes back', async () => {
    const rr = await newRig();
    const rep = await upload(rr.session, { action: 'install-ext', path: 'x.vsix' }, Buffer.alloc(1 << 20));
    expect(rep).toEqual({ ok: false, error: 'code-server is not installed' });
  });
});

describe('the bridge socket', () => {
  /** The bridge streams a core's session gets, answered and echoed. */
  function bridgeCore(s: Session, ok = true) {
    const seen: Header[] = [];
    void (async () => {
      for (;;) {
        const st = await s.accept().catch(() => null);
        if (!st) return;
        void (async () => {
          const rd = new Reader(st);
          const h = await readLine<Header>(rd);
          seen.push(h);
          if (!ok) return void (await writeLine(st, { ok: false, error: 'plugin_disabled' }).then(() => st.end()));
          await writeLine(st, { ok: true });
          const line = await rd.line(1 << 20);
          await writeLine(st, { echo: JSON.parse(line) });
        })().catch(() => {});
      }
    })();
    return seen;
  }

  async function window(path: string, hello: unknown): Promise<unknown> {
    const c = connect(path);
    await new Promise((res, rej) => c.once('connect', res).once('error', rej));
    await writeLine(c, hello);
    try {
      return await readLine(new Reader(c));
    } finally {
      c.destroy();
    }
  }

  test('a window reaches the core that last opened VS Code, else the newest', async () => {
    const rr = await newRig();
    const l = layout(rr);
    await until(() => existsSync(l.bridge), 'the bridge socket');
    expect(statSync(l.bridge).mode & 0o777).toBe(0o600);
    const one = bridgeCore(rr.session);
    const second = rr.connect('core-2');
    const two = bridgeCore(second);
    await until(() => rr.agent.liveSessions().length === 2, 'both sessions');
    // Nobody opened VS Code: the newest session.
    expect(await window(l.bridge, { type: 'hello', id: 'w1' })).toEqual({ echo: { type: 'hello', id: 'w1' } });
    expect(two.map((h) => h.op)).toEqual([Op.Bridge]);
    expect(one).toEqual([]);
    // The first core opens code-server's socket (nothing need answer there
    // for the dial to count once it is connected).
    const fake = Bun.serve({ unix: l.socket, fetch: () => new Response('') });
    try {
      const { conn } = await rr.session.open({ op: Op.DialUnix, path: 'cs.sock' });
      await until(() => rr.agent.liveSessions()[0].dialed(l.socket).last > 0, 'the dial');
      expect(await window(l.bridge, { type: 'hello', id: 'w2' })).toEqual({ echo: { type: 'hello', id: 'w2' } });
      expect(one.map((h) => h.op)).toEqual([Op.Bridge]);
      conn.stream.destroy();
    } finally {
      void fake.stop(true);
    }
  });

  test('a connection that sends nothing reaches no core; a refusal closes the window', async () => {
    const rr = await newRig();
    const l = layout(rr);
    await until(() => existsSync(l.bridge), 'the bridge socket');
    const seen = bridgeCore(rr.session, false);
    const c = connect(l.bridge);
    await new Promise((res) => c.once('connect', res));
    await new Promise((res) => setTimeout(res, 200));
    c.destroy();
    expect(seen).toEqual([]);
    const refused = connect(l.bridge);
    await new Promise((res) => refused.once('connect', res));
    await writeLine(refused, { type: 'hello' });
    await new Promise((res) => refused.once('close', res));
    expect(seen.map((h) => h.op)).toEqual([Op.Bridge]);
  });

  test('the bridge choice', () => {
    const s = (id: number, last: number) => ({
      id,
      client: '',
      live: true,
      dialed: () => ({ open: 0, last }),
      ask: () => Promise.reject(new Error('no')),
    });
    expect(bridgeSession([], '/x')).toBeNull();
    expect(bridgeSession([s(1, 0), s(2, 0)], '/x')!.id).toBe(2);
    expect(bridgeSession([s(1, 5), s(2, 0), s(3, 1)], '/x')!.id).toBe(1);
    expect(bridgeSession([s(1, 5), s(2, 5)], '/x')!.id).toBe(2);
  });

  test('the newest agent of the instance takes the socket over, and the other serves it again once it is free', async () => {
    const rr = await newRig();
    const sock = layout(rr).bridge;
    await until(() => existsSync(sock), 'the bridge socket');
    const first = inode(sock);
    const other = new Agent({
      instance: '',
      dirs: rr.dirs,
      logger: discard,
      features: [vscodeMachine({ socketWatchMs: 50 })],
      socketWatchMs: 50,
    });
    await until(() => inode(sock) !== first && inode(sock) !== null, 'the newer agent to take the socket');
    const taken = inode(sock);
    await new Promise((res) => setTimeout(res, 200));
    expect(inode(sock)).toBe(taken);
    await other.close();
    await until(() => inode(sock) !== null && inode(sock) !== taken, 'the first agent to serve it again');
  });
});

describe('retention', () => {
  test('releases unused for 14 days go, staging after a day; the running one is kept', async () => {
    const dir = tempDir();
    const l = layoutOf({ home: dir, run: posix.join(dir, 'run'), host: posix.join(dir, 'host') }, 'linux-amd64');
    const now = new Date();
    const at = (p: string, ageMs: number, file = false) => {
      if (file) writeFileSync(p, '');
      else mkdirSync(p, { recursive: true });
      const t = new Date(now.getTime() - ageMs);
      utimesSync(p, t, t);
    };
    at(posix.join(l.root, '1-linux-amd64'), RELEASE_RETENTION_MS + 1000);
    at(posix.join(l.root, '2-linux-amd64'), RELEASE_RETENTION_MS - 60_000);
    at(posix.join(l.root, '3-linux-amd64'), RELEASE_RETENTION_MS * 2);
    at(posix.join(l.root, '.install-1-a'), STAGING_RETENTION_MS + 1000);
    at(posix.join(l.root, '.upload-1-b'), STAGING_RETENTION_MS + 1000, true);
    at(posix.join(l.root, '.download-1-c'), 60_000, true);
    await pruneReleases(l, '3-linux-amd64', now, discard);
    expect(readdirSync(l.root).sort()).toEqual(['.download-1-c', '2-linux-amd64', '3-linux-amd64']);
  });

  test('housekeeping keeps the running release and prunes the others', async () => {
    const rr = await newRig();
    const l = layout(rr);
    await installRelease(rr, tempDir());
    await cs(rr.session, { action: 'start' });
    const dir = releaseDir(l, VERSION);
    const old = new Date(Date.now() - RELEASE_RETENTION_MS * 2);
    utimesSync(dir, old, old);
    const gone = posix.join(l.root, `0.1-${l.platform}`);
    mkdirSync(gone);
    utimesSync(gone, old, old);
    // Another agent of the instance, whose housekeeping runs often.
    const t0 = Date.now();
    extra.push(
      new Agent({
        instance: '',
        dirs: rr.dirs,
        logger: discard,
        features: [vscodeMachine({ socketWatchMs: 50 })],
        socketWatchMs: 50,
        housekeepMs: 50,
      }),
    );
    await until(() => !existsSync(gone), 'the unused release to go');
    expect(statSync(dir).mtimeMs).toBeGreaterThanOrEqual(t0 - 1000);
  });
});

describe('one thread for every core', () => {
  // Unpacking runs in slices: the node's thread goes on (another session
  // is answered) and is never held long.
  test('unpacking a release leaves the thread free', async () => {
    const rr = await newRig();
    const record = tempDir();
    const top = `code-server-${VERSION}-linux-amd64`;
    const files: Entry[] = [];
    const noise = Buffer.alloc(512 << 10);
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < noise.length; j += 4) noise.writeUInt32LE((Math.random() * 2 ** 32) >>> 0, j);
      files.push({ path: `${top}/data/f${i}`, body: Buffer.from(noise) });
    }
    const tb = release(record, { more: [{ path: `${top}/data/`, type: 'Directory' }, ...files], level: 1 });
    let ticks = 0;
    let gap = 0;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
      ticks++;
    }, 1);
    const other = rr.connect('core-2');
    const t0 = performance.now();
    const installing = upload(rr.session, { action: 'install', digest: sha(tb) }, tb);
    const hello = await other.request({ op: Op.Hello });
    expect(hello.ok).toBe(true);
    const rep = await installing;
    const took = performance.now() - t0;
    clearInterval(t);
    expect(rep.cs?.installed).toBe(true);
    expect(statSync(posix.join(releaseDir(layout(rr), VERSION), 'data', 'f63')).size).toBe(512 << 10);
    expect(gap).toBeLessThan(250);
    expect(ticks).toBeGreaterThan(took / 50);
  });
});
