// Files that mix line endings (eol.ts): lines as Monaco reads them, the
// line diff, and the endings a save of edited text keeps.

import { describe, expect, it } from 'vitest';
import { diffLines, dominantEol, hasLoneCR, isMixed, restoreEols, splitLines, unifiedEol, type Hunk } from '../eol';

/** What Monaco gives back: every ending the model's one. */
const normalize = (s: string, eol = unifiedEol(s)) => s.replace(/\r\n|\r|\n/g, eol);

describe('line endings', () => {
  it('splits lines as Monaco does', () => {
    expect(splitLines('a\r\nb\nc\rd')).toEqual({ lines: ['a', 'b', 'c', 'd'], eols: ['\r\n', '\n', '\r', ''] });
    expect(splitLines('a\n')).toEqual({ lines: ['a', ''], eols: ['\n', ''] });
    expect(splitLines('')).toEqual({ lines: [''], eols: [''] });
  });

  it('tells mixed files', () => {
    expect(isMixed('a\nb\n')).toBe(false);
    expect(isMixed('a\r\nb\r\n')).toBe(false);
    expect(isMixed('a\r\nb\n')).toBe(true);
    expect(isMixed('a\rb\n')).toBe(true);
    expect(hasLoneCR('a\rb')).toBe(true);
    expect(hasLoneCR('a\r\nb')).toBe(false);
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(unifiedEol('a\r\nb\nc\n')).toBe('\n');
    expect(unifiedEol('a\r\nb\r\nc\n')).toBe('\r\n');
  });
});

/** b rebuilt from a with the hunks, and the lines left equal. */
function apply(a: string[], b: string[], hunks: Hunk[]): { out: string[]; equal: number } {
  const out: string[] = [];
  let i = 0;
  let equal = 0;
  for (const [a0, a1, b0, b1] of hunks) {
    for (; i < a0; i++, equal++) out.push(a[i]);
    out.push(...b.slice(b0, b1));
    i = a1;
  }
  for (; i < a.length; i++, equal++) out.push(a[i]);
  return { out, equal };
}

/** The length of the longest common subsequence (quadratic). */
function lcs(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = cur;
    }
  }
  return row[b.length];
}

describe('diffLines', () => {
  it('finds the changed runs', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])).toEqual([[1, 2, 1, 2]]);
    expect(diffLines(['a', 'b'], ['a', 'b', 'c'])).toEqual([[2, 2, 2, 3]]);
    expect(diffLines(['a', 'b', 'c', 'd'], ['b', 'c', 'x', 'd'])).toEqual([
      [0, 1, 0, 0],
      [3, 3, 2, 3],
    ]);
  });

  it('is a shortest edit script', () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)]);
      const b = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)]);
      const hunks = diffLines(a, b);
      const { out, equal } = apply(a, b, hunks);
      expect(out).toEqual(b);
      expect(equal).toBe(lcs(a, b));
    }
  });

  it('takes the rest as one change past its limit of edits', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = ['same', ...Array.from({ length: 50 }, (_, i) => `b${i}`), 'end'];
    const hunks = diffLines(['same', ...a, 'end'], b, 10);
    expect(hunks).toEqual([[1, 51, 1, 51]]);
  });
});

describe('restoreEols', () => {
  const mixed = 'one\r\ntwo\nthree\r\nfour\n';

  it('gives back the text as it was when nothing changed', () => {
    expect(restoreEols(mixed, normalize(mixed))).toBe(mixed);
    expect(restoreEols(mixed, normalize(mixed, '\r\n'))).toBe(mixed);
    expect(restoreEols('a\r\nb\nc', normalize('a\r\nb\nc'))).toBe('a\r\nb\nc');
  });

  it('keeps a changed line’s ending', () => {
    expect(restoreEols(mixed, 'one\ntwo\nTHREE\nfour\n')).toBe('one\r\ntwo\nTHREE\r\nfour\n');
  });

  it('gives new lines a neighbour’s ending', () => {
    // After a CRLF line.
    expect(restoreEols(mixed, 'one\nnew\ntwo\nthree\nfour\n')).toBe('one\r\nnew\r\ntwo\nthree\r\nfour\n');
    // At the start: the line after.
    expect(restoreEols(mixed, 'new\none\ntwo\nthree\nfour\n')).toBe('new\r\none\r\ntwo\nthree\r\nfour\n');
    // After a last line without an ending, which gets one.
    expect(restoreEols('a\r\nb\nc', 'a\nb\nc\nd')).toBe('a\r\nb\nc\nd');
    expect(restoreEols('a\nb\r\nc', 'a\nb\nc\nd')).toBe('a\nb\r\nc\r\nd');
  });

  it('drops deleted lines with their endings', () => {
    expect(restoreEols(mixed, 'one\nthree\nfour\n')).toBe('one\r\nthree\r\nfour\n');
    expect(restoreEols(mixed, 'one\ntwo\nthree\nfour')).toBe('one\r\ntwo\nthree\r\nfour');
  });

  it('leaves text that does not mix endings as edited', () => {
    expect(restoreEols('a\nb\n', 'a\nx\n')).toBe('a\nx\n');
    expect(restoreEols('a\r\nb\r\n', 'a\r\nx\r\n')).toBe('a\r\nx\r\n');
  });

  it('keeps lone carriage returns', () => {
    expect(restoreEols('a\rb\nc\n', 'a\nb\nC\n')).toBe('a\rb\nC\n');
  });
});
