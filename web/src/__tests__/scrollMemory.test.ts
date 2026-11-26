// Where a terminal was scrolled, found again in a new emulator.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ANCHOR_ROWS,
  findPlace,
  MAX_REMEMBERED,
  noteScroll,
  resetScrollMemory,
  takeScroll,
  type Place,
  type View,
} from '../vt/scrollMemory';

const LEN = 40;
/** A history of rows and the screens read from it. */
function history(rows: string[], len = LEN): View & { read: number } {
  const view = {
    read: 0,
    bar: () => ({ total: Math.max(rows.length, len), offset: 0, len }),
    rowsAt(offset: number) {
      view.read++;
      return rows.slice(offset, offset + len);
    },
  };
  return view;
}
const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `row ${from + i}`);
/** The place of a view of rows that starts at offset. */
const placeAt = (rows: string[], offset: number, len = LEN): Place => ({
  total: rows.length,
  offset,
  len,
  rows: rows.slice(offset, offset + len),
});

describe('scroll memory', () => {
  beforeEach(resetScrollMemory);

  it('notes a terminal scrolled up, once, by its first rows, and none left at the end', () => {
    const rows = numbered(1, 500);
    noteScroll('m', 't1', placeAt(rows, 120));
    noteScroll('m', 't2', placeAt(rows, 460));
    noteScroll('n', 't1', undefined);
    const got = takeScroll('m', 't1')!;
    expect(got).toMatchObject({ total: 500, offset: 120, len: LEN });
    expect(got.rows).toEqual(['row 121', 'row 122', 'row 123'].slice(0, ANCHOR_ROWS));
    expect(takeScroll('m', 't1')).toBeUndefined();
    expect(takeScroll('m', 't2')).toBeUndefined();
    expect(takeScroll('n', 't1')).toBeUndefined();
    // Scrolled back to the end since: the earlier place is forgotten.
    noteScroll('m', 't1', placeAt(rows, 120));
    noteScroll('m', 't1', placeAt(rows, 460));
    expect(takeScroll('m', 't1')).toBeUndefined();
  });

  it('forgets the terminals noted longest ago beyond its bound', () => {
    const rows = numbered(1, 100);
    for (let i = 0; i <= MAX_REMEMBERED; i++) noteScroll('m', `t${i}`, placeAt(rows, 10));
    expect(takeScroll('m', 't0')).toBeUndefined();
    expect(takeScroll('m', 't1')).toBeDefined();
    expect(takeScroll('m', `t${MAX_REMEMBERED}`)).toBeDefined();
  });

  it('finds the rows where they are: at once when nothing came, above when the program wrote, also in a history cut at the top', () => {
    const rows = numbered(1, 3000);
    const was = { ...placeAt(rows, 1335), rows: rows.slice(1335, 1335 + ANCHOR_ROWS) };
    // The same history: one screen read.
    const same = history(rows);
    expect(findPlace(was, same)).toBe(1335);
    expect(same.read).toBe(1);
    // The terminal core's history is cut at the top and 105 rows came since.
    const cut = history([...rows.slice(240), ...numbered(9000, 9104)]);
    const offset = findPlace(was, cut);
    expect(cut.rowsAt(offset)[0]).toBe('row 1336');
    // Only cut: as far from the end as it was, where the rows are.
    expect(history(rows.slice(500)).rowsAt(findPlace(was, history(rows.slice(500))))[0]).toBe('row 1336');
  });

  it('goes as far from the end as it was when the rows are gone or say nothing', () => {
    const rows = numbered(1, 3000);
    const was = { ...placeAt(rows, 1335), rows: rows.slice(1335, 1335 + ANCHOR_ROWS) };
    // The rows scrolled out of a short history: its top.
    expect(findPlace(was, history(numbered(5000, 5600)))).toBe(0);
    // Rows that wrap otherwise now: the same distance from the end.
    const other = history(rows.map((r) => `${r} wrapped`));
    expect(findPlace(was, other)).toBe(1335);
    // Blank rows are no mark: no search.
    const blank = history(rows);
    expect(findPlace({ ...was, rows: ['', ' ', ''] }, blank)).toBe(1335);
    expect(blank.read).toBe(0);
    // Nothing above the screen now: the end.
    expect(findPlace(was, history(numbered(1, 10)))).toBe(0);
  });
});
