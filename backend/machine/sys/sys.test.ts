import { afterAll, describe, expect, test } from 'bun:test';
import { constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { tempHome } from '../testing.ts';
import { AT_REMOVEDIR, linkGuard, openDirAt, openNoLinks, readDirAt, renameNoReplace, tryLock, unlinkAt, closeQuietly } from './fs.ts';
import { parentOf, peerCred, socketFd } from './proc.ts';

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
