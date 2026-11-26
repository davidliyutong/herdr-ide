import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { Fail } from '#shared/lib/fail.ts';
import { extended } from '#shared/testdata/extended.ts';
import { call } from '#kernel/agent.ts';
import { rig, machineOf, type Rig } from '#machine/testing.ts';
import { searchMachine, type SearchMachineOptions } from './machine.ts';
import { Collector } from './machine/collector.ts';
import { MAX_PREVIEW, excerpt } from './machine/excerpt.ts';
import { Matcher, SKIPPED, rgGlobs, splitGlobs } from './machine/glob.ts';
import { MAX_FILE_SIZE } from './machine/query.ts';
import { RgParser, bundledRg, lookPath, rgArgs, rgEnviron, rgPlatform } from './machine/rg.ts';
import { MAX_GLOBS, MAX_QUERY, MAX_RESULTS, searchProtocol, type SearchParams } from './protocol.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

/** Writes files (path: contents) below dir. */
function tree(dir: string, files: Record<string, string | Buffer>) {
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), s);
  }
}

type Result = Awaited<ReturnType<typeof search>>;

async function start(o: SearchMachineOptions = {}) {
  r = await rig({ features: [searchMachine(o)] });
  return r;
}

const search = (p: Partial<SearchParams>) =>
  call(machineOf(r!.session), searchProtocol, 'search', { dir: '~', query: '', ...p } as SearchParams);

/** A result as "path:line:col" per match line. */
const summary = (res: Result) => (res.files ?? []).flatMap((f) => (f.matches ?? []).map((m) => `${f.path}:${m.line}:${m.col}`));

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Fail).code;
  }
  return 'ok';
};

const sample = {
  'src/a.go': 'package a\n\nfunc Needle() {}\n// needle and NEEDLE\n',
  'src/lib/b.go': 'x := needles\n',
  'docs/c.md': 'A needle in docs.\r\n',
  'node_modules/m/i.js': 'needle\n',
  '.git/config': 'needle\n',
  '.hidden/h.txt': 'needle\n',
  'bin.dat': 'needle\x00\x01\x02',
};

/** The searches both engines must agree on. */
async function engineCases(rg: string) {
  const rr = await start({ findRg: () => rg });
  const dir = join(rr.home, 'proj');
  tree(dir, sample);
  const run = (p: Partial<SearchParams>) => search({ dir: '~/proj', ...p });
  const cases: Array<[string, Partial<SearchParams>, string[]]> = [
    ['literal, any case', { query: 'needle' }, ['.hidden/h.txt:1:1', 'docs/c.md:1:3', 'src/a.go:3:6', 'src/a.go:4:4', 'src/lib/b.go:1:6']],
    ['case', { query: 'NEEDLE', caseSensitive: true }, ['src/a.go:4:15']],
    ['whole word', { query: 'needle', wholeWord: true }, ['.hidden/h.txt:1:1', 'docs/c.md:1:3', 'src/a.go:3:6', 'src/a.go:4:4']],
    ['regex', { query: 'Need(le)?\\(\\)', regex: true, caseSensitive: true }, ['src/a.go:3:6']],
    ['literal is not a regex', { query: 'needle.*' }, []],
    ['include by name', { query: 'needle', include: '*.md' }, ['docs/c.md:1:3']],
    ['include a folder', { query: 'needle', include: 'lib' }, ['src/lib/b.go:1:6']],
    ['include a path', { query: 'needle', include: './src, docs/*.txt' }, ['src/a.go:3:6', 'src/a.go:4:4', 'src/lib/b.go:1:6']],
    ['braces', { query: 'needle', include: '*.{md,txt}' }, ['.hidden/h.txt:1:1', 'docs/c.md:1:3']],
    ['exclude', { query: 'needle', exclude: 'lib, docs/**, .hidden' }, ['src/a.go:3:6', 'src/a.go:4:4']],
  ];
  for (const [name, p, want] of cases) {
    const res = await run(p);
    expect([name, summary(res)]).toEqual([name, want]);
    expect(res.truncated).toBeUndefined();
    expect(res.dir).toBe(dir);
    expect(res.engine).toBe(rg ? 'rg' : 'builtin');
  }
  // Matches on a line count each; the preview drops leading blanks.
  let res = await run({ query: 'needle', include: 'src/a.go' });
  expect(res.matchCount).toBe(3);
  expect(res.files).toHaveLength(1);
  expect(res.files![0].matches![1]).toEqual({
    line: 4,
    col: 4,
    preview: '// needle and NEEDLE',
    ranges: [
      [3, 9],
      [14, 20],
    ],
  });
  // The limit stops the search and says so.
  res = await run({ query: 'needle', maxResults: 2 });
  expect(res.matchCount).toBe(2);
  expect(res.truncated).toBe(true);
  expect(res.reason).toBe('max_results');
}

