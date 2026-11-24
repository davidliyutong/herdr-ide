// A VSIX identified by what it holds: the names and contents of its files,
// not the zip's metadata (times), so that a rebuilt but identical bridge
// extension is not installed again on every machine. The same digest as
// the Go core's (vsixContentHash, before this core replaced it), so that
// the marker a machine keeps (`.<bridge>-<hash>`) holds whichever core
// installed it.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface Entry {
  name: Buffer;
  method: number;
  compressed: number;
  local: number;
}

/** The entries of a zip's central directory; null when it is not a zip
 * this reads (no end record, a zip64 archive, a broken directory). */
function entries(b: Buffer): Entry[] | null {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) return null;
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CENTRAL) return null;
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    if (p + 46 + nameLen > b.length) return null;
    out.push({
      method: b.readUInt16LE(p + 10),
      compressed: b.readUInt32LE(p + 20),
      local: b.readUInt32LE(p + 42),
      name: b.subarray(p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** An entry's contents; null when it cannot be read (Go skips it). */
function contents(b: Buffer, e: Entry): Buffer | null {
  const p = e.local;
  if (p + 30 > b.length || b.readUInt32LE(p) !== LOCAL) return null;
  const start = p + 30 + b.readUInt16LE(p + 26) + b.readUInt16LE(p + 28);
  const data = b.subarray(start, start + e.compressed);
  if (data.length !== e.compressed) return null;
  try {
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data);
  } catch {
    return null;
  }
  return null;
}

/** 16 hex digits of SHA-256 over each file's name, a NUL and its contents,
 * in the order of their names; of the bytes themselves when they are not
 * a zip. */
export function vsixContentHash(vsix: Uint8Array): string {
  const b = Buffer.from(vsix.buffer, vsix.byteOffset, vsix.byteLength);
  const h = createHash('sha256');
  const list = entries(b);
  if (!list) return h.update(b).digest('hex').slice(0, 16);
  list.sort((x, y) => Buffer.compare(x.name, y.name));
  for (const e of list) {
    const data = contents(b, e);
    if (data === null) continue;
    h.update(e.name).update(Buffer.of(0)).update(data);
  }
  return h.digest('hex').slice(0, 16);
}
