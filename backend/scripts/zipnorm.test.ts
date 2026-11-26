// The zip normalization of the VSIX the hub embeds: the same files give
// the same bytes, whatever their order and times, and keep their contents,
// modes and compression.
import { expect, test } from 'bun:test';
import yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { normalize } from './zipnorm.ts';

const files: Array<[string, string, number]> = [
  ['extension/package.json', '{"name":"x"}', 0o100644],
  ['[Content_Types].xml', '<Types/>', 0o100644],
  ['extension/dist/run.sh', '#!/bin/sh\n'.repeat(50), 0o100755],
  ['extension.vsixmanifest', '<PackageManifest/>', 0o100644],
];

function zip(order: number[], mtime: Date): Promise<Buffer> {
  const z = new ZipFile();
  for (const i of order) {
    const [name, body, mode] = files[i]!;
    z.addBuffer(Buffer.from(body), name, { mtime, mode, compress: i !== 1 });
  }
  z.end();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function entries(b: Buffer): Promise<Array<[string, string, number, number]>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(b, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err);
      const out: Array<[string, string, number, number]> = [];
      z.on('end', () => resolve(out));
      z.on('entry', (e: yauzl.Entry) =>
        z.openReadStream(e, (_, s) => {
          const chunks: Buffer[] = [];
          s!.on('data', (c: Buffer) => chunks.push(c));
          s!.on('end', () => {
            out.push([e.fileName, Buffer.concat(chunks).toString(), e.externalFileAttributes >>> 16, e.compressionMethod]);
            z.readEntry();
          });
        }),
      );
      z.readEntry();
    });
  });
}

test('the same files give the same bytes', async () => {
  const a = await normalize(await zip([0, 1, 2, 3], new Date(2024, 4, 1, 12, 30)));
  const b = await normalize(await zip([3, 2, 1, 0], new Date(2026, 10, 25, 8, 0)));
  expect(a.equals(b)).toBe(true);
  expect((await normalize(a)).equals(a)).toBe(true);
  const got = await entries(a);
  expect(got.map((e) => e[0])).toEqual([
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/dist/run.sh',
    'extension/package.json',
  ]);
  for (const [name, body, mode, method] of got) {
    const i = files.findIndex((f) => f[0] === name);
    expect([name, body, mode, method]).toEqual([name, files[i]![1], files[i]![2], i === 1 ? 0 : 8]);
  }
});

test('not a zip archive', async () => {
  await expect(normalize(Buffer.from('not a zip'))).rejects.toThrow();
});
