import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { file, verify } from './checksum.ts';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'checksum-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('TestFileAndVerify', async () => {
  const dir = temp();
  const path = join(dir, 'f');
  writeFileSync(path, 'abc', { mode: 0o600 });
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  expect(await file(path)).toBe(abc);
  await verify(path, abc);
  await expect(verify(path, '0'.repeat(64))).rejects.toThrow('does not match');
  await expect(verify(join(dir, 'missing'), abc)).rejects.toThrow();
});

// A file larger than a stream's chunk is hashed whole.
test('large file', async () => {
  const path = join(temp(), 'big');
  const data = Buffer.alloc(3 << 20, 7);
  writeFileSync(path, data);
  const want = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  expect(await file(path)).toBe(want);
});
