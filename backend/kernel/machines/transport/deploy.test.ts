// The TypeScript build deployed as an ssh connection deploys it, through an
// ssh that runs the remote commands here (homes of the test's own): the
// probe; the release's manifest (SHA256SUMS), which the core fetches, by
// its own HTTPS through the machine when the release is unreachable from
// it (an ssh -W stand-in forwarding to a TLS server on loopback whose
// certificate a test authority signed, testdata/), and never otherwise
// takes from the machine; the machine's own
// download of the release's archive, checked against the manifest before
// it is unpacked, bounded in size and time, with curl or wget alone; the
// core's upload when the machine cannot (no tool, not allowed, a failed or
// tampered download), from the release, the operator's directory or the
// core's own executable, checked again on the machine; the node of that
// build, reached with node dial; what the node's environment gets. The
// release is a server on loopback; the executable is this host's, built
// from the sources with --machine ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AGENT_DIR, CORE_BIN } from '#shared/lib/brand.ts';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, Op, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { archiveMember, archiveName, bareName, tsVersion, type TSBuild } from './builds.ts';
import { deployCode } from './errors.ts';
import { dialNode } from './local.ts';
import { ownFile, Release, SUMS, type ReleaseOptions } from './release.ts';
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
let exePath = '';
let exe: Buffer = Buffer.alloc(0);
let archive: Buffer = Buffer.alloc(0);
let goodSums = '';
let releaseURL = '';
let release: Server | undefined;
let tlsRelease: HttpsServer | undefined;
const homes: string[] = [];

/** What the release serves, to the machine (curl, wget) and to the core
 * (its fetch) apart: bytes, 404, a stream that does not end, or one that
 * trickles a byte every 500 ms. */
type Body = Buffer | string | 404 | 'flood' | 'trickle';
const serve: { hostArchive: Body; coreArchive: Body; hostSums: Body; coreSums: Body } = {
  hostArchive: 404,
  coreArchive: 404,
  hostSums: 404,
  coreSums: 404,
};
function reset() {
  Object.assign(serve, { hostArchive: archive, coreArchive: archive, hostSums: goodSums, coreSums: goodSums });
}

