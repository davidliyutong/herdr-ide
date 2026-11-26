import { describe, expect, test } from 'bun:test';
import { Fail } from '#shared/lib/fail.ts';
import { MAX_ARG_BYTES, MAX_IGNORED, cleanPath, literal, pathArgs, plainName, redactURL, remoteURLs } from './check.ts';
import { logical, parseStatus } from './read.ts';
import { classify, gitEnv } from './run.ts';

const codeOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof Fail ? e.code : String(e);
  }
  return 'ok';
};

describe('names and paths', () => {
  test('ref names and revisions git gives no meaning pass; options and syntax are refused', () => {
    for (const s of ['main', 'feature/x', 'v1.0', 'origin/main', 'a-b', 'HEAD', '0123abcd']) expect(codeOf(() => plainName(s))).toBe('ok');
    for (const s of [
      '',
      '-x',
      '--upload-pack=evil',
      '--exec=sh',
      'a..b',
      'a b',
      'a~1',
      'a^2',
      'a:b',
      '@{u}',
      'x@{1}',
      'a\\b',
      'a*',
      'a?',
      'a[b',
      '/a',
      'a/',
      'a//b',
      'a.lock',
      'a.',
      'a\nb',
      'a\0',
      'x'.repeat(256),
    ])
      expect(codeOf(() => plainName(s))).toBe('bad_ref');
  });

  test("paths are relative to the top level, without '.' or '..'; a trailing '/' is a directory", () => {
    const ok: Record<string, string> = {
      'a.txt': 'a.txt',
      'dir/b c.txt': 'dir/b c.txt',
      '-weird': '-weird',
      ':(glob)*': ':(glob)*',
      'nested/': 'nested/',
      'a/b/': 'a/b/',
    };
    for (const [s, want] of Object.entries(ok)) expect(cleanPath(s)).toBe(want);
    for (const s of ['', '/', '/etc/passwd', '../x', 'a/../b', './a', 'a//b', 'a//', '../', 'a\0b', '.', '..', './'])
      expect(codeOf(() => cleanPath(s))).toBe('bad_params');
  });

  test('many paths are split over runs below the limit of a command line, each a literal pathspec after "--"', () => {
    const ps = Array.from({ length: 5000 }, (_, i) => `${'d'.repeat(40)}/${i}`);
    const runs = pathArgs(['add', '--all'], ps);
    expect(runs.length).toBeGreaterThan(1);
    let n = 0;
    for (const args of runs) {
      expect(args.slice(0, 3)).toEqual(['add', '--all', '--']);
      let size = 0;
      for (const a of args.slice(3)) {
        expect(a).toBe(literal(ps[n++]));
        size += a.length + 1;
      }
      expect(size).toBeLessThanOrEqual(MAX_ARG_BYTES);
    }
    expect(n).toBe(ps.length);
    expect(pathArgs(['x'], [])).toEqual([]);
  });
});

describe("remotes' URLs", () => {
  test('reach the page without what could be a credential', () => {
    const cases: Record<string, string> = {
      'https://github.com/o/r.git': 'https://github.com/o/r.git',
      'https://user:ghp_secret@github.com/o/r': 'https://github.com/o/r',
      'https://ghp_secret@github.com/o/r': 'https://github.com/o/r',
      'https://a@b:tok@host:8443/p@q': 'https://host:8443/p@q',
      'ssh://git@host:22/o/r.git': 'ssh://host:22/o/r.git',
      'git@github.com:o/r.git': 'git@github.com:o/r.git',
      'user:pass@host:o/r.git': 'host:o/r.git',
      '/srv/repos/a@b:c': '/srv/repos/a@b:c',
      'https://user:sp%zz@host/invalid-escape': 'https://host/invalid-escape',
      'https://host/o/r.git?access_token=ghp_secret': 'https://host/o/r.git',
      'https://host/o/r.git#ghp_secret': 'https://host/o/r.git',
      'https://ghp_secret@host/r?x=a@b': 'https://host/r',
      'https://host/r?private_token=a@b#c': 'https://host/r',
      'https://user:tok/en@host/o/r': 'https://host/o/r',
      'https://x-access-token:a/b/c@github.com/o/r.git?x=1': 'https://github.com/o/r.git',
      'https://user:pa?ss@host/r': 'https://host/r',
      'https://u:a/b@c@host/p@q': 'https://host/p@q',
      'https://me@mail.example:s3cret@host/r': 'https://host/r',
      'https://git.example.com/@scope/pkg.git': 'https://git.example.com/@scope/pkg.git',
      'https://[::1]:8080/p@q': 'https://[::1]:8080/p@q',
      'file:///srv/r@x.git': 'file:///srv/r@x.git',
      'user:p@ss@host:o/r.git': 'host:o/r.git',
      'git@host:o/a@b.git': 'git@host:o/a@b.git',
    };
    for (const [in_, want] of Object.entries(cases)) expect([in_, redactURL(in_)]).toEqual([in_, want]);
    expect(remoteURLs('origin\thttps://t@h/r (fetch)\norigin\thttps://t@h/r (push)\nup\t/srv/r.git (fetch)\n')).toEqual({
      origin: 'https://h/r',
      up: '/srv/r.git',
    });
  });
});

