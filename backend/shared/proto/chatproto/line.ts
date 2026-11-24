// The protocol's lines: reading one within MAX_LINE from a streamio Reader,
// passing over the rest of one that is longer, and writing a value as one.
import { EOFError, type Reader } from '#shared/lib/streamio.ts';
import { MAX_LINE } from './chatproto.ts';

/** readLine's error for a line longer than MAX_LINE. */
export const ERR_TOO_LARGE = new Error('chatproto: line longer than MaxLine (16 MiB)');

const NL = 0x0a;

/** Reads the next line, without its newline; the bytes are a copy, the
 * caller's to keep, and what follows the newline stays in the Reader. It
 * never holds more than limit bytes of a line: a longer one is answered with
 * ERR_TOO_LARGE as soon as it is known to be, with its end, the newline at
 * least, still to be read. A reader that goes on after that reads up to the
 * newline first (skipLine). What comes before the end of the input without a
 * newline is no line: EOFError. */
export async function readLine(r: Reader, limit = MAX_LINE): Promise<Buffer> {
  const parts: Buffer[] = [];
  let got = 0;
  for (;;) {
    // One byte more than the line may still take: a newline among them ends
    // a line within the limit, and without one the line is longer.
    const b = await r.chunk(limit - got + 1);
    if (b === null) throw new EOFError();
    const i = b.indexOf(NL);
    if (i >= 0) {
      r.unread(b.subarray(i + 1));
      parts.push(b.subarray(0, i));
      return Buffer.concat(parts, got + i);
    }
    got += b.length;
    if (got > limit) throw ERR_TOO_LARGE;
    parts.push(b);
  }
}

/** Passes over the rest of a line through its newline, holding none of it,
 * as a reader does after ERR_TOO_LARGE: true once the newline is read, false
 * when max bytes went by without one; EOFError when the input ends first. */
export async function skipLine(r: Reader, max = Infinity): Promise<boolean> {
  for (let n = 0; n < max;) {
    const b = await r.chunk(max - n);
    if (b === null) throw new EOFError();
    const i = b.indexOf(NL);
    if (i >= 0) {
      r.unread(b.subarray(i + 1));
      return true;
    }
    n += b.length;
  }
  return false;
}

/** v as one line with its newline. Members left undefined are left out, the
 * characters of HTML are not escaped, and U+2028 and U+2029 are, as Go
 * writes them; a value JSON cannot hold throws. */
export function line(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) throw new TypeError(`chatproto: no JSON for ${typeof v}`);
  return s.replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029')) + '\n';
}
