// Resolving code-server releases and extensions on the hub's host: seeds
// verified by their sidecars, offline, pinned digests, downloads recorded
// on first use, fetch-assets.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discard } from '#shared/lib/log.ts';
import {
  Artifacts,
  DEFAULT_VERSION,
  MissingArtifact,
  NotRegular,
  PINNED,
  readRegular,
  sha256File,
  tarballFile,
  type ArtifactsOptions,
} from './artifacts.ts';
import { fetchAssets } from './fetchassets.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vsc-art-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sum = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** Artifacts of a version that is not pinned, without extensions, in a
 * cache of the test's own. */
const artifacts = (o: Partial<ArtifactsOptions> = {}) =>
  new Artifacts({ logger: discard, cacheDir: join(dir, 'cache'), version: '9.9.9', extensions: [], ...o });

/** A download server that answers "content of <path>" and records the
 * paths asked for. */
function mirror(body?: string) {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const p = new URL(req.url).pathname;
      paths.push(p);
      return new Response(body ?? `content of ${p}`);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, paths, stop: () => void server.stop(true) };
}

test('a seed is verified by its sidecar', async () => {
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  const file = tarballFile('9.9.9', 'linux-amd64');
  writeFileSync(join(seed, file), 'tarball');
  writeFileSync(join(seed, `${file}.sha256`), `${sum('tarball')}  ${file}\n`);
  const a = artifacts({ seedDirs: [seed], offline: true });
  expect(await a.tarball('linux-amd64')).toBe(join(seed, file));
  // A tampered seed is refused, never silently replaced.
  writeFileSync(join(seed, file), 'evil');
  await expect(a.tarball('linux-amd64')).rejects.toThrow('does not match');
  expect(readFileSync(join(seed, file), 'utf8')).toBe('evil');
});

// A FIFO under a seed's or a sidecar's name would block whatever opened
// it until something wrote to it (and with it a thread of the hub's file
// I/O): it is passed over as a file that is not there.
test.skipIf(process.platform === 'win32')('FIFOs in a seed are passed over, never waited on', async () => {
  const seed = join(dir, 'seed');
  const cache = join(dir, 'cache');
  mkdirSync(seed);
  mkdirSync(cache);
  const file = tarballFile('9.9.9', 'linux-amd64');
  try {
    execFileSync('mkfifo', ['-m', '600', join(seed, file), join(cache, `${file}.sha256`)]);
  } catch {
    return; // no mkfifo: nothing to check
  }
  writeFileSync(join(cache, file), 'tarball');
  const a = artifacts({ seedDirs: [seed], offline: true });
  // The cache's copy, unverified: its sidecar is a FIFO too.
  expect(await a.tarball('linux-amd64')).toBe(join(cache, file));
  expect(await a.knownDigest(file)).toBe('');
  await expect(sha256File(join(seed, file))).rejects.toBeInstanceOf(NotRegular);
  await expect(readRegular(join(seed, file))).rejects.toBeInstanceOf(NotRegular);
  expect(await sha256File(join(cache, file))).toBe(sum('tarball'));
});

test('offline, a missing file is named with where to put it', async () => {
  const err = await artifacts({ offline: true })
    .tarball('linux-arm64')
    .catch((e: Error) => e);
  expect(err).toBeInstanceOf(MissingArtifact);
  expect((err as Error).message).toContain('code-server-9.9.9-linux-arm64.tar.gz');
  expect((err as Error).message).toContain(join(dir, 'cache'));
});

test('a pinned digest refuses what a mirror sends', async () => {
  const m = mirror('not the real tarball');
  try {
    const a = artifacts({ version: DEFAULT_VERSION, tarballURL: `${m.url}/{file}` });
    await expect(a.tarball('linux-amd64')).rejects.toThrow('does not match');
    await a.tarball('linux-amd64').catch(() => {});
    expect(existsSync(join(dir, 'cache', tarballFile(DEFAULT_VERSION, 'linux-amd64')))).toBe(false);
    expect(PINNED[tarballFile(DEFAULT_VERSION, 'linux-amd64')]).toHaveLength(64);
  } finally {
    m.stop();
  }
});

