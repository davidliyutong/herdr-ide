// A core's release (release.ts): the manifest from the operator's
// directory, the cache, the core's own download (through the
// environment's proxy) or the machine's, refused when it is another
// build's; what the core uploads from the directory, the cache, its own
// executable or a download, each checked against the manifest. The
// executables are fakes; nothing leaves this host (the "release" is a
// server on loopback, reached through a proxy on loopback).
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { archiveMember, archiveName, bareName } from './builds.ts';
import { deployCode } from './errors.ts';
import { CACHE_RETENTION_MS, ownGz, parseSums, Release, SUMS, type OwnExecutable } from './release.ts';

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  servers.forEach((s) => s.close());
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'rel-'));
  dirs.push(d);
  return d;
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const KEY = 'linux-amd64';
const OTHER = 'linux-arm64';
const EXE = Buffer.from('#!/bin/sh\necho a machine build\n');
/** The release's archive of KEY: <bin>-<key>/<bin> in a .tar.gz. */
function archiveOf(key: string, exe: Buffer): Buffer {
  const d = temp();
  mkdirSync(join(d, bareName(key)));
  writeFileSync(join(d, archiveMember(key)), exe, { mode: 0o755 });
  const r = spawnSync('tar', ['-czf', '-', '-C', d, bareName(key)], { maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  return r.stdout;
}
const ARCHIVE = archiveOf(KEY, EXE);
const sums = (o: { exe?: string; archive?: string; ownExe?: string } = {}) =>
  [
    `${o.archive ?? sha256(ARCHIVE)}  ${archiveName(KEY)}`,
    `${o.exe ?? sha256(EXE)}  ${archiveMember(KEY)}`,
    ...(o.ownExe ? [`${o.ownExe}  ${archiveMember(OTHER)}`] : []),
    `${'0'.repeat(64)}  ${'veldr'}-1.2.3-mac-arm64.dmg`,
  ].join('\n') + '\n';

/** A release on loopback: GET /v1/<name> answers files[name] (404
 * without), counting requests. */
async function release(files: Record<string, Buffer | string>) {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(req.url ?? '');
    const name = (req.url ?? '').replace(/^\/v1\//, '');
    const body = files[name];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, hits };
}

/** The own executable of OTHER (another platform than KEY's), named in
 * the manifest by ownExe. */
const OWN_EXE = Buffer.from('#!/bin/sh\necho the core\n');
const ownOther = (): OwnExecutable => ownGz(OTHER, async () => gzipSync(OWN_EXE))!;

test('parseSums reads sha256sum lines, text and binary mode', () => {
  const m = parseSums(`${'A'.repeat(64)}  a.tar.gz\n${'b'.repeat(64)} *dir/b\nnot a line\n\n`);
  expect([...m]).toEqual([
    ['a.tar.gz', 'a'.repeat(64)],
    ['dir/b', 'b'.repeat(64)],
  ]);
});

describe('the manifest', () => {
  test("is the release's, fetched by the core and cached per version; the next core reads the cache", async () => {
    const r = await release({ [SUMS]: sums() });
    const cacheDir = temp();
    const rel = new Release({ version: 'v1', url: r.url, cacheDir });
    expect(await rel.digests(KEY)).toEqual({
      exe: sha256(EXE),
      archive: sha256(ARCHIVE),
      integrityOnly: false,
      source: `${r.url}/${SUMS}`,
    });
    expect(r.hits).toEqual([`/v1/${SUMS}`]);
    // Kept: not fetched again, by this core nor by the next.
    await rel.digests(KEY);
    const next = new Release({ version: 'v1', url: r.url, cacheDir });
    expect((await next.digests(KEY)).source).toContain('SHA256SUMS-v1');
    expect(r.hits).toHaveLength(1);
  });

  test("the operator's directory's comes first", async () => {
    const dir = temp();
    writeFileSync(join(dir, SUMS), sums());
    const rel = new Release({ version: 'v1', url: 'http://127.0.0.1:9/v1', dir, cacheDir: temp() });
    expect((await rel.digests(KEY)).source).toBe(join(dir, SUMS));
  });

  test("one of another build is refused: it must name this core's own executable by its digest", async () => {
    const dir = temp();
    writeFileSync(join(dir, SUMS), sums({ ownExe: 'e'.repeat(64) }));
    const logged: string[] = [];
    const rel = new Release({ version: 'v1', dir, cacheDir: temp(), own: ownOther(), logger: (l) => logged.push(l) });
    const e = await rel.digests(KEY).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain('of another build');
    expect((e as Error).message).not.toContain(dir);
    expect(logged.join('\n')).toContain(join(dir, SUMS));
    // Its own: accepted.
    const ok = temp();
    writeFileSync(join(ok, SUMS), sums({ ownExe: sha256(OWN_EXE) }));
    expect((await new Release({ version: 'v1', dir: ok, cacheDir: temp(), own: ownOther() }).digests(KEY)).exe).toBe(sha256(EXE));
  });

  test("when only the machine reaches the release, the machine's download: integrity only, and not cached", async () => {
    const cacheDir = temp();
    const rel = new Release({ version: 'v1', url: 'http://127.0.0.1:9/v1', cacheDir });
    const asked: string[] = [];
    const d = await rel.digests(KEY, { viaHost: async (url) => (asked.push(url), sums()) });
    expect(asked).toEqual([`http://127.0.0.1:9/v1/${SUMS}`]);
    expect(d.integrityOnly).toBe(true);
    expect(existsSync(join(cacheDir, `${SUMS}-v1`))).toBe(false);
  });

  test('the core does not try again for 10 minutes after its download failed; nothing anywhere: build_unavailable, saying what was tried', async () => {
    let now = 0;
    const rel = new Release({ version: 'v1', url: 'http://127.0.0.1:9/v1', cacheDir: temp(), now: () => now });
    const e = await rel.digests(KEY).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain('the core could not download');
    expect((e as Error).message).toContain('--agent-dir');
    now += 60_000;
    expect(((await rel.digests(KEY).catch((x) => x)) as Error).message).toContain('lately');
    const none = await new Release({ version: 'v1', cacheDir: temp() }).digests(KEY).catch((x) => x as Error);
    expect((none as Error).message).toContain('no release');
  });

  test("without a manifest, the core's own executable gives its platform's digest", async () => {
    const rel = new Release({ version: 'v1', cacheDir: temp(), own: ownOther() });
    expect(await rel.digests(OTHER)).toEqual({ exe: sha256(OWN_EXE), source: "this core's own executable" });
  });
});

describe('what the core uploads', () => {
  const d = { exe: sha256(EXE), archive: sha256(ARCHIVE), source: 'test' };

  test("the operator's directory: the archive, or the executable; each checked, a tampered one refused naming no path", async () => {
    const dir = temp();
    writeFileSync(join(dir, archiveName(KEY)), ARCHIVE);
    expect(await new Release({ version: 'v1', dir, cacheDir: temp() }).load(KEY, d)).toEqual({ kind: 'archive', bytes: ARCHIVE });
    const bare = temp();
    writeFileSync(join(bare, bareName(KEY)), EXE);
    const p = await new Release({ version: 'v1', dir: bare, cacheDir: temp() }).load(KEY, d);
    expect(p.kind).toBe('gz');
    expect(gunzipSync(p.bytes)).toEqual(EXE);
    const bad = temp();
    writeFileSync(join(bad, archiveName(KEY)), archiveOf(KEY, Buffer.from('tampered')));
    writeFileSync(join(bad, bareName(KEY)), Buffer.from('tampered too'));
    const logged: string[] = [];
    const e = await new Release({ version: 'v1', dir: bad, cacheDir: temp(), logger: (l) => logged.push(l) })
      .load(KEY, d)
      .catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain(`--agent-dir's ${archiveName(KEY)}: sha256`);
    expect((e as Error).message).toContain(`--agent-dir's ${bareName(KEY)}: sha256`);
    expect((e as Error).message).not.toContain(bad);
    expect(logged.join('\n')).toContain(join(bad, archiveName(KEY)));
  });

  test("a download through the environment's proxy, checked, cached and not asked again; a tampered cache removed", async () => {
    let hits = 0;
    const proxy = createServer((req, res) => {
      hits++;
      if (req.url !== `http://releases.test/v1/${archiveName(KEY)}`) return void res.writeHead(502).end();
      res.writeHead(200, { 'content-length': ARCHIVE.length }).end(ARCHIVE);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const keys = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HTTP_PROXY = process.env.http_proxy = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      const cacheDir = temp();
      expect(await new Release({ version: 'v1', url: 'http://releases.test/v1', cacheDir }).load(KEY, d)).toEqual({
        kind: 'archive',
        bytes: ARCHIVE,
      });
      expect(hits).toBe(1);
      const file = join(cacheDir, `${bareName(KEY)}-${d.exe.slice(0, 16)}.tar.gz`);
      expect(readFileSync(file).equals(ARCHIVE)).toBe(true);
      expect((await new Release({ version: 'v1', url: 'http://releases.test/v1', cacheDir }).load(KEY, d)).bytes).toEqual(ARCHIVE);
      expect(hits).toBe(1);
      writeFileSync(file, archiveOf(KEY, Buffer.from('tampered')));
      const e = await new Release({ version: 'v1', cacheDir }).load(KEY, d).catch((x) => x as Error);
      expect((e as Error).message).toContain("the cache's");
      expect((e as Error).message).not.toContain(cacheDir);
      expect(existsSync(file)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  test("an archive that is not the release's is refused before anything is cached; the cache keeps 14 days", async () => {
    const r = await release({ [archiveName(KEY)]: archiveOf(KEY, Buffer.from('another build')) });
    const cacheDir = temp();
    const old = join(cacheDir, `${bareName(OTHER)}-0000000000000000.tar.gz`);
    writeFileSync(old, ARCHIVE);
    const past = new Date(Date.now() - CACHE_RETENTION_MS - 60_000);
    utimesSync(old, past, past);
    const e = await new Release({ version: 'v1', url: r.url, cacheDir }).load(KEY, d).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain('is not the release');
    expect(existsSync(join(cacheDir, `${bareName(KEY)}-${d.exe.slice(0, 16)}.tar.gz`))).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  test("the core's own executable for a machine of its platform, when it is the build; one load for machines deployed at once", async () => {
    let reads = 0;
    const own = ownGz(OTHER, async () => (reads++, gzipSync(OWN_EXE)))!;
    const rel = new Release({ version: 'v1', cacheDir: temp(), own });
    const od = { exe: sha256(OWN_EXE), source: 'test' };
    const loads = await Promise.all([rel.load(OTHER, od), rel.load(OTHER, od), rel.load(OTHER, od)]);
    for (const l of loads) expect(gunzipSync(l.bytes)).toEqual(OWN_EXE);
    // One read for the digest, one for the upload.
    expect(reads).toBe(2);
    const e = await rel.load(OTHER, { exe: 'f'.repeat(64), source: 'test' }).catch((x) => x as Error);
    expect((e as Error).message).toContain("the core's own executable: sha256");
  });
});
