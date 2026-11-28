// The hub-side tests run on Windows too (CI's desktop job, `make test-win`),
// where files have no POSIX permission bits: Node and Bun report 0o666 (or
// 0o444) whatever was asked. An assertion on a file's mode there says so
// on its line (`process.platform !== 'win32'`), or its test skips on
// Windows (`skipIf(process.platform === 'win32')`), else the Windows job
// fails on it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hubTestFiles } from './hubtests.ts';

const ROOT = join(import.meta.dir, '..');

/** The lines of text asserting a POSIX mode without a Windows guard. */
export function unguardedModeAsserts(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  // The test (or describe) a line is in skips on Windows.
  let skipping = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(test|it|describe)\b/.test(line)) skipping = /skipIf\([^)]*win32/.test(line);
    if (/\.mode\s*&\s*0o[0-7]+/.test(line) && /expect\(/.test(line) && !line.includes('win32') && !skipping) out.push(i + 1);
  }
  return out;
}

describe('the hub-side tests', () => {
  test('the files test:hub runs', () => {
    const files = hubTestFiles(ROOT);
    expect(files).toContain('kernel/config/settings/settings.test.ts');
    expect(files).toContain('features/vault/store.test.ts');
    expect(files.some((f) => f.includes('/machine/') || f.endsWith('/machine.test.ts'))).toBe(false);
  });

  test('assert POSIX modes only off Windows', () => {
    const found: string[] = [];
    for (const f of hubTestFiles(ROOT)) {
      for (const n of unguardedModeAsserts(readFileSync(join(ROOT, f), 'utf8'))) found.push(`${f}:${n}`);
    }
    expect(found).toEqual([]);
  });

  test('a guard on the line or a test that skips on Windows counts', () => {
    expect(unguardedModeAsserts(`test('x', () => {\n  expect(statSync(p).mode & 0o777).toBe(0o600);\n});`)).toEqual([2]);
    expect(unguardedModeAsserts(`  if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);`)).toEqual([]);
    expect(
      unguardedModeAsserts(`test.skipIf(process.platform === 'win32')('y', () => {\n  expect(st.mode & 0o777).toBe(0o600);\n});`),
    ).toEqual([]);
  });
});
