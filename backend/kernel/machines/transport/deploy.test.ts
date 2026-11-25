// The TypeScript machine executable deployed as an ssh connection deploys
// it, through an ssh that runs the remote commands here (homes of the
// test's own): the probe, the machine's own download of its build from the
// release (a server on loopback), the core's upload when the machine has
// no curl or wget, may not download, or got something else, each checked
// by its SHA-256 on the machine, and the node of that build, reached with
// node dial. The executable is this host's, compiled from the sources.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AGENT_DIR, CORE_BIN } from '#shared/lib/brand.ts';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, Op, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { compileMachine } from '#hosts/machine/compile.ts';
import { machineAsset, type TSBuild } from './builds.ts';
import { dialNode } from './local.ts';
import type { Session } from './session.ts';
import {
  DownloadFailures,
  PROBE_SCRIPT,
  checkRuntimeRuns,
  dialSSH,
  installScript,
  parseProbe,
  setMachineDownloadLimit,
  type SSHOptions,
} from './ssh.ts';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const key = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
const work = realpathSync(mkdtempSync('/tmp/hdp-'));
const instance = 'dev';
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, BUN_OPTIONS: process.env.BUN_OPTIONS };
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let exe: Buffer = Buffer.alloc(0);
let gz: Buffer = Buffer.alloc(0);
let release: Server | undefined;
let releaseURL = '';
/** What the release serves (tests swap it): bytes, a stream that does not
 * end, or one that trickles a byte every 500 ms. */
let served: Buffer | 'flood' | 'trickle' = Buffer.alloc(0);
const homes: string[] = [];

beforeAll(async () => {
  if (!supported) return;
  const out = join(work, 'machine');
  await compileMachine({ version: 'test-deploy', outfile: out });
  exe = readFileSync(out);
  gz = gzipSync(exe, { level: 1 });
  served = gz;
  release = createServer((req, res) => {
    if (req.url !== `/v1/${machineAsset(key)}.gz`) return void res.writeHead(404).end();
    if (served === 'flood') {
      res.writeHead(200);
      const chunk = Buffer.alloc(1 << 16);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
      };
      res.on('drain', pump);
      return pump();
    }
    if (served === 'trickle') {
      res.writeHead(200, { 'content-length': gz.length });
      const t = setInterval(() => res.write(Buffer.from([0x1f])), 500);
      return void res.on('close', () => clearInterval(t));
    }
    res.writeHead(200, { 'content-length': served.length }).end(served);
  });
  await new Promise<void>((r) => release!.listen(0, '127.0.0.1', r));
  releaseURL = `http://127.0.0.1:${(release.address() as { port: number }).port}/v1/${machineAsset(key)}.gz`;
}, 120_000);

afterAll(async () => {
  release?.close();
  // Each home's nodes end through their own command, at once.
  await Promise.all(
    homes.flatMap((h) =>
      (existsSync(join(h, AGENT_DIR)) ? readdirSync(join(h, AGENT_DIR)) : []).map(
        (v) =>
          new Promise((r) =>
            spawn(join(h, AGENT_DIR, v, CORE_BIN), ['node', 'stop', '--instance', instance], {
              env: { PATH: '/usr/bin:/bin', HOME: h },
              stdio: 'ignore',
            })
              .on('exit', r)
              .on('error', r),
          ),
      ),
    ),
  );
  Object.assign(process.env, { HOME: saved.HOME, PATH: saved.PATH });
  if (saved.BUN_OPTIONS === undefined) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = saved.BUN_OPTIONS;
  rmSync(work, { recursive: true, force: true });
}, 60_000);

/** The tools a machine has besides curl and wget, linked into a directory
 * of their own with extra (name: path), for a PATH without the others. */
function tools(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(work, 'tools-'));
  for (const t of [
    'sh',
    'cat',
    'gunzip',
    'gzip',
    'mkdir',
    'chmod',
    'mv',
    'rm',
    'cut',
    'find',
    'uname',
    'grep',
    'ls',
    'head',
    'wc',
    'tr',
    'shasum',
    'sha256sum',
    'openssl',
    'getconf',
    'ldd',
    'env',
    'true',
    'sleep',
    'perl',
  ])
    for (const d of ['/bin', '/usr/bin', '/sbin', '/usr/sbin'])
      if (existsSync(join(d, t)) && !existsSync(join(dir, t))) symlinkSync(join(d, t), join(dir, t));
  for (const [name, path] of Object.entries(extra)) {
    rmSync(join(dir, name), { force: true });
    symlinkSync(path, join(dir, name));
  }
  return dir;
}

/** The machine's wget, when this host has one. */
const WGET = ['/opt/homebrew/bin/wget', '/usr/local/bin/wget', '/usr/bin/wget', '/bin/wget'].find((p) => existsSync(p));

