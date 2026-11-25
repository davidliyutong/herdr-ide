import { afterAll, describe, expect, test } from 'bun:test';
import { constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { tempHome } from '../testing.ts';
import {
  AT_REMOVEDIR,
  linkGuard,
  openAtAsync,
  openDirAt,
  openNoLinks,
  openNoLinksAsync,
  readDirAt,
  renameNoReplace,
  tryLock,
  unlinkAt,
  closeQuietly,
} from './fs.ts';
import { parentOf, peerCred, socketFd } from './proc.ts';
import { darwin, libcPath, linux } from './libc.ts';

const h = tempHome();
afterAll(() => h.remove());

describe('peer credentials', () => {
  test('of an accepted connection: this process and user', async () => {
    const p = join(h.home, 'peer.sock');
    const got = new Promise<{ pid: number; uid: number }>((resolve, reject) => {
      const srv = createServer((s) => {
        try {
          resolve(peerCred(socketFd(s)));
        } catch (e) {
          reject(e);
        } finally {
          s.destroy();
          srv.close();
        }
      });
      srv.listen(p, () => connect(p).on('error', () => {}));
    });
    expect(await got).toEqual({ pid: process.pid, uid: process.getuid!() });
  });
});

describe('processes', () => {
  test("a process's parent and name; none for one that is gone", () => {
    const me = parentOf(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.name.length).toBeGreaterThan(0);
    expect(parentOf(2 ** 22 + 12345)).toBeNull();
  });
});

describe('locks', () => {
  test('an exclusive lock is held against another process', () => {
    const p = join(h.home, 'lock');
    const fd = openSync(p, 'a+', 0o600);
    try {
      expect(tryLock(fd)).toBe(true);
      const child = Bun.spawnSync([
        process.execPath,
        '-e',
        `const { tryLock } = await import(${JSON.stringify(join(import.meta.dir, 'fs.ts'))}); const fd = require('fs').openSync(${JSON.stringify(p)}, 'r'); process.exit(tryLock(fd) ? 0 : 3);`,
      ]);
      expect(child.exitCode).toBe(3);
    } finally {
      closeSync(fd);
    }
  });
});

describe('opening without links', () => {
  test('a link anywhere on the path is refused (where the system can), the last one always', () => {
    const real = join(h.home, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'f'), 'ok');
    symlinkSync(real, join(h.home, 'link'));
    symlinkSync(join(real, 'f'), join(h.home, 'flink'));
    const fd = openNoLinks(join(real, 'f'), constants.O_RDONLY);
    expect(readFileSync(fd, 'utf8')).toBe('ok');
    closeSync(fd);
    expect(() => openNoLinks(join(h.home, 'flink'), constants.O_RDONLY | constants.O_NOFOLLOW)).toThrow(/ELOOP/);
    if (linkGuard.refusedEverywhere) expect(() => openNoLinks(join(h.home, 'link', 'f'), constants.O_RDONLY)).toThrow(/ELOOP/);
  });

  test('creates with its mode', () => {
    const fd = openNoLinks(join(h.home, 'new'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
    expect(require('node:fs').statSync(join(h.home, 'new')).mode & 0o777).toBe(0o600);
  });

  test('a directory below another, never through a link; removal relative to it', () => {
    const top = join(h.home, 'top');
    mkdirSync(join(top, 'sub'), { recursive: true });
    writeFileSync(join(top, 'sub', 'x'), '');
    symlinkSync(join(top, 'sub'), join(top, 'via'));
    const dir = openNoLinks(top, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(() => openDirAt(dir, top, 'via')).toThrow(/ELOOP|ENOTDIR/);
      const sub = openDirAt(dir, top, 'sub');
      expect(readDirAt(sub, join(top, 'sub'))).toEqual(['x']);
      unlinkAt(sub, 'x', 0);
      closeQuietly(sub);
      unlinkAt(dir, 'sub', AT_REMOVEDIR);
      expect(existsSync(join(top, 'sub'))).toBe(false);
      expect(() => unlinkAt(dir, 'missing', 0)).toThrow(/ENOENT/);
    } finally {
      closeQuietly(dir);
    }
  });
});

// The opens that wait in the runtime's pool, not on the node's thread.
describe('opening without links, asynchronously', () => {
  test('a link anywhere on the path is refused, the descriptor closed; a FIFO does not wait', async () => {
    const real = join(h.home, 'areal');
    mkdirSync(real);
    writeFileSync(join(real, 'f'), 'ok');
    symlinkSync(real, join(h.home, 'alink'));
    symlinkSync(join(real, 'f'), join(h.home, 'aflink'));
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    const fh = await openNoLinksAsync(join(real, 'f'), flags);
    expect((await fh.readFile()).toString()).toBe('ok');
    await fh.close();
    await expect(openNoLinksAsync(join(h.home, 'aflink'), flags)).rejects.toThrow(/ELOOP/);
    await expect(openNoLinksAsync(join(h.home, 'alink', 'f'), flags)).rejects.toThrow(/ELOOP/);
    expect(Bun.spawnSync(['mkfifo', join(h.home, 'afifo')]).exitCode).toBe(0);
    const fifo = await openNoLinksAsync(join(h.home, 'afifo'), flags);
    expect((await fifo.stat()).isFIFO()).toBe(true);
    await fifo.close();
  });

  test('a name in a directory open, never a link at the name, the directory the one held', async () => {
    const top = join(h.home, 'atop');
    mkdirSync(join(top, 'sub'), { recursive: true });
    writeFileSync(join(top, 'sub', 'x'), 'x1');
    symlinkSync(join(top, 'sub', 'x'), join(top, 'sub', 'lx'));
    const dir = await open(join(top, 'sub'), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const flags = constants.O_RDONLY | constants.O_NONBLOCK;
      const x = await openAtAsync(dir, join(top, 'sub'), 'x', flags);
      expect((await x.readFile()).toString()).toBe('x1');
      await x.close();
      await expect(openAtAsync(dir, join(top, 'sub'), 'lx', flags)).rejects.toThrow(/ELOOP/);
      for (const bad of ['', '.', '..', 'a/b']) await expect(openAtAsync(dir, join(top, 'sub'), bad, flags)).rejects.toThrow(/EINVAL/);
      if (linux) {
        // The directory swapped for another after it was opened: the name
        // is still read in the one held.
        renameSync(join(top, 'sub'), join(top, 'old'));
        mkdirSync(join(top, 'sub'));
        writeFileSync(join(top, 'sub', 'x'), 'x2');
        const held = await openAtAsync(dir, join(top, 'sub'), 'x', flags);
        expect((await held.readFile()).toString()).toBe('x1');
        await held.close();
      }
    } finally {
      await dir.close();
    }
  });
});

describe('renaming without replacing', () => {
  test('refuses a target that exists; renames onto a free name', () => {
    const a = join(h.home, 'a');
    const b = join(h.home, 'b');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    expect(() => renameNoReplace(a, b)).toThrow(/EEXIST/);
    expect(readFileSync(b, 'utf8')).toBe('b');
    renameNoReplace(a, join(h.home, 'c'));
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(join(h.home, 'c'), 'utf8')).toBe('a');
  });
});

describe('the C library', () => {
  test.skipIf(darwin)('is the one the process has mapped, not whatever /lib holds', () => {
    const glibc = [
      'aaaab0000000-aaaab0010000 r-xp 00000000 00:2c 123 /usr/local/bin/bun',
      'ffff80000000-ffff80180000 r-xp 00000000 00:2c 456 /usr/lib/aarch64-linux-gnu/libc.so.6',
      'ffff80200000-ffff80230000 r-xp 00000000 00:2c 789 /usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1',
    ].join('\n');
    // A glibc process on a system with musl's package (/lib/ld-musl-* there).
    expect(libcPath(glibc)).toBe('libc.so.6');
    const musl = [
      '55555000-55556000 r-xp 00000000 08:01 1 /usr/local/bin/bun',
      '7f0000000000-7f0000090000 r-xp 00000000 08:01 2 /lib/ld-musl-x86_64.so.1',
    ].join('\n');
    expect(libcPath(musl)).toBe('/lib/ld-musl-x86_64.so.1');
    expect(libcPath(null)).toBe('libc.so.6');
    // This process's own.
    expect(libcPath()).toMatch(/^(libc\.so\.6|\/.*ld-musl-.*)$/);
  });
});