describe('runs of git', () => {
  test('a failed run has its code: auth_required, not_a_repo, conflicts, diverged, git_failed', () => {
    const cases: Record<string, string> = {
      "fatal: could not read Username for 'https://example.com': terminal prompts disabled": 'auth_required',
      'git@example.com: Permission denied (publickey).': 'auth_required',
      'Host key verification failed.': 'auth_required',
      'remote: HTTP Basic: Access denied': 'auth_required',
      'fatal: not a git repository (or any of the parent directories): .git': 'not_a_repo',
      'error: could not apply 1234... x': 'conflicts',
      'hint: You have divergent branches and need to specify how to reconcile divergent branches.': 'diverged',
      'fatal: something else': 'git_failed',
    };
    for (const [msg, code] of Object.entries(cases)) expect(classify('x', { out: Buffer.alloc(0), err: Buffer.from(msg) }).code).toBe(code);
    expect(classify('merge', { out: Buffer.from('CONFLICT (content): a.txt'), err: Buffer.alloc(0) }).code).toBe('conflicts');
  });

  test('the environment points git nowhere else and asks for nothing; reads take no optional locks', () => {
    const base = {
      PATH: '/bin',
      GIT_DIR: '/x',
      GIT_ASKPASS: '/a',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.pager',
      LANG: 'de_DE',
      GIT_CONFIG_GLOBAL: '/tmp/evil',
      GIT_ATTR_SOURCE: 'HEAD~1',
      GIT_TRACE: '/tmp/trace',
      GIT_EXEC_PATH: '/x',
      GIT_PAGER: 'less',
      SSH_ASKPASS: '/a',
      GIT_SSH_COMMAND: 'ssh -i k',
      GIT_SSH: '/usr/bin/ssh',
      GIT_SSH_VARIANT: 'ssh',
      GIT_AUTHOR_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'c@x',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_GLOB_PATHSPECS: '1',
    };
    const env = gitEnv(base, true);
    for (const k of [
      'GIT_DIR',
      'GIT_ASKPASS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'LANG',
      'GIT_CONFIG_GLOBAL',
      'GIT_ATTR_SOURCE',
      'GIT_TRACE',
      'GIT_EXEC_PATH',
      'SSH_ASKPASS',
      'GIT_LITERAL_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
    ])
      expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({
      PATH: '/bin',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_OPTIONAL_LOCKS: '0',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: 'ssh -i k',
      GIT_SSH: '/usr/bin/ssh',
      GIT_SSH_VARIANT: 'ssh',
      GIT_AUTHOR_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'c@x',
    });
    expect(gitEnv(base, false).GIT_OPTIONAL_LOCKS).toBeUndefined();
  });
});

describe('the status', () => {
  const changed =
    '1 .M N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 a.txt\0';
  test('cut among the ignored paths keeps the changes whole; cut before them it is not whole; ignored paths are capped', () => {
    const cut = parseStatus(Buffer.from('# branch.head main\0' + changed + '? b.txt\0! x/\0! y/partl'), true);
    expect(cut.whole).toBe(true);
    expect(cut.st.files).toHaveLength(2);
    expect(cut.st.ignored).toEqual(['x/']);
    expect(cut.st.ignoredTruncated).toBe(true);
    expect(cut.st.branch).toBe('main');
    expect(parseStatus(Buffer.from(changed + '? b.t'), true).whole).toBe(false);
    const whole = parseStatus(Buffer.from(changed + '! x/\0'), false);
    expect(whole.whole).toBe(true);
    expect(whole.st.ignoredTruncated).toBeUndefined();
    expect(whole.st.ignored).toHaveLength(1);
    const many = parseStatus(Buffer.from(changed + '! f\0'.repeat(MAX_IGNORED + 5)), false);
    expect(many.st.ignored).toHaveLength(MAX_IGNORED);
    expect(many.st.ignoredTruncated).toBe(true);
    expect(many.st.files).toHaveLength(1);
  });

  test('a rename has its original path; a submodule is marked; ahead and behind are read', () => {
    const recs =
      '# branch.oid (initial)\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +2 -3\0' +
      '2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 R100 new name.txt\0old name.txt\0' +
      '1 M. SC.. 160000 160000 160000 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 sub\0' +
      'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 c.txt\0';
    const { st } = parseStatus(Buffer.from(recs), false);
    expect(st.head).toBeUndefined();
    expect(st.branch).toBeUndefined();
    expect(st).toMatchObject({ upstream: 'origin/main', ahead: 2, behind: 3 });
    expect(st.files).toEqual([
      { path: 'new name.txt', orig: 'old name.txt', x: 'R', y: '.', kind: 'renamed' },
      { path: 'sub', x: 'M', y: '.', kind: 'changed', submodule: true },
      { path: 'c.txt', x: 'U', y: 'U', kind: 'unmerged' },
    ]);
  });
});

test('the top level as the directory spells it', async () => {
  for (const [dir, top, prefix, want] of [
    ['/a/b/c', '/x/b', 'c/', '/x/b'],
    ['/a/b/c', '/a/b', 'c/', '/a/b'],
    ['/a/b/c', '/x', 'b/c/', '/x'],
  ])
    expect(await logical(dir, top, prefix)).toBe(want);
});
