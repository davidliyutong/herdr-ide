// The TypeScript machine build deployed as an ssh upload deploys it, through
// an ssh that runs the remote commands here (a home of the test's own): the
// probe, the runtime uploaded once and the build per version, each checked
// by its digest on the machine, the launcher that runs them, and its node,
// reached with node dial. The runtime is the one running the tests.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { AGENT_DIR, CORE_BIN, RUNTIME_DIR } from '#shared/lib/brand.ts';
import { createHash } from 'node:crypto';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { buildBundle } from '#hosts/machine/bundle.ts';
import { BUNDLE_FILE, runtimeDirName, tsBuild } from './builds.ts';
import { runtimeOf } from './runtimes.ts';
import { PROBE_SCRIPT, checkRuntimeRuns, dialSSH, parseProbe, uploadScript, type SSHOptions } from './ssh.ts';

const supported = process.platform === 'linux' || process.platform === 'darwin';
const home = realpathSync(mkdtempSync('/tmp/hdp-'));
const instance = 'dev';
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
let launcherPath = '';

afterAll(() => {
  if (launcherPath) spawnSync(launcherPath, ['node', 'stop', '--instance', instance], { env: { ...process.env, HOME: home } });
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

test('the probe reports the C library, its C++ runtime and SSE4.2; a machine the runtime cannot run on is refused', () => {
  const alpine = '@gnulibc=\n@ldd=musl libc (x86_64)\n@muslloader=yes\n';
  const p = parseProbe(`motd\n@os=Linux\n@arch=x86_64\n@home=/home/u\n${alpine}@libs=no\n@sse42=yes\n`);
  expect(p).toEqual({ os: 'linux', arch: 'amd64', home: '/home/u', libc: 'musl', libs: false, sse42: true });
  expect(() => checkRuntimeRuns(p)).toThrow(/^libs_missing/);
  expect(() => checkRuntimeRuns({ ...p, libc: 'glibc', sse42: false })).toThrow(/^cpu_unsupported/);
  expect(() => checkRuntimeRuns({ ...p, arch: 'arm64', libc: 'glibc', sse42: false })).not.toThrow();
  expect(() => checkRuntimeRuns({ os: 'darwin', arch: 'amd64', home: '/Users/u' })).not.toThrow();
  expect(() => parseProbe('Linux\nx86_64\n/home/u\n')).toThrow(/unexpected probe output/);
  // Debian or Ubuntu with musl's package: musl's loader in /lib, glibc's
  // library.
  const debianWithMusl =
    '@os=Linux\n@arch=aarch64\n@home=/h\n@gnulibc=glibc 2.41\n@ldd=ldd (Debian GLIBC 2.41-12+deb13u4) 2.41\n@muslloader=yes\n@libs=yes\n@sse42=no\n';
  expect(parseProbe(debianWithMusl).libc).toBe('glibc');
  // Without getconf, ldd says it; with neither, the loader.
  expect(parseProbe('@os=Linux\n@arch=x86_64\n@home=/h\n@gnulibc=\n@ldd=ldd (GNU libc) 2.17\n@muslloader=yes\n').libc).toBe('glibc');
  expect(parseProbe('@os=Linux\n@arch=x86_64\n@home=/h\n@gnulibc=\n@ldd=\n@muslloader=yes\n').libc).toBe('musl');
  expect(parseProbe('@os=Linux\n@arch=x86_64\n@home=/h\n@gnulibc=\n@ldd=\n@muslloader=no\n').libc).toBe('glibc');
  // The probe itself, here.
  const here = parseProbe(spawnSync('/bin/sh', ['-c', PROBE_SCRIPT], { encoding: 'utf8' }).stdout);
  expect(here.os).toBe(process.platform);
  expect(here.home).toBe(process.env.HOME!);
});

test.skipIf(!supported)(
  'an ssh machine gets the runtime once and the build per version, both checked; its node of that build answers',
  async () => {
    // ssh that runs its remote command with this host's shell.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec /bin/sh -c "$*"\n');
    chmodSync(join(bin, 'ssh'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.HOME = home;
    const { js } = await buildBundle('test-deploy');
    const b = tsBuild(Buffer.from(js), runtimeOf(gzipSync(readFileSync(process.execPath), { level: 1 })));
    const logs: string[] = [];
    const o: SSHOptions = { target: 'box', controlDir: '', builds: async () => b, logger: (l) => logs.push(l), instance };

    // A runtime whose digest is not the one the machine computes is not put
    // in place.
    const bad = { ...b, runtime: { ...b.runtime, digest: 'f'.repeat(64) } };
    await expect(dialSSH({ ...o, builds: async () => bad })).rejects.toThrow(/upload the Bun runtime/);
    expect(existsSync(join(home, RUNTIME_DIR, runtimeDirName(bad.runtime.digest), 'bun'))).toBe(false);

    // Nor a bundle whose digest is not the one the machine computes.
    const badBundle = { ...b, bundleDigest: 'e'.repeat(64) };
    await expect(dialSSH({ ...o, builds: async () => badBundle })).rejects.toThrow(/upload the machine build/);
    expect(existsSync(join(home, AGENT_DIR, b.version, BUNDLE_FILE))).toBe(false);
    expect(existsSync(join(home, AGENT_DIR, b.version, CORE_BIN))).toBe(false);

    const { session, platform } = await dialSSH(o);
    expect(platform.home).toBe(home);
    const hello = await session.request({ op: Op.Hello });
    expect(hello.info?.home).toBe(home);
    expect(hello.info?.version).toBe('test-deploy');
    const rt = join(home, RUNTIME_DIR, runtimeDirName(b.runtime.digest), 'bun');
    const dir = join(home, AGENT_DIR, b.version);
    launcherPath = join(dir, CORE_BIN);
    expect(statSync(rt).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, BUNDLE_FILE), 'utf8')).toBe(js);
    expect(logs.filter((l) => l.includes('uploading'))).toHaveLength(4);
    session.close();

    // Again: nothing is uploaded, the same node serves.
    const again = await dialSSH(o);
    expect((await again.session.request({ op: Op.Hello })).ok).toBe(true);
    expect(logs.filter((l) => l.includes('uploading'))).toHaveLength(4);
    again.session.close();
  },
  120_000,
);

test.skipIf(!supported)('an upload that breaks off (the connection hung up) leaves no partial file', async () => {
  const dir = join(home, 'interrupted');
  const { spawn } = await import('node:child_process');
  const sh = spawn('/bin/sh', ['-c', uploadScript(dir, 'bun', 'f'.repeat(64))], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  // Part of a large compressed file, then the session's hangup.
  sh.stdin!.write(gzipSync(Buffer.alloc(8 << 20, 7)).subarray(0, 4096));
  await new Promise((r) => setTimeout(r, 300));
  const { readdirSync } = await import('node:fs');
  expect(readdirSync(dir).filter((n) => n.startsWith('.upload.'))).toHaveLength(1);
  const exited = new Promise((r) => sh.once('exit', r));
  process.kill(-sh.pid!, 'SIGHUP');
  await exited;
  expect(readdirSync(dir)).toEqual([]);
});

test.skipIf(!supported)(
  "the launcher keeps a working directory's .env and bunfig.toml and the environment's BUN_OPTIONS from node dial and the node it starts",
  async () => {
    const home2 = realpathSync(mkdtempSync('/tmp/hdq-'));
    const was = process.env.HOME;
    const wasOpts = process.env.BUN_OPTIONS;
    try {
      // What would run code in the runtime, or change its environment:
      // in the directory node dial runs in and the node starts in (home).
      const marker = join(home2, 'preloaded');
      writeFileSync(join(home2, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)} + '-' + process.pid, '')`);
      writeFileSync(join(home2, 'bunfig.toml'), 'preload = ["./evil.js"]\n');
      writeFileSync(join(home2, '.env'), 'EVIL_DOTENV=1\n');
      // Without the launcher's flags they do: the control.
      writeFileSync(join(home2, 'probe.js'), 'console.log(process.env.EVIL_DOTENV ?? "")');
      const control = spawnSync(process.execPath, ['probe.js'], { cwd: home2, env: { ...process.env, HOME: home2 }, encoding: 'utf8' });
      expect(control.stdout.trim()).toBe('1');
      const { readdirSync } = await import('node:fs');
      const preloads = () => readdirSync(home2).filter((n) => n.startsWith('preloaded-'));
      expect(preloads().length).toBeGreaterThan(0);
      for (const f of preloads()) rmSync(join(home2, f));

      const bin = join(home2, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\ncd "$HOME" && exec /bin/sh -c "$*"\n');
      chmodSync(join(bin, 'ssh'), 0o755);
      process.env.PATH = `${bin}:${saved.PATH}`;
      process.env.HOME = home2;
      process.env.BUN_OPTIONS = `--preload=${join(home2, 'evil.js')}`;
      const { js } = await buildBundle('test-launcher');
      const b = tsBuild(Buffer.from(js), runtimeOf(gzipSync(readFileSync(process.execPath), { level: 1 })));
      const { session } = await dialSSH({ target: 'box', controlDir: '', builds: async () => b, logger: () => {}, instance });
      const launcher2 = join(home2, AGENT_DIR, b.version, CORE_BIN);
      try {
        expect((await session.request({ op: Op.Hello })).ok).toBe(true);
        // The node's environment, as the programs it starts get it: a
        // terminal core that writes it down.
        const exe = Buffer.from('#!/bin/sh\nenv > "${0%/*}/env.txt"\n');
        const digest = createHash('sha256').update(exe).digest('hex');
        const { conn } = await session.open({ op: Op.HC, action: 'install', digest });
        const cw = new ChunkWriter(conn.stream);
        await cw.write(gzipSync(exe));
        await cw.finish();
        await readLine<Reply>(new Reader(conn.reader.release()));
        closeStream(conn.stream);
        await session.request({ op: Op.HC, action: 'start', digest }, { timeoutMs: 30_000 });
        const env = readFileSync(join(dirsFor(instance).host, 'hc', 'env.txt'), 'utf8');
        expect(env).not.toContain('EVIL_DOTENV');
        expect(env).not.toContain('BUN_OPTIONS');
        expect(env).toContain('BUN_RUNTIME_TRANSPILER_CACHE_PATH=0');
        expect(preloads()).toEqual([]);
      } finally {
        session.close();
        spawnSync(launcher2, ['node', 'stop', '--instance', instance], { env: { ...process.env, HOME: home2, BUN_OPTIONS: '' } });
      }
    } finally {
      process.env.HOME = was;
      if (wasOpts === undefined) delete process.env.BUN_OPTIONS;
      else process.env.BUN_OPTIONS = wasOpts;
      process.env.PATH = saved.PATH;
      rmSync(home2, { recursive: true, force: true });
    }
  },
  120_000,
);
