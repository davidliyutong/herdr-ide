// The CLIs' logs as the cost scan and a session's read see them: found by
// walking their directories (no symbolic link followed), opened only as
// regular files and without blocking (a FIFO at the name fails at once),
// and read line by line in chunks with fs/promises: each chunk's lines are
// handed on, then the next read lets the node's other work in, so a scan
// of gigabytes of logs never holds the thread for more than a chunk's
// lines (one line is at most MAX_LINE). Lines longer than MAX_LINE (a
// tool's output) carry no usage and are skipped.
import { constants, createReadStream } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';

/** Bounds a log line. */
export const MAX_LINE = 16 << 20;
/** What one read of a log takes. */
const CHUNK = 1 << 20;

/** A file that is not a regular file. */
export class NotRegular extends Error {
  constructor() {
    super('not a regular file');
    this.name = 'NotRegular';
  }
}

/** Opens a regular file for reading without blocking: a FIFO or a device
 * at the name, also one swapped in after it was looked at, is refused
 * (NotRegular) once open. With noFollow, refuses symlinks at the final
 * component; with uid >= 0, refuses files owned by another user. */
export async function openRegular(p: string, o: { noFollow?: boolean; uid?: number } = {}): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | (o.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
  const fh = await open(p, flags);
  try {
    const st = await fh.stat();
    if (st.isFile() && (o.uid === undefined || o.uid < 0 || st.uid === o.uid)) return fh;
  } catch {
    // refused below
  }
  await fh.close();
  throw new NotRegular();
}

/** The regular files below root whose path relative to it match, without
 * following symbolic links; [] when root cannot be read. */
export async function walk(root: string, match: (rel: string) => boolean, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const dirs = [''];
  while (dirs.length) {
    if (signal?.aborted) break;
    const rel = dirs.pop()!;
    let ents;
    try {
      ents = await readdir(rel ? posix.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of ents) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) dirs.push(p);
      else if (d.isFile() && match(p)) out.push(p);
    }
  }
  return out.sort();
}

/** Splits bytes into lines, handing on each complete line shorter than
 * MAX_LINE, trimmed and not empty; end() hands on a last one that does
 * not end with a newline. */
class Lines {
  private carry: Buffer[] = [];
  private carried = 0;
  private long = false;
  /** Bytes up to and including the last newline seen. */
  ended = 0;
  private seen = 0;
  private readonly fn: (line: string) => void;

  constructor(fn: (line: string) => void) {
    this.fn = fn;
  }

  push(b: Buffer): void {
    let start = 0;
    for (;;) {
      const nl = b.indexOf(10, start);
      if (nl < 0) break;
      if (!this.long) this.line(this.carried ? Buffer.concat([...this.carry, b.subarray(start, nl)]) : b.subarray(start, nl));
      this.carry = [];
      this.carried = 0;
      this.long = false;
      start = nl + 1;
      this.ended = this.seen + start;
    }
    this.seen += b.length;
    const rest = b.subarray(start);
    if (this.long || rest.length === 0) return;
    if (this.carried + rest.length > MAX_LINE) {
      this.carry = [];
      this.carried = 0;
      this.long = true;
      return;
    }
    // A copy: the buffer is read into again.
    this.carry.push(Buffer.from(rest));
    this.carried += rest.length;
  }

  end(): void {
    if (!this.long && this.carried) this.line(Buffer.concat(this.carry));
    this.carry = [];
    this.carried = 0;
  }

  private line(b: Buffer): void {
    if (b.length > MAX_LINE) return;
    const s = b.toString('utf8').trim();
    if (s) this.fn(s);
  }
}

/** Reads fh's lines from byte from up to size, handing each complete one
 * to fn (with final also a last one without a newline); the offset after
 * the last newline. Stops, failing with the signal's reason, once signal
 * ends. */
export async function readLines(
  fh: FileHandle,
  from: number,
  size: number,
  final: boolean,
  fn: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const lines = new Lines(fn);
  const buf = Buffer.alloc(CHUNK);
  let pos = from;
  while (pos < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    lines.push(buf.subarray(0, bytesRead));
  }
  if (final) lines.end();
  return from + lines.ended;
}

/** Reads the lines of the gzip-compressed file fh, all of them (a
 * compressed log is never read on from an offset). */
export async function readGzLines(fh: FileHandle, fn: (line: string) => void, signal?: AbortSignal): Promise<void> {
  const lines = new Lines(fn);
  const gz = createReadStream('', { fd: fh.fd, autoClose: false, start: 0, highWaterMark: CHUNK }).pipe(createGunzip());
  await new Promise<void>((resolve, reject) => {
    const stop = () => gz.destroy(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', stop, { once: true });
    gz.on('data', (d: Buffer) => lines.push(d));
    gz.on('end', () => {
      signal?.removeEventListener('abort', stop);
      resolve();
    });
    gz.on('error', (e) => {
      signal?.removeEventListener('abort', stop);
      reject(e);
    });
  });
  lines.end();
}

/** Whether the byte before off is a newline: a log read on from off was
 * not rewritten up to there. */
export async function endsLine(fh: FileHandle, off: number): Promise<boolean> {
  const b = Buffer.alloc(1);
  try {
    const { bytesRead } = await fh.read(b, 0, 1, off - 1);
    return bytesRead === 1 && b[0] === 10;
  } catch {
    return false;
  }
}

/** Hands fn fh's lines between from and size, the last first, until fn
 * returns true; lines longer than MAX_LINE are skipped, and a line cut at
 * from is handed on as it is there. */
export async function eachLineBackward(
  fh: FileHandle,
  from: number,
  size: number,
  fn: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  let pos = size;
  // The end of a line whose start is before pos.
  let carry: Buffer = Buffer.alloc(0);
  let long = false;
  const hand = (b: Buffer): boolean => {
    const s = b.length <= MAX_LINE ? b.toString('utf8').trim() : '';
    return s !== '' && fn(s);
  };
  while (pos > from) {
    signal?.throwIfAborted();
    // Reads grow with a long line, so it is copied a few times only.
    const n = Math.min(Math.max(CHUNK, carry.length), pos - from);
    pos -= n;
    let b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, pos);
    if (bytesRead < n) return;
    if (long) {
      // Still inside a line too long to read: drop up to its start.
      const i = b.lastIndexOf(10);
      if (i < 0) continue;
      b = b.subarray(0, i + 1);
      long = false;
    } else if (carry.length) b = Buffer.concat([b, carry]);
    for (;;) {
      const i = b.lastIndexOf(10);
      if (i < 0) break;
      if (hand(b.subarray(i + 1))) return;
      b = b.subarray(0, i);
    }
    carry = b;
    if (carry.length > MAX_LINE) {
      carry = Buffer.alloc(0);
      long = true;
    }
  }
  if (!long) hand(carry);
}

/** Hands fn the lines of the log at p that contain marker, the last first,
 * until fn returns true. */
export async function lastLineWith(p: string, marker: string, fn: (line: string) => boolean, signal?: AbortSignal): Promise<void> {
  let fh: FileHandle;
  try {
    fh = await openRegular(p);
  } catch {
    return;
  }
  try {
    const { size } = await fh.stat();
    await eachLineBackward(fh, 0, size, (line) => line.includes(marker) && fn(line), signal);
  } catch {
    // unreadable
  } finally {
    await fh.close();
  }
}
