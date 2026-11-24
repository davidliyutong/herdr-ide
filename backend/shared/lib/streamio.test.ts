import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EOFError, Reader } from './streamio.ts';

function feed(...parts: string[]): PassThrough {
  const p = new PassThrough();
  (async () => {
    for (const s of parts) {
      p.write(s);
      await Bun.sleep(1);
    }
    p.end();
  })();
  return p;
}

test('lines across chunks, then exact bytes, then the rest for other code', async () => {
  const r = new Reader(feed('{"a"', ':1}\n{"b":2}\nxy', 'zREST', 'OF IT'));
  expect(JSON.parse(await r.line(100))).toEqual({ a: 1 });
  expect(JSON.parse(await r.line(100))).toEqual({ b: 2 });
  expect((await r.exactly(3)).toString()).toBe('xyz');
  const s = r.release();
  let rest = '';
  for await (const c of s) rest += c;
  expect(rest).toBe('REST' + 'OF IT');
});

test('a line at the end without a newline, then EOF', async () => {
  const r = new Reader(feed('one\ntwo'));
  expect(await r.line(10)).toBe('one');
  expect(await r.line(10)).toBe('two');
  expect(r.line(10)).rejects.toBeInstanceOf(EOFError);
});

test('exactly fails at a short stream', async () => {
  const r = new Reader(feed('ab'));
  const e = await r.exactly(3).catch((e) => e);
  expect(e).toBeInstanceOf(EOFError);
  expect((e as EOFError).unexpected).toBe(true);
});

test('lines are bounded', async () => {
  const r = new Reader(feed('x'.repeat(50), 'y'.repeat(50), '\n'));
  expect(r.line(64)).rejects.toThrow('line too long');
});

test('release hands on what was read ahead, also after the stream ended', async () => {
  const ended = new PassThrough();
  ended.end('head\nbody');
  const r1 = new Reader(ended);
  expect(await r1.line(10)).toBe('head');
  let got = '';
  for await (const c of r1.release()) got += c;
  expect(got).toBe('body');

  const live = new PassThrough();
  live.write('head\nfirst ');
  const r2 = new Reader(live);
  expect(await r2.line(10)).toBe('head');
  const s = r2.release();
  setTimeout(() => live.end('second'), 5);
  got = '';
  for await (const c of s) got += c;
  expect(got).toBe('first second');
});
