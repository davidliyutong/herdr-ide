// Patches of selected ranges (plugins/git/patch.ts). The shared vectors
// (spec/vectors/git/range-patches.json) are what the machine side's git
// apply takes.

import { describe, expect, it } from 'vitest';
import rangeVectors from '../../../spec/vectors/git/range-patches.json';
import { quotePath, rangePatch, selectChanges, type Direction, type LineChange, type LineRange, type Side } from '../plugins/git/patch';
import { selectedLines } from '../plugins/git/DiffPane';

interface Vector {
  name: string;
  path: string;
  original: string;
  modified: string;
  changes: LineChange[];
  ranges: LineRange[];
  side: Side;
  direction: Direction;
  patch: string | null;
}

const vectors = rangeVectors as unknown as Vector[];

describe('rangePatch vectors', () => {
  it('has vectors', () => expect(vectors.length).toBeGreaterThan(10));
  for (const v of vectors) {
    it(v.name, () => {
      expect(rangePatch(v.path, v.original, v.modified, v.changes, v.ranges, v.side, v.direction) ?? null).toBe(v.patch);
    });
  }
});

const lc = (a: number, b: number, c: number, d: number): LineChange => ({
  originalStartLineNumber: a,
  originalEndLineNumber: b,
  modifiedStartLineNumber: c,
  modifiedEndLineNumber: d,
});

describe('selectChanges', () => {
  const changes = [lc(2, 3, 2, 4), lc(9, 0, 10, 11), lc(14, 15, 15, 0)];
  it('takes the changes a selection touches, cut to it forward', () => {
    expect(selectChanges(changes, [{ startLine: 4, endLine: 10 }], 'modified', 'forward')).toEqual([
      { o: [1, 3], m: [3, 4] },
      { o: [9, 9], m: [9, 10] },
    ]);
  });
  it('takes whole changes backward or from the original side', () => {
    expect(selectChanges(changes, [{ startLine: 4, endLine: 4 }], 'modified', 'backward')).toEqual([{ o: [1, 3], m: [1, 4] }]);
    expect(selectChanges(changes, [{ startLine: 15, endLine: 15 }], 'original', 'forward')).toEqual([{ o: [13, 15], m: [15, 15] }]);
  });
  it('takes a deletion when the selection touches a line next to it', () => {
    expect(selectChanges(changes, [{ startLine: 16, endLine: 16 }], 'modified', 'forward')).toHaveLength(1);
    expect(selectChanges(changes, [{ startLine: 17, endLine: 20 }], 'modified', 'forward')).toHaveLength(0);
  });
});

describe('patch details', () => {
  it('quotes paths git would quote', () => {
    expect(quotePath('a b/c.txt')).toBe('a b/c.txt');
    expect(quotePath('tab\there')).toBe('"tab\\there"');
    expect(quotePath('q"uote')).toBe('"q\\"uote"');
    expect(rangePatch('x"y', 'a\n', 'b\n', [lc(1, 1, 1, 1)], [{ startLine: 1, endLine: 1 }], 'modified', 'forward')).toMatch(
      /^diff --git "a\/x\\"y" "b\/x\\"y"\n--- "a\/x\\"y"\n\+\+\+ "b\/x\\"y"\n/,
    );
  });
  it('reads selections as lines, a selection ending at a line start without it', () => {
    expect(
      selectedLines([
        { startLineNumber: 2, endLineNumber: 4, endColumn: 1 },
        { startLineNumber: 5, endLineNumber: 5, endColumn: 1 },
        { startLineNumber: 6, endLineNumber: 7, endColumn: 3 },
      ]),
    ).toEqual([
      { startLine: 2, endLine: 3 },
      { startLine: 5, endLine: 5 },
      { startLine: 6, endLine: 7 },
    ]);
  });
});
