import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Op } from '#shared/proto/agentproto/index.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { MAX_NESTED_DEPTH } from './machine/read.ts';
import { openRepo } from './machine/repo.ts';
import { MAX_STATUS } from './machine/check.ts';
import { runsOf } from './machine/write.ts';
import { gitRig, hasGit, script, setupEnv, write, type GitRig } from './machine/testing.ts';
import type { Params, Write } from './protocol.ts';
import vectors from '../../../spec/vectors/git/range-patches.json';

let g: GitRig | undefined;
afterEach(async () => {
  await g?.close();
  g = undefined;
});

const it = hasGit ? test : test.skip;
const SLOW = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const byPath = (st: { files: Array<{ path: string }> }) => Object.fromEntries(st.files.map((f) => [f.path, f])) as Record<string, any>;

/** The runs a change would make, without running it. */
function runsFor(rig: GitRig, dir: string, action: Write, p: Params) {
  const ctx = {
    run: (d: string, read: boolean, rn: import('./machine/run.ts').Run) => {
      // The checks' runs of git (rev-parse, show-ref, remote) go to real git.
      const r = spawnSync('git', ['-C', d, ...rn.args], { env: setupEnv(rig.home) });
      const res = { out: r.stdout, err: r.stderr, code: r.status ?? -1, cut: false };
      if (res.code !== 0 && !rn.ok?.includes(res.code)) return Promise.reject(new Error(`git ${rn.args[0]} failed`));
      void read;
      return Promise.resolve(res);
    },
    expand: (p: string) => p,
  };
  return runsOf(openRepo(ctx, dir, false), action, p);
}

describe('the checks', () => {
  it(
    'values of a request never become options of git; paths are literal pathspecs after "--"',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const bad: Array<[Write, Params]> = [
        ['branchCreate', { name: '--upload-pack=evil' }],
        ['branchCreate', { name: 'ok', at: '--all' }],
        ['branchCreate', { name: 'has space' }],
        ['branchCreate', { name: 'a..b' }],
        ['checkout', { name: '-f' }],
        ['checkout', { rev: '--orphan=x' }],
        ['checkout', { name: 'nonexistent' }],
        ['merge', { ref: '--abort' }],
        ['rebase', { onto: '-i' }],
        ['rebase', { onto: 'HEAD..main' }],
        ['cherryPick', { rev: '--continue' }],
        ['reset', { rev: 'HEAD', mode: 'keep' }],
        ['reset', { rev: '--hard', mode: 'hard' }],
        ['push', { remote: '--exec=touch /tmp/x' }],
        ['push', { remote: 'origin' }],
        ['fetch', { remote: '--upload-pack=x' }],
        ['pull', { remote: '--upload-pack=x' }],
        ['pull', { branch: 'main' }],
        ['pull', { remote: 'origin', branch: 'main' }],
        ['stashApply', { index: -1 }],
        ['stashApply', { index: 0 }],
        ['stashDrop', { index: 0, hash: '--all' }],
        ['stashPop', { index: 0, hash: 'stash@{0}' }],
        ['tagCreate', { name: '-d' }],
        ['tagDelete', { name: 'missing' }],
        ['branchDelete', { name: '--force' }],
        ['branchRename', { name: 'main', to: '-m' }],
        ['stage', { paths: ['../outside'] }],
        ['stage', {}],
        ['discard', { paths: ['/etc/passwd'] }],
        ['abort', { op: 'bisect' }],
        ['abort', { op: 'toString' }],
        ['reset', { rev: 'HEAD', mode: 'constructor' }],
        ['commit', { message: '  ' }],
        ['applyPatch', {}],
      ];
      for (const [action, p] of bad) {
        const got = await runsFor(g, dir, action, p).then(
          (r) => r,
          () => null,
        );
        expect([action, p, got]).toEqual([action, p, null]);
      }
      expect((await runsFor(g, dir, 'stage', { paths: ['-n', 'a.txt', ':(glob)*'] })).map((r) => r.args.join(' '))).toEqual([
        'add --all -- :(literal)-n :(literal)a.txt :(literal):(glob)*',
      ]);
      expect((await runsFor(g, dir, 'discard', { paths: ['a.txt'], untracked: ['-f'] })).map((r) => r.args.join(' '))).toEqual([
        'clean -f -q -- :(literal)-f',
        'restore --worktree -- :(literal)a.txt',
      ]);
      expect((await runsFor(g, dir, 'stage', { all: true, tracked: true })).map((r) => r.args.join(' '))).toEqual(['add --update']);
      const commit = await runsFor(g, dir, 'commit', { message: '--amend\n\nbody' });
      expect(commit).toEqual([{ args: ['commit', '--cleanup=whitespace', '--file=-'], stdin: '--amend\n\nbody' }]);
      // As many paths as a status lists, and not one more.
      const many = Array.from({ length: MAX_STATUS }, (_, i) => `f${i}`);
      expect((await runsFor(g, dir, 'stage', { paths: many })).length).toBeGreaterThan(0);
      expect(
        await runsFor(g, dir, 'stage', { paths: [...many, 'one more'] }).then(
          () => 'accepted',
          () => 'refused',
        ),
      ).toBe('refused');
    },
    SLOW,
  );

  it(
    'paths are literal: pathspec magic matches nothing, a name with wildcards names that file; hooks keep their own globs',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      write(join(dir, 'b.txt'), 'b\n');
      expect(await g.fails('stage', { repo: dir, paths: [':(glob)*.txt'] })).toBe('git_failed');
      g.sh(dir, 'diff', '--cached', '--exit-code');
      write(join(dir, '*.txt'), 'star\n');
      await g.call('stage', { repo: dir, paths: ['*.txt'] });
      expect(g.sh(dir, 'diff', '--cached', '--name-only')).toBe('*.txt');
      await g.call('commit', { repo: dir, message: 'star' });
      const marker = join(g.home, 'hook.out');
      script(join(dir, '.git', 'hooks', 'pre-commit'), `git diff --cached --name-only -- '*.txt' > '${marker}'\n`);
      await g.call('stage', { repo: dir, paths: ['b.txt'] });
      await g.call('commit', { repo: dir, message: 'b' });
      expect(readFileSync(marker, 'utf8').trim()).toBe('b.txt');
    },
    SLOW,
  );

  it(
    'the actions run in the top level only, which repo finds; elsewhere not_a_repo',
    async () => {
      g = await gitRig();
      const plain = join(g.home, 'plain');
      mkdirSync(plain);
      expect(await g.fails('repo', { path: plain })).toBe('not_a_repo');
      expect(await g.fails('status', { repo: plain })).toBe('not_a_repo');
      expect(await g.fails('repo', { path: join(g.home, 'missing') })).toBe('not_found');
      expect(await g.fails('status', {})).toBe('bad_params');
      const dir = g.newRepo();
      mkdirSync(join(dir, 'sub'));
      expect(await g.fails('status', { repo: join(dir, 'sub') })).toBe('not_a_repo');
      const info = await g.call('repo', { path: join(dir, 'sub') });
      expect(info).toMatchObject({ root: dir, branch: 'main', ahead: 0, behind: 0, remotes: [] });
      expect(info.head).toMatch(/^[0-9a-f]{40}/);
      expect(info.detached).toBeUndefined();
      // An action the machine does not serve.
      const rep = await g.r.session
        .request({ op: Op.Plugin, plugin: 'git', action: 'nope', params: { repo: dir } })
        .catch((e) => (e as AgentError).reply);
      expect(rep?.code).toBe('bad_params');
    },
    SLOW,
  );

  it('without git the actions fail git_missing', async () => {
    g = await gitRig({ git: () => null });
    const dir = g.newRepo();
    expect(await g.fails('status', { repo: dir })).toBe('git_missing');
  });

  it(
    'reads run no file system monitor and no textconv driver of the repository',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const marker = join(g.home, 'marker');
      const hook = script(join(g.home, 'fsmonitor'), `touch ${marker}\nexit 1\n`);
      const tc = script(join(g.home, 'textconv'), `touch ${marker}.tc\ncat "$1"\n`);
      g.sh(dir, 'config', 'core.fsmonitor', hook);
      g.sh(dir, 'config', 'diff.evil.textconv', tc);
      write(join(dir, '.gitattributes'), '*.txt diff=evil\n');
      g.sh(dir, 'add', '.gitattributes');
      g.sh(dir, 'commit', '-q', '-m', 'attrs');
      rmSync(marker, { force: true });
      write(join(dir, 'a.txt'), 'changed\n');
      const st = await g.call('status', { repo: dir });
      const ds = await g.call('diffStat', { repo: dir });
      await g.call('repo', { path: dir });
      await g.call('show', { repo: dir, rev: g.sh(dir, 'rev-parse', 'HEAD~1'), rev2: 'HEAD' });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(marker + '.tc')).toBe(false);
      expect(st.files).toHaveLength(1);
      expect(ds.worktree['a.txt']).toEqual([1, 3]);
    },
    SLOW,
  );
});

