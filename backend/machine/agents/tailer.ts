// Safe, bounded, incremental JSONL file tailing under explicit root directories.
// Shared by read-only transcript/subagent observers (ACP Antigravity subagents,
// and future Native CLI + Native UI live transcript tailers).
//
// Security guarantees:
//   - Leaf path must be a regular user-owned file (never a symlink or FIFO).
//   - Resolved realpath must stay strictly inside a resolved allowed root,
//     preventing parent-directory symlink escapes.
//   - Opened with openNoLinks (openat2 RESOLVE_NO_SYMLINKS on Linux /
//     O_NOFOLLOW_ANY on macOS) + O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_NOCTTY,
//     then verified via fstatSync(fd) (regular file, uid, dev/ino match) so a
//     swapped FIFO or symlink can neither block the event loop nor redirect reads.
//
// Framing guarantees:
//   - Accumulates raw bytes up to maxLineBytes and splits on 0x0a before UTF-8
//     decoding, so multi-byte characters split across chunk boundaries are never
//     corrupted into U+FFFD.
//   - Oversized lines are discarded cleanly through their terminating newline.
import { closeSync, constants, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { openNoLinks } from '#machine/sys/fs.ts';

/** Default chunk read cap per poll (1 MiB). */
export const DEFAULT_MAX_READ_BYTES = 1 << 20;
/** Default maximum single JSONL line length (2 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 2 << 20;
/** Default ceiling for multi-chunk drainAll() calls (32 MiB). */
export const DEFAULT_DRAIN_BYTES = 32 << 20;

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY;

/** Whether realPath lies strictly inside realRoot (both normalized POSIX paths). */
export function isWithinRoot(realPath: string, realRoot: string): boolean {
  const root = realRoot.length > 1 ? realRoot.replace(/\/+$/, '') : realRoot;
  if (!root.startsWith('/') || !realPath.startsWith('/')) return false;
  if (root === '/') return realPath.length > 1;
  return realPath.startsWith(root + '/');
}

/** Resolves allowedRoots to canonical real paths (dropping non-existent entries). */
function resolveRoots(allowedRoots: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of allowedRoots) {
    if (!r || !posix.isAbsolute(r)) continue;
    try {
      const real = realpathSync(r);
      if (real && !out.includes(real)) out.push(real);
    } catch {
      // Root may not exist yet.
    }
  }
  return out;
}

export interface OpenedRegular {
  fd: number;
  size: number;
  dev: number;
  ino: number;
}

/** Opens a user-owned regular file strictly inside allowedRoots without following
 * symlinks or blocking on special files. Caller must close the returned fd. */
