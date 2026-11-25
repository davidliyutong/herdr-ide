// Claude Code's session transcripts (JSON lines) and the messages of its
// SDK protocol, whose shapes are the transcript's, read into the
// conversation events of agentproto (Transcript*): ACP v1 session updates,
// the user's prompts, turns and notices (docs/features/35). Each line maps
// on its own (claudeFrame); eachClaude reads a file's lines forward. The
// chat host's imports and its Claude Code adapter read them; the shared
// vectors (spec/vectors/transcript) say what they give.
//
// Every read is bounded: the text of an event, the output of a tool call,
// the length of a line (longer ones are skipped with a notice), the events
// and the decoded values of a line; and it ends with its signal.
import type { TranscriptEvent } from '#shared/proto/agentproto/index.ts';
import { parseClaude } from './claude.ts';
import { LineOut, NOTICE_SKIPPED, bounds, type Limits } from './events.ts';

export { cutText, type Limits } from './events.ts';

/** The longest line read: a longer one is skipped with a notice. Claude
 * Code keeps pasted images in its lines as base64, so lines of several
 * megabytes are ordinary. */
export const MAX_LINE = 8 << 20;

/** What one line of a Claude Code transcript gives, read on its own: its
 * events, and what a reader that follows a whole conversation needs to
 * name the items they belong to (the chat host's import, its adapter's
 * live frames). */
export interface Frame {
  /** The line's events, in their order. */
  events: TranscriptEvent[];
  /** For each event, the index among the line's content blocks of the
   * block it was made of; -1 for an event of no block. */
  blocks: number[];
  /** The assistant message whose content blocks the line holds, and how
   * many it holds; first is the index in the message of the first of them,
   * -1 when the line does not say (an SDK frame, an older transcript). */
  message: string;
  count: number;
  first: number;
  /** What could not be read. */
  unknown: number;
  /** The session's title the line gives; custom: the user named it. */
  title: string;
  custom: boolean;
}

const decoder = new TextDecoder();

/** The Frame of one line of a Claude Code transcript, or of one assistant
 * or user message of Claude Code's SDK protocol (its tool_use_result is
 * the line's toolUseResult), within lim. A line longer than MAX_LINE bytes
 * gives a notice that it was skipped. */
export function claudeFrame(line: Uint8Array | string, lim?: Limits): Frame {
  const o = new LineOut(bounds(lim));
  const bytes = typeof line === 'string' ? Buffer.byteLength(line) : line.length;
  if (bytes > MAX_LINE) o.notice(NOTICE_SKIPPED, { bytes });
  else if (bytes > 0) parseClaude(typeof line === 'string' ? line : decoder.decode(line), o);
  return frameOf(o);
}

function frameOf(o: LineOut): Frame {
  if (o.over) o.unknown++;
  return {
    events: o.made.map((m) => m.ev),
    blocks: o.made.map((m) => m.block - 1),
    message: o.message,
    count: o.count,
    first: o.first - 1,
    unknown: o.unknown,
    title: o.title,
    custom: o.custom,
  };
}

/** What eachClaude reads from: a FileHandle's read. */
export interface ReadAt {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/** A line of a transcript: a complete one (it ends in a newline), or the
 * part of a long line the read saw. */
interface RawLine {
  /** The offset of its first byte; n its length with the newline (for an
   * open or a continued line, of the part the read saw). */
  off: number;
  n: number;
  /** Its bytes without the newline; null when it is longer than MAX_LINE
   * (long). */
  b: Buffer | null;
  long: boolean;
  /** The part ends without the line's newline: the line does not end yet. */
  open: boolean;
  /** The part does not begin at the line's start (the read began inside
   * the line): it makes no notice, the part with the start does. */
  cont: boolean;
}

const CHUNK = 64 << 10;

/** The lines of r from an offset on, up to a size read before. */
async function* lines(r: ReadAt, from: number, size: number, signal?: AbortSignal): AsyncGenerator<RawLine> {
  const read = async (buf: Buffer, pos: number): Promise<number> => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    return (await r.read(buf, 0, buf.length, pos)).bytesRead;
  };
  let off = Math.min(Math.max(from, 0), size);
  // Whether off starts a line: the file's start or the byte after a newline.
  let cont = false;
  if (off > 0) {
    const one = Buffer.alloc(1);
    cont = !((await read(one, off - 1)) === 1 && one[0] === 0x0a);
  }
  let start = off;
  let parts: Buffer[] = [];
  let got = 0;
  let long = cont;
  const buf = Buffer.allocUnsafe(CHUNK);
  while (off < size) {
    const n = await read(buf.subarray(0, Math.min(CHUNK, size - off)), off);
    if (n === 0) throw new Error('transcript: the file changed while it was read');
    let i = 0;
    while (i < n) {
      const nl = buf.indexOf(0x0a, i);
      const end = nl >= 0 && nl < n ? nl + 1 : n;
      const piece = buf.subarray(i, end);
      if (!long) {
        if (got + piece.length > MAX_LINE + 1) {
          long = true;
          parts = [];
        } else parts.push(Buffer.from(piece));
      }
      got += piece.length;
      off += piece.length;
      i = end;
      if (end <= n && piece[piece.length - 1] === 0x0a) {
        const line = long ? null : Buffer.concat(parts, got).subarray(0, got - 1);
        yield { off: start, n: off - start, b: line, long, open: false, cont };
        start = off;
        parts = [];
        got = 0;
        long = false;
        cont = false;
      }
    }
  }
  // What is left is a line that does not end (yet); a long one's part is
  // skipped with a notice.
  if (long && off > start) yield { off: start, n: off - start, b: null, long: true, open: true, cont };
}

/** Reads the Claude Code transcript r forward, from the first line that
 * starts at or after from to size, and calls fn with each complete line's
 * offset and Frame until fn returns false or signal ends (which throws its
 * reason). A line longer than MAX_LINE gives a notice that it was skipped;
 * a last line without its newline (still being written) is not read. */
export async function eachClaude(
  r: ReadAt,
  from: number,
  size: number,
  lim: Limits,
  fn: (off: number, f: Frame) => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const l = bounds(lim);
  for await (const line of lines(r, from, size, signal)) {
    // The rest of a line that began before from.
    if (line.cont) continue;
    const o = new LineOut(l);
    if (line.long) o.notice(NOTICE_SKIPPED, { bytes: line.open ? line.n : line.n - 1 });
    else {
      const text = trimLine(line.b!);
      if (text.length > 0) parseClaude(decoder.decode(text), o);
    }
    if (!fn(line.off, frameOf(o))) return;
  }
}

/** A line's bytes without the space around them. */
function trimLine(b: Buffer): Buffer {
  let i = 0;
  let j = b.length;
  const sp = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  while (i < j && sp(b[i])) i++;
  while (j > i && sp(b[j - 1])) j--;
  return b.subarray(i, j);
}
