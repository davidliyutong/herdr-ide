// The pinned herdr-core release and the extraction of its archives: only
// the one regular file at the root of an archive of the pinned digest.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { extract, verify } from './fetch-hc.ts';
import { EXECUTABLE, LICENSE, MAX_EXECUTABLE, NOTICES, PLATFORMS, VERSION, forPlatform, urlOf, type Artifact } from './hcdist.ts';

interface Member {
  path: string;
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link';
  body?: string;
  linkpath?: string;
}

/** A tar.gz of members and an Artifact pinned to it. */
function archive(...members: Member[]): { gz: Buffer; a: Artifact } {
  const parts = members.map((m) => {
    const body = Buffer.from(m.body ?? '');
    const h = Buffer.alloc(512);
    new Header({
      path: m.path,
      type: m.type ?? 'File',
      mode: 0o755,
      size: body.length,
      ...(m.linkpath ? { linkpath: m.linkpath } : {}),
      mtime: new Date(1_000_000_000_000),
    }).encode(h, 0);
    return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  });
  const gz = gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
  return { gz, a: { name: 'a.tar.gz', sha256: createHash('sha256').update(gz).digest('hex') } };
}

test('platforms and their archives', () => {
  const names: Record<string, string> = {
    'linux/amd64': 'herdr-core-linux-x86_64.tar.gz',
    'linux/arm64': 'herdr-core-linux-aarch64.tar.gz',
    'darwin/amd64': 'herdr-core-macos-x86_64.tar.gz',
    'darwin/arm64': 'herdr-core-macos-aarch64.tar.gz',
  };
  expect(PLATFORMS.sort()).toEqual(Object.keys(names).sort());
  for (const [p, name] of Object.entries(names)) {
    const a = forPlatform(p);
    expect(a.name).toBe(name);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(urlOf(a)).toBe(`https://releases.herdr.dev/core/${VERSION}/${name}`);
  }
  expect(() => forPlatform('windows/amd64')).toThrow('unsupported');
});

test('an archive of another digest is refused', async () => {
  const { gz, a } = archive({ path: EXECUTABLE, body: 'bin' });
  expect(() => verify(a, gz)).not.toThrow();
  const tampered = Buffer.from('tampered');
  expect(() => verify(a, tampered)).toThrow('does not match');
  await expect(extract(a, tampered, EXECUTABLE, MAX_EXECUTABLE)).rejects.toThrow('does not match');
});

describe('extract', () => {
  test('the members at the root', async () => {
    // The layout of a macOS release: the application bundle has a second
    // executable of the same base name, which is not the member at the root.
    const { gz, a } = archive(
      { path: 'Herdr Core.app/', type: 'Directory' },
      { path: 'Herdr Core.app/Contents/MacOS/herdr-core', body: 'bundle' },
      { path: './herdr-core', body: 'executable' },
      { path: LICENSE, body: 'license' },
      { path: NOTICES, body: 'notices' },
    );
    for (const [name, want] of [
      [EXECUTABLE, 'executable'],
      [LICENSE, 'license'],
      [NOTICES, 'notices'],
    ] as const)
      expect((await extract(a, gz, name, 64)).toString()).toBe(want);
    await expect(extract(a, gz, EXECUTABLE, 9)).rejects.toThrow('larger');
  });

  const cases: Record<string, [Member[], string]> = {
    symlink: [[{ path: EXECUTABLE, type: 'SymbolicLink', linkpath: '/bin/sh' }], 'not a regular file'],
    hardlink: [
      [
        { path: LICENSE, body: 'x' },
        { path: EXECUTABLE, type: 'Link', linkpath: LICENSE },
      ],
      'not a regular file',
    ],
    directory: [[{ path: EXECUTABLE + '/', type: 'Directory' }], 'not a regular file'],
    twice: [
      [
        { path: EXECUTABLE, body: 'a' },
        { path: EXECUTABLE, body: 'b' },
      ],
      'more than one',
    ],
    'link then file': [
      [
        { path: EXECUTABLE, type: 'SymbolicLink', linkpath: 'x' },
        { path: EXECUTABLE, body: 'b' },
      ],
      'not a regular file',
    ],
    missing: [[{ path: 'bin/' + EXECUTABLE, body: 'a' }], 'no ' + EXECUTABLE],
    empty: [[{ path: EXECUTABLE }], 'empty'],
  };
  for (const [name, [members, want]] of Object.entries(cases))
    test(name, async () => {
      const { gz, a } = archive(...members);
      await expect(extract(a, gz, EXECUTABLE, MAX_EXECUTABLE)).rejects.toThrow(want);
    });

  test('a truncated archive', async () => {
    const { gz } = archive({ path: EXECUTABLE, body: 'bin' });
    const cut = gz.subarray(0, gz.length / 2);
    const a = { name: 'cut', sha256: createHash('sha256').update(cut).digest('hex') };
    await expect(extract(a, cut, EXECUTABLE, MAX_EXECUTABLE)).rejects.toThrow();
  });
});