describe('search', () => {
  test('the walker', () => engineCases(''));

  const rg = lookPath('rg');
  test.skipIf(!rg)('ripgrep, when the machine running the tests has it', () => engineCases(rg));

  test('the walker leaves out the top-level .gitignore, large files, FIFOs and links; a bad expression is bad_regex', async () => {
    const rr = await start({ findRg: () => '' });
    const dir = join(rr.home, 'p');
    tree(dir, {
      '.gitignore': '# built\nout/\n/top.log\n!keep\n',
      'out/x.txt': 'needle\n',
      'sub/top.log': 'needle\n',
      'top.log': 'needle\n',
      'big.txt': 'a'.repeat(MAX_FILE_SIZE) + 'needle',
      'ok.txt': 'needle\n',
    });
    Bun.spawnSync(['mkfifo', join(dir, 'fifo')]);
    symlinkSync(join(dir, 'ok.txt'), join(dir, 'link.txt'));
    const res = await search({ dir, query: 'needle' });
    expect(summary(res)).toEqual(['ok.txt:1:1', 'sub/top.log:1:1']);
    expect(res.engine).toBe('builtin');
    expect(await codeOf(search({ dir, query: '(', regex: true }))).toBe('bad_regex');
  });

  test('the walker reads a line that is not UTF-8 as the Go agent did', async () => {
    const rr = await start({ findRg: () => '' });
    tree(rr.home, { 'bad.txt': Buffer.from([0x61, 0xff, ...Buffer.from('needle 😀needle\n')]) });
    const res = await search({ query: 'needle' });
    expect(res.files![0].matches![0]).toEqual({
      line: 1,
      col: 3,
      preview: 'a�needle 😀needle',
      ranges: [
        [2, 8],
        [11, 17],
      ],
    });
    expect(res.matchCount).toBe(2);
  });

  test('a search past its time stops with what it found', async () => {
    const rr = await start({ findRg: () => '', timeoutMs: 0 });
    tree(rr.home, { 'a.txt': 'needle\n' });
    const res = await search({ query: 'needle' });
    expect(res.truncated).toBe(true);
    expect(res.reason).toBe('timeout');
  });

  test('parameters are checked: codes for what is not a search', async () => {
    const rr = await start({ findRg: () => '' });
    tree(rr.home, { 'f.txt': 'x' });
    const cases: Array<[Partial<SearchParams>, string]> = [
      [{ query: '' }, 'bad_params'],
      [{ query: 'x'.repeat(MAX_QUERY + 1) }, 'bad_params'],
      [{ query: 'a\nb' }, 'bad_params'],
      [{ query: 'a\0' }, 'bad_params'],
      [{ dir: '', query: 'a' }, 'bad_params'],
      [{ query: 'a', include: 'x'.repeat(MAX_GLOBS + 1) }, 'bad_params'],
      [{ dir: '~/nope', query: 'a' }, 'not_found'],
      [{ dir: '~/f.txt', query: 'a' }, 'not_dir'],
    ];
    for (const [p, code] of cases)
      expect([JSON.stringify(p).slice(0, 60), await codeOf(search(p))]).toEqual([JSON.stringify(p).slice(0, 60), code]);
    // At most MAX_RESULTS, whatever is asked.
    tree(rr.home, { 'many.txt': 'x\n'.repeat(MAX_RESULTS + 10) });
    const res = await search({ query: 'x', include: 'many.txt', maxResults: MAX_RESULTS * 10 });
    expect(res.matchCount).toBe(MAX_RESULTS);
  });

  extended('at most so many searches at once: one more waits, then is busy', async () => {
    // A ripgrep that takes its time: the search holds its place until its
    // time is up, and its process group is killed then.
    const rr = await start({ findRg: () => join(r!.home, 'slow-rg'), maxSearches: 1, slotWaitMs: 100, timeoutMs: 1000 });
    writeFileSync(join(rr.home, 'slow-rg'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const first = search({ query: 'a' });
    await new Promise((res) => setTimeout(res, 50));
    expect(await codeOf(search({ query: 'b' }))).toBe('busy');
    const res = await first;
    expect(res.reason).toBe('timeout');
  });
});

/** ripgrep's --json output, as recorded from ripgrep 15: text, a line that
 * is not UTF-8 (bytes), messages that are not matches, a broken line. */
const RG_OUTPUT = `{"type":"begin","data":{"path":{"text":"./src/a.go"}}}
{"type":"match","data":{"path":{"text":"./src/a.go"},"lines":{"text":"\\tfunc Needle() {} // needle\\n"},"line_number":3,"absolute_offset":11,"submatches":[{"match":{"text":"Needle"},"start":6,"end":12},{"match":{"text":"needle"},"start":21,"end":27}]}}
{"type":"context","data":{"path":{"text":"./src/a.go"},"lines":{"text":"x\\n"},"line_number":4}}
{"type":"end","data":{"path":{"text":"./src/a.go"},"binary_offset":null,"stats":{}}}
{"type":"begin","data":{"path":{"text":"./bad.txt"}}}
{"type":"match","data":{"path":{"text":"./bad.txt"},"lines":{"bytes":"Yf9uZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}
not json
{"type":"match","data":{"path":{"text":"./😀.txt"},"lines":{"text":"😀needle\\r\\n"},"line_number":9,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10},{"match":{"text":""},"start":10,"end":10}]}}
{"type":"summary","data":{"elapsed_total":{"secs":0,"nanos":1},"stats":{}}}
`;

describe('ripgrep', () => {
  const parse = (out: string | Buffer, limit = 100, chunk = 7) => {
    const c = new Collector('rg', limit);
    const p = new RgParser(c);
    const b = Buffer.from(out);
    // In pieces, as a pipe delivers it.
    for (let i = 0; i < b.length && p.push(b.subarray(i, i + chunk)); i += chunk);
    p.end();
    return { c, seen: p.seen };
  };

  test('its output: text, bytes, other messages and a broken line', () => {
    const { c, seen } = parse(RG_OUTPUT);
    expect(seen).toBe(true);
    expect(c.res.files).toEqual([
      {
        path: 'src/a.go',
        matches: [
          {
            line: 3,
            col: 7,
            preview: 'func Needle() {} // needle',
            ranges: [
              [5, 11],
              [20, 26],
            ],
          },
        ],
      },
      { path: 'bad.txt', matches: [{ line: 1, col: 3, preview: 'a�needle', ranges: [[2, 8]] }] },
      { path: '😀.txt', matches: [{ line: 9, col: 3, preview: '😀needle', ranges: [[2, 8]] }] },
    ]);
    expect(c.res.matchCount).toBe(4);
    // The limit stops reading.
    const one = parse(RG_OUTPUT, 1).c;
    expect(one.res.matchCount).toBe(1);
    expect(one.res.files).toHaveLength(1);
    // Nothing searched (a refused regex prints no JSON).
    expect(parse('').seen).toBe(false);
  });

  test('a line over the limit is skipped', () => {
    const c = new Collector('rg', 100);
    const p = new RgParser(c, 100 << 10);
    p.push(Buffer.from('x'.repeat(200 << 10) + '\n' + RG_OUTPUT.split('\n')[1] + '\n'));
    p.end();
    expect(c.res.matchCount).toBe(2);
  });

  test('its arguments: the query after --, no configuration, the globs', () => {
    const args = rgArgs({ query: '-e', includes: [], excludes: [] });
    expect(args.slice(-3)).toEqual(['--', '-e', '.']);
    for (const a of ['--no-config', '--fixed-strings', '--ignore-case', '--json']) expect(args).toContain(a);
    expect(rgEnviron({ A: '1', RIPGREP_CONFIG_PATH: '/x' })).toEqual({ A: '1' });
  });

  test("the copy of code-server's newest install", async () => {
    const rr = await start();
    expect(bundledRg(rr.home)).toBe('');
    for (const v of ['4.1.0', '4.2.0']) {
      const p = join(
        rr.home,
        DATA_DIR_NAME,
        'code-server',
        v,
        'lib',
        'vscode',
        'node_modules',
        '@vscode',
        'ripgrep-universal',
        'bin',
        rgPlatform(),
        'rg',
      );
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
    }
    expect(bundledRg(rr.home)).toContain('4.2.0');
  });
});

describe('patterns', () => {
  test('split, matched by name or path, given to ripgrep', () => {
    expect(splitGlobs(' *.ts , ./src/, {a,b}/*.go,, /x')).toEqual(['*.ts', 'src', '{a,b}/*.go', '/x']);
    const m = new Matcher(['*.go', 'docs/**/*.md', '/build']);
    const want: Record<string, boolean> = {
      'a.go': true,
      'x/y/a.go': true,
      'a.gox': false,
      'docs/a.md': true,
      'docs/x/y/a.md': true,
      'x/docs/a.md': false,
      'build/out.txt': true,
      'src/build/out.txt': false,
    };
    for (const [p, w] of Object.entries(want)) expect([p, m.any(p)]).toEqual([p, w]);
    expect(new Matcher(['[!a]?.txt', 'ü*.md']).self('ü1.md')).toBe(true);
    expect(rgGlobs(['src', 'a/b'], ['*.min.js', '/out']).slice(SKIPPED.length)).toEqual([
      '--glob=src',
      '--glob=**/src/**',
      '--glob=/a/b',
      '--glob=/a/b/**',
      '--glob=!*.min.js',
      '--glob=!/out',
    ]);
  });
});

describe('previews', () => {
  test('a match far into a long line: the preview starts shortly before it and ends after its length', () => {
    const line = Buffer.from('a'.repeat(500) + 'needle' + 'b'.repeat(500));
    const { preview, col, ranges } = excerpt(line, [[500, 506]]);
    expect(col).toBe(501);
    expect(preview.startsWith('…')).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    expect([...preview].length).toBe(MAX_PREVIEW + 2);
    expect(preview.slice(ranges![0][0], ranges![0][1])).toBe('needle');
    // A match past the preview's end is not marked.
    expect(
      excerpt(line, [
        [500, 506],
        [990, 995],
      ]).ranges,
    ).toHaveLength(1);
  });
});
