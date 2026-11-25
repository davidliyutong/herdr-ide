// What the core carries for others (payloads.ts): herdr-core's and the
// video encoder's digest is the SHA-256 of the uncompressed executable,
// which the agent's install checks; a machine build's version is derived
// from its content, so a rebuilt one is uploaded again.
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BRIDGE_EXT, CORE_BIN } from '#shared/lib/brand.ts';
import { dirFiles, layered, payloads, type Files } from './payloads.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'payloads-'));
  dirs.push(d);
  return d;
};

/** Files of a map, which a test changes. */
const mapFiles = (m: Map<string, Uint8Array>): Files => ({ get: async (p) => m.get(p) ?? null });
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

for (const [what, dir, get] of [
  ['herdr-core', 'hc/hc', (p: ReturnType<typeof payloads>, os: string, arch: string) => p.hc(os, arch)],
  ['the video encoder', 'encoder/encoder', (p: ReturnType<typeof payloads>, os: string, arch: string) => p.encoder(os, arch)],
] as const) {
  // The executable comes as the build stored it (gzip), with the digest of
  // what it holds, computed once per platform; a file that is not gzip, a
  // stream cut off before its checksum or a platform without one gets no
  // digest, and a failure is not kept.
  test(`${what}: its digest is of the uncompressed executable; a damaged or missing one has none`, async () => {
    const bin = Buffer.from('#!/bin/sh\nexit 0\n');
    const gz = gzipSync(bin);
    const files = new Map<string, Uint8Array>([
      [`${dir}-linux-amd64.gz`, gz],
      [`${dir}-linux-arm64.gz`, Buffer.from('not gzip')],
      [`${dir}-darwin-arm64.gz`, gz.subarray(0, gz.length - 6)],
    ]);
    const p = payloads({ files: mapFiles(files) });
    const got = await get(p, 'linux', 'amd64');
    expect(got.digest).toBe(sha256(bin));
    expect(got.digest).not.toBe(sha256(gz));
    expect(got.gz.equals(gz)).toBe(true);
    files.delete(`${dir}-linux-amd64.gz`);
    expect((await get(p, 'linux', 'amd64')).digest).toBe(sha256(bin));
    for (const [os, arch] of [
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
      ['linux', 'riscv64'],
    ])
      await expect(get(p, os, arch)).rejects.toThrow();
    files.set(`${dir}-linux-riscv64.gz`, gz);
    expect((await get(p, 'linux', 'riscv64')).digest).toBe(sha256(bin));
  });
}

// The version is the start of the content's SHA-256: the same build has the
// same version however it was compressed, a rebuilt one another, so the
// core uploads it again; --agent-dir's uncompressed builds come first.
test("a machine build's version is derived from its content, so a rebuilt one is uploaded again", async () => {
  const name = `${CORE_BIN}-linux-amd64`;
  const one = Buffer.from('machine build one');
  const two = Buffer.from('machine build two');
  const of = (gz: Uint8Array, agentDir?: string) => payloads({ files: mapFiles(new Map([[`agents/${name}.gz`, gz]])), agentDir });
  const a = await of(gzipSync(one)).machine({ os: 'linux', arch: 'amd64' });
  expect(a).toEqual({ kind: 'go', bin: one, version: sha256(one).slice(0, 16) });
  expect((await of(gzipSync(one, { level: 1 })).machine({ os: 'linux', arch: 'amd64' })).version).toBe(a.version);
  expect((await of(gzipSync(two)).machine({ os: 'linux', arch: 'amd64' })).version).not.toBe(a.version);
  const dev = temp();
  writeFileSync(join(dev, name), two);
  expect(await of(gzipSync(one), dev).machine({ os: 'linux', arch: 'amd64' })).toEqual({
    kind: 'go',
    bin: two,
    version: sha256(two).slice(0, 16),
  });
  await expect(of(gzipSync(one)).machine({ os: 'darwin', arch: 'arm64' })).rejects.toThrow('not bundled');
});

test('the bridge extension, when the build has it', async () => {
  const vsix = Buffer.from('PK vsix');
  expect(await payloads({ files: mapFiles(new Map([[`ext/${BRIDGE_EXT}.vsix`, vsix]])) }).bridgeVSIX()).toEqual(vsix);
  expect(await payloads({ files: mapFiles(new Map()) }).bridgeVSIX()).toBeNull();
});

