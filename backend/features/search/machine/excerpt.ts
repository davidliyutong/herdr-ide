// A line's preview around its matches, as the Go agent made it: byte
// offsets in, the first match's column and the matches' ranges out in
// UTF-16 code units (editors count so).
import { decode, decodeRune, runeStart, u16 } from './utf8.ts';

/** The length of a line's preview, in characters. */
export const MAX_PREVIEW = 250;
/** How much of a line before its first match a preview shows at most
 * (bytes); one whose first match is further in starts with an ellipsis,
 * LEAD_KEPT bytes before the match. */
const LEAD = 120;
const LEAD_KEPT = 40;

export type Span = [number, number];

/** The preview of line (without its line break) with the matches spans
 * (byte offsets, in order): the text around the first match, at most
 * MAX_PREVIEW characters, leading blanks dropped, an ellipsis where it was
 * cut; the first match's column (1-based, UTF-16 code units of the whole
 * line); and the matches in the preview ([start, end) in UTF-16 code units
 * of it; null for none, as Go's nil slice). */
export function excerpt(line: Uint8Array, spans: Span[]): { preview: string; col: number; ranges: Span[] | null } {
  const len = line.length;
  const first = spans.length ? Math.min(Math.max(spans[0][0], 0), len) : 0;
  const col = u16(line, 0, first) + 1;
  let lo = 0;
  while (lo < len && (line[lo] === 0x20 || line[lo] === 0x09)) lo++;
  if (lo > first) lo = 0;
  let prefix = '';
  if (first - lo > LEAD) {
    lo = runeStart(line, first - LEAD_KEPT);
    prefix = '…';
  }
  let hi = lo;
  for (let n = 0; hi < len && n < MAX_PREVIEW; n++) hi += decodeRune(line, hi)[1];
  const preview = prefix + decode(line, lo, hi) + (hi < len ? '…' : '');
  const off = prefix.length;
  let ranges: Span[] | null = null;
  for (const sp of spans) {
    let s = Math.max(sp[0], lo);
    let e = Math.min(sp[1], hi);
    if (sp[0] >= hi || e < s) continue;
    s = runeStart(line, s);
    e = runeStart(line, e);
    (ranges ??= []).push([off + u16(line, lo, s), off + u16(line, lo, e)]);
  }
  return { preview, col, ranges };
}
