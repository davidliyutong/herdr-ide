import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_DEPTH, MAX_FILE_SIZE, read, type Host } from './sshconfig.ts';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'sshconfig-'));
  temps.push(d);
  return d;
};

/** Puts files under home, creating directories. */
function write(home: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    const p = join(home, name);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, body, { mode: 0o600 });
  }
}

describe('read', () => {
  test('aliases', async () => {
    const home = tempDir();
    write(home, {
      '.ssh/config': `# Comments, keywords in any case, = and quotes.
Include conf.d/*.conf ~/.ssh/extra "${join(home, 'abs.conf')}"
Include missing.conf

HOST gpu gpu-b *.corp !bastion web?
  hostname 10.0.0.5
  USER yutong
  IdentityFile ~/.ssh/id_secret
  ProxyCommand ssh -W %h:%p jump
Host=gpu
  HostName other.example
  User other

Match host gpu exec "true"
  User matched
Host nus-ws-1   # the lab's
  HostName=%h.lab.example
  User "li yu"
Host *
  User everyone
\tHost\ttabbed
\t  User\ttab
`,
      '.ssh/conf.d/a.conf': 'Host from-a\n  HostName a.example\n',
      '.ssh/conf.d/b.conf': 'Host from-b GPU\n  User b\n',
      '.ssh/conf.d/c.txt': 'Host not-included\n',
      '.ssh/extra': 'Host extra\n',
      'abs.conf': 'Host absolute\n',
    });
    const got = await read(home);
    expect(got).toEqual([
      { alias: 'from-a', hostname: 'a.example' },
      // GPU is the config's gpu, spelled as it was first named; its User
      // comes from here, the first one given to it, its HostName from the
      // config's first Host block.
      { alias: 'from-b', user: 'b' },
      { alias: 'GPU', user: 'b', hostname: '10.0.0.5' },
      { alias: 'extra' },
      { alias: 'absolute' },
      { alias: 'gpu-b', hostname: '10.0.0.5', user: 'yutong' },
      { alias: 'nus-ws-1', hostname: 'nus-ws-1.lab.example' },
      { alias: 'tabbed', user: 'tab' },
    ]);
    // A user name with a space is not one this reader passes on; key paths
    // and proxy commands are never read.
    for (const h of got) {
      for (const v of [h.alias, h.hostname ?? '', h.user ?? '']) {
        expect(v).not.toContain('id_secret');
        expect(v).not.toContain('ssh -W');
        expect(v).not.toContain(' ');
      }
    }
    // The JSON's members in Go's order, whichever the file gave first.
    expect(JSON.stringify(got[2])).toBe('{"alias":"GPU","hostname":"10.0.0.5","user":"b"}');
  });

  test('missing and bounded', async () => {
    expect(await read(tempDir())).toEqual([]);
    let home = tempDir();
    // An Include of itself, a file too large, a directory.
    write(home, {
      '.ssh/config': 'Include config big dir\nHost ok\n',
      '.ssh/big': 'Host big\n' + '# padding\n'.repeat(Math.floor(MAX_FILE_SIZE / 10) + 1),
    });
    mkdirSync(join(home, '.ssh', 'dir'), { mode: 0o700 });
    expect(await read(home)).toEqual([{ alias: 'ok' }]);
    // Includes nest at most MAX_DEPTH deep.
    const files: Record<string, string> = { '.ssh/config': 'Include n1\nHost top\n' };
    for (let i = 1; i <= MAX_DEPTH + 3; i++) files[`.ssh/n${i}`] = `Include n${i + 1}\nHost h${i}\n`;
    home = tempDir();
    write(home, files);
    const got = await read(home);
    expect(got.length).toBe(MAX_DEPTH + 1);
    expect(got[got.length - 1]!.alias).toBe('top');
  });

  // A FIFO named by an Include would block a reader that opened it: it is
  // skipped, as every file that is not a regular one.
  test.skipIf(process.platform === 'win32')('skips special files', async () => {
    const home = tempDir();
    write(home, { '.ssh/config': 'Include fifo /dev/zero\nHost after\n' });
    try {
      execFileSync('mkfifo', ['-m', '600', join(home, '.ssh', 'fifo')]);
    } catch {
      return; // no mkfifo: nothing to check
    }
    expect(await read(home)).toEqual([{ alias: 'after' }]);
  });

  // Includes resolve as ssh's glob(3) does: sorted matches, no file
  // starting with a dot for '*', nothing for another user's home.
  test.skipIf(process.platform === 'win32')('include globs', async () => {
    const home = tempDir();
    write(home, {
      '.ssh/config': 'Include d/* c/[ab].conf ~root/.ssh/config ~/.ssh/c/z.conf\n',
      '.ssh/d/b': 'Host d-b\n',
      '.ssh/d/.hidden': 'Host d-hidden\n',
      '.ssh/d/a': 'Host d-a\n',
      '.ssh/c/a.conf': 'Host c-a\n',
      '.ssh/c/c.conf': 'Host c-c\n',
      '.ssh/c/z.conf': 'Host c-z\n',
    });
    expect((await read(home)).map((h: Host) => h.alias)).toEqual(['d-a', 'd-b', 'c-a', 'c-z']);
  });

  // An Include inside a Host block applies the block to the included
  // file's lines until that file's own Host line; the including file's
  // block goes on after it.
  test('blocks across includes', async () => {
    const home = tempDir();
    write(home, {
      '.ssh/config': 'Host a\nInclude inc\nUser after\n',
      '.ssh/inc': 'HostName a.example\nHost b\nUser bee\n',
    });
    expect(await read(home)).toEqual([
      { alias: 'a', hostname: 'a.example', user: 'after' },
      { alias: 'b', user: 'bee' },
    ]);
  });
});
