// The command line host's own logic: the launcher's hello, the desktop
// app's cookie, which machines a run connects.
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { SLUG } from '#shared/lib/brand.ts';
import type { Spec } from '#kernel/machines/spec.ts';
import { DESKTOP_COOKIE, desktopClient, readHello } from './parent.ts';
import { selectSpecs } from './serve.ts';

const TOKEN = 'a'.repeat(43);
const KEY = 'b'.repeat(43);

/** stdin with these bytes, left open. */
function stdin(text: string): PassThrough {
  const s = new PassThrough();
  s.write(text);
  return s;
}

describe('readHello', () => {
  test('the token and the verify key of the launch', async () => {
    expect(await readHello(stdin(`{"desktop_token":"${TOKEN}","verify_key":"${KEY}"}\n`))).toEqual({ token: TOKEN, verifyKey: KEY });
    expect(await readHello(stdin('{}\n'))).toEqual({ token: '', verifyKey: '' });
  });

  test('what follows the hello stays unread, and its end is seen', async () => {
    const s = stdin('{}\nmore');
    await readHello(s);
    const ended = new Promise((r) => s.once('end', r));
    s.end();
    await ended;
  });

  test('refuses a launcher gone before its hello, a long line, not JSON, malformed tokens', async () => {
    const gone = new PassThrough();
    gone.end();
    await expect(readHello(gone)).rejects.toThrow('launcher hello');
    await expect(readHello(stdin('x'.repeat(5000) + '\n'))).rejects.toThrow('launcher hello');
    await expect(readHello(stdin('nope\n'))).rejects.toThrow('launcher hello');
    await expect(readHello(stdin('{"desktop_token":"short"}\n'))).rejects.toThrow('malformed');
    await expect(readHello(stdin('{"desktop_token":"has space and more than thirty-two chars"}\n'))).rejects.toThrow('malformed');
    // The verify key is not the token.
    await expect(readHello(stdin(`{"desktop_token":"${TOKEN}","verify_key":"${TOKEN}"}\n`))).rejects.toThrow('malformed');
  });
});

describe('desktopClient', () => {
  const h = (cookie: string) => new Headers({ Cookie: cookie });

  test('the desktop app: a cookie of its name holds the token of the launch', () => {
    expect(DESKTOP_COOKIE).toBe(`${SLUG}-desktop`);
    expect(desktopClient(h(`${DESKTOP_COOKIE}=${TOKEN}`), TOKEN)).toBe(true);
    // A script may add cookies of the same name (for another path), which
    // come first: any that holds the token proves it.
    expect(desktopClient(h(`a=1; ${DESKTOP_COOKIE}=forged; ${DESKTOP_COOKIE}=${TOKEN}`), TOKEN)).toBe(true);
  });

  test('a browser: no token configured, no cookie, another value, another name', () => {
    expect(desktopClient(h(`${DESKTOP_COOKIE}=${TOKEN}`), '')).toBe(false);
    expect(desktopClient(new Headers(), TOKEN)).toBe(false);
    expect(desktopClient(h(`${DESKTOP_COOKIE}=${TOKEN}x`), TOKEN)).toBe(false);
    expect(desktopClient(h(`${DESKTOP_COOKIE}x=${TOKEN}`), TOKEN)).toBe(false);
  });
});

describe('selectSpecs', () => {
  const ssh = (id: string, label = id, target = id): Spec => ({ id, label, kind: 'ssh', target, enabled: true });
  const specs: Spec[] = [
    { id: 'local', label: 'Mac (local)', kind: 'local', enabled: true },
    ssh('a1', 'GPU', 'me@gpu'),
    ssh('b2', 'box', 'box'),
    ssh('x@y'),
  ];
  const ids = (l: Spec[]) => l.map((s) => s.id);

  test('every machine by default', () => {
    expect(ids(selectSpecs(specs, false, [], []))).toEqual(['local', 'a1', 'b2', 'x@y']);
  });

  test('--local-only keeps the local machine and the --ssh ones of this run', () => {
    expect(ids(selectSpecs(specs, true, [], []))).toEqual(['local']);
    expect(ids(selectSpecs(specs, true, ['x@y'], []))).toEqual(['local', 'x@y']);
  });

  test('--machine selects by id, label or target', () => {
    expect(ids(selectSpecs(specs, false, [], ['a1']))).toEqual(['a1']);
    expect(ids(selectSpecs(specs, false, [], ['box', 'me@gpu']))).toEqual(['a1', 'b2']);
    expect(ids(selectSpecs(specs, false, [], ['Mac (local)']))).toEqual(['local']);
  });
});
