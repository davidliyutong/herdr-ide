import { expect, test } from 'bun:test';
import { attachment, contentType, parseRange } from './serve.ts';

test('parseRange', () => {
  const cases: Array<[string, number, { start: number; length: number } | null]> = [
    ['bytes=0-', 100, { start: 0, length: 100 }],
    ['bytes=10-19', 100, { start: 10, length: 10 }],
    ['bytes=90-200', 100, { start: 90, length: 10 }],
    ['bytes=-10', 100, { start: 90, length: 10 }],
    ['bytes=-500', 100, { start: 0, length: 100 }],
    ['bytes=+5-', 100, { start: 5, length: 95 }],
    ['bytes=100-', 100, null],
    ['bytes=5-1', 100, null],
    ['bytes=0-1,5-6', 100, null],
    ['bytes=-0', 100, null],
    ['bytes=--5', 100, null],
    ['bytes=a-', 100, null],
    ['bytes=5', 100, null],
    ['items=0-1', 100, null],
    ['bytes=0-', 0, null],
  ];
  for (const [h, size, want] of cases) expect([h, size, parseRange(h, size)]).toEqual([h, size, want]);
});

test('content types are never active', () => {
  for (const name of ['x.html', 'x.htm', 'x.js', 'x.mjs', 'x.xhtml', 'X.HTML'])
    expect([name, contentType(name)]).toEqual([name, 'text/plain; charset=utf-8']);
  const cases: Record<string, string> = {
    'a.mp4': 'video/mp4',
    'a.ts': 'text/plain; charset=utf-8',
    'a.md': 'text/markdown; charset=utf-8',
    'a.pdf': 'application/pdf',
    'a.png': 'image/png',
    'a.txt': 'text/plain; charset=utf-8',
    'a.svg': 'image/svg+xml',
    '/d.ir/noext': 'application/octet-stream',
    'a.unknownext': 'application/octet-stream',
  };
  for (const [name, want] of Object.entries(cases)) expect([name, contentType(name)]).toEqual([name, want]);
});

test('attachment names as Go writes them', () => {
  expect(attachment('proj.zip')).toBe('attachment; filename=proj.zip');
  expect(attachment('notes é.md')).toBe("attachment; filename*=utf-8''notes%20%C3%A9.md");
  expect(attachment('my file "x".txt')).toBe('attachment; filename="my file \\"x\\".txt"');
  expect(attachment("it's (1).txt")).toBe('attachment; filename="it\'s (1).txt"');
});
