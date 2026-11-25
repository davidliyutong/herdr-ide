import { afterAll, describe, expect, test } from 'bun:test';
import { extended } from '#shared/testdata/extended.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { tempHome } from '#machine/testing.ts';
import { GIT_TIMING, MAX_RUNS, Slots, execGit, findGit, type GitTiming, type Run } from './run.ts';
import { script } from './testing.ts';

const h = tempHome();
afterAll(() => h.remove());
let n = 0;

/** A directory with a script as git and the runner that runs it. */
function fake(body: string, timing: Partial<GitTiming> = {}) {
  const dir = join(h.home, `fake-${++n}`);
  mkdirSync(dir, { recursive: true });
  const git = script(join(dir, 'git'), body);
  const o = { timing: { ...GIT_TIMING, ...timing }, git: () => git, slots: new Slots(MAX_RUNS) };
  const run = (rn: Run, signal = new AbortController().signal) => execGit(o, { PATH: process.env.PATH ?? '' }, dir, true, rn, signal);
  return { dir, run, o };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Fail ? e.code : String(e);
  }
  return 'ok';
};

/** Kills the processes whose ids a fake git wrote to file, after the test. */
const pidsOf = (file: string): number[] => {
  try {
    return readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const killAll = (file: string) => {
  for (const pid of pidsOf(file))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('a run of git', () => {
  test('over its time is killed with its process group', async () => {
    const pids = join(h.home, 'timeout.pids');
    const f = fake(`sleep 30 & echo $! >> ${pids}\necho $$ >> ${pids}\nsleep 30\n`);
    const start = Date.now();
    expect(await codeOf(f.run({ args: ['status'], timeoutMs: 300 }))).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of pidsOf(pids)) expect(alive(pid)).toBe(false);
  });

  test('ends when the request does', async () => {
    const f = fake('sleep 30\n');
    const ac = new AbortController();
    const p = f.run({ args: ['status'] }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    expect(await codeOf(p)).toBe('cancelled');
  });

  test('printing more than its limit fails too_large, or with keep is cut', async () => {
    const f = fake('while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n');
    expect(await codeOf(f.run({ args: ['log'], limit: 1000 }))).toBe('too_large');
    const res = await f.run({ args: ['status'], limit: 1000, keep: true });
    expect(res.cut).toBe(true);
    expect(res.out.length).toBeGreaterThan(0);
    expect(res.out.length).toBeLessThanOrEqual(1000);
  });

  extended('a program git leaves holding its output does not hold the run, and keeps running (also in a session of its own)', async () => {
    const detach = Bun.which('setsid') ?? (Bun.which('perl') ? `${Bun.which('perl')} -MPOSIX -e 'POSIX::setsid(); exec @ARGV'` : '');
    const cases: Record<string, string> = { 'same group': 'sleep 30' };
    if (detach) cases['own session'] = `${detach} sleep 30`;
    for (const [name, child] of Object.entries(cases)) {
      const pids = join(h.home, `bg-${name.replace(' ', '-')}.pids`);
      try {
        const f = fake(`${child} &\necho $! > ${pids}\necho ok\n`, { waitDelayMs: 200 });
        const start = Date.now();
        const res = await f.run({ args: ['status'] });
        expect([name, res.code, res.out.toString()]).toEqual([name, 0, 'ok\n']);
        expect(Date.now() - start).toBeLessThan(10_000);
        const [pid] = pidsOf(pids);
        expect(alive(pid)).toBe(true);
      } finally {
        killAll(pids);
      }
    }
    if (detach) {
      // Over its time it ends although a child that left the group keeps
      // its output open.
      const pids = join(h.home, 'bg-timeout.pids');
      try {
        const f = fake(`${detach} sleep 30 &\necho $! > ${pids}\nsleep 30\n`, { waitDelayMs: 200 });
        const start = Date.now();
        expect(await codeOf(f.run({ args: ['status'], timeoutMs: 300 }))).toBe('timeout');
        expect(Date.now() - start).toBeLessThan(10_000);
      } finally {
        killAll(pids);
      }
    }
  }, 30_000);

  test('at most MAX_RUNS at once; another waits briefly, then fails busy; the slots are free again after', async () => {
    const pids = join(h.home, 'busy.pids');
    try {
      const f = fake(`echo $$ >> ${pids}\nexec sleep 30\n`, { slotWaitMs: 200 });
      const ac = new AbortController();
      const running = Array.from({ length: MAX_RUNS }, () => codeOf(f.run({ args: ['status'], timeoutMs: 60_000 }, ac.signal)));
      const deadline = Date.now() + 5000;
      while (f.o.slots.taken < MAX_RUNS) {
        if (Date.now() > deadline) throw new Error(`${f.o.slots.taken} runs started`);
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(await codeOf(f.run({ args: ['status'] }))).toBe('busy');
      ac.abort();
      expect(await Promise.all(running)).toEqual(Array(MAX_RUNS).fill('cancelled'));
      expect(f.o.slots.taken).toBe(0);
    } finally {
      killAll(pids);
    }
  });

  test("an exit code the run allows is not a failure; another is git's failure", async () => {
    const f = fake('echo "fatal: bad thing" >&2\nexit 1\n');
    expect((await f.run({ args: ['diff'], ok: [1] })).code).toBe(1);
    expect(await codeOf(f.run({ args: ['diff'] }))).toBe('git_failed');
  });

  test('stdin is given to git', async () => {
    const f = fake('cat\n');
    expect((await f.run({ args: ['apply'], stdin: 'a patch' })).out.toString()).toBe('a patch');
  });

  test('that cannot start fails as what kept it: no git, no directory, too long an argument list', async () => {
    const real = findGit();
    if (!real) return;
    const o = { timing: GIT_TIMING, git: () => real, slots: new Slots(MAX_RUNS) };
    const signal = new AbortController().signal;
    const env = { PATH: process.env.PATH ?? '' };
    expect(await codeOf(execGit(o, env, h.home, true, { args: ['log', 'x'.repeat(4 << 20)] }, signal))).toBe('failed');
    expect(await codeOf(execGit(o, env, join(h.home, 'gone'), true, { args: ['status'] }, signal))).toBe('not_found');
    expect(await codeOf(execGit({ ...o, git: () => join(h.home, 'no-git') }, env, h.home, true, { args: ['status'] }, signal))).toBe(
      'git_missing',
    );
    expect(await codeOf(execGit({ ...o, git: () => null }, env, h.home, true, { args: ['status'] }, signal))).toBe('git_missing');
  });
});
