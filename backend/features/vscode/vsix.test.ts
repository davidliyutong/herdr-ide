import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vsixContentHash } from './vsix.ts';

// testdata/a.vsix and b.vsix hold the same files with other times (stored,
// deflated, a directory, out of order); the digests are the Go core's
// (vsixContentHash, before this core replaced it), so that a machine's
// marker holds for either core.
test('the content hash ignores the zip metadata, as the Go core', () => {
  const a = readFileSync(join(import.meta.dir, 'testdata', 'a.vsix'));
  const b = readFileSync(join(import.meta.dir, 'testdata', 'b.vsix'));
  expect(a.equals(b)).toBe(false);
  expect(vsixContentHash(a)).toBe('2964ebb14ff1f629');
  expect(vsixContentHash(b)).toBe('2964ebb14ff1f629');
  // Not a zip: the bytes themselves.
  expect(vsixContentHash(Buffer.from('not a zip'))).toBe('a3989126344744ef');
});