describe('the reads', () => {
  it(
    'repo, status, log, show, blob, branches, tags, diffStat and watch of a repository with merges, renames, tags and stashes',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const sh = (...a: string[]) => g!.sh(dir, ...a);
      sh('checkout', '-q', '-b', 'feature');
      write(join(dir, 'b.txt'), 'bee\n');
      sh('add', 'b.txt');
      sh('commit', '-q', '-m', 'add b');
      sh('checkout', '-q', 'main');
      write(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
      sh('commit', '-q', '-am', 'four');
      sh('merge', '-q', '--no-ff', '--no-edit', 'feature');
      sh('mv', 'b.txt', 'c.txt');
      sh('commit', '-q', '-m', 'rename b\n\nlonger body');
      sh('tag', '-a', '-m', 'release', 'v1');
      write(join(dir, 'a.txt'), 'stashed\n');
      sh('stash', 'push', '-q', '-m', 'wip');
      write(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
      sh('add', 'a.txt');
      write(join(dir, 'a.txt'), 'zero\none\ntwo\nthree\nfour\nfive\n');
      write(join(dir, 'new dir/u.txt'), 'u\n');
      write(join(dir, 'bin.dat'), 'a\0b');

      const info = await g.call('repo', { path: dir });
      expect(info).toMatchObject({ branch: 'main', gitDir: join(dir, '.git') });
      expect(info.state).toBeUndefined();

      const st = await g.call('status', { repo: dir });
      const files = byPath(st);
      expect(files['a.txt']).toMatchObject({ x: 'M', y: 'M', kind: 'changed' });
      expect(files['new dir/u.txt'].kind).toBe('untracked');
      expect(st.branch).toBe('main');
      expect(st.head).toBe(info.head);

      const lg = await g.call('log', { repo: dir });
      expect(lg.commits).toHaveLength(5);
      expect(lg.more).toBe(false);
      expect(lg.branch).toBe('main');
      expect(lg.commits[0].subject).toBe('rename b');
      expect(lg.commits[1].parents).toHaveLength(2);
      const refs = Object.fromEntries(lg.refs.map((r: { name: string; hash: string }) => [r.name, r.hash]));
      expect(refs['refs/tags/v1']).toBe(lg.commits[0].hash);
      expect(refs['refs/heads/feature']).toBeTruthy();
      expect(lg.stashes).toHaveLength(1);
      expect(lg.stashes[0].base).toBe(lg.commits[0].hash);
      expect(lg.stashes[0].message).toContain('wip');
      const page = await g.call('log', { repo: dir, skip: 2, limit: 2 });
      expect(page.commits).toHaveLength(2);
      expect(page.more).toBe(true);
      expect(page.commits[0].hash).toBe(lg.commits[2].hash);
      expect(page.refs).toBeUndefined();
      expect((await g.call('log', { repo: dir, branches: ['feature'] })).commits).toHaveLength(2);
      expect(await g.fails('log', { repo: dir, branches: ['--all'] })).toBe('bad_ref');
      expect(await g.fails('log', { repo: dir, branches: ['nope'] })).toBe('bad_ref');
      expect(await g.fails('log', { repo: dir, skip: -1 })).toBe('bad_params');

      let shown = await g.call('show', { repo: dir, rev: lg.commits[0].hash });
      expect(shown.commit.message).toBe('rename b\n\nlonger body');
      expect(shown.commit.subject).toBe('rename b');
      expect(shown.files).toEqual([{ path: 'c.txt', orig: 'b.txt', status: 'R', added: 0, deleted: 0 }]);
      // The merge against its second parent: main's change.
      shown = await g.call('show', { repo: dir, rev: lg.commits[1].hash, parent: 2 });
      expect(shown.files.map((f: { path: string; added: number }) => [f.path, f.added])).toEqual([['a.txt', 1]]);
      // The root commit against the empty tree.
      shown = await g.call('show', { repo: dir, rev: lg.commits[4].hash });
      expect(shown.files.map((f: { status: string; added: number }) => [f.status, f.added])).toEqual([['A', 3]]);
      shown = await g.call('show', { repo: dir, rev: lg.commits[4].hash, rev2: 'main' });
      expect(shown.commit).toBeUndefined();
      expect(shown.files).toHaveLength(2);
      expect(await g.fails('show', { repo: dir, rev: lg.commits[0].hash, parent: 3 })).toBe('bad_params');

      const blob = (source: string, path: string, parent = 0) =>
        g!.call('blob', { repo: dir, source, path, ...(parent ? { parent } : {}) });
      const wt = await blob('worktree', 'a.txt');
      expect(wt.text).toBe('zero\none\ntwo\nthree\nfour\nfive\n');
      expect(wt.mtime).toBeGreaterThan(0);
      expect((await blob('index', 'a.txt')).text).toBe('one\ntwo\nthree\nfour\nfive\n');
      expect((await blob('head', 'a.txt')).text).toBe('one\ntwo\nthree\nfour\n');
      expect((await blob(lg.commits[0].hash, 'b.txt', 1)).text).toBe('bee\n');
      expect(await blob('v1', 'b.txt')).toEqual({ exists: false, text: '', size: 0 });
      expect(await blob('worktree', 'bin.dat')).toMatchObject({ exists: true, binary: true, text: '' });
      expect(await g.fails('blob', { repo: dir, source: 'worktree', path: '../x' })).toBe('bad_params');
      expect(await g.fails('blob', { repo: dir, source: '--output=/tmp/x', path: 'a.txt' })).toBe('bad_ref');

      const branches = await g.call('branches', { repo: dir });
      expect(branches.map((b: { name: string; current?: boolean }) => [b.name, !!b.current])).toEqual([
        ['feature', false],
        ['main', true],
      ]);
      const tags = await g.call('tags', { repo: dir });
      expect(tags).toEqual([{ name: 'v1', hash: lg.commits[0].hash, annotated: true, date: expect.any(Number), subject: 'release' }]);
      const ds = await g.call('diffStat', { repo: dir });
      expect(ds.worktree['a.txt']).toEqual([1, 0]);
      expect(ds.staged['a.txt']).toEqual([1, 0]);
      expect((await g.call('stashes', { repo: dir }))[0]).toMatchObject({ index: 0, base: lg.commits[0].hash });

      const w1 = await g.call('watch', { repo: dir });
      expect(await g.call('watch', { repo: dir })).toEqual(w1);
      expect(w1.token).toMatch(/^[0-9a-f]{24}$/);
      await sleep(20);
      sh('commit', '-q', '-m', 'five');
      expect(await g.call('watch', { repo: dir })).not.toEqual(w1);
    },
    SLOW,
  );

  it(
    'a conflict, the merge in progress and its abort; a detached HEAD',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const sh = (...a: string[]) => g!.sh(dir, ...a);
      sh('checkout', '-q', '-b', 'other');
      write(join(dir, 'a.txt'), 'other\n');
      sh('commit', '-q', '-am', 'other');
      sh('checkout', '-q', 'main');
      write(join(dir, 'a.txt'), 'mine\n');
      sh('commit', '-q', '-am', 'mine');
      expect(await g.fails('merge', { repo: dir, ref: 'other' })).toBe('conflicts');
      expect((await g.call('repo', { path: dir })).state).toBe('merge');
      const st = await g.call('status', { repo: dir });
      expect(st.files).toHaveLength(1);
      expect(st.files[0]).toMatchObject({ kind: 'unmerged', x: 'U' });
      expect(st.state).toBe('merge');
      await g.call('abort', { repo: dir, op: 'merge' });
      expect((await g.call('repo', { path: dir })).state).toBeUndefined();

      const first = sh('rev-parse', 'HEAD~1');
      await g.call('checkout', { repo: dir, rev: first.slice(0, 8) });
      const info = await g.call('repo', { path: dir });
      expect(info).toMatchObject({ detached: true, head: first });
      expect(info.branch).toBeUndefined();
      const dst = await g.call('status', { repo: dir });
      expect(dst.branch).toBeUndefined();
      expect(dst.head).toBe(first);
      await g.call('checkout', { repo: dir, name: 'main' });
    },
    SLOW,
  );

  it(
    "a linked worktree's .git names its git directory; its watch moves when it stages",
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const wt0 = join(g.home, 'wt');
      g.sh(dir, 'worktree', 'add', '-q', '-b', 'side', wt0);
      const wt = (await import('node:fs')).realpathSync(wt0);
      const info = await g.call('repo', { path: wt });
      expect(info).toMatchObject({ root: wt, branch: 'side', gitDir: join(dir, '.git', 'worktrees', 'wt'), commonDir: join(dir, '.git') });
      const w1 = await g.call('watch', { repo: wt });
      await sleep(20);
      write(join(wt, 'w.txt'), 'w\n');
      await g.call('stage', { repo: wt, paths: ['w.txt'] });
      expect(await g.call('watch', { repo: wt })).not.toEqual(w1);
    },
    SLOW,
  );

  it(
    'a repository inside another lists the outer one; before its first commit it logs nothing and stages and unstages',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const inner = join(dir, 'inner');
      mkdirSync(inner);
      g.sh(inner, 'init', '-q', '-b', 'main');
      const info = await g.call('repo', { path: inner });
      expect(info).toMatchObject({ root: inner, parents: [dir] });
      expect(info.head).toBeUndefined();
      expect((await g.call('log', { repo: inner })).commits).toEqual([]);
      write(join(inner, 'x'), 'x\n');
      await g.call('stage', { repo: inner, all: true });
      // Changed again after it was staged: unstaging drops it from the index
      // and keeps the working tree's file.
      write(join(inner, 'x'), 'x again\n');
      await g.call('unstage', { repo: inner, paths: ['x'] });
      let st = await g.call('status', { repo: inner });
      expect(st.files.map((f: { kind: string }) => f.kind)).toEqual(['untracked']);
      expect(readFileSync(join(inner, 'x'), 'utf8')).toBe('x again\n');
      // From the outer repository the inner one is an untracked directory,
      // listed with a trailing "/"; it can be staged and unstaged, and a
      // discard does not delete a repository.
      g.sh(inner, 'add', 'x');
      g.sh(inner, '-c', 'user.name=I', '-c', 'user.email=i@example.com', 'commit', '-q', '-m', 'inner');
      st = await g.call('status', { repo: dir });
      expect(st.files).toEqual([{ path: 'inner/', x: '?', y: '?', kind: 'untracked', mtime: expect.any(Number) }]);
      expect((await g.call('blob', { repo: dir, path: 'inner/', source: 'worktree' })).exists).toBe(false);
      await g.call('stage', { repo: dir, paths: ['inner/'] });
      st = await g.call('status', { repo: dir });
      expect(st.files).toHaveLength(1);
      expect(st.files[0]).toMatchObject({ x: 'A', submodule: true });
      await g.call('unstage', { repo: dir, paths: [st.files[0].path] });
      await g.call('discard', { repo: dir, untracked: ['inner/'] });
      expect(existsSync(join(inner, '.git'))).toBe(true);
    },
    SLOW,
  );

  it("on a branch without commits the log has the other branches' commits", async () => {
    g = await gitRig();
    const dir = g.newRepo();
    g.sh(dir, 'checkout', '-q', '--orphan', 'fresh');
    const lg = await g.call('log', { repo: dir });
    expect(lg.commits).toHaveLength(1);
    expect(lg.head).toBeUndefined();
    expect(lg.branch).toBe('fresh');
    expect(lg.refs).toHaveLength(1);
  });

  it('a directory reached through a link: the top level is spelled through the link', async () => {
    g = await gitRig();
    const dir = g.newRepo();
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
    const link = join(g.home, 'link');
    symlinkSync(dir, link);
    for (const p of [link, join(link, 'sub'), join(link, 'sub', 'deeper')]) expect((await g.call('repo', { path: p })).root).toBe(link);
    await g.call('status', { repo: link });
    // A link inside the repository: git's prefix is not the path's end, the
    // physical top level is answered.
    symlinkSync('sub', join(dir, 'alias'));
    expect((await g.call('repo', { path: join(link, 'alias') })).root).toBe(dir);
  });

  it(
    'the watch: the token moves with the index, the refs token with HEAD, refs and stashes, the config token with the configuration',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const watch = async (d: string) => {
        const w = await g!.call('watch', { repo: d });
        await sleep(20);
        return w;
      };
      const w0 = await watch(dir);
      write(join(dir, 'b.txt'), 'b\n');
      expect(await watch(dir)).toEqual(w0);
      g.sh(dir, 'add', 'b.txt');
      let w1 = await watch(dir);
      expect([w1.token !== w0.token, w1.refs, w1.config]).toEqual([true, w0.refs, w0.config]);
      for (const step of [
        ['commit', '-q', '-m', 'b'],
        ['branch', 'x'],
        ['stash', 'push', '-q', '--include-untracked', '-m', 's'],
      ]) {
        if (step[0] === 'stash') write(join(dir, 'u.txt'), 'u\n');
        g.sh(dir, ...step);
        const w2 = await watch(dir);
        expect([step[0], w2.refs !== w1.refs, w2.token !== w1.token, w2.config]).toEqual([step[0], true, true, w1.config]);
        w1 = w2;
      }
      g.sh(dir, 'remote', 'add', 'o', '/nowhere');
      const w2 = await watch(dir);
      expect([w2.config !== w1.config, w2.token !== w1.token, w2.refs]).toEqual([true, true, w1.refs]);

      // Refs in reftable (git 2.45 and later).
      const rt0 = join(g.home, 'rt');
      const made = spawnSync('git', ['init', '-q', '-b', 'main', '--ref-format=reftable', rt0], { env: setupEnv(g.home) });
      if (made.status !== 0) return;
      const rt = (await import('node:fs')).realpathSync(rt0);
      g.sh(rt, 'config', 'user.name', 'Tester');
      g.sh(rt, 'config', 'user.email', 'tester@example.com');
      write(join(rt, 'a'), 'a\n');
      g.sh(rt, 'add', 'a');
      g.sh(rt, 'commit', '-q', '-m', 'a');
      const r0 = await watch(rt);
      g.sh(rt, 'branch', 'other');
      expect((await watch(rt)).refs).not.toBe(r0.refs);
    },
    SLOW,
  );

  it('the status gives a changed file of the working tree its time and size, which move when it is edited again', async () => {
    g = await gitRig();
    const dir = g.newRepo();
    write(join(dir, 'a.txt'), 'changed\n');
    write(join(dir, 'u.txt'), 'u\n');
    write(join(dir, 's.txt'), 's\n');
    g.sh(dir, 'add', 's.txt');
    const f1 = byPath(await g.call('status', { repo: dir }));
    expect(f1['a.txt'].size).toBe(8);
    expect(f1['a.txt'].mtime).toBeGreaterThan(0);
    expect(f1['u.txt'].size).toBe(2);
    expect(f1['s.txt'].mtime).toBeUndefined();
    write(join(dir, 'a.txt'), 'changed again\n');
    const f2 = byPath(await g.call('status', { repo: dir }));
    expect(f2['a.txt'].y).toBe(f1['a.txt'].y);
    expect(f2['a.txt'].size).not.toBe(f1['a.txt'].size);
  });

  it('what git ignores comes with the status, an ignored directory as itself, nothing of the git directory', async () => {
    g = await gitRig();
    const dir = g.newRepo();
    write(join(dir, '.gitignore'), 'node_modules/\n*.log\nlogs\n');
    write(join(dir, 'kept', 'tracked.txt'), 't\n');
    g.sh(dir, 'add', '.gitignore', 'kept/tracked.txt');
    g.sh(dir, 'commit', '-q', '-m', 'ignore');
    for (let i = 0; i < 50; i++) write(join(dir, 'node_modules', `p${i}`, 'index.js'), 'x\n');
    write(join(dir, 'src', 'debug.log'), 'd\n');
    write(join(dir, 'logs', 'today.txt'), 'l\n');
    write(join(dir, 'kept', 'x.log'), 'x\n');
    write(join(dir, 'new.txt'), 'n\n');
    const st = await g.call('status', { repo: dir });
    expect(st.ignored).toEqual(['kept/x.log', 'logs/', 'node_modules/', 'src/debug.log']);
    expect(st.ignoredTruncated).toBeUndefined();
    expect(st.files.map((f: { path: string; kind: string }) => [f.path, f.kind])).toEqual([['new.txt', 'untracked']]);
  });

  test('a git that refuses --ignored=matching (before 2.16) gets the status without what it ignores, from then on', async () => {
    for (const refusal of [
      `echo "error: option \\\`ignored' takes no value" >&2; echo 'usage: git status' >&2; exit 129`,
      `echo "fatal: Invalid ignored mode 'matching'" >&2; exit 128`,
    ]) {
      let calls = 0;
      const dir0 = join((await import('node:os')).tmpdir(), `nim-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(dir0, '.git'), { recursive: true });
      const fake = script(
        join(dir0, 'git'),
        `echo x >> ${dir0}/calls\nfor a in "$@"; do\n  if [ "$a" = --ignored=matching ]; then ${refusal}; fi\ndone\nprintf '# branch.head main\\0? new.txt\\0'\n`,
      );
      g = await gitRig({ git: () => fake });
      for (let i = 0; i < 2; i++) {
        const st = await g.call('status', { repo: dir0 });
        expect(st.branch).toBe('main');
        expect(st.files).toHaveLength(1);
        expect(st.ignored).toBeUndefined();
      }
      calls = readFileSync(join(dir0, 'calls'), 'utf8').trim().split('\n').length;
      // Refused once, then asked without the mode.
      expect(calls).toBe(3);
      await g.close();
      g = undefined;
      rmSync(dir0, { recursive: true, force: true });
    }
  });

  it('a file of the working tree is read only inside the repository; a link is shown as its target; a FIFO is no file', async () => {
    g = await gitRig();
    const dir = g.newRepo();
    symlinkSync('/', join(dir, 'out'));
    write(join(dir, 'sub/x.txt'), 'x\n');
    symlinkSync('sub', join(dir, 'in'));
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    const blob = (path: string) => g!.call('blob', { repo: dir, source: 'worktree', path });
    expect(await blob('out/etc/hosts')).toEqual({ exists: false, text: '', size: 0 });
    expect((await blob('in/x.txt')).text).toBe('x\n');
    expect((await blob('hosts')).text).toBe('/etc/hosts');
    if (spawnSync('mkfifo', [join(dir, 'fifo')]).status === 0) expect((await blob('fifo')).exists).toBe(false);
  });

  it(
    'a file over the limit is too large, its size told',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      writeFileSync(join(dir, 'big.txt'), Buffer.alloc((8 << 20) + 10, 'a'));
      expect(await g.call('blob', { repo: dir, source: 'worktree', path: 'big.txt' })).toMatchObject({
        exists: true,
        tooLarge: true,
        size: (8 << 20) + 10,
      });
      g.sh(dir, 'add', 'big.txt');
      expect(await g.call('blob', { repo: dir, source: 'index', path: 'big.txt' })).toEqual({
        exists: true,
        tooLarge: true,
        text: '',
        size: (8 << 20) + 10,
      });
    },
    SLOW,
  );
});

describe('the changes', () => {
  it(
    'many paths are staged and discarded over several runs of git',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const sub = 'long-directory-name-'.repeat(3);
      const ps: string[] = [];
      for (let i = 0; i < 2500; i++) {
        const p = `${sub}/f${i}`;
        write(join(dir, p), 'x\n');
        ps.push(p);
      }
      await g.call('stage', { repo: dir, paths: ps });
      expect(g.sh(dir, 'diff', '--cached', '--name-only').split('\n')).toHaveLength(ps.length);
      await g.call('unstage', { repo: dir, all: true });
      await g.call('discard', { repo: dir, untracked: ps });
      expect(g.sh(dir, 'status', '--porcelain')).toBe('');
    },
    SLOW,
  );

  it(
    'stage, unstage, patches, discard, commit, branches, cherry-pick, revert, merge, reset, tags, stashes and rebase',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const sh = (...a: string[]) => g!.sh(dir, ...a);
      const status = async () => byPath(await g!.call('status', { repo: dir }));

      write(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
      write(join(dir, '-n.txt'), 'dash\n');
      await g.call('stage', { repo: dir, paths: ['a.txt', '-n.txt'] });
      let s = await status();
      expect([s['a.txt'].x, s['-n.txt'].x]).toEqual(['M', 'A']);
      await g.call('unstage', { repo: dir, paths: ['a.txt'] });
      s = await status();
      expect([s['a.txt'].x, s['a.txt'].y]).toEqual(['.', 'M']);
      await g.call('unstage', { repo: dir, all: true });

      // A staged rename is unstaged with both its paths.
      sh('mv', 'a.txt', 'moved.txt');
      expect((await status())['moved.txt']).toMatchObject({ kind: 'renamed', orig: 'a.txt' });
      await g.call('unstage', { repo: dir, paths: ['moved.txt', 'a.txt'] });
      for (const f of Object.values(await status())) expect(['.', '?']).toContain(f.x);
      renameSync(join(dir, 'moved.txt'), join(dir, 'a.txt'));

      // A patch into the index, and the same patch taken back; into the
      // working tree in reverse it discards the change.
      const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
      await g.call('applyPatch', { repo: dir, patch, cached: true });
      expect(sh('show', ':a.txt')).toBe('one\nTWO\nthree');
      await g.call('applyPatch', { repo: dir, patch, cached: true, reverse: true });
      expect(sh('show', ':a.txt')).toBe('one\ntwo\nthree');
      await g.call('applyPatch', { repo: dir, patch, reverse: true });
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
      expect(await g.fails('applyPatch', { repo: dir, patch: 'not a patch' })).toBe('git_failed');

      // Discard: a tracked change restored, an untracked file removed; a
      // tracked file named as untracked is left alone.
      write(join(dir, 'a.txt'), 'changed\n');
      await g.call('discard', { repo: dir, paths: ['a.txt'], untracked: ['-n.txt'] });
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
      expect(existsSync(join(dir, '-n.txt'))).toBe(false);
      await g.call('discard', { repo: dir, untracked: ['a.txt'] });
      expect(existsSync(join(dir, 'a.txt'))).toBe(true);

      // Commit with the message on stdin as typed, amend, signoff.
      write(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
      await g.call('stage', { repo: dir, paths: ['a.txt'] });
      const done = await g.call('commit', { repo: dir, message: '--amend title  \n\n\n# kept as typed\nbody `x` $(y)\n\n' });
      expect(typeof done.output).toBe('string');
      expect(sh('log', '-1', '--format=%B')).toBe('--amend title\n\n# kept as typed\nbody `x` $(y)');
      write(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
      await g.call('stage', { repo: dir, paths: ['a.txt'] });
      await g.call('commit', { repo: dir, message: '#123 reported this' });
      expect(sh('log', '-1', '--format=%B')).toBe('#123 reported this');
      sh('reset', '-q', '--soft', 'HEAD~1');
      write(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
      sh('add', 'a.txt');
      await g.call('commit', { repo: dir, message: 'four', amend: true, signoff: true });
      expect(sh('log', '-1', '--format=%B')).toStartWith('four\n\nSigned-off-by: Tester');
      expect(sh('rev-list', '--count', 'HEAD')).toBe('2');
      expect(await g.fails('commit', { repo: dir, message: 'nothing' })).toBe('git_failed');
      expect(await g.fails('commit', { repo: dir, message: ' ' })).toBe('empty_message');

      // Branches.
      await g.call('branchCreate', { repo: dir, name: 'topic', at: sh('rev-parse', 'HEAD~1') });
      await g.call('branchRename', { repo: dir, name: 'topic', to: 'topic2' });
      await g.call('checkout', { repo: dir, name: 'topic2' });
      write(join(dir, 't.txt'), 't\n');
      sh('add', 't.txt');
      sh('commit', '-q', '-m', 'topic');
      const topic = sh('rev-parse', 'HEAD');
      await g.call('branchCreate', { repo: dir, name: 'made', checkout: true });
      expect(sh('branch', '--show-current')).toBe('made');
      await g.call('checkout', { repo: dir, name: 'main' });
      expect(await g.fails('branchDelete', { repo: dir, name: 'topic2' })).toBe('git_failed');
      await g.call('cherryPick', { repo: dir, rev: topic });
      expect(sh('show', 'HEAD:t.txt')).toBe('t');
      await g.call('revert', { repo: dir, rev: 'HEAD' });
      expect((await status())['t.txt']).toBeUndefined();
      await g.call('merge', { repo: dir, ref: 'topic2', noFF: true });
      expect(sh('log', '-1', '--format=%P').split(' ')).toHaveLength(2);
      await g.call('branchDelete', { repo: dir, name: 'topic2' });
      await g.call('branchDelete', { repo: dir, name: 'made', force: true });

      // Reset.
      const before = sh('rev-parse', 'HEAD~1');
      await g.call('reset', { repo: dir, rev: before, mode: 'hard' });
      expect(sh('rev-parse', 'HEAD')).toBe(before);

      // Tags.
      await g.call('tagCreate', { repo: dir, name: 'v1', message: 'release one' });
      await g.call('tagCreate', { repo: dir, name: 'light', at: before.slice(0, 12) });
      expect(sh('cat-file', '-t', 'v1')).toBe('tag');
      await g.call('tagDelete', { repo: dir, name: 'light' });

      // Stashes: the entry must still be the one the page showed.
      write(join(dir, 'a.txt'), 'stash me\n');
      write(join(dir, 'un.txt'), 'untracked\n');
      await g.call('stashPush', { repo: dir, message: '--keep-index', includeUntracked: true });
      expect(Object.keys(await status())).toEqual([]);
      expect(sh('stash', 'list')).toContain('--keep-index');
      const stash = (n: number) => sh('rev-parse', `stash@{${n}}`);
      await g.call('stashApply', { repo: dir, index: 0, hash: stash(0) });
      expect(Object.keys(await status())).toHaveLength(2);
      sh('checkout', '--', 'a.txt');
      rmSync(join(dir, 'un.txt'));
      await g.call('stashPop', { repo: dir, hash: stash(0) });
      sh('stash', 'push', '-q', '-u');
      const shown = stash(0);
      write(join(dir, 'a.txt'), 'another\n');
      sh('stash', 'push', '-q');
      expect(await g.fails('stashDrop', { repo: dir, index: 0, hash: shown })).toBe('stale');
      expect(sh('stash', 'list', '--format=%H').split('\n')).toHaveLength(2);
      await g.call('stashDrop', { repo: dir, index: 1, hash: shown });
      await g.call('stashDrop', { repo: dir, index: 0, hash: stash(0) });
      expect(sh('stash', 'list')).toBe('');
      expect(await g.fails('stashDrop', { repo: dir, index: 3, hash: shown })).toBe('stale');

      // Rebase.
      sh('checkout', '-q', '-b', 're');
      write(join(dir, 'r.txt'), 'r\n');
      sh('add', 'r.txt');
      sh('commit', '-q', '-m', 'r');
      sh('checkout', '-q', 'main');
      write(join(dir, 'm.txt'), 'm\n');
      sh('add', 'm.txt');
      sh('commit', '-q', '-m', 'm');
      sh('checkout', '-q', 're');
      await g.call('rebase', { repo: dir, onto: 'main' });
      expect(sh('rev-parse', 'HEAD~1')).toBe(sh('rev-parse', 'main'));
    },
    SLOW,
  );

  it(
    'push, fetch and pull with bare repositories as remotes; their URLs without credentials; diverged branches',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const home = g.home;
      const sh = (d: string, ...a: string[]) => g!.sh(d, ...a);
      const bare = join(home, 'bare.git');
      sh(home, 'init', '-q', '--bare', '-b', 'main', bare);
      sh(dir, 'remote', 'add', 'origin', bare);
      await g.call('push', { repo: dir, remote: 'origin', branch: 'main', setUpstream: true });
      let info = await g.call('repo', { path: dir });
      expect(info).toMatchObject({ upstream: 'origin/main', ahead: 0, remotes: ['origin'] });
      // Another clone pushes; fetch and pull bring it.
      const other = join(home, 'other');
      sh(home, 'clone', '-q', bare, other);
      sh(other, 'config', 'user.name', 'O');
      sh(other, 'config', 'user.email', 'o@example.com');
      write(join(other, 'o.txt'), 'o\n');
      sh(other, 'add', 'o.txt');
      sh(other, 'commit', '-q', '-m', 'o');
      sh(other, 'push', '-q');
      await g.call('fetch', { repo: dir, remote: 'origin', prune: true });
      expect((await g.call('repo', { path: dir })).behind).toBe(1);
      const main = (await g.call('branches', { repo: dir })).find(
        (b: { name: string; remote?: boolean }) => b.name === 'main' && !b.remote,
      );
      expect(main).toMatchObject({ upstream: 'origin/main', behind: 1 });
      expect(main.ahead).toBeUndefined();
      await g.call('pull', { repo: dir, rebase: true });
      expect(existsSync(join(dir, 'o.txt'))).toBe(true);
      await g.call('tagCreate', { repo: dir, name: 'v2' });
      await g.call('push', { repo: dir, remote: 'origin', tag: 'v2' });
      sh(bare, 'rev-parse', 'refs/tags/v2');
      await g.call('tagDelete', { repo: dir, name: 'v2', remote: 'origin' });
      await g.call('fetch', { repo: dir, all: true });
      await g.call('push', { repo: dir });
      expect(await g.fails('push', { repo: dir, remote: 'upstream' })).toBe('not_found');

      const second = join(home, 'second.git');
      sh(home, 'init', '-q', '--bare', '-b', 'main', second);
      sh(dir, 'remote', 'add', 'second', second);
      sh(dir, 'remote', 'add', 'token', 'https://user:secret@example.com/r.git');
      info = await g.call('repo', { path: dir });
      expect(info.remotes).toHaveLength(3);
      expect(info.remoteUrls).toMatchObject({ second, token: 'https://example.com/r.git' });
      sh(dir, 'remote', 'remove', 'token');
      sh(dir, 'checkout', '-q', '-b', 'topic');
      await g.call('push', { repo: dir, remote: 'second', branch: 'topic', setUpstream: true });
      expect((await g.call('repo', { path: dir })).upstream).toBe('second/topic');
      write(join(other, 's.txt'), 's\n');
      sh(other, 'add', 's.txt');
      sh(other, 'commit', '-q', '-m', 's');
      sh(other, 'push', '-q', second, 'HEAD:refs/heads/topic');
      await g.call('fetch', { repo: dir, remote: 'second' });
      await g.call('pull', { repo: dir, remote: 'second', branch: 'topic', rebase: true });
      expect(existsSync(join(dir, 's.txt'))).toBe(true);
      for (const b of ['-x', 'a:b', 'a..b', 'x y'])
        expect(await g.fails('pull', { repo: dir, remote: 'second', branch: b })).toBe('bad_ref');
      sh(dir, 'checkout', '-q', 'main');

      // Branches that diverged: a pull follows pull.rebase, and without it
      // git's refusal is diverged.
      write(join(other, 'o1'), '1');
      sh(other, 'add', 'o1');
      sh(other, 'commit', '-q', '-m', 'other 1');
      sh(other, 'pull', '-q', '--rebase');
      sh(other, 'push', '-q');
      write(join(dir, 'd1'), '1');
      sh(dir, 'add', 'd1');
      sh(dir, 'commit', '-q', '-m', 'mine 1');
      const [major, minor] = sh(home, '--version').replace('git version ', '').split('.').map(Number);
      if (major > 2 || (major === 2 && minor >= 34)) expect(await g.fails('pull', { repo: dir })).toBe('diverged');
      sh(dir, 'config', 'pull.rebase', 'true');
      await g.call('pull', { repo: dir });
      expect(sh(dir, 'log', '-1', '--format=%P').split(' ')).toHaveLength(1);
      expect(sh(dir, 'rev-parse', 'HEAD~1')).toBe(sh(dir, 'rev-parse', 'origin/main'));
    },
    SLOW,
  );

  it(
    'a remote that asks for a password fails with auth_required instead of waiting for one',
    async () => {
      const srv = createServer((_, res) => {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
        res.end();
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      try {
        let home = '';
        g = await gitRig({
          environ: () => ({ PATH: process.env.PATH ?? '', HOME: home, GIT_ASKPASS: '/bin/echo', SSH_ASKPASS: '/bin/echo', NO_PROXY: '*' }),
        });
        home = g.home;
        const dir = g.newRepo();
        g.sh(dir, 'remote', 'add', 'origin', `http://127.0.0.1:${(srv.address() as { port: number }).port}/repo.git`);
        expect(await g.fails('fetch', { repo: dir, remote: 'origin' })).toBe('auth_required');
      } finally {
        srv.close();
      }
    },
    SLOW,
  );

  it(
    "the web UI's patches of selected ranges (spec/vectors/git/range-patches.json) apply and give the vectors' results",
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      for (const v of vectors as Array<{
        name: string;
        path: string;
        original: string;
        modified: string;
        direction: string;
        patch?: string | null;
        result?: string | null;
      }>) {
        if (v.patch == null) {
          expect([v.name, v.result ?? null]).toEqual([v.name, null]);
          continue;
        }
        write(join(dir, v.path), v.direction === 'backward' ? v.modified : v.original);
        g.sh(dir, 'add', '--', v.path);
        await g.call('applyPatch', { repo: dir, patch: v.patch, cached: true });
        const got = spawnSync('git', ['cat-file', 'blob', `:0:${v.path}`], { cwd: dir, env: setupEnv(g.home), encoding: 'utf8' }).stdout;
        expect([v.name, got]).toEqual([v.name, v.result!]);
      }
    },
    SLOW,
  );
});

