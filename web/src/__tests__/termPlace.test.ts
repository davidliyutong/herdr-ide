// Where a terminal's user is (term/place.ts): the shell's directory as it
// changes; a program that walks a tree is not followed, one that stays
// where it started is, after a moment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { follows, nextPlace, settled, SETTLE_MS, type Place } from '../term/place';
import { FakeCore } from './fakeTerms';

const term = (foreground?: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  FakeCore.term('t1', { cwd: '/start', pid: 100, ...(foreground === undefined ? {} : { foreground }), ...extra });
const zsh = (cwd: string) => ({ pid: 100, name: '-zsh', cwd });
const tar = (cwd: string) => ({ pid: 200, name: 'bsdtar', cwd });

describe('a terminal’s place', () => {
  it('follows shells and the terminal’s file managers by name', () => {
    for (const n of ['zsh', '-zsh', '/bin/bash', 'fish', 'pwsh.exe', 'yazi', 'ranger']) expect(follows(n), n).toBe(true);
    for (const n of ['tar', 'bsdtar', 'node', 'claude', 'vim', 'find', '']) expect(follows(n), n).toBe(false);
  });

  it('is the shell’s directory as it changes, and where the terminal started before that', () => {
    let p = nextPlace(undefined, term(), 0);
    expect(p.dir).toBe('/start');
    p = nextPlace(p, term(zsh('/a')), 0);
    expect(p).toEqual({ dir: '/a', pid: 100 });
    expect(nextPlace(p, term(zsh('/a/b')), 0).dir).toBe('/a/b');
  });

  it('stays where the shell was while a program walks a tree, and is the shell’s again after', () => {
    let p: Place = nextPlace(undefined, term(zsh('/proj')), 0);
    // First seen where the shell is: then it moves, many times.
    p = nextPlace(p, term(tar('/proj')), 100);
    for (const [i, d] of ['/proj/yyy', '/proj/yyy/a', '/proj/yyy/a/b', '/proj/yyy/c'].entries()) {
      p = nextPlace(p, term(tar(d)), 600 + i * 500);
      expect(settled(p, 60_000).dir, d).toBe('/proj');
    }
    expect(nextPlace(p, term(zsh('/proj')), 9000)).toEqual({ dir: '/proj', pid: 100 });
  });

  it('does not take a walking program’s directory when it was first seen inside the tree', () => {
    let p: Place = nextPlace(undefined, term(zsh('/proj')), 0);
    p = nextPlace(p, term(tar('/proj/yyy/a')), 400);
    // Not yet: it may be on its way.
    expect(p.dir).toBe('/proj');
    expect(settled(p, 400 + SETTLE_MS - 1).dir).toBe('/proj');
    p = nextPlace(p, term(tar('/proj/yyy/b')), 900);
    expect(p).toEqual({ dir: '/proj', pid: 200, roams: true });
    // Staying somewhere long (a large file) later does not make that the place.
    p = nextPlace(p, term(tar('/proj/yyy/big')), 1400);
    expect(settled(p, 600_000).dir).toBe('/proj');
  });

  it('takes the directory of a program that stays where it started (cd project && agent), after a moment', () => {
    let p: Place = nextPlace(undefined, term(zsh('/home/u')), 0);
    p = nextPlace(p, term({ pid: 300, name: 'claude', cwd: '/home/u/project' }), 1000);
    expect(p.dir).toBe('/home/u');
    expect(settled(p, 1000 + SETTLE_MS - 1)).toBe(p);
    p = settled(p, 1000 + SETTLE_MS);
    expect(p).toEqual({ dir: '/home/u/project', pid: 300 });
    // A move it makes later is not followed.
    expect(nextPlace(p, term({ pid: 300, name: 'claude', cwd: '/elsewhere' }), 90_000).dir).toBe('/home/u/project');
    // A shell it starts is.
    expect(nextPlace(p, term({ pid: 301, name: 'bash', cwd: '/tmp' }), 90_000).dir).toBe('/tmp');
  });

  it('stays where the user was when the core cannot read the foreground program', () => {
    let p: Place = nextPlace(undefined, term(zsh('/proj')), 0);
    p = nextPlace(p, term(null), 100);
    expect(p.dir).toBe('/proj');
    p = nextPlace(p, term({ pid: 400, name: 'sudo' }), 200);
    expect(p.dir).toBe('/proj');
  });

  it('is where a program is when nothing was known before (a page opened while it runs)', () => {
    const p = nextPlace(undefined, term(tar('/proj/yyy/a')), 0);
    expect(p).toEqual({ dir: '/proj/yyy/a', pid: 200 });
    expect(nextPlace(p, term(tar('/proj/yyy/b')), 500).dir).toBe('/proj/yyy/a');
  });
});

describe('the model’s directory of a terminal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the shell, not tar, and an agent started in another directory once it stayed there', async () => {
    const core = new FakeCore();
    core.machine('m1', [FakeCore.term('t1', { cwd: '/home/u', pid: 100, foreground: zsh('/proj') })]);
    const model = core.install();
    model.subscribe('m1');
    await vi.advanceTimersByTimeAsync(0);
    expect(model.directory('m1', 't1')).toBe('/proj');

    core.event('m1', 'foreground', 't1', tar('/proj'));
    for (const d of ['/proj/yyy', '/proj/yyy/a', '/proj/yyy/b']) {
      core.event('m1', 'foreground', 't1', tar(d));
      await vi.advanceTimersByTimeAsync(500);
      expect(model.directory('m1', 't1'), d).toBe('/proj');
    }
    await vi.advanceTimersByTimeAsync(10 * SETTLE_MS);
    expect(model.directory('m1', 't1')).toBe('/proj');
    core.event('m1', 'foreground', 't1', zsh('/proj'));
    expect(model.directory('m1', 't1')).toBe('/proj');

    // cd sub && claude: the place once it stayed there, and the page is told.
    core.event('m1', 'foreground', 't1', { pid: 300, name: 'claude', cwd: '/proj/sub' });
    expect(model.directory('m1', 't1')).toBe('/proj');
    let told = 0;
    const off = (await import('../state/terms')).useTerms.subscribe(() => told++);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(model.directory('m1', 't1')).toBe('/proj/sub');
    expect(told).toBeGreaterThan(0);
    off();

    // Gone with its terminal.
    core.event('m1', 'removed', 't1');
    expect(model.directory('m1', 't1')).toBeUndefined();
  });
});
