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
import { Op } from '#shared/proto/agentproto/index.ts';
import { buildBundle } from '#hosts/machine/bundle.ts';
import { BUNDLE_FILE, runtimeDirName, tsBuild } from './builds.ts';
import { runtimeOf } from './runtimes.ts';
import { PROBE_SCRIPT, checkRuntimeRuns, dialSSH, parseProbe, type SSHOptions } from './ssh.ts';

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
    expect(logs.filter((l) => l.includes('uploading'))).toHaveLength(3);
    session.close();

    // Again: nothing is uploaded, the same node serves.
    const again = await dialSSH(o);
    expect((await again.session.request({ op: Op.Hello })).ok).toBe(true);
    expect(logs.filter((l) => l.includes('uploading'))).toHaveLength(3);
    again.session.close();
  },
  120_000,
);
