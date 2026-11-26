import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { ChunkReader, Op } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { archiveNames } from './fsops.ts';
import { rig, type Rig } from './testing.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

/** The entries of a zip: files and links by content ("-> target"),
 * directories as "/", and their modes. */
async function readZip(b: Buffer): Promise<{ files: Record<string, string>; modes: Record<string, number> }> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.fromBuffer(b, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  await new Promise<void>((resolve, reject) => {
    zip.on('end', resolve).on('error', reject);
    zip.on('entry', (e: yauzl.Entry) => {
      const mode = (e.externalFileAttributes >>> 16) & 0xffff;
      modes[e.fileName] = mode;
      if (e.fileName.endsWith('/')) {
        files[e.fileName] = '/';
        return zip.readEntry();
      }
      zip.openReadStream(e, (err, s) => {
        if (err) return reject(err);
        const parts: Buffer[] = [];
        s!
          .on('data', (d: Buffer) => parts.push(d))
          .on('end', () => {
            const c = Buffer.concat(parts).toString();
            files[e.fileName] = (mode & 0o170000) === 0o120000 ? `-> ${c}` : c;
            zip.readEntry();
          });
      });
    });
    zip.readEntry();
  });
  return { files, modes };
}

async function archive(paths: string[], chunked = false): Promise<Buffer> {
  const { conn } = await r!.session.open({ op: Op.FsArchive, paths, ...(chunked ? { chunked } : {}) });
  const parts: Buffer[] = [];
  if (chunked) for await (const b of new ChunkReader(conn.reader)) parts.push(b);
  else for (let b = await conn.reader.chunk(); b; b = await conn.reader.chunk()) parts.push(b);
  closeStream(conn.stream);
  return Buffer.concat(parts);
}

test('an archive: each path at its root by name, links below stored as links, irregular files left out', async () => {
  r = await rig();
  const { home } = r;
  const proj = join(home, 'proj');
  mkdirSync(join(proj, 'src', 'deep'), { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'alpha');
  writeFileSync(join(proj, 'src', 'run.sh'), '#!/bin/sh', { mode: 0o755 });
  writeFileSync(join(proj, 'src', 'deep', 'b.txt'), 'beta');
  symlinkSync('/etc', join(proj, 'src', 'etc'));
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(join(proj, 'src', 's.sock'), res));
  mkdirSync(join(home, 'other'));
  writeFileSync(join(home, 'other', 'a.txt'), 'second');
  symlinkSync(join(proj, 'src'), join(home, 'linked'));
  try {
    const { files, modes } = await readZip(await archive([join(proj, 'src'), join(proj, 'a.txt'), '~/other/a.txt', join(home, 'linked')]));
    expect(files).toEqual({
      'src/': '/',
      'src/deep/': '/',
      'src/deep/b.txt': 'beta',
      'src/etc': '-> /etc',
      'src/run.sh': '#!/bin/sh',
      'a.txt': 'alpha',
      'a-1.txt': 'second',
      'linked/': '/',
      'linked/deep/': '/',
      'linked/deep/b.txt': 'beta',
      'linked/etc': '-> /etc',
      'linked/run.sh': '#!/bin/sh',
    });
    expect(modes['src/run.sh'] & 0o777).toBe(0o755);
  } finally {
    srv.close();
  }
  await expect(r.session.request({ op: Op.FsArchive, paths: [join(home, 'missing')] })).rejects.toThrow();
  await expect(r.session.request({ op: Op.FsArchive })).rejects.toThrow(/between 1 and/);
});

test('a chunked archive ends with its end marker', async () => {
  r = await rig();
  const proj = join(r.home, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'alpha');
  writeFileSync(join(proj, 'src', 'b.txt'), 'beta'.repeat(1 << 16));
  const { files } = await readZip(await archive([proj], true));
  expect(files['proj/a.txt']).toBe('alpha');
  expect(files['proj/src/b.txt'].length).toBe(4 << 16);
});

test('a reader that goes away stops the archive; the agent goes on', async () => {
  r = await rig();
  const big = join(r.home, 'big');
  mkdirSync(big);
  const chunk = Buffer.alloc(1 << 20);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761) >>> 24;
  for (let i = 0; i < 8; i++) writeFileSync(join(big, String.fromCharCode(97 + i)), chunk);
  const { conn } = await r.session.open({ op: Op.FsArchive, paths: [big] });
  await conn.reader.exactly(1000);
  conn.stream.destroy();
  expect((await r.session.request({ op: Op.Hello })).ok).toBe(true);
});

test('names at the root of an archive', () => {
  expect(archiveNames(['/a/x.txt', '/b/x.txt', '/c/x.txt', '/d/.env', '/e/.env', '/'])).toEqual([
    'x.txt',
    'x-1.txt',
    'x-2.txt',
    '.env',
    '.env-1',
    'root',
  ]);
});