/** The release's archive of the platform's executable. */
function archiveOf(bytes: Buffer): Buffer {
  const d = mkdtempSync(join(work, 'a-'));
  mkdirSync(join(d, bareName(key)));
  writeFileSync(join(d, archiveMember(key)), bytes, { mode: 0o755 });
  const r = spawnSync('tar', ['-czf', '-', '-C', d, bareName(key)], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  return r.stdout;
}
const sumsOf = (o: { exe: string; archive: string }) => `${o.archive}  ${archiveName(key)}\n${o.exe}  ${archiveMember(key)}\n`;

beforeAll(async () => {
  if (!supported) return;
  exePath = join(work, bareName(key));
  const p = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, '..', '..', '..', 'scripts', 'build.ts'),
      '--out',
      exePath,
      '--machine',
      'ts',
      '--version',
      'test-deploy',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (p.exitCode !== 0) throw new Error(`build: ${p.stderr.toString()}`);
  exe = readFileSync(exePath);
  archive = archiveOf(exe);
  goodSums = sumsOf({ exe: sha256(exe), archive: sha256(archive) });
  reset();
  release = createServer((req, res) => {
    const host = /^(curl|wget)/i.test(req.headers['user-agent'] ?? '');
    const name = (req.url ?? '').replace(/^\/v1\//, '');
    const body: Body =
      name === SUMS
        ? host
          ? serve.hostSums
          : serve.coreSums
        : name === archiveName(key)
          ? host
            ? serve.hostArchive
            : serve.coreArchive
          : 404;
    if (body === 404) return void res.writeHead(404).end();
    if (body === 'flood') {
      res.writeHead(200);
      const chunk = Buffer.alloc(1 << 16);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
      };
      res.on('drain', pump);
      return pump();
    }
    if (body === 'trickle') {
      res.writeHead(200, { 'content-length': archive.length });
      const t = setInterval(() => res.write(Buffer.from([0x1f])), 500);
      return void res.on('close', () => clearInterval(t));
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((r) => release!.listen(0, '127.0.0.1', r));
  releaseURL = `http://127.0.0.1:${(release.address() as { port: number }).port}/v1`;
  tlsRelease = createHttpsServer(
    {
      cert: readFileSync(join(import.meta.dir, 'testdata', 'test-release.pem')),
      key: readFileSync(join(import.meta.dir, 'testdata', 'test-release-key.pem')),
    },
    (req, res) => (req.url === `/v1/${SUMS}` ? res.writeHead(200).end(goodSums) : res.writeHead(404).end()),
  );
  await new Promise<void>((r) => tlsRelease!.listen(0, '127.0.0.1', r));
  tlsPort = (tlsRelease.address() as { port: number }).port;
}, 120_000);

afterAll(async () => {
  release?.close();
  tlsRelease?.close();
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
    'tar',
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
  // ssh -W host:port forwards (forward.js) as tunnel says: a port of this
  // host, or a refusal as an sshd that forbids forwarding gives one.
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nfwd=\nwhile [ "$1" != "--" ]; do [ "$1" = -W ] && fwd=$2; shift; done\n` +
      `[ -n "$fwd" ] && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FORWARD)} ${JSON.stringify(TUNNEL)} "$fwd"\n` +
      `shift 2\ncd "$HOME" && PATH=${JSON.stringify(path)} exec /bin/sh -c "$*"\n`,
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.HOME = home;
  return home;
}

/** The stand-in's ssh -W: where it forwards (TUNNEL holds a port, or
 * "refuse"), each request written down beside it. */
const FORWARD = join(work, 'forward.js');
const TUNNEL = join(work, 'tunnel');
writeFileSync(
  FORWARD,
  `const net = require('net'), fs = require('fs');
const [ctl, to] = process.argv.slice(2);
fs.appendFileSync(ctl + '.log', to + '\\n');
const how = fs.existsSync(ctl) ? fs.readFileSync(ctl, 'utf8').trim() : 'refuse';
if (how === 'refuse') { process.stderr.write('channel 0: open failed: administratively prohibited: open failed\\nstdio forwarding failed\\n'); process.exit(255); }
const s = net.connect(Number(how), '127.0.0.1');
process.stdin.pipe(s); s.pipe(process.stdout);
s.on('close', () => process.exit(0)); s.on('error', () => process.exit(1));
`,
);
const tunnelled = () => (existsSync(`${TUNNEL}.log`) ? readFileSync(`${TUNNEL}.log`, 'utf8').trim().split('\n') : []);

/** The test authority, and the release over TLS with the certificate of
 * releases.test it signed (testdata/, tests only). */
const TEST_CA = readFileSync(join(import.meta.dir, 'testdata', 'test-ca.pem'));
let tlsPort = 0;

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

/** The build of this host's platform from a release of the test's own
 * (a new core: nothing remembered); loads counts the core's uploads. */
function build(o: Partial<ReleaseOptions> = {}): TSBuild & { loads: number; logs: string[] } {
  const logs: string[] = [];
  const rel = new Release({
    version: 'test-deploy',
    url: releaseURL,
    cacheDir: mkdtempSync(join(work, 'cache-')),
    logger: (l) => logs.push(l),
    ...o,
  });
  const url = rel.url(archiveName(key));
  const b = {
    kind: 'ts' as const,
    key,
    ...(url ? { url } : {}),
    loads: 0,
    logs,
    digests: (x: Parameters<TSBuild['digests']>[0]) => rel.digests(key, x),
    load: (d: Parameters<TSBuild['load']>[0]) => (b.loads++, rel.load(key, d)),
  };
  return b;
}

const options = (b: TSBuild & { logs: string[] }, o: Partial<SSHOptions> = {}): SSHOptions => ({
  target: 'box',
  controlDir: '',
  builds: async () => b,
  logger: (l) => b.logs.push(l),
  instance,
  ...o,
});

const installed = (home: string) => join(home, AGENT_DIR, tsVersion(sha256(exe)));
const saw = (b: { logs: string[] }, s: string) => b.logs.some((l) => l.includes(s));

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

describe.skipIf(!supported)('the TypeScript build over ssh', () => {
  test("the core fetches the manifest, the machine downloads the release's archive and checks it; nothing is uploaded; its node answers", async () => {
    reset();
    const home = machine();
    const b = build();
    const { session } = await dialSSH(options(b));
    try {
      const hello = await session.request({ op: Op.Hello });
      expect(hello.info?.home).toBe(home);
      expect(hello.info?.version).toBe('test-deploy');
      expect(b.loads).toBe(0);
      expect(saw(b, 'downloads its build')).toBe(true);
      expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
      expect(readdirSync(installed(home))).toEqual([CORE_BIN]);
    } finally {
      session.close();
    }
    // Again: nothing is fetched or uploaded.
    const again = await dialSSH(options(b));
    expect((await again.session.request({ op: Op.Hello })).ok).toBe(true);
    again.session.close();
    expect(b.logs.filter((l) => l.includes('downloads its build'))).toHaveLength(1);
  }, 60_000);

  test("without curl or wget, not allowed to download, a failed download and one tampered on the machine's path: the core uploads the release's archive, checked on the machine", async () => {
    const none = tools();
    for (const [why, path, hostArchive, download] of [
      ['no curl or wget', none, archive, true],
      ['may not download', undefined, archive, false],
      ['a download that fails', undefined, 404, true],
      ["tampered on the machine's path", undefined, archiveOf(Buffer.from('another build')), true],
    ] as const) {
      reset();
      serve.hostArchive = hostArchive;
      const home = machine(path);
      const b = build();
      const { session } = await dialSSH(options(b, { machineDownload: download }));
      try {
        expect((await session.request({ op: Op.Hello })).ok).toBe(true);
        expect(b.loads, why).toBe(1);
        expect(saw(b, 'the release archive'), why).toBe(true);
        expect(saw(b, 'downloads its build'), why).toBe(download);
        expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
        expect(readdirSync(installed(home))).toEqual([CORE_BIN]);
      } finally {
        session.close();
      }
    }
  }, 180_000);

  test.skipIf(!WGET)(
    'a machine with wget alone downloads its build with it',
    async () => {
      reset();
      const home = machine(tools({ wget: WGET! }));
      const b = build();
      const { session } = await dialSSH(options(b));
      try {
        expect((await session.request({ op: Op.Hello })).ok).toBe(true);
        expect(b.loads, b.logs.join('\n')).toBe(0);
        expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
      } finally {
        session.close();
      }
    },
    60_000,
  );

  test("the machine's download is bounded: a stream that does not end stops at the cap, a trickle at the time limit (curl, and wget alone), and a gzip bomb is never unpacked", async () => {
    // gunzip as the machine has it, writing down each call.
    const calls = join(work, 'gunzip-calls');
    const spy = join(work, 'gunzip-spy');
    writeFileSync(
      spy,
      `#!/bin/sh\necho "$*" >> '${calls}'\nexec ${existsSync('/usr/bin/gunzip') ? '/usr/bin/gunzip' : '/bin/gunzip'} "$@"\n`,
      { mode: 0o755 },
    );
    const bomb = gzipSync(Buffer.alloc(200 << 20), { level: 9 });
    setMachineDownloadLimit(3, archive.length * 2);
    try {
      for (const [why, path, body] of [
        ['a stream that does not end (curl)', undefined, 'flood'],
        ['a trickle (curl)', undefined, 'trickle'],
        ...(WGET ? ([['a trickle (wget alone)', tools({ wget: WGET }), 'trickle']] as const) : []),
        ['a gzip bomb', tools({ curl: '/usr/bin/curl', gunzip: spy }), bomb],
      ] as const) {
        reset();
        serve.hostArchive = body;
        rmSync(calls, { force: true });
        const home = machine(path);
        const b = build();
        const t0 = Date.now();
        const { session } = await dialSSH(options(b));
        session.close();
        expect(Date.now() - t0, why).toBeLessThan(20_000);
        expect(saw(b, 'could not download'), why).toBe(true);
        expect(b.loads, why).toBe(1);
        expect(readdirSync(installed(home)), why).toEqual([CORE_BIN]);
        // Only the upload's archive was unpacked (after its digest).
        if (body === bomb) expect(readFileSync(calls, 'utf8').trim().split('\n'), why).toHaveLength(1);
      }
    } finally {
      setMachineDownloadLimit(300);
      reset();
    }
  }, 120_000);

  test("a machine whose own download failed gets the core's upload at once for a day, then downloads again", async () => {
    reset();
    let now = 0;
    const failures = new DownloadFailures(24 * 60 * 60_000, () => now);
    const none = tools();
    const deploy = async (path?: string) => {
      machine(path);
      const b = build();
      const { session } = await dialSSH(options(b, { downloadFailures: failures }));
      session.close();
      return saw(b, 'downloads its build');
    };
    expect(await deploy(none)).toBe(true);
    // Within the day: no attempt, even where it would work now.
    now += 60_000;
    expect(await deploy()).toBe(false);
    // A day later: tried again, and it works.
    now += 24 * 60 * 60_000;
    expect(await deploy()).toBe(true);
    expect(failures.recent('box')).toBe(false);
  }, 120_000);

  test('a release the core cannot reach: it fetches the manifest through the machine with its own TLS, the machine is never trusted for it; the build follows', async () => {
    reset();
    writeFileSync(TUNNEL, String(tlsPort));
    rmSync(`${TUNNEL}.log`, { force: true });
    const home = machine();
    // releases.test has no address: the core's own fetch finds it unreachable.
    const b = build({ url: `https://releases.test:${tlsPort}/v1`, tunnelCA: TEST_CA, own: ownFile(key, openSync(exePath, 'r')) });
    const { session } = await dialSSH(options(b));
    try {
      expect((await session.request({ op: Op.Hello })).ok).toBe(true);
      expect(tunnelled()).toEqual([`releases.test:${tlsPort}`]);
      expect(saw(b, 'the core could not download')).toBe(true);
      // The machine cannot resolve the release either: the core uploads its own.
      expect(b.loads).toBe(1);
      expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
    } finally {
      session.close();
      rmSync(TUNNEL, { force: true });
    }
  }, 60_000);

  test('a certificate the core does not trust, or an HTTP answer, on its own fetch: build_unavailable, and the machine is not asked for the manifest', async () => {
    reset();
    serve.coreSums = 404;
    writeFileSync(TUNNEL, String(tlsPort));
    for (const url of [`https://127.0.0.1:${tlsPort}/v1`, releaseURL]) {
      rmSync(`${TUNNEL}.log`, { force: true });
      machine();
      const b = build({ url, tunnelCA: TEST_CA });
      const e = await dialSSH(options(b)).then(
        () => new Error('dialed'),
        (x: unknown) => x as Error,
      );
      expect(deployCode(e), url).toBe('build_unavailable');
      expect(e.message).toContain('the core could not download');
      expect(tunnelled()).toEqual([]);
    }
    rmSync(TUNNEL, { force: true });
    reset();
  }, 60_000);

  test('a release the core cannot reach and a machine whose sshd does not forward: build_unavailable, saying so', async () => {
    reset();
    writeFileSync(TUNNEL, 'refuse');
    machine();
    const b = build({ url: `https://releases.test:${tlsPort}/v1`, tunnelCA: TEST_CA });
    const e = await dialSSH(options(b)).then(
      () => new Error('dialed'),
      (x: unknown) => x as Error,
    );
    expect(deployCode(e)).toBe('build_unavailable');
    expect(e.message).toContain('administratively prohibited');
    expect(saw(b, 'AllowTcpForwarding')).toBe(true);
    rmSync(TUNNEL, { force: true });
  }, 60_000);

  test('a machine whose download failed lately is asked again when the core has nothing to upload', async () => {
    reset();
    serve.coreArchive = 404;
    const failures = new DownloadFailures();
    failures.failure('box');
    const home = machine();
    const b = build();
    const { session } = await dialSSH(options(b, { downloadFailures: failures }));
    try {
      expect((await session.request({ op: Op.Hello })).ok).toBe(true);
      expect(saw(b, 'failed within the last day')).toBe(true);
      expect(saw(b, 'downloads its build')).toBe(true);
      expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
      expect(failures.recent('box')).toBe(false);
    } finally {
      session.close();
      reset();
    }
  }, 60_000);

  test('a manifest whose executable is not the one in the archive: neither the download nor the upload puts anything in place', async () => {
    reset();
    serve.coreSums = serve.hostSums = sumsOf({ exe: 'f'.repeat(64), archive: sha256(archive) });
    const home = machine();
    const b = build();
    const e = await dialSSH(options(b)).then(
      () => new Error('dialed'),
      (x: unknown) => x as Error,
    );
    expect(e.message).toMatch(/upload the machine build/);
    expect(readdirSync(join(home, AGENT_DIR, 'f'.repeat(16)))).toEqual([]);
    reset();
  }, 60_000);

  test("an offline site: the operator's directory with the release's SHA256SUMS and archive, uploaded from there", async () => {
    reset();
    const dir = mkdtempSync(join(work, 'dir-'));
    writeFileSync(join(dir, SUMS), goodSums);
    writeFileSync(join(dir, archiveName(key)), archive);
    const home = machine(tools());
    const b = build({ url: undefined, dir });
    const { session } = await dialSSH(options(b));
    try {
      expect((await session.request({ op: Op.Hello })).ok).toBe(true);
      expect(b.loads).toBe(1);
      expect(saw(b, 'the release archive')).toBe(true);
      expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
    } finally {
      session.close();
    }
  }, 60_000);

  test('no route anywhere: the deployment ends with build_unavailable, saying what was tried, and the core logs it', async () => {
    reset();
    machine(tools());
    const b = build({ url: 'http://127.0.0.1:9/v1' });
    const e = await dialSSH(options(b)).then(
      () => new Error('dialed'),
      (x: unknown) => x as Error & { code?: string },
    );
    expect(deployCode(e)).toBe('build_unavailable');
    expect(e.message).toContain('the core cannot reach');
    expect(e.message).toContain('through the machine either');
    expect(saw(b, 'the core could not download')).toBe(true);
  }, 60_000);

  test("a deployment failure keeps its code through the dial's error", async () => {
    machine();
    const { Unsupported } = await import('./errors.ts');
    const b = build();
    const o = options(b);
    o.builds = async () => {
      throw new Unsupported('platform_unsupported', 'no machine build for this platform');
    };
    const e = (await dialSSH(o).then(
      () => new Error('dialed'),
      (x: unknown) => x,
    )) as Error & { code?: string };
    expect(e.code).toBe('platform_unsupported');
    expect(e.message).toContain('no agent for');
  }, 60_000);

  test("a working directory's .env and bunfig.toml, and BUN_OPTIONS, reach neither node dial nor the node it starts", async () => {
    reset();
    const home = machine();
    // What would run code in a Bun executable, or change its environment:
    // in the directory node dial runs in and the node starts in (home).
    const marker = join(home, 'preloaded');
    writeFileSync(join(home, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.pid, '')`);
    writeFileSync(join(home, 'bunfig.toml'), 'preload = ["./evil.js"]\n');
    writeFileSync(join(home, '.env'), 'EVIL_DOTENV=1\n');
    const preloads = () => readdirSync(home).filter((n) => n.startsWith('preloaded-'));
    // The control: the executable honours BUN_OPTIONS when it is given.
    spawnSync(exePath, ['version'], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, BUN_OPTIONS: `--preload=${join(home, 'evil.js')}` },
    });
    expect(preloads().length).toBeGreaterThan(0);
    for (const f of preloads()) rmSync(join(home, f));

    process.env.BUN_OPTIONS = `--preload=${join(home, 'evil.js')}`;
    process.env.BUN_CONFIG_VERBOSE_FETCH = 'curl';
    // The core's own executable: this process fetches nothing meanwhile
    // (it would print it).
    const { session } = await dialSSH(options(build({ url: undefined, own: ownFile(key, openSync(exePath, 'r')) })));
    try {
      expect((await session.request({ op: Op.Hello })).ok).toBe(true);
      const env = await nodeEnvironment(session);
      expect(env).not.toContain('EVIL_DOTENV');
      expect(env).not.toContain('BUN_OPTIONS');
      expect(env).not.toContain('BUN_CONFIG_VERBOSE_FETCH');
      expect(preloads()).toEqual([]);
    } finally {
      session.close();
      delete process.env.BUN_OPTIONS;
      delete process.env.BUN_CONFIG_VERBOSE_FETCH;
    }
  }, 60_000);

  test("the local machine gets the core's own executable, and its node none of BUN_OPTIONS, BUN_BE_BUN and BUN_INSPECT* of the core's environment", async () => {
    const home = machine();
    const marker = join(home, 'preloaded');
    writeFileSync(join(home, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.pid, '')`);
    const vars = {
      BUN_OPTIONS: `--preload=${join(home, 'evil.js')}`,
      BUN_INSPECT: 'ws://127.0.0.1:9/x',
      BUN_INSPECT_NOTIFY: 'unix:///nonexistent',
      BUN_CONFIG_VERBOSE_FETCH: 'curl',
    };
    Object.assign(process.env, vars);
    let session: Awaited<ReturnType<typeof dialNode>> | undefined;
    try {
      // A build of no release, offline: its own executable is the build.
      const b = build({ url: undefined, own: ownFile(key, openSync(exePath, 'r')) });
      session = await dialNode({ instance, builds: async () => b, logger: () => {} });
      expect((await session.request({ op: Op.Hello })).info?.home).toBe(home);
      expect(readFileSync(join(installed(home), CORE_BIN)).equals(exe)).toBe(true);
      const env = await nodeEnvironment(session);
      for (const k of Object.keys(vars)) expect(env).not.toContain(`${k}=`);
      expect(readdirSync(home).filter((n) => n.startsWith('preloaded-'))).toEqual([]);
    } finally {
      session?.close();
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  }, 60_000);

  test('an upload that breaks off (the connection went) leaves no partial file', async () => {
    const dir = join(work, 'interrupted');
    const sh = spawn('/bin/sh', ['-c', installScript({ dir, name: CORE_BIN, exe: 'f'.repeat(64) })], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    sh.stdin!.write(gzipSync(Buffer.alloc(8 << 20, 7)).subarray(0, 4096));
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(dir).filter((n) => n.startsWith('.upload.'))).toHaveLength(1);
    const exited = new Promise((r) => sh.once('exit', r));
    // The input ends, as when the connection goes.
    sh.stdin!.end();
    await exited;
    expect(readdirSync(dir)).toEqual([]);
  });
});