test('a corrupt cached file is downloaded again', async () => {
  const m = mirror();
  try {
    const a = artifacts({ tarballURL: `${m.url}/{file}` });
    const path = await a.tarball('linux-amd64');
    writeFileSync(path, 'rotten');
    expect(await a.tarball('linux-amd64')).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(`content of /${tarballFile('9.9.9', 'linux-amd64')}`);
    expect(m.paths.length).toBe(2);
  } finally {
    m.stop();
  }
});

test('downloads record their digest, fetch-assets copies with sidecars', async () => {
  const m = mirror();
  try {
    const a = artifacts({
      tarballURL: `${m.url}/cs/v{version}/{file}`,
      extensionURL: `${m.url}/ext/{publisher}/{name}/{version}/{file}`,
      extensions: [{ id: 'pub.thing', version: '1.0.0' }],
    });
    const out = join(dir, 'out');
    const { files, error } = await a.fetchAssets(out, ['linux-amd64']);
    expect(error).toBeUndefined();
    expect(files).toEqual(['code-server-9.9.9-linux-amd64.tar.gz', 'pub.thing-1.0.0.vsix']);
    expect(m.paths).toEqual(['/cs/v9.9.9/code-server-9.9.9-linux-amd64.tar.gz', '/ext/pub/thing/1.0.0/pub.thing-1.0.0.vsix']);
    for (const f of files) expect(readFileSync(join(out, `${f}.sha256`), 'utf8')).toBe(`${sum(readFileSync(join(out, f)))}  ${f}\n`);
    // Recorded in the cache on first use: the next resolution uses it.
    expect(await a.knownDigest(files[0])).toBe(sum(readFileSync(join(out, files[0]))));
    await a.tarball('linux-amd64');
    expect(m.paths.length).toBe(2);
  } finally {
    m.stop();
  }
});

// A digest learnt from a machine's download is used to verify later.
test('recorded digests', async () => {
  const a = artifacts({ cacheDir: join(dir, 'new', 'cache') });
  const file = tarballFile('9.9.9', 'linux-amd64');
  expect(await a.knownDigest(file)).toBe('');
  await a.recordDigest(file, 'abc123');
  expect(await a.knownDigest(file)).toBe('abc123');
  const pinned = tarballFile(DEFAULT_VERSION, 'linux-amd64');
  expect(await a.knownDigest(pinned)).toBe(PINNED[pinned]);
});

test('the fetch-assets command', async () => {
  const m = mirror();
  const lines: string[] = [];
  const logged: string[] = [];
  try {
    const out = join(dir, 'bundle');
    const code = await fetchAssets(
      [
        '--platforms',
        'linux-amd64,macos-arm64',
        '--code-server-version',
        '9.9.9',
        '--code-server-url',
        `${m.url}/{file}`,
        '--extension-url',
        `${m.url}/{file}`,
        out,
      ],
      { logger: (l) => void logged.push(l), out: (l) => void lines.push(l), cacheDir: join(dir, 'cache') },
    );
    // The tarballs are new to the hub; Git Graph's pinned digest refuses
    // the mirror's file.
    expect(code).toBe(1);
    expect(lines).toEqual([join(out, 'code-server-9.9.9-linux-amd64.tar.gz'), join(out, 'code-server-9.9.9-macos-arm64.tar.gz')]);
    expect(logged.at(-1)).toContain('mhutchie.git-graph-1.30.0.vsix: downloaded sha256');
  } finally {
    m.stop();
  }
  // Offline without seeds: fails, naming the file.
  const code = await fetchAssets(['--offline', '--code-server-version', '9.9.9', join(dir, 'b2')], {
    logger: (l) => void logged.push(l),
    out: (l) => void lines.push(l),
    cacheDir: join(dir, 'empty'),
  });
  expect(code).toBe(1);
  expect(logged.at(-1)).toContain('code-server-9.9.9-linux-amd64.tar.gz');
  expect(await fetchAssets([], { logger: discard, err: () => {} })).toBe(2);
});
