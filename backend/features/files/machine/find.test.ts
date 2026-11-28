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

  test('explorer name search traverses the whole project, honors regex/hidden/exclude, and rejects invalid regex', async () => {
    const root = makeTree();
    mkdirSync(join(root, 'a/b/c/deep'), { recursive: true });
    writeFileSync(join(root, 'a/b/c/deep/Widget12.tsx'), '');
    writeFileSync(join(root, 'a/b/c/deep/.env.local'), '');

    // Whole-project substring filename search finds unexpanded deeply nested files,
    // including gitignored files not excluded by files.exclude, while skipping .git and hidden files by default.
    const sub = await findFiles({ dir: root, query: 'widget', match: 'name' });
    expect(sub.matches.map((m) => m.rel)).toEqual(['a/b/c/deep/Widget12.tsx']);

    const gitignored = await findFiles({ dir: root, query: 'debug.log', match: 'name' });
    expect(gitignored.matches.map((m) => m.rel)).toEqual(['debug.log']);

    // Regex matching on filenames (case-insensitive) and path patterns (when containing /).
    const rx = await findFiles({ dir: root, query: '^(button.*|widget\\d+)\\.tsx$', match: 'name', regex: true });
    expect(rx.matches.map((m) => m.rel).sort()).toEqual([
      'a/b/c/deep/Widget12.tsx',
      'src/components/Button.tsx',
      'src/components/ButtonGroup.tsx',
    ]);

    const pathRx = await findFiles({ dir: root, query: 'components/.*\\.tsx$', match: 'name', regex: true });
    expect(pathRx.matches.map((m) => m.rel).sort()).toEqual(['src/components/Button.tsx', 'src/components/ButtonGroup.tsx']);

    // Hidden files are skipped unless hidden: true, and exclude globs filter both files and folders.
    const noHidden = await findFiles({ dir: root, query: '^\\.env', match: 'name', regex: true, hidden: false });
    expect(noHidden.matches).toEqual([]);
    const withHidden = await findFiles({ dir: root, query: '^\\.env', match: 'name', regex: true, hidden: true });
    expect(withHidden.matches.map((m) => m.rel)).toEqual(['a/b/c/deep/.env.local']);

    const excludedRes = await findFiles({
      dir: root,
      query: '\\.tsx$',
      match: 'name',
      regex: true,
      exclude: ['.git', 'components'],
    });
    expect(excludedRes.matches.map((m) => m.rel)).toEqual(['a/b/c/deep/Widget12.tsx']);

    // Symlinks are never followed even in name mode.
    const links = await findFiles({ dir: root, query: 'link.md', match: 'name' });
    expect(links.matches).toEqual([]);

    // Invalid regex fails with 400 bad_regex.
    await expect(findFiles({ dir: root, query: '[unclosed', match: 'name', regex: true })).rejects.toMatchObject({
      code: 'bad_regex',
      status: 400,
    });
  });

  test('a backtracking pattern matches in linear time, and syntax RE2 lacks is bad_regex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-redos-'));
    try {
      writeFileSync(join(root, `${'a'.repeat(64)}b`), '');
      const started = performance.now();
      const res = await findFiles({ dir: root, query: '(a+)+$', match: 'name', regex: true });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(res.matches).toEqual([]);
      await expect(findFiles({ dir: root, query: '(?<=a)b', match: 'name', regex: true })).rejects.toMatchObject({
        code: 'bad_regex',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exclude globs and .gitignore patterns match in linear time without ReDoS and handle bracket escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-glob-redos-'));
    dirs.push(root);
    const evilFile = `${'a'.repeat(48)}c`;
    const evilGlob = `${'*a'.repeat(20)}*b`;
    const evilDoubleStar = `${'**a'.repeat(20)}**b`;
    writeFileSync(join(root, evilFile), '');
    writeFileSync(join(root, '.gitignore'), `${evilGlob}\n${evilDoubleStar}\n`);

    // Linear-time matching for both malicious .gitignore (fuzzy mode) and ?exclude= (name mode).
    const t0 = performance.now();
    const fuzzy = await findFiles({ dir: root, query: 'aaa' });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(fuzzy.matches.map((m) => m.name)).toContain(evilFile);

    const t1 = performance.now();
    const named = await findFiles({ dir: root, query: 'aaa', match: 'name', exclude: [evilGlob] });
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(named.matches.map((m) => m.name)).toContain(evilFile);

    // Bracket escapes inside files.exclude: [\]] matches literal ], [a\-z] matches a, -, z (not b), [\\] matches \.
    writeFileSync(join(root, 'x]y'), '');
    writeFileSync(join(root, 'x-y'), '');
    writeFileSync(join(root, 'xby'), '');
    writeFileSync(join(root, 'xay'), '');
    writeFileSync(join(root, 'x\\y'), '');
    const res = await findFiles({
      dir: root,
      query: 'x',
      match: 'name',
      exclude: ['x[\\]]y', 'x[a\\-z]y', 'x[\\\\]y'],
    });
    expect(res.matches.map((m) => m.name)).toEqual(['xby']);
  });
});
