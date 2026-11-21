import { describe, expect, it } from 'vitest';
import { lineChanges, matchLines } from '../plugins/files/quickDiff';

const lines = (...l: string[]) => l.join('\n') + '\n';

describe('quick diff', () => {
  it('finds nothing in equal texts', () => {
    expect(lineChanges(lines('a', 'b'), lines('a', 'b'))).toEqual([]);
    expect(lineChanges('', '')).toEqual([]);
  });

  it('marks added, changed and removed lines of the current text', () => {
    expect(lineChanges(lines('a', 'b', 'c'), lines('a', 'x', 'b', 'c'))).toEqual([{ kind: 'added', start: 2, end: 2 }]);
    expect(lineChanges(lines('a', 'b', 'c'), lines('a', 'B', 'c'))).toEqual([{ kind: 'modified', start: 2, end: 2 }]);
    expect(lineChanges(lines('a', 'b', 'c'), lines('a', 'c'))).toEqual([{ kind: 'deleted', after: 1 }]);
    expect(lineChanges(lines('a', 'b'), lines('b'))).toEqual([{ kind: 'deleted', after: 0 }]);
    expect(lineChanges('', lines('a', 'b'))).toEqual([{ kind: 'added', start: 1, end: 2 }]);
  });

  it('keeps hunks apart', () => {
    const base = lines('1', '2', '3', '4', '5', '6', '7', '8');
    const text = lines('1', 'two', '3', '4', 'new', '5', '6', '8');
    expect(lineChanges(base, text)).toEqual([
      { kind: 'modified', start: 2, end: 2 },
      { kind: 'added', start: 5, end: 5 },
      { kind: 'deleted', after: 7 },
    ]);
  });

  it('ignores line endings and a missing last newline', () => {
    expect(lineChanges('a\r\nb\r\n', 'a\nb')).toEqual([]);
  });

  it('matches lines as a longest common subsequence', () => {
    const a = ['x', 'a', 'b', 'c', 'y'];
    const b = ['a', 'z', 'b', 'c'];
    expect(Array.from(matchLines(a, b)!)).toEqual([1, -1, 2, 3]);
    // Beyond the limit of edits: no answer.
    expect(matchLines(['a', 'b'], ['c', 'd'], 1)).toBeUndefined();
  });

  it('makes one change of a large difference beyond the limit', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const text = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `other ${i}` : `line ${i}`)).join('\n');
    const changes = lineChanges(base, text);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.kind !== 'deleted')).toBe(true);
  });
});
