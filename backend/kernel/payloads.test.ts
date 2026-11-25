// What the core carries for others (payloads.ts): the video encoder's
// digest is the SHA-256 of the uncompressed executable, which the machine's
// install checks; the machine builds come from the release the build
// records.
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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

// The core is the machine build too: it
// records its version, platform and release, and the herdr-core digests of
// its release; a machine's build comes from the release (release.ts), the
// desktop app's own platform's from its resources.
test('the machine side: the release recorded, the own executable carried, every platform from the release', async () => {
  const own = Buffer.from('#!/bin/sh\necho own\n');
  const files = mapFiles(
    new Map([
      [
        'machine/release.json',
        Buffer.from(JSON.stringify({ version: 'v1.2.3', key: 'linux-amd64', release: 'https://releases.example/download/v1.2.3' })),
      ],
      ['machine/hc.json', Buffer.from(JSON.stringify({ 'linux-amd64': 'c'.repeat(64) }))],
      [`machine/${CORE_BIN}-linux-amd64.gz`, gzipSync(own)],
    ]),
  );
  const p = payloads({ files, machineCache: temp() });
  expect(await p.embeddedHC('linux', 'amd64')).toBe('c'.repeat(64));
  expect(await p.embeddedHC('linux', 'arm64')).toBeNull();
  const b = await p.machine({ os: 'linux', arch: 'amd64', libc: 'glibc' });
  if (b.kind !== 'ts') throw new Error('not the TypeScript build');
  expect(b.url).toBe(`https://releases.example/download/v1.2.3/${CORE_BIN}-linux-amd64.tar.gz`);
  const m = await p.machine({ os: 'linux', arch: 'amd64', libc: 'musl' });
  expect(m.kind === 'ts' && m.url).toBe(`https://releases.example/download/v1.2.3/${CORE_BIN}-linux-amd64-musl.tar.gz`);
  await expect(p.machine({ os: 'linux', arch: 'riscv64' })).rejects.toThrow(/^platform_unsupported/);
  // A build that records no release has no machine build to give.
  await expect(payloads({ files: mapFiles(new Map()) }).machine({ os: 'linux', arch: 'amd64' })).rejects.toThrow(/^build_unavailable/);
});
