// What the core carries for others (payloads.ts): herdr-core's and the
// video encoder's digest is the SHA-256 of the uncompressed executable,
// which the agent's install checks; a machine build's version is derived
// from its content, so a rebuilt one is uploaded again.
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

// A core that deploys the TypeScript machine side carries the digests of
// every platform's executable and its own platform's executable: a
// machine's build names the release's asset, and is loaded (the core's own
// copy here) only for a machine that cannot get it itself.
test('the TypeScript machine side: every platform by its digests, the own executable carried', async () => {
  const own = Buffer.from('#!/bin/sh\necho own\n');
  const ownGz = gzipSync(own);
  const manifest = {
    version: 'v1.2.3',
    release: 'https://releases.example/download/v1.2.3',
    machines: {
      'linux-amd64': { sha256: sha256(own), gz: sha256(ownGz), size: ownGz.length },
      'linux-amd64-musl': { sha256: 'a'.repeat(64), gz: 'b'.repeat(64), size: 1 },
    },
  };
  const files = mapFiles(
    new Map([
      ['machine/manifest.json', Buffer.from(JSON.stringify(manifest))],
      [`machine/${CORE_BIN}-machine-linux-amd64.gz`, ownGz],
      // A Go build beside it is not the one used.
      [`agents/${CORE_BIN}-linux-amd64.gz`, gzipSync(Buffer.from('go'))],
    ]),
  );
  // How often the core's own copy is read.
  let reads = 0;
  const counting = { get: (path: string) => (path.endsWith('-machine-linux-amd64.gz') && reads++, files.get(path)) };
  const p = payloads({ files: counting, machineCache: temp() });
  const b = await p.machine({ os: 'linux', arch: 'amd64', libc: 'glibc' });
  if (b.kind !== 'ts') throw new Error('not the TypeScript build');
  expect(b.digest).toBe(sha256(own));
  expect(b.version).toBe(sha256(own).slice(0, 16));
  expect(b.url).toBe(`https://releases.example/download/v1.2.3/${CORE_BIN}-machine-linux-amd64.gz`);
  // Machines of one platform deployed at once: one load, shared, and
  // kept for the next.
  const again = await p.machine({ os: 'linux', arch: 'amd64', libc: 'glibc' });
  const loads = await Promise.all([b.load(), b.load(), again.kind === 'ts' ? again.load() : null]);
  for (const l of loads) expect(l).toEqual(ownGz);
  expect(await b.load()).toEqual(ownGz);
  expect(reads).toBe(1);
  const m = await p.machine({ os: 'linux', arch: 'amd64', libc: 'musl' });
  expect(m.kind === 'ts' && m.key).toBe('linux-amd64-musl');
  await expect(p.machine({ os: 'linux', arch: 'riscv64' })).rejects.toThrow(/^platform_unsupported/);
});
