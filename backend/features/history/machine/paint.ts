// A terminal's first paint as herdr-core sends it to an observer
// (crates/herdr-core/src/viewers.rs of 0.1.21): every paint starts with CAN
// (0x18) and begins a DATA frame; an attach's first paint is the history
// lines, the screen, the window title, then ESC[?9001h or ESC[?9001l and
// the status reports. What a snapshot keeps of it: up to the end marker,
// without the window titles.
import { createHash } from 'node:crypto';

/** Ends the screen part of a first paint: herdr-core follows the screen and
 * the window title with the terminal's win32-input-mode, ESC[?9001h or
 * ESC[?9001l, then the status reports. The program's own output may carry
 * the same sequence: the paint ends at the first one after its start. */
export const PAINT_END = Buffer.from('\x1b[?9001');

/** The text of the line herdr-core writes into a kept terminal's new shell
 * below the screen and history of the program before, when its
 * configuration has restore_screen = true (RESTORED in
 * crates/herdr-core/src/kept.rs of 0.1.21): how a capture knows that the
 * core restored the screen itself (its records do not keep why a program
 * was replaced). */
export const RESTORED_LINE = Buffer.from('the program above ended; this is a new shell');

/** Identifies what terminal.read showed of a terminal of a grid: its text
 * alone does not change with the grid. */
export function screenHash(cols: number, rows: number, text: string): string {
  return createHash('sha256').update(`${cols}x${rows}\n`).update(text).digest('hex');
}

/** Where the paint's end marker starts in b, at or after from; -1 when b
 * has none (yet). */
export function endOf(b: Buffer, from: number): number {
  for (;;) {
    const i = b.indexOf(PAINT_END, from);
    if (i < 0) return -1;
    const n = i + PAINT_END.length;
    if (n >= b.length) return -1; // its last byte is still on its way
    if (b[n] === 0x68 || b[n] === 0x6c) return i; // h, l
    from = i + 1;
  }
}

/** Whether a paint shows the line the terminal core writes below a screen
 * it restored, in its text: the bytes without escape sequences and
 * control characters, so that the line is found also when the paint draws
 * it in pieces (styles, a wrapped row). */
export const restoredByCore = (b: Buffer): boolean => paintText(b).includes(RESTORED_LINE);

/** b without escape sequences (CSI, OSC and the other strings, two- and
 * three-byte escapes) and control characters. */
export function paintText(b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(b.length);
  let n = 0;
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c === 0x1b && i + 1 < b.length) i = escapeEnd(b, i);
    else {
      if (c >= 0x20 && c !== 0x7f) out[n++] = c;
      i++;
    }
  }
  return out.subarray(0, n);
}

/** Where the escape sequence at b[i] (an ESC with a byte after it) ends. */
function escapeEnd(b: Buffer, i: number): number {
  switch (b[i + 1]) {
    case 0x5b: // [
      for (let j = i + 2; j < b.length; j++) if (b[j] >= 0x40 && b[j] <= 0x7e) return j + 1;
      return b.length;
    case 0x5d: // ]
    case 0x50: // P
    case 0x58: // X
    case 0x5e: // ^
    case 0x5f: // _
      return oscEnd(b, i + 2);
  }
  let j = i + 1;
  while (j < b.length && b[j] >= 0x20 && b[j] <= 0x2f) j++; // intermediate bytes (ESC ( B)
  return Math.min(j + 1, b.length);
}

/** Removes the window title sequences (OSC 0, 1 and 2) from a paint: a page
 * that replays the snapshot must not take the old program's title for the
 * terminal's. A title not terminated ends the bytes. */
export function stripTitles(b: Buffer): Buffer {
  const parts: Buffer[] = [];
  const osc = Buffer.from('\x1b]');
  for (let i = 0; i < b.length;) {
    const j = b.indexOf(osc, i);
    if (j < 0) {
      parts.push(b.subarray(i));
      break;
    }
    parts.push(b.subarray(i, j));
    let k = j + 2;
    while (k < b.length && b[k] >= 0x30 && b[k] <= 0x39) k++;
    const n = b.subarray(j + 2, k).toString('latin1');
    if ((n === '0' || n === '1' || n === '2') && k < b.length && b[k] === 0x3b) {
      i = oscEnd(b, k);
      continue;
    }
    parts.push(b.subarray(j, j + 2));
    i = j + 2;
  }
  return Buffer.concat(parts);
}

/** Where the string started before from ends: after its BEL or ST (ESC \),
 * at an ESC that starts another sequence or a CAN or SUB that cancels it,
 * else at the end of b. */
function oscEnd(b: Buffer, from: number): number {
  for (let m = from; m < b.length; m++) {
    switch (b[m]) {
      case 0x07:
        return m + 1;
      case 0x18:
      case 0x1a:
        return m;
      case 0x1b:
        return m + 1 < b.length && b[m + 1] === 0x5c ? m + 2 : m;
    }
  }
  return b.length;
}