export function openContainedRegular(path: string, allowedRoots: readonly string[], uid: number): OpenedRegular | null {
  if (!path || !posix.isAbsolute(path)) return null;
  let lst;
  try {
    lst = lstatSync(path);
  } catch {
    return null;
  }
  if (!lst.isFile() || lst.isSymbolicLink()) return null;
  if (uid >= 0 && lst.uid !== uid) return null;

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }

  if (allowedRoots.length > 0) {
    const roots = resolveRoots(allowedRoots);
    if (!roots.some((root) => isWithinRoot(real, root))) return null;
  }

  let fd = -1;
  try {
    fd = openNoLinks(real, OPEN_FLAGS);
    const fst = fstatSync(fd);
    if (!fst.isFile()) return null;
    if (uid >= 0 && fst.uid !== uid) return null;
    if (fst.dev !== lst.dev || fst.ino !== lst.ino) return null;
    const out: OpenedRegular = { fd, size: fst.size, dev: fst.dev, ino: fst.ino };
    fd = -1;
    return out;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

export interface SafeChunk {
  bytes: Buffer;
  nextOffset: number;
  size: number;
  more: boolean;
}

/** Reads up to maxBytes starting from offset of a contained regular file. */
export function safeReadContainedChunk(
  path: string,
  offset: number,
  allowedRoots: readonly string[],
  uid: number,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): SafeChunk | null {
  const opened = openContainedRegular(path, allowedRoots, uid);
  if (!opened) return null;
  try {
    if (opened.size <= offset) {
      return { bytes: Buffer.alloc(0), nextOffset: offset, size: opened.size, more: false };
    }
    const toRead = Math.min(opened.size - offset, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    const n = readSync(opened.fd, buf, 0, toRead, offset);
    const nextOffset = offset + n;
    return {
      bytes: buf.subarray(0, n),
      nextOffset,
      size: opened.size,
      more: n > 0 && nextOffset < opened.size,
    };
  } catch {
    return null;
  } finally {
    try {
      closeSync(opened.fd);
    } catch {
      // closed
    }
  }
}

export interface TailerOptions {
  /** Canonical or raw parent directories the tailed file must resolve within. */
  allowedRoots: readonly string[];
  /** Required file owner UID (< 0 disables UID check). */
  uid: number;
  /** Initial byte offset (default 0). */
  startOffset?: number;
  /** Max bytes read per poll() call (default 1 MiB). */
  maxReadBytes?: number;
  /** Max bytes kept for a single JSONL line (default 2 MiB). */
  maxLineBytes?: number;
}

export interface PollResult<T> {
  items: T[];
  bytesRead: number;
  more: boolean;
}

/** Incremental, UTF-8-safe, symlink-contained JSONL file tailer. */
export class SafeFileTailer {
  readonly path: string;
  private readonly allowedRoots: readonly string[];
  private readonly uid: number;
  private readonly maxReadBytes: number;
  private readonly maxLineBytes: number;
  private offset: number;
  private rem: Buffer = Buffer.alloc(0);
  private remOverflow = false;

  constructor(path: string, o: TailerOptions) {
    this.path = path;
    this.allowedRoots = o.allowedRoots;
    this.uid = o.uid;
    this.offset = o.startOffset ?? 0;
    this.maxReadBytes = o.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxLineBytes = o.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** Current byte offset into the file. */
  get position(): number {
    return this.offset;
  }

  /** Fast-forwards to the current end of the file (if it exists and is valid). */
  seekEnd(): void {
    const opened = openContainedRegular(this.path, this.allowedRoots, this.uid);
    if (!opened) return;
    try {
      this.offset = opened.size;
      this.rem = Buffer.alloc(0);
      this.remOverflow = false;
    } finally {
      try {
        closeSync(opened.fd);
      } catch {
        // closed
      }
    }
  }

  /** Reads at most one chunk (maxReadBytes) and parses all newly completed JSON objects. */
  poll(): PollResult<Record<string, unknown>> {
    const chunk = safeReadContainedChunk(this.path, this.offset, this.allowedRoots, this.uid, this.maxReadBytes);
    if (!chunk || chunk.bytes.length === 0) {
      return { items: [], bytesRead: 0, more: false };
    }
    this.offset = chunk.nextOffset;
    const items = this.consumeBytes(chunk.bytes);
    return { items, bytesRead: chunk.bytes.length, more: chunk.more };
  }

  /** Drains multiple chunks until EOF or maxTotalBytes is reached. */
  drainAll(maxTotalBytes = DEFAULT_DRAIN_BYTES): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let total = 0;
    while (total < maxTotalBytes) {
      const res = this.poll();
      if (res.items.length > 0) out.push(...res.items);
      total += res.bytesRead;
      if (!res.more || res.bytesRead === 0) break;
    }
    return out;
  }

  private consumeBytes(buf: Buffer): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const segEnd = nl >= 0 ? nl : buf.length;
      const piece = buf.subarray(pos, segEnd);

      if (nl >= 0) {
        if (!this.remOverflow) {
          const totalLen = this.rem.length + piece.length;
          if (totalLen > 0 && totalLen <= this.maxLineBytes) {
            const rawLine = this.rem.length > 0 ? Buffer.concat([this.rem, piece], totalLen) : piece;
            const parsed = parseJsonObjectLine(rawLine);
            if (parsed) out.push(parsed);
          }
        }
        this.rem = Buffer.alloc(0);
        this.remOverflow = false;
        pos = nl + 1;
      } else {
        if (!this.remOverflow) {
          const totalLen = this.rem.length + piece.length;
          if (totalLen > this.maxLineBytes) {
            this.rem = Buffer.alloc(0);
            this.remOverflow = true;
          } else {
            this.rem = this.rem.length > 0 ? Buffer.concat([this.rem, piece], totalLen) : Buffer.from(piece);
          }
        }
        pos = buf.length;
      }
    }
    return out;
  }
}

function parseJsonObjectLine(rawLine: Buffer): Record<string, unknown> | null {
  const trimmed = rawLine.toString('utf8').trim();
  if (!trimmed) return null;
  try {
    const v: unknown = JSON.parse(trimmed);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