// Files below a directory never leave it; the first source that has a
// file gives it.
test('files of a directory, and layered sources', async () => {
  const d = temp();
  writeFileSync(join(d, 'a'), 'A');
  const files = dirFiles(d);
  expect(Buffer.from((await files.get('a'))!).toString()).toBe('A');
  for (const p of ['../a', 'x/../a', '', 'x//a', 'missing']) expect([p, await files.get(p)]).toEqual([p, null]);
  const first = mapFiles(new Map([['a', Buffer.from('first')]]));
  const l = layered(null, first, files, undefined);
  expect(Buffer.from((await l.get('a'))!).toString()).toBe('first');
  expect(await l.get('b')).toBeNull();
});

// A core that embeds the TypeScript machine side deploys its bundle with
// the Bun runtime of the machine's platform: embedded for glibc and macOS,
// fetched (here: cached) for musl; the build's version names both.
test('the TypeScript machine side: the bundle with the runtime of the platform and C library', async () => {
  const js = Buffer.from('console.log("machine")');
  const bun = Buffer.from('a runtime');
  const files = mapFiles(
    new Map([
      ['machine/machine.js', js],
      ['runtime/bun-linux-amd64.gz', gzipSync(bun)],
      // A Go build beside it is not the one used.
      [`agents/${CORE_BIN}-linux-amd64.gz`, gzipSync(Buffer.from('go'))],
    ]),
  );
  const cache = temp();
  const musl = Buffer.from('musl runtime');
  let downloads = 0;
  const pins = { 'linux/amd64': sha256(bun), 'linux-musl/amd64': sha256(musl) };
  const p = payloads({ files, runtimeCache: cache, runtimePins: pins, downloadRuntime: async () => (downloads++, musl) });
  const b = await p.machine({ os: 'linux', arch: 'amd64', libc: 'glibc' });
  if (b.kind !== 'ts') throw new Error('not the TypeScript build');
  expect(b.bundle).toEqual(js);
  expect(b.bundleDigest).toBe(sha256(js));
  expect(b.runtime.digest).toBe(sha256(bun));
  expect(b.version).toBe(sha256(Buffer.from(`${sha256(js)}\0${sha256(bun)}`)).slice(0, 16));
  await expect(p.machine({ os: 'darwin', arch: 'arm64' })).rejects.toThrow('no Bun runtime for darwin/arm64');
  // musl's comes from the cache when it is the pinned one; a tampered one
  // is refused and fetched again.
  const cached = join(cache, 'bun-linux-x64-musl-baseline-1.4.5.gz');
  writeFileSync(cached, gzipSync(Buffer.from('tampered')));
  const m = await p.machine({ os: 'linux', arch: 'amd64', libc: 'musl' });
  expect(m.kind === 'ts' && m.runtime.digest).toBe(sha256(musl));
  expect(m.version).not.toBe(b.version);
  expect(downloads).toBe(1);
  expect(gunzipSync(readFileSync(cached))).toEqual(musl);
  // Cached now: not fetched again.
  const again = payloads({ files, runtimeCache: cache, runtimePins: pins, downloadRuntime: async () => (downloads++, musl) });
  await again.machine({ os: 'linux', arch: 'amd64', libc: 'musl' });
  expect(downloads).toBe(1);
  // A build's runtime that is not the pinned one is refused.
  const other = payloads({ files, runtimeCache: cache, runtimePins: { ...pins, 'linux/amd64': 'f'.repeat(64) } });
  await expect(other.machine({ os: 'linux', arch: 'amd64', libc: 'glibc' })).rejects.toThrow(/not the pinned/);
});

test('the pinned runtimes: every embedded platform and musl, archive and executable', async () => {
  const { RUNTIMES, keyOfFile, runtimeFile } = await import('./machines/transport/runtimes.ts');
  for (const [key, a] of Object.entries(RUNTIMES)) {
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bun).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOfFile(runtimeFile(key).slice('runtime/'.length))).toBe(key);
  }
  expect(keyOfFile('bun-linux-amd64.gz.tmp')).toBeNull();
});
