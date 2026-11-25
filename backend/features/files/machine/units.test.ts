import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '#machine/testing.ts';
import { revealCommand, systemProgram } from './reveal.ts';
import { escapePath, mountTop, mountTrash, trashFreedesktop, trashMac } from './trash.ts';
import { copyFile, copyTree, removeTree } from './tree.ts';
import { within } from './guard.ts';

const h = tempHome();
afterAll(() => h.remove());
let n = 0;
const fresh = () => {
  const d = join(h.home, `t${n++}`);
  mkdirSync(d);
  return d;
};
const write = (p: string, s: string) => writeFileSync(p, s);
const read = (p: string) => readFileSync(p, 'utf8');
const none = new AbortController().signal;

describe('removal', () => {
  test('a tree of more entries than one read, links removed and never followed', async () => {
    const root = fresh();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    write(join(outside, 'keep'), 'k');
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    for (let i = 0; i < 2500; i++) write(join(tree, 'a', `f${i}`), 'x');
    write(join(tree, 'a', 'b', 'deep'), 'd');
    symlinkSync(outside, join(tree, 'link'));
    symlinkSync(outside, join(tree, 'a', 'b', 'link'));
    await removeTree(none, tree);
    expect(existsSync(tree)).toBe(false);
    expect(read(join(outside, 'keep'))).toBe('k');
    // A file and a link alone.
    write(join(root, 'f'), 'f');
    symlinkSync(outside, join(root, 'l'));
    await removeTree(none, join(root, 'f'));
    await removeTree(none, join(root, 'l'));
    expect(existsSync(join(root, 'l'))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  test('a removal or a copy the core gave up on stops before the next entry or chunk', async () => {
    const root = fresh();
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    write(join(tree, 'sub', 'f'), 'x'.repeat(3 << 20));
    const ac = new AbortController();
    ac.abort(new Error('gave up'));
    await expect(removeTree(ac.signal, tree)).rejects.toThrow('gave up');
    expect(statSync(join(tree, 'sub', 'f')).size).toBe(3 << 20);
    const { error } = await copyTree(ac.signal, tree, join(root, 'copy'));
    expect((error as Error).message).toBe('gave up');
    await expect(copyFile(ac.signal, join(tree, 'sub', 'f'), join(root, 'one'), 0o644)).rejects.toThrow('gave up');
  });
});

describe('the trash', () => {
  test('freedesktop.org: an info file claims a unique name; another mount keeps paths relative to its top', () => {
    const home = fresh();
    const dir = join(home, '.local', 'share', 'Trash');
    mkdirSync(join(home, '.local', 'share'), { recursive: true });
    const now = new Date(2026, 2, 4, 5, 6, 7);
    const got: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = join(home, 'my notes.txt');
      write(p, 'n');
      got.push(trashFreedesktop(dir, '', p, now));
      expect(existsSync(p)).toBe(false);
    }
    expect(got).toEqual([`${dir}/files/my notes.txt`, `${dir}/files/my notes.2.txt`]);
    expect(read(`${dir}/info/my notes.2.txt.trashinfo`)).toBe(
      `[Trash Info]\nPath=${home}/my%20notes.txt\nDeletionDate=2026-03-04T05:06:07\n`,
    );
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const top = fresh();
    mkdirSync(`${top}/d`);
    write(`${top}/d/f`, 'f');
    trashFreedesktop(`${top}/.Trash-1000`, top, `${top}/d/f`, now);
    expect(read(`${top}/.Trash-1000/info/f.trashinfo`)).toContain('\nPath=d/f\n');
    expect(escapePath('/a b/ü;,?!$&+:=@~')).toBe('/a%20b/%C3%BC%3B%2C%3F%21$&+:=@~');
  });

  test('macOS: its own name, then "stem 2.ext"', () => {
    const home = fresh();
    const dir = join(home, '.Trash');
    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(home, 'a.tar.gz');
      write(p, 'x');
      got.push(trashMac(dir, p).slice(dir.length + 1));
    }
    expect(got).toEqual(['a.tar.gz', 'a.tar 2.gz', 'a.tar 3.gz']);
  });

  test('the trash at the top of another mount is made private, and one planted by someone else is not used', () => {
    const uid = process.getuid!();
    const name = `.Trash-${uid}`;
    let top = fresh();
    const dir = mountTrash(top, uid);
    expect(dir).toBe(join(top, name));
    for (const d of [dir, `${dir}/files`, `${dir}/info`]) expect(statSync(d).mode & 0o777).toBe(0o700);
    const plants: Record<string, (top: string) => void> = {
      'a link': (t) => symlinkSync(fresh(), join(t, name)),
      'open to others': (t) => {
        mkdirSync(join(t, name), 0o700);
        chmodSync(join(t, name), 0o777);
      },
      'files a link': (t) => {
        mkdirSync(join(t, name), 0o700);
        symlinkSync(fresh(), join(t, name, 'files'));
      },
      'info open to others': (t) => {
        mkdirSync(join(t, name, 'info'), { recursive: true, mode: 0o700 });
        chmodSync(join(t, name, 'info'), 0o755);
      },
    };
    for (const [what, plant] of Object.entries(plants)) {
      const t = fresh();
      plant(t);
      expect(
        `${what}: ${(() => {
          try {
            return mountTrash(t, uid);
          } catch {
            return 'refused';
          }
        })()}`,
      ).toBe(`${what}: refused`);
    }
    // An administrator's .Trash (sticky): the user's directory in it.
    top = fresh();
    mkdirSync(`${top}/.Trash`);
    chmodSync(`${top}/.Trash`, 0o1777);
    expect(mountTrash(top, uid)).toBe(join(top, '.Trash', String(uid)));
    // Without the sticky bit, or a link to one: the user's own.
    top = fresh();
    mkdirSync(`${top}/.Trash`, 0o777);
    expect(mountTrash(top, uid)).toBe(join(top, name));
    top = fresh();
    const sticky = fresh();
    chmodSync(sticky, 0o1777);
    symlinkSync(sticky, `${top}/.Trash`);
    expect(mountTrash(top, uid)).toBe(join(top, name));
  });

  test("the top of a mount is looked for along the path's real directory", () => {
    const real = realpathSync(fresh());
    write(`${real}/f`, 'f');
    const link = join(fresh(), 'l');
    symlinkSync(real, link);
    const top = mountTop(`${link}/f`);
    expect(within(real, top)).toBe(true);
  });
});

describe('the file manager', () => {
  test("each system's command: the program by its absolute path, the path an argument of its own, xdg-open given a folder with a slash", () => {
    const bin = fresh();
    const xdg = join(bin, 'xdg-open');
    writeFileSync(xdg, '#!/bin/sh\n', { mode: 0o755 });
    const dirs = [join(bin, 'none'), bin];
    const cases: Array<[string, string, boolean, string[] | null]> = [
      ['darwin', '/Users/me/a b;$(x).txt', false, ['/usr/bin/open', '-R', '/Users/me/a b;$(x).txt']],
      ['darwin', '/Users/me/proj', true, ['/usr/bin/open', '-R', '/Users/me/proj']],
      ['linux', '/home/me/a.txt', false, [xdg, '/home/me/']],
      ['linux', '/home/me/proj', true, [xdg, '/home/me/proj/']],
      ['linux', '/', true, [xdg, '/']],
      ['linux', '/a.txt', false, [xdg, '/']],
      ['win32', 'C:\\x', false, null],
    ];
    for (const [os, p, dir, want] of cases) expect(revealCommand(os, p, dir, dirs)).toEqual(want);
    // None in the system's directories, whatever PATH holds; a file there
    // that is not executable is none either.
    expect(revealCommand('linux', '/home/me', true, [fresh()])).toBeNull();
    const plain = fresh();
    writeFileSync(join(plain, 'xdg-open'), '#!/bin/sh\n', { mode: 0o644 });
    expect(systemProgram('xdg-open', [plain])).toBe('');
    expect(readdirSync(plain)).toEqual(['xdg-open']);
  });
});
