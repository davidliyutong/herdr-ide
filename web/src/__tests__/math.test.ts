// Formulas in pane text: the spellings agents print, after their terminal
// markdown renderers dropped backslashes, and text that only looks like
// math (shell variables, prices, calls).

import { describe, expect, it } from 'vitest';
import { findMath, mathAround, mathAt } from '../terminal/math';
import type { RowText } from '../terminal/links';

const texts = (s: string) =>
  findMath(s)
    .sort((a, b) => a.start - b.start)
    .map((m) => [m.tex, m.display]);

/** The vectors of spec/vectors/math. */
interface MathVectors {
  cases: Array<{ description: string; text: string; expected: Array<[string, boolean]> }>;
}

const vectors = import.meta.glob<MathVectors>('../../../spec/vectors/math/*.json', { eager: true, import: 'default' });

describe('findMath', () => {
  it('has vectors', () => {
    expect(Object.keys(vectors).length).toBeGreaterThan(0);
  });

  for (const file of Object.values(vectors)) {
    for (const c of file.cases) {
      it(c.description, () => {
        expect(texts(c.text)).toEqual(c.expected);
      });
    }
  }
});

describe('mathAround', () => {
  // Rows of a pane 24 columns wide starting at column 2.
  const W = 24;
  const rows = (...lines: string[]) => {
    const out = lines.map((l): RowText => ({ text: l.padEnd(W), colOf: [...Array(W + 1).keys()].map((i) => 2 + i) }));
    return (y: number) => out[y];
  };
  const cells = (m?: { cells: Array<{ y: number; from: number; to: number }> }) => m?.cells.map((c) => [c.y, c.from, c.to]);

  it('takes a display formula over its lines, without the indentation', () => {
    const r = rows('text', '', '  $$', '  x = \\frac{1}{2}', '  $$', '', 'after');
    const m = mathAt(6, 3, 0, 7, r);
    expect(m?.tex).toBe('x = \\frac{1}{2}');
    expect(cells(m)).toEqual([
      [2, 4, 6],
      [3, 4, 19],
      [4, 4, 6],
    ]);
    expect(mathAt(8, 4, 0, 7, r)).toBeUndefined();
    expect(mathAround(6, 0, 7, r)).toEqual([]);
  });

  it('joins a formula wrapped by the terminal or by the program', () => {
    // The terminal wrapped at the last column; the program wrapped at a
    // space and indented the next row.
    const r = rows('so $\\int_0^1 f(x)\\,dx=F(', '1)-F(0)$ holds; and', '  $\\alpha', '  + \\beta$ too');
    expect('so $\\int_0^1 f(x)\\,dx=F(').toHaveLength(W);
    const wrapped = mathAt(3, 1, 0, 4, r);
    expect(wrapped?.tex).toBe('\\int_0^1 f(x)\\,dx=F(1)-F(0)');
    expect(cells(wrapped)).toEqual([
      [0, 5, 26],
      [1, 2, 10],
    ]);
    const m = mathAt(5, 3, 0, 4, r);
    expect(m?.tex).toBe('\\alpha\n  + \\beta');
    expect(cells(m)).toEqual([
      [2, 4, 11],
      [3, 4, 12],
    ]);
  });

  it('pairs $$ within a paragraph only', () => {
    // The first $$ closes a formula above the rows looked at.
    const r = rows('a^2$$', '', '$$b^2$$');
    expect(mathAt(2, 0, 0, 3, r)).toBeUndefined();
    expect(mathAt(3, 2, 0, 3, r)?.tex).toBe('b^2');
  });

  it('maps wide characters to their cells', () => {
    // 公式 takes two columns per character.
    const r = (y: number): RowText =>
      y === 0 ? { text: '公式 $a_1$', colOf: [0, 2, 4, 5, 6, 7, 8, 9, 10, 11] } : { text: '', colOf: [11] };
    expect(cells(mathAt(6, 0, 0, 1, r))).toEqual([[0, 5, 10]]);
  });
});
