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

describe('findMath', () => {
  it('finds what Claude Code prints', () => {
    // As Claude Code showed it: its markdown dropped the \ of \,.
    const s = [
      '⏺ 二次方公式: 对于方程 $ax^2+bx+c=0$($a\\neq 0$),其解为',
      '',
      '  $$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$',
      '',
      '  高斯积分: 行内形式为 $\\int_{-\\infty}^{\\infty} e^{-x^2},dx=\\sqrt{\\pi}$,更一般地,',
    ].join('\n');
    expect(texts(s)).toEqual([
      ['ax^2+bx+c=0', false],
      ['a\\neq 0', false],
      ['x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}', true],
      ['\\int_{-\\infty}^{\\infty} e^{-x^2},dx=\\sqrt{\\pi}', false],
    ]);
  });

  it('finds \\( \\) and \\[ \\], also without their backslashes', () => {
    expect(texts('root \\(x_1\\) and \\[\\sum_{k=1}^n k\\]')).toEqual([
      ['x_1', false],
      ['\\sum_{k=1}^n k', true],
    ]);
    expect(texts('Area:\n[\n  A = \\pi r^2\n]\nwhere (\\alpha + \\beta) is (a sum)')).toEqual([
      ['A = \\pi r^2', true],
      ['\\alpha + \\beta', false],
    ]);
    expect(texts('$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$')).toEqual([
      ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', true],
    ]);
  });

  it('leaves shell variables, prices and calls alone', () => {
    expect(texts('echo "$HOME" "$PATH"; cost $5 and $10; awk \'{print $1}\'')).toEqual([]);
    expect(texts('f(\\n) and print(\\alpha) and [x] and \\$a_1\\$')).toEqual([]);
    expect(texts('$x$ alone, $ a_1 $ spaced, $a_1$5')).toEqual([]);
    // Not across an empty line.
    expect(texts('$$a^2\n\n$$ and $b_1\n\nc$')).toEqual([]);
  });
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
