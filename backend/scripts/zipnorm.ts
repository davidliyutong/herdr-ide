// Rewrites a zip archive with its entries sorted by name and a fixed
// modification time (1980-01-01, the earliest a zip can hold), so that
// packaging the same files twice gives identical bytes (the VS Code bridge
// VSIX the core's executable embeds; scripts/build.sh).
//
//   bun backend/scripts/zipnorm.ts FILE
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import yauzl from 'yauzl';
import { ZipFile } from 'yazl';

/** The time every entry gets: the DOS date's epoch, whatever the time zone. */
const EPOCH = new Date(1980, 0, 1, 0, 0, 0);

interface Entry {
  name: string;
  compressed: boolean;
  mode: number;
  body: Buffer;
}

/** The entries of the zip archive zip, decompressed. */
function read(zip: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => {
      if (err || !z) return reject(err ?? new Error('not a zip archive'));
      const out: Entry[] = [];
      z.on('error', reject);
      z.on('end', () => resolve(out));
      z.on('entry', (e: yauzl.Entry) => {
        // Unix modes are kept; others' files are plain files.
        const unix = e.versionMadeBy >> 8 === 3 && e.externalFileAttributes >>> 16 !== 0;
        const mode = unix ? e.externalFileAttributes >>> 16 : e.fileName.endsWith('/') ? 0o40755 : 0o100644;
        if (e.fileName.endsWith('/')) {
          out.push({ name: e.fileName, compressed: false, mode, body: Buffer.alloc(0) });
          return z.readEntry();
        }
        z.openReadStream(e, (err2, s) => {
          if (err2 || !s) return reject(err2 ?? new Error(`${e.fileName}: unreadable`));
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          s.on('error', reject);
          s.on('end', () => {
            out.push({ name: e.fileName, compressed: e.compressionMethod !== 0, mode, body: Buffer.concat(chunks) });
            z.readEntry();
          });
        });
      });
      z.readEntry();
    });
  });
}

/** entries as a zip archive in the order given. */
function write(entries: Entry[]): Promise<Buffer> {
  const z = new ZipFile();
  for (const e of entries) {
    const o = { mtime: EPOCH, mode: e.mode, forceDosTimestamp: true };
    if (e.name.endsWith('/')) z.addEmptyDirectory(e.name, o);
    else z.addBuffer(e.body, e.name, { ...o, compress: e.compressed });
  }
  z.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('error', reject);
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** The archive zip normalized. */
export async function normalize(zip: Buffer): Promise<Buffer> {
  const entries = await read(zip);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return write(entries);
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length > 0) {
    console.error('usage: bun backend/scripts/zipnorm.ts FILE');
    process.exit(2);
  }
  try {
    const out = await normalize(readFileSync(file));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, out, { mode: 0o644 });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch (e) {
    console.error(`zipnorm: ${(e as Error).message}`);
    process.exit(1);
  }
}