/** A home of its own, with an ssh that runs the remote command there with
 * PATH path (default: this one's). */
function machine(path = saved.PATH ?? '/usr/bin:/bin'): string {
  const home = mkdtempSync(join(work, 'h'));
  homes.push(home);
  const bin = join(home, '.ssh-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\ncd "$HOME" && PATH=${JSON.stringify(path)} exec /bin/sh -c "$*"\n`,
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.HOME = home;
  return home;
}

/** The environment of a session's node, as the programs it starts get it:
 * a terminal core that writes it down. */
async function nodeEnvironment(session: Session): Promise<string> {
  const fake = Buffer.from('#!/bin/sh\nenv > "${0%/*}/env.txt"\n');
  const digest = sha256(fake);
  const { conn } = await session.open({ op: Op.HC, action: 'install', digest });
  const cw = new ChunkWriter(conn.stream);
  await cw.write(gzipSync(fake));
  await cw.finish();
  await readLine<Reply>(new Reader(conn.reader.release()));
  closeStream(conn.stream);
  await session.request({ op: Op.HC, action: 'start', digest }, { timeoutMs: 30_000 });
  return readFileSync(join(dirsFor(instance).host, 'hc', 'env.txt'), 'utf8');
}

/** The build of this host's executable; loads counts the core's loads. */
function build(o: { url?: string; digest?: string } = {}): TSBuild & { loads: number } {
  const digest = o.digest ?? sha256(exe);
  const b = {
    kind: 'ts' as const,
    key,
    digest,
    gzDigest: sha256(gz),
    gzSize: gz.length,
    version: digest.slice(0, 16),
    ...(o.url ? { url: o.url } : {}),
    loads: 0,
    load: async () => (b.loads++, gz),
  };
  return b;
}

const options = (b: TSBuild, logs: string[], o: Partial<SSHOptions> = {}): SSHOptions => ({
  target: 'box',
  controlDir: '',
  builds: async () => b,
  logger: (l) => logs.push(l),
  instance,
  ...o,
});

test('the probe reports the C library, its C++ runtime and SSE4.2; a machine Bun cannot run on is refused', () => {
  const p = parseProbe(
    'motd\n@os=Linux\n@arch=x86_64\n@home=/home/u\n@gnulibc=\n@ldd=musl libc (x86_64)\n@muslloader=yes\n@libs=no\n@sse42=yes\n',
  );
  expect(p).toEqual({ os: 'linux', arch: 'amd64', home: '/home/u', libc: 'musl', libs: false, sse42: true });
  expect(() => checkRuntimeRuns(p)).toThrow(/^libs_missing/);
  expect(() => checkRuntimeRuns({ ...p, libc: 'glibc', sse42: false })).toThrow(/^cpu_unsupported/);
  expect(() => checkRuntimeRuns({ ...p, arch: 'arm64', libc: 'glibc', sse42: false })).not.toThrow();
  // A glibc system with musl's package: musl's loader in /lib.
  expect(
    parseProbe('@os=Linux\n@arch=aarch64\n@home=/h\n@gnulibc=glibc 2.41\n@ldd=ldd (Debian GLIBC 2.41) 2.41\n@muslloader=yes\n').libc,
  ).toBe('glibc');
  const here = parseProbe(spawnSync('/bin/sh', ['-c', PROBE_SCRIPT], { encoding: 'utf8' }).stdout);
  expect(here.os).toBe(process.platform);
});

describe.skipIf(!supported)('the machine executable over ssh', () => {
  test('the machine downloads its build from the release itself, checked; the core uploads nothing; its node answers', async () => {
    const home = machine();
    const logs: string[] = [];
    const b = build({ url: releaseURL });
    const { session } = await dialSSH(options(b, logs));
    try {
      const hello = await session.request({ op: Op.Hello });
      expect(hello.info?.home).toBe(home);
      expect(hello.info?.version).toBe('test-deploy');
      expect(b.loads).toBe(0);
      expect(logs.some((l) => l.includes('downloads its build'))).toBe(true);
      expect(logs.some((l) => l.includes('uploading'))).toBe(false);
      expect(readFileSync(join(home, AGENT_DIR, b.version, CORE_BIN)).equals(exe)).toBe(true);
    } finally {
      session.close();
    }
    // Again: nothing is fetched or uploaded.
    const again = await dialSSH(options(b, logs));
    expect((await again.session.request({ op: Op.Hello })).ok).toBe(true);
    again.session.close();
    expect(logs.filter((l) => l.includes('downloads its build'))).toHaveLength(1);
  }, 60_000);

  test('a machine without curl or wget, one that may not download, and a download that is not the build: the core uploads it', async () => {
    // A PATH of the tools a machine has, without curl and wget.
    const none = tools();
    for (const [why, path, url, served2, download] of [
      ['no curl or wget', none, releaseURL, gz, true],
      ['may not download', undefined, releaseURL, gz, false],
      ['a download that fails', undefined, `${releaseURL}.missing`, gz, true],
      ['not the build', undefined, releaseURL, gzipSync(Buffer.from('another build')), true],
    ] as const) {
      const home = machine(path);
      served = served2 as Buffer;
      const logs: string[] = [];
      const b = build({ url });
      const { session } = await dialSSH(options(b, logs, { machineDownload: download }));
      try {
        expect((await session.request({ op: Op.Hello })).ok).toBe(true);
        expect(b.loads).toBe(1);
        expect(
          logs.some((l) => l.includes('uploading the machine build')),
          why,
        ).toBe(true);
        expect(
          logs.some((l) => l.includes('downloads its build')),
          why,
        ).toBe(download);
        expect(readFileSync(join(home, AGENT_DIR, b.version, CORE_BIN)).equals(exe)).toBe(true);
        expect(readdirSync(join(home, AGENT_DIR, b.version))).toEqual([CORE_BIN]);
      } finally {
        session.close();
      }
    }
    served = gz;
  }, 120_000);

  test.skipIf(!WGET)(
    'a machine with wget alone downloads its build with it',
    async () => {
      const home = machine(tools({ wget: WGET! }));
      served = gz;
      const logs: string[] = [];
      const b = build({ url: releaseURL });
      const { session } = await dialSSH(options(b, logs));
      try {
        expect((await session.request({ op: Op.Hello })).ok).toBe(true);
        expect(b.loads, logs.join('\n')).toBe(0);
        expect(readFileSync(join(home, AGENT_DIR, b.version, CORE_BIN)).equals(exe)).toBe(true);
      } finally {
        session.close();
      }
    },
    60_000,
  );

  test("the machine's download is bounded: a stream that does not end stops at the asset's size, a trickle at the time limit (curl, and wget alone), and a gzip bomb is never decompressed", async () => {
    // gunzip as the machine has it, writing down each call.
    const calls = join(work, 'gunzip-calls');
    const spy = join(work, 'gunzip-spy');
    writeFileSync(
      spy,
      `#!/bin/sh\necho "$*" >> '${calls}'\nexec ${existsSync('/usr/bin/gunzip') ? '/usr/bin/gunzip' : '/bin/gunzip'} "$@"\n`,
      { mode: 0o755 },
    );
    // 200 MB of zeros, compressed, padded to the asset's size: only its
    // digest tells it from the asset.
    const bomb = Buffer.concat([gzipSync(Buffer.alloc(200 << 20), { level: 9 })]);
    const padded = Buffer.concat([bomb, Buffer.alloc(gz.length - bomb.length)]);
    setMachineDownloadLimit(3);
    try {
      for (const [why, path, body] of [
        ['a stream that does not end (curl)', undefined, 'flood'],
        ['a trickle (curl)', undefined, 'trickle'],
        ...(WGET ? ([['a trickle (wget alone)', tools({ wget: WGET }), 'trickle']] as const) : []),
        ['a gzip bomb', tools({ curl: '/usr/bin/curl', gunzip: spy }), padded],
      ] as const) {
        rmSync(calls, { force: true });
        const home = machine(path);
        served = body;
        const logs: string[] = [];
        const b = build({ url: releaseURL });
        const t0 = Date.now();
        const { session } = await dialSSH(options(b, logs));
        session.close();
        expect(Date.now() - t0, why).toBeLessThan(20_000);
        expect(
          logs.some((l) => l.includes('could not download')),
          why,
        ).toBe(true);
        expect(b.loads, why).toBe(1);
        expect(readdirSync(join(home, AGENT_DIR, b.version)), why).toEqual([CORE_BIN]);
        // Only the upload decompressed anything (from its standard input).
        if (body === padded) expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['-c']);
      }
    } finally {
      setMachineDownloadLimit(300);
      served = gz;
    }
  }, 120_000);

  test("a machine whose own download failed gets the core's upload at once for a day, then downloads again", async () => {
    let now = 0;
    const failures = new DownloadFailures(24 * 60 * 60_000, () => now);
    const none = tools();
    const deploy = async (path?: string) => {
      machine(path);
      const logs: string[] = [];
      const { session } = await dialSSH(options(build({ url: releaseURL }), logs, { downloadFailures: failures }));
      session.close();
      return logs.some((l) => l.includes('downloads its build'));
    };
    served = gz;
    expect(await deploy(none)).toBe(true);
    // Within the day: no attempt, even where it would work now.
    now += 60_000;
    expect(await deploy()).toBe(false);
    // A day later: tried again, and it works.
    now += 24 * 60 * 60_000;
    expect(await deploy()).toBe(true);
    expect(failures.recent('box')).toBe(false);
  }, 120_000);

  test("a deployment failure keeps its code through the dial's error", async () => {
    machine();
    const { Unsupported } = await import('./errors.ts');
    const o = options(build(), []);
    o.builds = async () => {
      throw new Unsupported('platform_unsupported', 'no machine build for this platform');
    };
    const e = (await dialSSH(o).then(
      () => new Error('dialed'),
      (x: unknown) => x,
    )) as Error & { code?: string };
    expect(e.code).toBe('platform_unsupported');
    expect(e.message).toContain('no agent for');
    // Nothing has the build.
    const unusable = { ...build(), load: async () => Promise.reject(new Unsupported('build_unavailable', 'nothing has it')) };
    const u = (await dialSSH(options(unusable, [], { machineDownload: false })).then(
      () => new Error('dialed'),
      (x: unknown) => x,
    )) as Error & { code?: string };
    expect(u.code).toBe('build_unavailable');
  }, 60_000);

  test('a build whose digest is not the one the machine computes is put in place by neither the download nor the upload', async () => {
    const home = machine();
    const b = build({ url: releaseURL, digest: 'f'.repeat(64) });
    await expect(dialSSH(options(b, []))).rejects.toThrow(/upload the machine build/);
    expect(existsSync(join(home, AGENT_DIR, b.version, CORE_BIN))).toBe(false);
    expect(readdirSync(join(home, AGENT_DIR, b.version))).toEqual([]);
  }, 60_000);

  test("a working directory's .env and bunfig.toml, and BUN_OPTIONS, reach neither node dial nor the node it starts", async () => {
    const home = machine();
    // What would run code in a Bun executable, or change its environment:
    // in the directory node dial runs in and the node starts in (home).
    const marker = join(home, 'preloaded');
    writeFileSync(join(home, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.pid, '')`);
    writeFileSync(join(home, 'bunfig.toml'), 'preload = ["./evil.js"]\n');
    writeFileSync(join(home, '.env'), 'EVIL_DOTENV=1\n');
    const preloads = () => readdirSync(home).filter((n) => n.startsWith('preloaded-'));
    // The control: the executable honours BUN_OPTIONS when it is given.
    writeFileSync(join(work, 'machine.copy'), exe, { mode: 0o755 });
    spawnSync(join(work, 'machine.copy'), ['version'], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, BUN_OPTIONS: `--preload=${join(home, 'evil.js')}` },
    });
    expect(preloads().length).toBeGreaterThan(0);
    for (const f of preloads()) rmSync(join(home, f));

    process.env.BUN_OPTIONS = `--preload=${join(home, 'evil.js')}`;
    const { session } = await dialSSH(options(build({ url: releaseURL }), []));
    try {
      expect((await session.request({ op: Op.Hello })).ok).toBe(true);
      const env = await nodeEnvironment(session);
      expect(env).not.toContain('EVIL_DOTENV');
      expect(env).not.toContain('BUN_OPTIONS');
      expect(preloads()).toEqual([]);
    } finally {
      session.close();
      delete process.env.BUN_OPTIONS;
    }
  }, 60_000);

  test("the local machine's node gets none of BUN_OPTIONS, BUN_BE_BUN and BUN_INSPECT* of the core's environment", async () => {
    const home = machine();
    const marker = join(home, 'preloaded');
    writeFileSync(join(home, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.pid, '')`);
    const vars = {
      BUN_OPTIONS: `--preload=${join(home, 'evil.js')}`,
      BUN_INSPECT: 'ws://127.0.0.1:9/x',
      BUN_INSPECT_NOTIFY: 'unix:///nonexistent',
    };
    Object.assign(process.env, vars);
    let session: Awaited<ReturnType<typeof dialNode>> | undefined;
    try {
      session = await dialNode({ instance, builds: async () => build(), logger: () => {} });
      expect((await session.request({ op: Op.Hello })).info?.home).toBe(home);
      const env = await nodeEnvironment(session);
      for (const k of Object.keys(vars)) expect(env).not.toContain(`${k}=`);
      expect(readdirSync(home).filter((n) => n.startsWith('preloaded-'))).toEqual([]);
    } finally {
      session?.close();
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  }, 60_000);

  test('an upload that breaks off (the connection hung up) leaves no partial file', async () => {
    const dir = join(work, 'interrupted');
    const sh = spawn('/bin/sh', ['-c', installScript(dir, CORE_BIN, 'f'.repeat(64))], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    sh.stdin!.write(gzipSync(Buffer.alloc(8 << 20, 7)).subarray(0, 4096));
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(dir).filter((n) => n.startsWith('.upload.'))).toHaveLength(1);
    const exited = new Promise((r) => sh.once('exit', r));
    process.kill(-sh.pid!, 'SIGHUP');
    await exited;
    expect(readdirSync(dir)).toEqual([]);
  });
});
