import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFiles } from './find.ts';

const dirs: string[] = [];
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'veldr-find-'));
  dirs.push(root);
  mkdirSync(join(root, 'src/components'), { recursive: true });
  mkdirSync(join(root, 'src/utils'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, '.git/objects'), { recursive: true });
  mkdirSync(join(root, 'ignored_dir'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored_dir/\n*.log\nsecret.txt\n');
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, 'debug.log'), 'noise\n');
  writeFileSync(join(root, 'secret.txt'), 'secret\n');
  writeFileSync(join(root, 'src/index.ts'), 'export {}\n');
  writeFileSync(join(root, 'src/components/Button.tsx'), 'export const Button = 1;\n');
  writeFileSync(join(root, 'src/components/ButtonGroup.tsx'), 'export const ButtonGroup = 1;\n');
  writeFileSync(join(root, 'src/utils/btnHelper.ts'), 'export const h = 1;\n');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), '');
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, 'ignored_dir/foo.ts'), '');
  symlinkSync(join(root, 'README.md'), join(root, 'link.md'));
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('findFiles', () => {
  test('respects .gitignore, skips node_modules/.git/symlinks, and ranks matches', async () => {
    const root = makeTree();
    const all = await findFiles({ dir: root });
    const rels = all.matches.map((m) => m.rel);
    expect(rels).toContain('README.md');
    expect(rels).toContain('src/components/Button.tsx');
    expect(rels).not.toContain('debug.log');
    expect(rels).not.toContain('secret.txt');
    expect(rels).not.toContain('ignored_dir');
    expect(rels).not.toContain('ignored_dir/foo.ts');
    expect(rels).not.toContain('node_modules');
    expect(rels).not.toContain('.git');
    expect(rels).not.toContain('link.md');

    const btn = await findFiles({ dir: root, query: 'Button' });
    expect(btn.matches.map((m) => m.rel)).toEqual(['src/components/Button.tsx', 'src/components/ButtonGroup.tsx']);

    // Subsequence fuzzy match across path.
    const fuzzy = await findFiles({ dir: root, query: 'scb' });
    expect(fuzzy.matches.some((m) => m.rel === 'src/components/Button.tsx')).toBe(true);
  });

  test('bounds visited entries and respects limit', async () => {
    const root = makeTree();
    const limited = await findFiles({ dir: root, limit: 2 });
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const capped = await findFiles({ dir: root, maxVisited: 2 });
    expect(capped.truncated).toBe(true);
  });

  test('never follows a symlinked .gitignore', async () => {
    const root = makeTree();
    const outside = mkdtempSync(join(tmpdir(), 'veldr-find-out-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'external-ignore'), 'README.md\n');
    rmSync(join(root, '.gitignore'));
    symlinkSync(join(outside, 'external-ignore'), join(root, '.gitignore'));
    const res = await findFiles({ dir: root });
    // Symlinked .gitignore is ignored (not read), so README.md remains visible.
    expect(res.matches.map((m) => m.rel)).toContain('README.md');
  });

  test('validates dir and query', async () => {
    await expect(findFiles({ dir: '/no-such-dir-veldr-find-xyz' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    const root = makeTree();
    await expect(findFiles({ dir: join(root, 'README.md') })).rejects.toMatchObject({ code: 'not_dir', status: 400 });
    await expect(findFiles({ dir: root, query: 'bad\nquery' })).rejects.toMatchObject({ code: 'bad_params', status: 400 });
  });
});
