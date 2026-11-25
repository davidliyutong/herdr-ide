// UTF-8 as the Go agent read it (unicode/utf8): a byte that does not start
// a valid sequence is one replacement character, so byte offsets map to
// the text and its UTF-16 code units as an editor counts them, also in
// lines that are not UTF-8.

/** The replacement character a byte that is not UTF-8 decodes to. */
export const RUNE_ERROR = 0xfffd;

/** The code point at i of b (below end) and its width in bytes (Go's
 * DecodeRune): [RUNE_ERROR, 1] for a byte that starts no valid sequence. */
export function decodeRune(b: Uint8Array, i: number, end = b.length): [number, number] {
  if (i >= end) return [RUNE_ERROR, 0];
  const c0 = b[i];
  if (c0 < 0x80) return [c0, 1];
  const cont = (j: number, lo = 0x80, hi = 0xbf) => i + j < end && b[i + j] >= lo && b[i + j] <= hi;
  if (c0 >= 0xc2 && c0 <= 0xdf) return cont(1) ? [((c0 & 0x1f) << 6) | (b[i + 1] & 0x3f), 2] : [RUNE_ERROR, 1];
  if (c0 >= 0xe0 && c0 <= 0xef) {
    const lo = c0 === 0xe0 ? 0xa0 : 0x80;
    const hi = c0 === 0xed ? 0x9f : 0xbf;
    if (!cont(1, lo, hi) || !cont(2)) return [RUNE_ERROR, 1];
    return [((c0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f), 3];
  }
  if (c0 >= 0xf0 && c0 <= 0xf4) {
    const lo = c0 === 0xf0 ? 0x90 : 0x80;
    const hi = c0 === 0xf4 ? 0x8f : 0xbf;
    if (!cont(1, lo, hi) || !cont(2) || !cont(3)) return [RUNE_ERROR, 1];
    return [((c0 & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f), 4];
  }
  return [RUNE_ERROR, 1];
}

/** Byte offset i of b moved back to the start of its code point. */
export function runeStart(b: Uint8Array, i: number): number {
  while (i > 0 && i < b.length && (b[i] & 0xc0) === 0x80) i--;
  return i;
}

/** The UTF-16 code units of b[lo:hi] as an editor sees them. */
export function u16(b: Uint8Array, lo = 0, hi = b.length): number {
  let n = 0;
  for (let i = lo; i < hi;) {
    const [r, w] = decodeRune(b, i, hi);
    n += r >= 0x10000 ? 2 : 1;
    i += w;
  }
  return n;
}

/** b[lo:hi] as text, each byte that is not UTF-8 a replacement character. */
export function decode(b: Uint8Array, lo = 0, hi = b.length): string {
  const parts: string[] = [];
  let cps: number[] = [];
  for (let i = lo; i < hi;) {
    const [r, w] = decodeRune(b, i, hi);
    cps.push(r);
    i += w;
    if (cps.length >= 4096) {
      parts.push(String.fromCodePoint(...cps));
      cps = [];
    }
  }
  parts.push(String.fromCodePoint(...cps));
  return parts.join('');
}

/** b as text, and the byte offset of each UTF-16 index of it (one past the
 * end included): where in b a match found in the text is. */
export function decodeMapped(b: Uint8Array): { text: string; byteAt: Uint32Array } {
  const text = decode(b);
  const byteAt = new Uint32Array(text.length + 1);
  let k = 0;
  for (let i = 0; i < b.length;) {
    const [r, w] = decodeRune(b, i);
    byteAt[k++] = i;
    if (r >= 0x10000) byteAt[k++] = i;
    i += w;
  }
  byteAt[k] = b.length;
  return { text, byteAt };
}