describe('nested repositories', () => {
  it(
    'submodules and nested repositories are found; each runs its own actions apart from its parent',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const home = g.home;
      const sh = (d: string, ...a: string[]) => g!.sh(d, ...a);
      const subSrc = join(home, 'sub-src');
      mkdirSync(subSrc);
      sh(subSrc, 'init', '-q', '-b', 'main');
      sh(subSrc, 'config', 'user.name', 'Sub');
      sh(subSrc, 'config', 'user.email', 'sub@example.com');
      write(join(subSrc, 'src/s.txt'), 'sub1\n');
      sh(subSrc, 'add', 'src/s.txt');
      sh(subSrc, 'commit', '-q', '-m', 'sub init');
      sh(dir, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', subSrc, 'libs/sub');
      sh(dir, 'commit', '-q', '-m', 'add submodule');
      const subDir = join(dir, 'libs', 'sub');
      sh(subDir, 'config', 'user.name', 'Sub');
      sh(subDir, 'config', 'user.email', 'sub@example.com');
      const indep = join(dir, 'packages', 'indep');
      mkdirSync(indep, { recursive: true });
      sh(indep, 'init', '-q', '-b', 'main');
      sh(indep, 'config', 'user.name', 'Indep');
      sh(indep, 'config', 'user.email', 'indep@example.com');
      write(join(indep, 'indep.txt'), 'i\n');
      sh(indep, 'add', 'indep.txt');
      sh(indep, 'commit', '-q', '-m', 'indep init');
      const deep = join(indep, 'deep');
      mkdirSync(deep);
      sh(deep, 'init', '-q', '-b', 'main');
      write(join(dir, '.gitignore'), 'ignored-nest/\n');
      sh(dir, 'add', '.gitignore');
      sh(dir, 'commit', '-q', '-m', 'ignore nest');
      const ignoredNest = join(dir, 'ignored-nest');
      mkdirSync(ignoredNest);
      sh(ignoredNest, 'init', '-q', '-b', 'main');

      const info = await g.call('repo', { path: dir });
      expect(info.root).toBe(dir);
      expect(info.parents).toBeUndefined();
      expect(info.nested).toEqual([ignoredNest, subDir, deep, indep].sort());

      // Inside the submodule: it is the root, the parent its parent, its git
      // directory in the parent's .git/modules.
      const subInfo = await g.call('repo', { path: join(subDir, 'src') });
      expect(subInfo).toMatchObject({ root: subDir, parents: [dir] });
      expect(subInfo.gitDir).toEndWith(join('.git', 'modules', 'libs', 'sub'));
      const w0 = await g.call('watch', { repo: subDir });
      await sleep(20);
      write(join(subDir, 'src', 's.txt'), 'sub2\n');
      write(join(subDir, 'extra.txt'), 'e\n');
      expect((await g.call('status', { repo: subDir })).files).toHaveLength(2);
      const parentFiles = (await g.call('status', { repo: dir })).files as Array<{ path: string; submodule?: boolean }>;
      expect(parentFiles.filter((f) => f.path === 'src/s.txt' || f.path === 'extra.txt')).toEqual([]);
      expect(parentFiles.some((f) => f.path === 'libs/sub' && f.submodule)).toBe(true);
      await g.call('stage', { repo: subDir, paths: ['src/s.txt', 'extra.txt'] });
      expect((await g.call('watch', { repo: subDir })).token).not.toBe(w0.token);
      await g.call('commit', { repo: subDir, message: 'sub commit' });
      const subLog = await g.call('log', { repo: subDir });
      expect(subLog.commits.map((c: { subject: string }) => c.subject)).toEqual(['sub commit', 'sub init']);
      expect((await g.call('log', { repo: dir })).commits.some((c: { subject: string }) => c.subject === 'sub commit')).toBe(false);
      await g.call('branchCreate', { repo: subDir, name: 'sub-branch', checkout: true });
      write(join(subDir, 'extra.txt'), 'stashed\n');
      await g.call('stashPush', { repo: subDir, message: 'sub stash' });
      const stashes = await g.call('stashes', { repo: subDir });
      expect(stashes).toHaveLength(1);
      expect(stashes[0].message).toContain('sub stash');
      await g.call('stashPop', { repo: subDir, index: 0, hash: stashes[0].hash });

      const indepInfo = await g.call('repo', { path: indep });
      expect(indepInfo).toMatchObject({ root: indep, parents: [dir], nested: [deep] });
    },
    SLOW,
  );

  it(
    'the search for nested repositories follows no link and keeps within its bounds; .gitmodules leads nowhere outside',
    async () => {
      g = await gitRig();
      const dir = g.newRepo();
      const outside = join(g.home, 'outside-repo');
      mkdirSync(outside);
      g.sh(outside, 'init', '-q', '-b', 'main');
      symlinkSync(outside, join(dir, 'link-out'));
      symlinkSync('.', join(dir, 'loop'));
      mkdirSync(join(dir, 'fake-sym'));
      symlinkSync(join(outside, '.git'), join(dir, 'fake-sym', '.git'));
      let deep = dir;
      for (let i = 0; i < MAX_NESTED_DEPTH + 2; i++) deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
      g.sh(deep, 'init', '-q', '-b', 'main');
      for (let i = 0; i < 20; i++) mkdirSync(join(dir, 'node_modules', `pkg${i}`), { recursive: true });
      const app = join(dir, 'packages', 'app');
      mkdirSync(app, { recursive: true });
      g.sh(app, 'init', '-q', '-b', 'main');
      write(join(dir, '.gitmodules'), '[submodule "bad1"]\n\tpath = ../outside-repo\n[submodule "bad2"]\n\tpath = link-out\n');
      expect((await g.call('repo', { path: dir })).nested).toEqual([app]);
    },
    SLOW,
  );
});
