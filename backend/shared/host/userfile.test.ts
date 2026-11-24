import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooks, poll, read, sameSig, stat, write } from './userfile.ts';

const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(join(tmpdir(), 'userfile-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const original = { ...hooks };
afterEach(() => Object.assign(hooks, original));

// A written file is replaced whole and read back; no temporary file is
// left beside it. The permissions are checked on Linux and macOS.
test('TestWriteReplaces', () => {
  const dir = join(temp(), 'conf', 'app');
  const path = join(dir, 'settings.json');
  for (const body of ['{"a":1}', '{"a":22}']) {
    const sig = write(path, body);
    expect(sig.exists).toBe(true);
    expect(sig.size).toBe(body.length);
    const got = read(path);
    expect(got.data?.toString()).toBe(body);
    expect(got.sig.size).toBe(sig.size);
    expect(sameSig(got.sig, sig)).toBe(true);
  }
  expect(fs.readdirSync(dir)).toHaveLength(1);
  const gone = read(join(dir, 'missing.json'));
  expect(gone.data).toBeNull();
  expect(gone.sig.exists).toBe(false);
});

// The new content is flushed to disk before it replaces the file, and the
// directory after the rename; a content that cannot be flushed replaces
// nothing and leaves no temporary file.
test('TestWriteIsDurable', () => {
  const dir = join(temp(), 'conf');
  const path = join(dir, 'vault.json');
  const order: string[] = [];
  hooks.syncFile = (fd, tmp) => {
    if (fs.existsSync(path)) expect(fs.readFileSync(path, 'utf8')).toBe('{"a":1}');
    order.push('file:' + tmp.slice(dir.length + 1));
    original.syncFile(fd, tmp);
  };
  hooks.syncDir = (d) => {
    expect(fs.readFileSync(path, 'utf8')).not.toBe(''); // flushed after the rename
    order.push('dir:' + d);
    original.syncDir(d);
  };
  write(path, '{"a":1}');
  expect(order).toHaveLength(2);
  expect(order[0].startsWith('file:.vault.json-')).toBe(true);
  expect(order[1]).toBe('dir:' + dir);

  hooks.syncFile = () => {
    throw new Error('EINVAL');
  };
  expect(() => write(path, '{"a":2}')).toThrow('EINVAL');
  expect(read(path).data?.toString()).toBe('{"a":1}');
  expect(fs.readdirSync(dir)).toHaveLength(1);
});

// A directory that cannot be flushed does not fail a write that replaced
// the file.
test('a directory not flushed', () => {
  const path = join(temp(), 'machines.json');
  hooks.syncDir = () => {
    throw new Error('EIO');
  };
  expect(write(path, '{}').exists).toBe(true);
  expect(fs.readFileSync(path, 'utf8')).toBe('{}');
});

// A signature changes with a write of another size or time, and a file that
// cannot be read counts as missing.
test('signatures', () => {
  const path = join(temp(), 'k.json');
  expect(stat(path).exists).toBe(false);
  const a = write(path, '[]');
  const b = write(path, '[1]');
  expect(sameSig(a, b)).toBe(false);
  expect(sameSig(stat(path), b)).toBe(true);
});

// poll calls check until its signal ends.
test('poll', async () => {
  const ac = new AbortController();
  let n = 0;
  const done = poll(ac.signal, 5, () => {
    if (++n === 3) ac.abort();
  });
  await done;
  const after = n;
  await new Promise((r) => setTimeout(r, 30));
  expect(n).toBe(after);
  expect(after).toBe(3);
});

describe.skipIf(process.platform === 'win32')('unix', () => {
  // A written file is private (0600) and replaced whole: no temporary file
  // is left beside it, and a reader holding the old file keeps the old
  // content.
  test('TestWriteIsPrivateAndAtomic', () => {
    const dir = join(temp(), 'conf', 'app');
    const path = join(dir, 'settings.json');
    const sig = write(path, '{"a":1}');
    expect(sig.exists).toBe(true);
    expect(sig.size).toBe(7);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const old = fs.openSync(path, 'r');
    try {
      fs.chmodSync(path, 0o644); // edited by hand with another mode
      write(path, '{"a":2}');
      expect(read(path).data?.toString()).toBe('{"a":2}');
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      const buf = Buffer.alloc(16);
      const n = fs.readSync(old, buf);
      expect(buf.subarray(0, n).toString()).toBe('{"a":1}');
    } finally {
      fs.closeSync(old);
    }
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(read(join(dir, 'missing.json')).data).toBeNull();
  });

  // A directory of the user's that others may read is made 0700 by the
  // next write; a link to a directory is left as it is.
  test('TestWriteTightensItsDirectory', () => {
    const base = temp();
    const dir = join(base, 'app');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    write(join(dir, 'keybindings.json'), '[]');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    const target = join(base, 'elsewhere');
    fs.mkdirSync(target);
    fs.chmodSync(target, 0o755);
    const link = join(base, 'linked');
    fs.symlinkSync(target, link);
    write(join(link, 'machines.json'), '{}');
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(fs.statSync(join(target, 'machines.json')).mode & 0o777).toBe(0o600);
  });
});
