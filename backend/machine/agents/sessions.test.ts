// The coding agents' sessions: what resolve finds and from where, what it
// refuses to believe, what stamp follows, where locate finds a transcript
// and what it refuses to open. Every test has a home, an environment, a
// process table and a clock of its own; nothing of the user's is read.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { SessionFrom } from '#shared/proto/agentproto/index.ts';
import {
  CLAUDE_MAX_NAME,
  LIMITS,
  SessionError,
  TIMING,
  agyArgv,
  agyConvId,
  agyResumedArgv,
  claudeArgv,
  claudeEscape,
  codexArgv,
  codexDays,
  decodeSessionMeta,
  rolloutId,
  uuidTime,
  type Found,
  type Proc,
} from './sessions.ts';
import { Files } from './files.ts';
import { parseStat, procfs } from './procs.ts';
import { Resolver } from './sessions.ts';
import { FakeProcfs, TestEnv, local, mkfifo, sid, tempDir, within } from './testing.ts';

const cwd = '/home/dev/project';
const MIN = 60_000;
const HOUR = 60 * MIN;
const found = (id: string, source: string): Found => ({ id, source });

const envs: Array<TestEnv | FakeProcfs> = [];
const newEnv = () => {
  const e = new TestEnv();
  envs.push(e);
  return e;
};
const newProcfs = (boot: number) => {
  const f = new FakeProcfs(boot);
  envs.push(f);
  return f;
};
afterEach(() => {
  for (const e of envs.splice(0)) e.remove();
});

const readAll = async (fh: FileHandle | null): Promise<string> => {
  if (!fh) throw new Error('nothing opened');
  try {
    return (await fh.readFile()).toString('utf8');
  } finally {
    await fh.close();
  }
};

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof SessionError) return e.code;
    throw e;
  }
};

describe('command lines', () => {
  test('claude', () => {
    const [a, b] = [sid(1), sid(2)];
    const cases: Array<[string[], string]> = [
      [['claude', '--session-id', a], a],
      [['claude', `--session-id=${a}`], a],
      [['claude', '--resume', a], a],
      [['claude', `--resume=${a}`], a],
      [['claude', '-r', a], a],
      [['/bin/sh', '/usr/local/bin/claude-wrapper', '--model', 'opus', '-r', a, 'fix it'], a],
      // --fork-session makes a new session: the resumed one is not it.
      [['claude', '--resume', a, '--fork-session'], ''],
      [['claude', '--resume', a, '--fork-session', '--session-id', b], b],
      [['claude', '--continue'], ''],
      [['claude', '--resume'], ''],
      [['claude', '--resume', 'my title'], ''],
      [['claude', '--session-id', a.toUpperCase()], ''],
      [['claude', '--session-id', a + '\n'], ''],
      [['claude', '--', '--session-id', a], ''],
      [['claude', `--session-id ${a}`], ''],
      [[], ''],
    ];
    for (const [argv, want] of cases) expect([argv, claudeArgv(argv)]).toEqual([argv, want]);
  });

  test('codex', () => {
    const a = sid(1);
    const cases: Array<[string[], string]> = [
      [['codex', 'resume', a], a],
      [['codex', '-m', 'gpt-5', 'resume', a, 'go on'], a],
      [['codex', 'exec', 'resume', a], a],
      [['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'resume', a], a],
      [['codex', 'resume', '--last'], ''],
      [['codex', 'resume'], ''],
      [['codex', 'resume', a.toUpperCase()], ''],
      [['codex', `resume ${a}`], ''],
      [['codex', '--', 'resume', a], ''],
      [['codex', 'fork', a], ''],
      [['codex'], ''],
    ];
    for (const [argv, want] of cases) expect([argv, codexArgv(argv)]).toEqual([argv, want]);
  });
});

describe('Claude Code', () => {
  test('its record of the process, /clear and the command line', async () => {
    const e = newEnv();
    const start = e.now - 5 * MIN;
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    const p: Proc = { pid: 100, argv: ['claude'], cwd };
    expect(await e.r.resolve('claude', p)).toBeNull();
    const before = await e.r.stamp('claude', p, found('', ''));
    e.record('', 100, sid(1), cwd, start + 800);
    expect(await e.r.stamp('claude', p, found('', ''))).not.toBe(before);
    const f = (await e.r.resolve('claude', p))!;
    expect(f).toEqual(found(sid(1), SessionFrom.PID));
    const stamp = await e.r.stamp('claude', p, f);
    expect(await e.r.stamp('claude', p, f)).toBe(stamp);

    // /clear rewrites the record with a new session.
    const rec = e.record('', 100, sid(2), cwd, start + 800);
    const later = (Date.now() + MIN) / 1000;
    utimesSync(rec, later, later);
    expect(await e.r.stamp('claude', p, f)).not.toBe(stamp);
    expect(await e.r.resolve('claude', p)).toEqual(found(sid(2), SessionFrom.PID));

    // The command line's session is the initial answer; the record wins
    // when it names another one.
    expect(await e.r.resolve('claude', { ...p, argv: ['claude', '--session-id', sid(2)] })).toEqual(found(sid(2), SessionFrom.Argv));
    expect(await e.r.resolve('claude', { ...p, argv: ['claude', '--session-id', sid(1)] })).toEqual(found(sid(2), SessionFrom.PID));
    unlinkSync(rec);
    expect(await e.r.resolve('claude', { ...p, argv: ['claude', '--session-id', sid(1)] })).toEqual(found(sid(1), SessionFrom.Argv));
  });

  test('records not believed', async () => {
    const start = local(2026, 11, 22, 14, 55);
    const cases: Array<[string, (e: TestEnv) => void]> = [
      ['pid reused', (e) => e.record('', 100, sid(1), cwd, start - 3 * HOUR)],
      ['another pid', (e) => e.write('.claude/sessions/100.json', `{"pid":101,"sessionId":"${sid(1)}"}`)],
      ['not a session id', (e) => e.write('.claude/sessions/100.json', '{"pid":100,"sessionId":"../../etc/passwd"}')],
      ['upper case', (e) => e.write('.claude/sessions/100.json', `{"pid":100,"sessionId":"${sid(1).toUpperCase()}"}`)],
      [
        'too large',
        (e) => e.write('.claude/sessions/100.json', `{"pid":100,"sessionId":"${sid(1)}","pad":"${'x'.repeat(LIMITS.record)}"}`),
      ],
      ['not JSON', (e) => e.write('.claude/sessions/100.json', '{')],
      ['a directory', (e) => mkdirSync(posix.join(e.home, '.claude/sessions/100.json'), { recursive: true })],
    ];
    for (const [name, write] of cases) {
      const e = newEnv();
      e.procs.set(100, { ppid: 1, pgid: 100, start });
      write(e);
      expect([name, await e.r.resolve('claude', { pid: 100, argv: [], cwd })]).toEqual([name, null]);
    }
    // Without a start time to compare (the process is gone), the record is
    // believed.
    const e = newEnv();
    e.record('', 100, sid(1), cwd, start - 3 * HOUR);
    expect((await e.r.resolve('claude', { pid: 100, argv: [], cwd }))?.id).toBe(sid(1));
  });

  test('startedAt must agree with the process’s start', async () => {
    const e = newEnv();
    const start = e.now - MIN;
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    const p: Proc = { pid: 100, argv: [], cwd: '/w' };
    for (const at of [
      '',
      ',"startedAt":"1"',
      `,"startedAt":"${start}"`,
      ',"startedAt":0',
      ',"startedAt":-5',
      ',"startedAt":1e300',
      ',"startedAt":null',
      ',"startedAt":true',
      ',"startedAt":{}',
      `,"startedAt":${e.now - 48 * HOUR}`,
    ]) {
      e.write('.claude/sessions/100.json', `{"pid":100,"sessionId":"${sid(7)}"${at}}`);
      expect([at, await e.r.resolve('claude', p)]).toEqual([at, null]);
    }
    e.write('.claude/sessions/100.json', `{"pid":100,"sessionId":"${sid(7)}","startedAt":${start + 1000}}`);
    expect(await e.r.resolve('claude', p)).toEqual(found(sid(7), SessionFrom.PID));
    // Without a start time to compare (the process is gone), the record is
    // believed, also without startedAt.
    e.procs.delete(100);
    e.write('.claude/sessions/100.json', `{"pid":100,"sessionId":"${sid(7)}"}`);
    expect((await e.r.resolve('claude', p))?.id).toBe(sid(7));
  });

  test('a record is believed only as the user’s own file in a directory no one else writes', async () => {
    const e = newEnv();
    const start = e.now - MIN;
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    const p: Proc = { pid: 100, argv: [], cwd: '/w' };
    const dir = posix.dirname(e.record('', 100, sid(1), '/w', start));
    const believed = async () => (await e.r.resolve('claude', p))?.source === SessionFrom.PID;
    expect(await believed()).toBe(true);
    e.uid++;
    e.renew();
    expect(await believed()).toBe(false);
    e.uid--;
    // A directory the user's primary group may write: the user's own on
    // Linux (a user private group), not on macOS, where it is staff, every
    // user's.
    const linux = process.platform === 'linux';
    const gid = statSync(dir).gid;
    for (const c of [
      { mode: 0o700, ownGroup: true, ok: true, linux: true },
      { mode: 0o755, ownGroup: true, ok: true, linux: true },
      { mode: 0o770, ownGroup: true, ok: false, linux: true },
      { mode: 0o775, ownGroup: true, ok: false, linux: true },
      { mode: 0o770, ownGroup: false, ok: false, linux: false },
      { mode: 0o777, ownGroup: true, ok: false, linux: false },
      { mode: 0o703, ownGroup: true, ok: false, linux: false },
      { mode: 0o1777, ownGroup: true, ok: false, linux: false },
    ]) {
      chmodSync(dir, c.mode);
      e.gid = c.ownGroup ? gid : gid + 1;
      e.renew();
      expect([c, await believed()]).toEqual([c, linux ? c.linux : c.ok]);
    }
    chmodSync(dir, 0o700);
  });

  test('a wrapper’s descendant, within the process group and the bounds', async () => {
    const e = newEnv();
    const start = e.now - MIN;
    // The terminal's program is a shell script; its child is a launcher
    // whose child is Claude Code. A background job of the script is in
    // another process group, and a process deeper than the bound is not
    // looked at.
    for (const [pid, ppid, pgid] of [
      [100, 1, 100],
      [101, 100, 100],
      [102, 101, 100],
      [103, 100, 103],
      [104, 102, 100],
      [105, 104, 100],
    ])
      e.procs.set(pid, { ppid, pgid, start });
    const p: Proc = { pid: 100, argv: ['/bin/sh', '/usr/local/bin/claude'], cwd };
    e.record('', 103, sid(3), cwd, start);
    e.record('', 105, sid(5), cwd, start);
    expect(await e.r.resolve('claude', p)).toBeNull();
    e.record('', 102, sid(2), cwd, start);
    const f = (await e.r.resolve('claude', p))!;
    expect(f).toEqual(found(sid(2), SessionFrom.PID));
    // The stamp watches the descendant's record.
    const stamp = await e.r.stamp('claude', p, f);
    const rec = e.record('', 102, sid(6), cwd, start);
    const later = (Date.now() + MIN) / 1000;
    utimesSync(rec, later, later);
    expect(await e.r.stamp('claude', p, f)).not.toBe(stamp);
    expect(await e.r.candidates(100)).toEqual([100, 101, 102, 104]);
    // A cycle in the table and a wide group stay bounded.
    e.procs = new Map([
      [1000, { ppid: 1001, pgid: 1000 }],
      [1001, { ppid: 1000, pgid: 1000 }],
    ]);
    for (let i = 0; i < 100; i++) e.procs.set(2000 + i, { ppid: 1000, pgid: 1000 });
    const c = await e.r.candidates(1000);
    expect([c.length, c[0]]).toEqual([LIMITS.candidates, 1000]);
  });

  // Claude Code's keys (<pid>.<hex>.key) are never opened, and a FIFO put
  // at a record's name does not block.
  test('keys are never opened, FIFOs never wait', async () => {
    const e = newEnv();
    const start = e.now - MIN;
    for (const pid of [100, 200, 300]) e.procs.set(pid, { ppid: 1, pgid: pid, start });
    const dir = posix.join(e.home, '.claude', 'sessions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const k of ['100.6b1d0e.key', '200.0f3a.key', '300.9c.key', '100.json.key'])
      writeFileSync(posix.join(dir, k), `{"pid":100,"sessionId":"${sid(7)}","startedAt":${start}}`, { mode: 0o600 });
    mkfifo(posix.join(dir, '300.json'));
    e.record('', 200, sid(2), '/other', start);
    e.claudeTranscript('', cwd, sid(1), start, e.now);
    expect(await within(5000, e.r.resolve('claude', { pid: 100, argv: [], cwd }))).toEqual(found(sid(1), SessionFrom.Guess));
    await within(5000, e.r.resolve('claude', { pid: 300, argv: [], cwd }));
    await within(5000, e.r.stamp('claude', { pid: 300, argv: [], cwd }, found('', '')));
    await within(5000, e.r.locate('claude', sid(1)));
    const opened = e.take();
    for (const want of [posix.join(dir, '200.json'), posix.join(dir, '300.json'), dir]) expect(opened).toContain(want);
    expect(e.opened.filter((p) => p.endsWith('.key'))).toEqual([]);
  });

  describe('a guess', () => {
    const start = local(2026, 11, 22, 14, 55);
    const setup = () => {
      const e = newEnv();
      e.procs.set(100, { ppid: 1, pgid: 100, start });
      return e;
    };
    const p: Proc = { pid: 100, argv: ['claude'], cwd };
    const guess = (id: string) => found(id, SessionFrom.Guess);

    test('the newest since the start', async () => {
      const e = setup();
      e.claudeTranscript('', cwd, sid(1), start, start + MIN);
      e.claudeTranscript('', cwd, sid(2), start, start + 2 * MIN);
      e.claudeTranscript('', cwd, sid(3), start, start - HOUR);
      expect(await e.r.resolve('claude', p)).toEqual(guess(sid(2)));
    });
    test('none with another terminal there', async () => {
      const e = setup();
      e.peers = 1;
      e.claudeTranscript('', cwd, sid(1), start, start + MIN);
      expect(await e.r.resolve('claude', p)).toBeNull();
    });
    test('older than the process, within the slack', async () => {
      const e = setup();
      e.claudeTranscript('', cwd, sid(1), start, start - 3000);
      expect(await e.r.resolve('claude', p)).toBeNull();
      e.claudeTranscript('', cwd, sid(1), start, start - 1000);
      expect(await e.r.resolve('claude', p)).toEqual(guess(sid(1)));
    });
    test('not one another running process’s record claims', async () => {
      const e = setup();
      // The terminal core was started from a Claude Code session in the
      // same directory: its transcript is the newest, but its record
      // claims it.
      e.procs.set(50, { ppid: 1, pgid: 50, start: start - HOUR });
      e.record('', 50, sid(9), cwd, start - HOUR);
      e.claudeTranscript('', cwd, sid(9), start, start + 3 * MIN);
      e.claudeTranscript('', cwd, sid(1), start, start + MIN);
      expect(await e.r.resolve('claude', p)).toEqual(guess(sid(1)));
      // A record of a process that is gone claims nothing.
      e.procs.delete(50);
      expect(await e.r.resolve('claude', p)).toEqual(guess(sid(9)));
    });
    test('the same escaped name of another directory', async () => {
      const e = setup();
      e.claudeTranscript('', '/home/dev-project', sid(1), start, start + MIN);
      expect(claudeEscape('/home/dev-project')).toBe(claudeEscape(cwd));
      expect(await e.r.resolve('claude', p)).toBeNull();
    });
    test('a long directory', async () => {
      const e = setup();
      const long = '/home/dev/' + 'deep/'.repeat(50) + 'project';
      const esc = claudeEscape(long);
      // Another long directory with the same first 200 characters, more
      // recently written.
      e.claudeTranscriptIn('', esc.slice(0, CLAUDE_MAX_NAME) + '-abc123', long + 'x', sid(2), start, start + 2 * MIN);
      e.claudeTranscriptIn('', esc.slice(0, CLAUDE_MAX_NAME) + '-1x9z', long, sid(1), start, start + MIN);
      e.claudeTranscriptIn('', esc.slice(0, CLAUDE_MAX_NAME - 1), long, sid(3), start, start + 3 * MIN);
      expect(await e.r.resolve('claude', { pid: 100, argv: [], cwd: long })).toEqual(guess(sid(1)));
    });
    test('not a transcript’s name', async () => {
      const e = setup();
      const f = e.claudeTranscript('', cwd, sid(1), start, start + MIN);
      renameSync(f, posix.join(posix.dirname(f), 'notes.jsonl'));
      expect(await e.r.resolve('claude', p)).toBeNull();
    });
    test('the stamp', async () => {
      const e = setup();
      const s0 = await e.r.stamp('claude', p, found('', ''));
      e.claudeTranscript('', cwd, sid(1), start, start + MIN);
      const s1 = await e.r.stamp('claude', p, found('', ''));
      expect(s1).not.toBe(s0);
      const f = (await e.r.resolve('claude', p))!;
      expect(await e.r.stamp('claude', p, f)).toBe(s1);
    });
    test('symlinked working directory matches real path', async () => {
      const e = setup();
      const base = e.tempDir();
      const real = posix.join(base, 'real-proj');
      const link = posix.join(base, 'link-proj');
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      e.claudeTranscript('', real, sid(1), start, start + MIN);
      expect(await e.r.resolve('claude', { pid: 100, argv: ['claude'], cwd: link })).toEqual(guess(sid(1)));
    });
  });

  test('escaped directory names', () => {
    for (const [i, want] of Object.entries({
      '/home/dev/project': '-home-dev-project',
      '/Users/a.b/my project_1': '-Users-a-b-my-project-1',
      '/tmp/café': '-tmp-caf-',
      '/tmp/\u{1F600}': '-tmp---',
      '/srv/日本': '-srv---',
      'C:\\Users\\x': 'C--Users-x',
      "/a/b-c/../d~e@f+g=h,i;j'": '-a-b-c----d-e-f-g-h-i-j-',
    }))
      expect(claudeEscape(i)).toBe(want);
  });

  // A process's environment (Linux) names its configuration directory,
  // and a child session of another Claude Code keeps no transcript.
  test('from /proc', async () => {
    const e = newEnv();
    const fs = newProcfs(local(2026, 11, 20, 8));
    e.procRoot = fs.root;
    const start = e.now - 2 * MIN;
    const cfg = posix.join(e.tempDir(), 'cfg');
    fs.add(100, 1, 100, 'bash', start, ['PATH=/bin']);
    fs.add(101, 100, 100, '2.1.330', start + 300, ['PATH=/bin', `CLAUDE_CONFIG_DIR=${cfg}`]);
    e.record(cfg, 101, sid(1), cwd, start + 1000);
    expect(await e.r.resolve('claude', { pid: 100, argv: ['bash', './claude'], cwd })).toEqual(found(sid(1), SessionFrom.PID));
    // The start time read from /proc rejects a record of a reused pid.
    e.record(cfg, 101, sid(1), cwd, start - 10 * MIN);
    expect(await e.r.resolve('claude', { pid: 100, argv: [], cwd })).toBeNull();
    fs.add(200, 1, 200, '2.1.330', start, ['CLAUDE_CODE_CHILD_SESSION=1']);
    e.claudeTranscript('', cwd, sid(2), start, start + MIN);
    expect(await e.r.resolve('claude', { pid: 200, argv: [], cwd })).toBeNull();
    fs.add(300, 1, 300, '2.1.330', start, [`HOME=${e.home}`]);
    expect(await e.r.resolve('claude', { pid: 300, argv: [], cwd })).toEqual(found(sid(2), SessionFrom.Guess));
  });

  // A process's own CLAUDE_CONFIG_DIR is searched for its record only when
  // the user's own: one the agent searches too, or the user's and written
  // by no one else.
  test('a process’s own configuration directory', async () => {
    const e = newEnv();
    const fs = newProcfs(e.now - HOUR);
    e.procRoot = fs.root;
    const start = e.now - MIN;
    const planted = e.tempDir();
    fs.add(100, 1, 100, 'node', start, [`CLAUDE_CONFIG_DIR=${planted}`]);
    e.record(planted, 100, sid(9), '/w', start);
    e.write(posix.join('.claude/projects/other', `${sid(9)}.jsonl`), '{}\n');
    const p: Proc = { pid: 100, argv: [], cwd: '/w' };
    expect((await e.r.resolve('claude', p))?.id).toBe(sid(9));
    // Writable by others: nothing in it is believed (and no guess is made
    // from its transcripts).
    e.claudeTranscript(planted, '/w', sid(8), start, e.now);
    for (const mode of [0o777, 0o757, 0o1777]) {
      chmodSync(planted, mode);
      expect([mode, await e.r.resolve('claude', p)]).toEqual([mode, null]);
    }
    chmodSync(planted, 0o700);
    e.uid++;
    e.renew();
    expect(await e.r.resolve('claude', p)).toBeNull();
    e.uid--;
    e.renew();
    // One the agent searches too is the user's whatever its mode.
    e.vars.set('CLAUDE_CONFIG_DIR', planted);
    expect(await e.r.trustedDir(planted, e.r.claudeDirs())).toBe(true);
    expect(await e.r.trustedDir(posix.join(planted, 'not-yet'), e.r.claudeDirs())).toBe(true);
  });

  test('the running process of a session', async () => {
    const e = newEnv();
    const start = e.now - HOUR;
    e.record('', 100, sid(1), '/w', start);
    e.record('', 200, sid(2), '/w', start);
    e.record('', 300, sid(3), '/w', start);
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    e.procs.set(200, { ppid: 1, pgid: 200, start: start + 10 * MIN }); // another process of the pid
    expect(await e.r.claudeRunning(sid(1))).toBe(100);
    for (const id of [sid(2), sid(3), sid(4), '../x']) expect(await e.r.claudeRunning(id)).toBeNull();
    expect(await e.r.claudeRunning(sid(1), (pid) => pid === 100)).toBeNull();
  });
});

test('kinds without sessions', async () => {
  const e = newEnv();
  e.procs.set(100, { ppid: 1, pgid: 100, start: e.now });
  e.record('', 100, sid(1), cwd, e.now);
  for (const k of ['gemini', 'opencode', '', 'nope', 'Claude']) {
    expect(await e.r.resolve(k, { pid: 100, argv: ['claude', '--session-id', sid(1)], cwd })).toBeNull();
    expect(await e.r.stamp(k, { pid: 100, argv: [], cwd: '' }, found('', ''))).toBe('');
  }
});

describe('Codex', () => {
  const start = local(2026, 11, 22, 14, 55);
  const setup = () => {
    const e = newEnv();
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    return e;
  };
  const p: Proc = { pid: 100, argv: ['codex'], cwd };

  test('the command line', async () => {
    const e = setup();
    e.rollout('', sid(2), cwd, start + 10_000, start + MIN);
    expect(await e.r.resolve('codex', { ...p, argv: ['codex', 'resume', sid(1)] })).toEqual(found(sid(1), SessionFrom.Argv));
  });
  test('no file yet', async () => {
    const e = setup();
    e.rollout('', sid(9), cwd, start - HOUR, start - HOUR);
    e.rollout('', sid(8), '/other', start + 1000, start + MIN);
    expect(await e.r.resolve('codex', p)).toBeNull();
  });
  test('exactly one since the start', async () => {
    const e = setup();
    e.rollout('', sid(9), cwd, start - HOUR, start + MIN);
    e.rollout('', sid(1), cwd, start + 20_000, start + MIN);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Start));
    e.peers = 1;
    expect(await e.r.resolve('codex', p)).toBeNull();
  });
  test('two: the newest is a guess', async () => {
    const e = setup();
    e.rollout('', sid(1), cwd, start + 20_000, start + 3 * MIN);
    e.rollout('', sid(2), cwd, start + 40_000, start + 2 * MIN);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Guess));
    e.peers = 1;
    expect(await e.r.resolve('codex', p)).toBeNull();
  });
  test('a subagent’s thread is not a session', async () => {
    const e = setup();
    e.rollout('', sid(1), cwd, start + 20_000, start + MIN);
    e.subRollout('', sid(2), sid(1), cwd, start + 40_000, start + 2 * MIN);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Start));
  });
  test('made just before the process', async () => {
    const e = setup();
    e.rollout('', sid(1), cwd, start - 1500, start + MIN);
    e.rollout('', sid(2), cwd, start - 3000, start + MIN);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Start));
  });
  test('a large session_meta', async () => {
    const e = setup();
    e.rollout('', sid(1), cwd, start + 1000, start + MIN, 200 << 10);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Start));
  });
  test('a name and a session_meta that disagree', async () => {
    const e = setup();
    const f = e.rollout('', sid(1), cwd, start + 1000, start + MIN);
    renameSync(f, f.replace(sid(1), sid(2)));
    expect(await e.r.resolve('codex', p)).toBeNull();
  });
  test('a day after the start, in CODEX_HOME', async () => {
    const e = setup();
    const home = posix.join(e.tempDir(), 'codex');
    e.vars.set('CODEX_HOME', home);
    e.procs.set(100, { ppid: 1, pgid: 100, start: start - 3 * 24 * HOUR });
    e.rollout(home, sid(1), cwd, start - 24 * HOUR, start + MIN);
    expect(await e.r.resolve('codex', p)).toEqual(found(sid(1), SessionFrom.Start));
  });
  test('not a regular file', async () => {
    const e = setup();
    const f = e.rollout('', sid(1), cwd, start + 1000, start + MIN);
    unlinkSync(f);
    symlinkSync(posix.join(e.home, 'elsewhere.jsonl'), f);
    expect(await e.r.resolve('codex', p)).toBeNull();
  });

  test('symlinked working directory and codex resume --last fallback', async () => {
    const e = setup();
    const base = e.tempDir();
    const real = posix.join(base, 'real-codex');
    const link = posix.join(base, 'link-codex');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    e.rollout('', sid(1), real, start + 10_000, start + MIN);
    expect(await e.r.resolve('codex', { pid: 100, argv: ['codex'], cwd: link })).toEqual(found(sid(1), SessionFrom.Start));
    // codex resume --last updates an older rollout created before process start.
    const e2 = setup();
    e2.rollout('', sid(2), real, start - 2 * HOUR, start + MIN);
    expect(await e2.r.resolve('codex', { pid: 100, argv: ['codex', 'resume', '--last'], cwd: link })).toEqual(
      found(sid(2), SessionFrom.Start),
    );
  });

  test('locate accepts extra Codex homes', async () => {
    const e = setup();
    const alt = posix.join(e.tempDir(), 'codex-extra');
    const f = e.rollout(alt, sid(3), cwd, start, start);
    expect(await code(e.r.locate('codex', sid(3)))).toBe('not_found');
    expect((await e.r.locate('codex', sid(3), [alt])).path).toBe(f);
  });

  test('the stamp', async () => {
    const e = setup();
    const s0 = await e.r.stamp('codex', p, found('', ''));
    expect(await e.r.stamp('codex', p, found('', ''))).toBe(s0);
    const f = e.rollout('', sid(1), cwd, start + 1000, start + MIN);
    const s1 = await e.r.stamp('codex', p, found('', ''));
    expect(s1).not.toBe(s0);
    const got = (await e.r.resolve('codex', p))!;
    // A rollout written to again: the answer of start does not change, a
    // guess may.
    utimesSync(f, (start + 2 * MIN) / 1000, (start + 2 * MIN) / 1000);
    expect(await e.r.stamp('codex', p, got)).toBe(s1);
    const g = found(sid(1), SessionFrom.Guess);
    const sg = await e.r.stamp('codex', p, g);
    utimesSync(f, (start + 3 * MIN) / 1000, (start + 3 * MIN) / 1000);
    expect(await e.r.stamp('codex', p, g)).not.toBe(sg);
    e.rollout('', sid(2), cwd, start + MIN, start + MIN);
    expect(await e.r.stamp('codex', p, got)).not.toBe(s1);
  });

  test('the rollout a process holds open (/proc)', async () => {
    const e = newEnv();
    const fs = newProcfs(local(2026, 11, 20, 8));
    e.procRoot = fs.root;
    const t = e.now - MIN;
    const rollout = e.rollout('', sid(1), '/somewhere/else', t - HOUR, t);
    const outside = e.write(`notes/rollout-2026-11-22T14-00-00-${sid(2)}.jsonl`, '{}\n');
    // npm's launcher and the native binary as its child, which holds the
    // rollout open; the launcher holds a rollout-like file outside the
    // sessions directory.
    fs.add(100, 1, 100, 'node', t, ['PATH=/bin'], { '0': '/dev/pts/3', '20': outside });
    fs.add(101, 100, 100, 'codex', t, ['PATH=/bin'], { '0': '/dev/pts/3', '1': '/dev/pts/3', '31': rollout });
    expect(await e.r.resolve('codex', { pid: 100, argv: ['node', 'codex'], cwd })).toEqual(found(sid(1), SessionFrom.FD));
    // A process's own CODEX_HOME.
    const home = posix.join(e.tempDir(), 'ch');
    const r2 = e.rollout(home, sid(3), cwd, t - HOUR, t);
    fs.add(200, 1, 200, 'codex', t, [`CODEX_HOME=${home}`], { '7': r2 });
    expect(await e.r.resolve('codex', { pid: 200, argv: [], cwd })).toEqual(found(sid(3), SessionFrom.FD));
    fs.add(300, 1, 300, 'codex', t, [], { '7': r2 });
    expect(await e.r.resolve('codex', { pid: 300, argv: [], cwd: '/nowhere' })).toBeNull();
    // A subagent's rollout open stands for its session; the session's own,
    // open too, is the answer.
    const sub = e.subRollout('', sid(5), sid(4), cwd, t - HOUR, t);
    fs.add(400, 1, 400, 'codex', t, ['PATH=/bin'], { '8': sub });
    expect(await e.r.resolve('codex', { pid: 400, argv: [], cwd })).toEqual(found(sid(4), SessionFrom.FD));
    const own = e.rollout('', sid(6), cwd, t - HOUR, t);
    const sub2 = e.subRollout('', sid(7), sid(6), cwd, t - HOUR, t);
    fs.add(500, 1, 500, 'codex', t, ['PATH=/bin'], { '8': sub2, '9': own });
    expect(await e.r.resolve('codex', { pid: 500, argv: [], cwd })).toEqual(found(sid(6), SessionFrom.FD));
  });

  // A process's own CODEX_HOME is searched only when the user's own.
  test('a process’s own home', async () => {
    const e = newEnv();
    const fs = newProcfs(e.now - HOUR);
    e.procRoot = fs.root;
    const t = e.now - MIN;
    const planted = e.tempDir();
    const held = e.rollout(planted, sid(9), cwd, t + 1000, t + 2000);
    fs.add(100, 1, 100, 'codex', t, [`CODEX_HOME=${planted}`], { '7': held });
    fs.add(200, 1, 200, 'codex', t, [`CODEX_HOME=${planted}`]);
    const byFD: Proc = { pid: 100, argv: [], cwd };
    const byStart: Proc = { pid: 200, argv: [], cwd };
    expect(await e.r.resolve('codex', byFD)).toEqual(found(sid(9), SessionFrom.FD));
    expect(await e.r.resolve('codex', byStart)).toEqual(found(sid(9), SessionFrom.Start));
    for (const mode of [0o777, 0o757, 0o1777]) {
      chmodSync(planted, mode);
      for (const q of [byFD, byStart]) expect([mode, q.pid, await e.r.resolve('codex', q)]).toEqual([mode, q.pid, null]);
    }
    chmodSync(planted, 0o700);
    e.uid++;
    e.renew();
    expect(await e.r.resolve('codex', byFD)).toBeNull();
    e.uid--;
    e.renew();
    e.vars.set('CODEX_HOME', planted);
    chmodSync(planted, 0o777);
    expect((await e.r.resolve('codex', byFD))?.id).toBe(sid(9));
    chmodSync(planted, 0o700);
  });

  test('dated directories', () => {
    const at = (d: number, h: number) => local(2026, 11, d, h);
    expect(codexDays(at(22, 10), at(22, 15))).toEqual(['2026/11/23', '2026/11/22', '2026/11/21']);
    expect(codexDays(at(20, 10), at(22, 15))).toEqual(['2026/11/23', '2026/11/22', '2026/11/21', '2026/11/20', '2026/11/19']);
    expect(codexDays(at(1, 10), at(22, 15))).toEqual([
      '2026/11/23',
      '2026/11/22',
      '2026/11/21',
      '2026/11/20',
      '2026/11/19',
      '2026/11/18',
      '2026/11/17',
      '2026/11/16',
      '2026/11/15',
      '2026/10/31',
      '2026/11/01',
      '2026/11/02',
    ]);
  });

  test('session_meta', () => {
    const id = sid(1);
    const ts = '2026-11-22T14:55:01.5Z';
    const cases: Array<[string, string, string | null]> = [
      [
        'fixture order',
        `{"timestamp":"2026-11-22T14:55:09Z","ordinal":0,"type":"session_meta","payload":{"id":"${id}","timestamp":"${ts}","cwd":"/p","base_instructions":{"text":"x"}}}`,
        '/p',
      ],
      [
        'payload first',
        `{"payload":{"base_instructions":{"text":"x","n":[1,2,{"a":null}]},"cwd":"/p","timestamp":"${ts}","id":"${id}"},"type":"session_meta"}`,
        '/p',
      ],
      ['line timestamp', `{"timestamp":"${ts}","type":"session_meta","payload":{"id":"${id}","cwd":"/p"}}`, '/p'],
      ['another type', `{"timestamp":"${ts}","type":"event_msg","payload":{"id":"${id}","timestamp":"${ts}","cwd":"/p"}}`, null],
      ['no cwd', `{"type":"session_meta","payload":{"id":"${id}","timestamp":"${ts}"}}`, null],
      ['cut off', `{"type":"session_meta","payload":{"id":"${id}","base_instructions":"xxxx`, null],
      ['not an object', '["session_meta"]', null],
      ['bad time', `{"type":"session_meta","payload":{"id":"${id}","timestamp":"yesterday","cwd":"/p"}}`, null],
      ['empty', '', null],
    ];
    for (const [name, line, want] of cases) {
      const m = decodeSessionMeta(line + '\n{"type":"next"}\n');
      expect([name, m?.cwd ?? null, m?.parent ?? '', m ? m.id === id && m.started > 0 : true]).toEqual([name, want, '', true]);
    }
    // A subagent's thread (Codex 0.171.0): its session in parent_thread_id
    // and session_id; either alone does.
    for (const line of [
      `{"type":"session_meta","payload":{"session_id":"${sid(2)}","id":"${id}","parent_thread_id":"${sid(2)}","timestamp":"${ts}","cwd":"/p","source":{"subagent":"review"}}}`,
      `{"type":"session_meta","payload":{"id":"${id}","parent_thread_id":"${sid(2)}","timestamp":"${ts}","cwd":"/p"}}`,
      `{"type":"session_meta","payload":{"session_id":"${sid(2)}","id":"${id}","timestamp":"${ts}","cwd":"/p"}}`,
    ]) {
      const m = decodeSessionMeta(line);
      expect([m?.id, m?.parent]).toEqual([id, sid(2)]);
    }
    expect(
      decodeSessionMeta(`{"type":"session_meta","payload":{"session_id":"${id}","id":"${id}","timestamp":"${ts}","cwd":"/p"}}`)?.parent,
    ).toBe('');
    // The members resolve reads come first: a line much longer than what
    // is read is enough.
    const long = `{"type":"session_meta","payload":{"id":"${id}","timestamp":"${ts}","cwd":"/p","base_instructions":"${'x'.repeat(3 << 20)}"}}`;
    expect(decodeSessionMeta(long.slice(0, LIMITS.metaLine))?.cwd).toBe('/p');
  });

  test('rollout names', () => {
    const id = sid(7);
    for (const [name, want] of Object.entries({
      [`rollout-2026-11-22T03-43-47-${id}.jsonl`]: id,
      [`rollout-2026-11-22T03-43-47-${id}.jsonl.zst`]: '',
      [`rollout-${id}.jsonl`]: '',
      [`rollout--${id}.jsonl`]: id,
      [`rollout-x${id}.jsonl`]: '',
      [`rollout-2026-${id.toUpperCase()}.jsonl`]: '',
      [`${id}.jsonl`]: '',
      [`rollout-2026-11-22T03-43-47-${id}x.jsonl`]: '',
    }))
      expect([name, rolloutId(name)]).toEqual([name, want]);
  });
});

describe('locate', () => {
  test('ids and kinds checked before any path', async () => {
    const e = newEnv();
    e.claudeTranscript('', cwd, sid(1), e.now, e.now);
    for (const id of [
      '',
      '../x',
      '*',
      sid(1).slice(0, 35),
      sid(1) + '\n',
      sid(1).toUpperCase(),
      '../' + sid(1),
      `${sid(1)}/../${sid(1)}`,
      ' ' + sid(1),
      '00000001-0000-4000-8000-00000000000g',
      sid(1) + '0',
    ])
      for (const kind of ['claude', 'codex', 'gemini']) {
        expect([id, kind, await code(e.r.locate(kind, id))]).toEqual([id, kind, 'bad_id']);
        expect([id, kind, await code(e.r.describe(kind, id))]).toEqual([id, kind, 'bad_id']);
      }
    for (const kind of ['gemini', 'opencode', '', 'Claude']) expect(await code(e.r.locate(kind, sid(1)))).toBe('unknown_kind');
    expect(e.take().length).toBe(0);
  });

  test('a Claude Code transcript and its subagents', async () => {
    const e = newEnv();
    const at = e.now - HOUR;
    const f = e.claudeTranscript('', cwd, sid(1), at, at);
    const sub = posix.join(f.replace(/\.jsonl$/, ''), 'subagents');
    e.write(posix.join(sub, 'agent-b.jsonl'), '{}\n');
    e.write(posix.join(sub, 'agent-a.jsonl'), '{}\n');
    e.write(posix.join(sub, 'notes.txt'), 'x');
    const secret = e.write(posix.join(e.tempDir(), 'secret.jsonl'), '{}\n');
    symlinkSync(secret, posix.join(sub, 'agent-c.jsonl'));
    mkfifo(posix.join(sub, 'agent-d.jsonl'));
    const got = await within(5000, e.r.locate('claude', sid(1)));
    expect(got.path).toBe(f);
    expect(got.subagents).toEqual([posix.join(sub, 'agent-a.jsonl'), posix.join(sub, 'agent-b.jsonl')]);
    expect(await e.r.describe('claude', sid(1))).toEqual({ cwd, started: at });
    expect(await code(e.r.locate('claude', sid(2)))).toBe('not_found');
    // The answer is kept, and checked again: gone, then a link out.
    unlinkSync(f);
    expect(await code(e.r.locate('claude', sid(1)))).toBe('not_found');
    symlinkSync(secret, f);
    e.now += TIMING.missRecheckMs;
    expect(await code(e.r.locate('claude', sid(1)))).toBe('not_found');
  });

  const id = sid(1);
  const fileCases: Array<[string, (e: TestEnv) => string, string]> = [
    [
      'a link out of the root',
      (e) => {
        const out = e.write(posix.join(e.tempDir(), 'x.jsonl'), '{}\n');
        mkdirSync(posix.join(e.home, '.claude/projects/p'), { recursive: true });
        symlinkSync(out, posix.join(e.home, '.claude/projects/p', `${id}.jsonl`));
        return '';
      },
      'not_found',
    ],
    [
      'a linked project directory out of the root',
      (e) => {
        const dir = e.tempDir();
        e.write(posix.join(dir, `${id}.jsonl`), '{}\n');
        mkdirSync(posix.join(e.home, '.claude/projects'), { recursive: true });
        symlinkSync(dir, posix.join(e.home, '.claude/projects/p'));
        return '';
      },
      'not_found',
    ],
    [
      'a link inside the root',
      (e) => {
        const f = e.claudeTranscriptIn('', 'a', cwd, sid(9), e.now, e.now);
        mkdirSync(posix.join(e.home, '.claude/projects/b'), { recursive: true });
        symlinkSync(f, posix.join(e.home, '.claude/projects/b', `${id}.jsonl`));
        return f;
      },
      'ok',
    ],
    [
      'a FIFO',
      (e) => {
        mkfifo(posix.join(e.home, '.claude/projects/p', `${id}.jsonl`));
        return '';
      },
      'not_found',
    ],
    [
      'a directory',
      (e) => {
        mkdirSync(posix.join(e.home, '.claude/projects/p', `${id}.jsonl`), { recursive: true });
        return '';
      },
      'not_found',
    ],
    [
      'compressed only',
      (e) => {
        e.write(`.claude/projects/p/${id}.jsonl.zst`, 'zst');
        return '';
      },
      'compressed',
    ],
    [
      'compressed and plain',
      (e) => {
        e.write(`.claude/projects/p/${id}.jsonl.zst`, 'zst');
        return e.write(`.claude/projects/q/${id}.jsonl`, '{}\n');
      },
      'ok',
    ],
    [
      'two: the most recently modified',
      (e) => {
        e.write(`.claude/projects/a/${id}.jsonl`, '{}\n', e.now - HOUR);
        const newer = e.write(`.config/claude/projects/b/${id}.jsonl`, '{}\n', e.now);
        e.write(`.claude/projects/c/${id}.jsonl`, '{}\n', e.now - 2 * HOUR);
        return newer;
      },
      'ok',
    ],
    [
      'CLAUDE_CONFIG_DIR',
      (e) => {
        const dir = posix.join(e.tempDir(), 'cfg');
        e.vars.set('CLAUDE_CONFIG_DIR', dir);
        return e.write(posix.join(dir, 'projects/p', `${id}.jsonl`), '{}\n');
      },
      'ok',
    ],
    [
      'a configuration directory behind a link',
      (e) => {
        const dir = e.tempDir();
        const f = e.write(posix.join(dir, 'projects/p', `${id}.jsonl`), '{}\n');
        symlinkSync(dir, posix.join(e.home, '.claude'));
        return f;
      },
      'ok',
    ],
    [
      'the projects directory a FIFO',
      (e) => {
        mkfifo(posix.join(e.home, '.claude/projects'));
        return '';
      },
      'not_found',
    ],
  ];
  for (const [name, setup, want] of fileCases)
    test(`Claude Code: ${name}`, async () => {
      const e = newEnv();
      const path = setup(e);
      const p = e.r.locate('claude', id);
      expect(await within(5000, code(p))).toBe(want);
      if (path) expect((await p).path).toBe(path);
    });

  // A version 7 id as Codex 0.170.0 made it, and a random one.
  const v7 = '01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3';
  const made = uuidTime(v7)!;
  test('a version 7 id’s time', () => {
    expect(new Date(made).toISOString()).toBe('2026-11-21T19:43:47.771Z');
    expect(uuidTime(sid(1))).toBeNull();
  });

  test('Codex: dated, version 7', async () => {
    const e = newEnv();
    const f = e.rollout('', v7, cwd, made, made);
    e.rollout('', sid(1), cwd, made, made);
    const got = await e.r.locate('codex', v7);
    expect([got.path, got.subagents]).toEqual([f, []]);
    expect(await e.r.describe('codex', v7)).toEqual({ cwd, started: made });
  });

  test('Codex: subagents’ threads', async () => {
    const e = newEnv();
    const f = e.rollout('', v7, cwd, made, made);
    // A review a second later, one the next day, another session's
    // subagent and another session.
    const later = '01a1ffa2-e81b-7c13-8240-7eb9e6fa29f3';
    const next = '01a20000-0000-7c13-8240-7eb9e6fa29f3';
    const other = '01a1ffa2-f000-7c13-8240-7eb9e6fa29f3';
    const s1 = e.subRollout('', later, v7, cwd, made + 1000, made);
    const s2 = e.subRollout('', next, v7, cwd, made + 30 * HOUR, made);
    e.subRollout('', other, sid(1), cwd, made + 2000, made);
    e.rollout('', sid(1), cwd, made, made);
    e.now = made + 2 * 24 * HOUR;
    const got = await e.r.locate('codex', v7);
    expect([got.path, got.subagents]).toEqual([f, [s1, s2]]);
    for (let i = 0; i < got.subagents.length; i++) await (await got.openSubagent(i))!.close();
  });

  test('Codex: dated elsewhere, walked', async () => {
    const e = newEnv();
    // The version 7 id's day has no match: the other days are read.
    const f = e.rollout('', v7, cwd, new Date(made).setMonth(new Date(made).getMonth() + 2), made);
    expect((await e.r.locate('codex', v7)).path).toBe(f);
    const g = e.rollout('', sid(1), cwd, new Date(made).setFullYear(2025), made);
    expect((await e.r.locate('codex', sid(1))).path).toBe(g);
  });

  test('Codex: archived', async () => {
    const e = newEnv();
    const home = posix.join(e.tempDir(), 'ch');
    e.vars.set('CODEX_HOME', home);
    const f = e.write(posix.join(home, 'archived_sessions', `rollout-2026-01-02T03-04-05-${sid(1)}.jsonl`), '{}\n');
    expect((await e.r.locate('codex', sid(1))).path).toBe(f);
    expect(await e.r.describe('codex', sid(1))).toEqual({ cwd: '', started: null });
  });

  test('Codex: two, the most recently modified', async () => {
    const e = newEnv();
    e.rollout('', sid(1), cwd, made, made);
    const newer = e.write(`.codex/archived_sessions/rollout-2026-01-02T03-04-05-${sid(1)}.jsonl`, '{}\n', made + HOUR);
    expect((await e.r.locate('codex', sid(1))).path).toBe(newer);
  });

  test('Codex: compressed only', async () => {
    const e = newEnv();
    const f = e.rollout('', v7, cwd, made, made);
    renameSync(f, f + '.zst');
    expect(await code(e.r.locate('codex', v7))).toBe('compressed');
  });

  test('Codex: not regular, or outside', async () => {
    const e = newEnv();
    const f = e.rollout('', v7, cwd, made, made);
    unlinkSync(f);
    mkfifo(f);
    const dir = posix.dirname(f);
    mkdirSync(posix.join(dir, `rollout-x-${sid(1)}.jsonl`));
    const out = e.write(posix.join(e.tempDir(), 'o.jsonl'), '{}\n');
    symlinkSync(out, posix.join(dir, `rollout-y-${sid(2)}.jsonl`));
    for (const x of [v7, sid(1), sid(2)]) expect([x, await within(5000, code(e.r.locate('codex', x)))]).toEqual([x, 'not_found']);
  });

  test('the user’s own home and environment by default', async () => {
    const e = newEnv();
    const was = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = e.home;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = '~/ch';
    try {
      const f = e.claudeTranscript('', cwd, sid(1), Date.now(), Date.now());
      const g = e.rollout(posix.join(e.home, 'ch'), sid(2), cwd, Date.now(), Date.now());
      const r = new Resolver();
      expect((await r.locate('claude', sid(1))).path).toBe(f);
      expect((await r.locate('codex', sid(2))).path).toBe(g);
    } finally {
      for (const [k, v] of Object.entries(was))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  test('a hard link is no transcript', async () => {
    const e = newEnv();
    const x = sid(2);
    const out = e.write('outside-secret', 'SECRET\n');
    const dir = posix.join(e.home, '.claude/projects/p');
    mkdirSync(dir, { recursive: true });
    linkSync(out, posix.join(dir, `${x}.jsonl`));
    expect(await code(e.r.locate('claude', x))).toBe('not_found');
    expect(await code(e.r.openLocated('claude', x))).toBe('not_found');
    // A subagent's transcript linked the same way is left out.
    const main = e.claudeTranscript('', cwd, sid(3), e.now, e.now);
    const sub = posix.join(main.replace(/\.jsonl$/, ''), 'subagents');
    e.write(posix.join(sub, 'agent-a.jsonl'), '{}\n');
    linkSync(out, posix.join(sub, 'agent-b.jsonl'));
    expect((await e.r.locate('claude', sid(3))).subagents.map((s) => posix.basename(s))).toEqual(['agent-a.jsonl']);
    // Once the file has one name again, it is located.
    unlinkSync(out);
    unlinkSync(posix.join(sub, 'agent-b.jsonl'));
    e.now += TIMING.missRecheckMs;
    expect(await code(e.r.locate('claude', x))).toBe('ok');
  });

  test('another user’s transcript is not located', async () => {
    const e = newEnv();
    e.claudeTranscript('', cwd, sid(1), e.now, e.now);
    e.uid++;
    expect(await code(e.r.locate('claude', sid(1)))).toBe('not_found');
  });

  describe('misses', () => {
    test('Codex: remembered, then rechecked where rollouts are made, walked again after their time', async () => {
      const e = newEnv();
      // Many dated directories, read only by the search that walks them.
      for (let i = 0; i < 40; i++) e.rollout('', sid(1000 + i), cwd, local(2025, 1 + Math.floor(i / 28), 1 + (i % 28), 12), undefined);
      e.take();
      const walked = (opened: string[]) => opened.some((p) => p.includes('/2025/'));
      const x = sid(1);
      expect(await code(e.r.locate('codex', x))).toBe('not_found');
      expect(walked(e.take())).toBe(true);
      // Asked again at once: nothing is read.
      for (let i = 0; i < 100; i++) expect(await code(e.r.locate('codex', x))).toBe('not_found');
      expect(e.take()).toEqual([]);
      // After missRecheckMs: only where rollouts are made.
      e.now += TIMING.missRecheckMs;
      await code(e.r.locate('codex', x));
      const o = e.take();
      expect(o.length).toBeGreaterThan(0);
      expect(walked(o)).toBe(false);
      // A rollout made now is found at the next recheck.
      const f = e.rollout('', x, cwd, e.now, e.now);
      expect(await code(e.r.locate('codex', x))).toBe('not_found');
      e.now += TIMING.missRecheckMs;
      expect((await e.r.locate('codex', x)).path).toBe(f);
      // One that existed in a directory only the walk reads is found once
      // the miss expires.
      const old = e.rollout('', sid(2), cwd, local(2025, 3, 3, 12), undefined);
      renameSync(old, old + '.hidden');
      await code(e.r.locate('codex', sid(2)));
      renameSync(old + '.hidden', old);
      e.now += TIMING.missRecheckMs;
      expect(await code(e.r.locate('codex', sid(2)))).toBe('not_found');
      e.now += TIMING.missTtlMs;
      expect((await e.r.locate('codex', sid(2))).path).toBe(old);
    });

    test('Claude Code: remembered, rechecked, compressed, and a clock that went back', async () => {
      const e = newEnv();
      for (let i = 0; i < 20; i++) e.claudeTranscriptIn('', `p${i}`, cwd, sid(100 + i), e.now, e.now);
      e.take();
      expect(await code(e.r.locate('claude', sid(1)))).toBe('not_found');
      e.take();
      const f = e.claudeTranscriptIn('', 'p3', cwd, sid(1), e.now, e.now);
      expect(await code(e.r.locate('claude', sid(1)))).toBe('not_found');
      expect(e.take()).toEqual([]);
      // A caller asking once a second finds it at the next ask.
      e.now += TIMING.missRecheckMs;
      expect((await e.r.locate('claude', sid(1))).path).toBe(f);
      // Compressed only: remembered as such.
      e.write(`.claude/projects/p1/${sid(2)}.jsonl.zst`, 'zst');
      for (let i = 0; i < 2; i++) expect(await code(e.r.locate('claude', sid(2)))).toBe('compressed');
      // A clock that went back does not keep a miss.
      await code(e.r.locate('claude', sid(3)));
      const f3 = e.claudeTranscriptIn('', 'p4', cwd, sid(3), e.now, e.now);
      e.now -= HOUR;
      expect((await e.r.locate('claude', sid(3))).path).toBe(f3);
    });

    test('bounded, the expired ones first', async () => {
      const e = newEnv();
      for (let i = 0; i < LIMITS.misses + 50; i++) {
        await code(e.r.locate('claude', sid(i)));
        e.now += 1;
      }
      expect([e.r.misses.size, e.r.misses.has(`claude/${sid(0)}`), e.r.misses.has(`claude/${sid(LIMITS.misses + 49)}`)]).toEqual([
        LIMITS.misses,
        false,
        true,
      ]);
      e.now += TIMING.missTtlMs;
      await code(e.r.locate('claude', sid(LIMITS.misses + 50)));
      expect(e.r.misses.size).toBe(1);
    });
  });
});

describe('opening', () => {
  test('only a regular file of the user’s own with one name, with no link on its path', async () => {
    const dir = tempDir();
    try {
      const files = new Files();
      const f = posix.join(dir, 'f');
      writeFileSync(f, 'x');
      await (await files.openStrict(f)).fh.close();
      mkfifo(posix.join(dir, 'fifo'));
      symlinkSync(f, posix.join(dir, 'link'));
      mkdirSync(posix.join(dir, 'sub'));
      writeFileSync(posix.join(dir, 'sub', 'g'), 'x');
      symlinkSync(posix.join(dir, 'sub'), posix.join(dir, 'linked'));
      writeFileSync(posix.join(dir, 'two'), 'x');
      linkSync(posix.join(dir, 'two'), posix.join(dir, 'two-again'));
      for (const p of [
        posix.join(dir, 'fifo'),
        dir,
        posix.join(dir, 'link'),
        '/dev/null',
        posix.join(dir, 'missing'),
        // A link on the way, not only at the end.
        posix.join(dir, 'linked', 'g'),
        // A hard link: the file has another name, maybe outside.
        posix.join(dir, 'two'),
        // Not absolute and clean.
        'f',
        dir + '/./f',
        dir + '/sub/../f',
        dir + '/f/',
      ]) {
        const opened = await within(
          5000,
          files.openStrict(p).then(
            async (o) => (await o.fh.close(), true),
            () => false,
          ),
        );
        expect([p, opened]).toEqual([p, false]);
      }
      // A file of another user.
      expect(
        await new Files({ uid: process.getuid!() + 1 }).openStrict(f).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A directory above the transcript, then the transcript itself, swapped
  // after locate for links out of the root: nothing opens the file
  // outside.
  test('after a swap', async () => {
    const e = newEnv();
    const x = sid(1);
    e.write(`.claude/projects/p/${x}.jsonl`, 'inside\n');
    const got = await e.r.locate('claude', x);
    const outside = e.tempDir();
    e.write(posix.join(outside, `${x}.jsonl`), 'OUTSIDE\n');
    const proj = posix.join(e.home, '.claude/projects/p');
    renameSync(proj, proj + '.old');
    symlinkSync(outside, proj);
    expect(
      await e.r.files.openStrict(got.path).then(
        () => 'opened',
        () => 'refused',
      ),
    ).toBe('refused');
    expect(await got.open()).toBeNull();
    // Located again: the transcript where it now is, inside the root.
    e.now += TIMING.missRecheckMs;
    const { fh, file: again } = await e.r.openLocated('claude', x);
    expect([await readAll(fh), again.path]).toEqual(['inside\n', posix.join(proj + '.old', `${x}.jsonl`)]);
    // The transcript itself swapped for a link out.
    unlinkSync(again.path);
    symlinkSync(posix.join(outside, `${x}.jsonl`), again.path);
    expect(
      await e.r.files.openStrict(again.path).then(
        () => 'opened',
        () => 'refused',
      ),
    ).toBe('refused');
    expect(await again.open()).toBeNull();
    expect(await code(e.r.openLocated('claude', x))).toBe('not_found');
  });

  // A located transcript replaced by another file at the same name:
  // open refuses it, openLocated locates it again.
  test('replaced', async () => {
    const e = newEnv();
    const x = sid(1);
    const p = e.write(`.claude/projects/p/${x}.jsonl`, 'first\n');
    const got = await e.r.locate('claude', x);
    expect(await readAll(await got.open())).toBe('first\n');
    renameSync(e.write(p + '.new', 'second\n'), p);
    expect(await got.open()).toBeNull();
    const { fh, file: again } = await e.r.openLocated('claude', x);
    expect([await readAll(fh), again.path]).toEqual(['second\n', got.path]);
  });

  test('subagents', async () => {
    const e = newEnv();
    const main = e.claudeTranscript('', cwd, sid(1), e.now, e.now);
    const sub = posix.join(main.replace(/\.jsonl$/, ''), 'subagents');
    e.write(posix.join(sub, 'agent-a.jsonl'), 'a\n');
    e.write(posix.join(sub, 'agent-b.jsonl'), 'b\n');
    const { fh, file: got } = await e.r.openLocated('claude', sid(1));
    await fh.close();
    expect(got.subagents.length).toBe(2);
    expect(await readAll(await got.openSubagent(0))).toBe('a\n');
    expect(await readAll(await got.openSubagent(1))).toBe('b\n');
    for (const i of [-1, 2, 0.5]) expect(await got.openSubagent(i)).toBeNull();
    // Swapped for a link out, or for another file: refused.
    const out = e.write(posix.join(e.tempDir(), 'x.jsonl'), 'OUTSIDE\n');
    unlinkSync(got.subagents[0]);
    symlinkSync(out, got.subagents[0]);
    renameSync(e.write(got.subagents[1] + '.new', 'other\n'), got.subagents[1]);
    for (const i of [0, 1]) expect(await got.openSubagent(i)).toBeNull();
  });
});

describe('processes', () => {
  test('a fake /proc', async () => {
    const boot = local(2026, 11, 20, 8);
    const fs = newProcfs(boot);
    const start = boot + 49 * HOUR + 1230;
    // A command name with parentheses, spaces and digits in it.
    fs.add(42, 7, 40, ') 9 9 (x y', start, ['A=1', 'CLAUDE_CONFIG_DIR=/c=d', 'CODEX_HOME=', 'junk'], { '3': '/a/b', '4': 'relative' });
    fs.add(43, 42, 40, 'sh', start, null);
    mkdirSync(posix.join(fs.root, 'self'));
    writeFileSync(posix.join(fs.root, '44'), 'not a process');
    const files = new Files();
    const ps = procfs(fs.root, files);
    expect(parseStat(await readFile(posix.join(fs.root, '42', 'stat'), 'latin1'))).toEqual({
      ppid: 7,
      pgid: 40,
      start: 49 * 3600 * 100 + 123,
    });
    expect(await ps.start(42)).toBe(start);
    expect(await ps.start(99)).toBeNull();
    const table = (await ps.table(42)).sort((a, b) => a.pid - b.pid);
    expect(table).toEqual([
      { pid: 42, ppid: 7, pgid: 40 },
      { pid: 43, ppid: 42, pgid: 40 },
    ]);
    expect(await ps.environ(42)).toEqual(
      new Map([
        ['CLAUDE_CONFIG_DIR', '/c=d'],
        ['CODEX_HOME', ''],
      ]),
    );
    expect(await ps.environ(43)).toBeNull();
    expect(await ps.fds(42)).toEqual(['/a/b']);
    expect(await new Resolver({ procs: ps }).candidates(42)).toEqual([42, 43]);
    // A stat without btime, a stat line cut short.
    writeFileSync(posix.join(fs.root, 'stat'), 'cpu 1 2\n');
    expect(await ps.start(42)).toBe(start); // the boot time is read once
    expect(await procfs(fs.root, files).start(42)).toBeNull();
    writeFileSync(posix.join(fs.root, '43', 'stat'), '43 (sh) S 42 40');
    expect(parseStat('43 (sh) S 42 40')).toBeNull();
  });

  // The test's own process, read from the system (sysctl on macOS, /proc
  // on Linux).
  test('this process', async () => {
    const r = new Resolver();
    const start = (await r.startOf(process.pid))!;
    // /proc's boot time is in whole seconds: a start a little after now is
    // a rounding.
    expect(start).toBeLessThan(Date.now() + 2000);
    expect(Date.now() - start).toBeLessThan(HOUR);
    const table = await r.procs.table(process.pid);
    expect(table.some((x) => x.pid === process.pid && x.ppid === process.ppid)).toBe(true);
    expect((await r.candidates(process.pid))[0]).toBe(process.pid);
    expect(await r.startOf(2 ** 30)).toBeNull();
  });
});

describe('Antigravity (agy)', () => {
  const start = local(2026, 11, 22, 14, 55);

  function writeSummaries(
    e: TestEnv,
    rows: Array<{
      id: string;
      workspaces: string[];
      parent?: string;
      depth?: number;
      status?: string;
      notIdle?: number;
      killed?: number;
      modified: string;
    }>,
    sub = '.gemini/antigravity-cli',
  ) {
    const dbPath = posix.join(e.home, sub, 'conversation_summaries.db');
    e.write(dbPath, '');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        workspace_uris text NOT NULL,
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT '',
        not_fully_idle numeric NOT NULL DEFAULT 0,
        killed numeric NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL
      )
    `);
    const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
      ins.run(r.id, JSON.stringify(r.workspaces), r.parent ?? '', r.depth ?? 0, r.status ?? '', r.notIdle ?? 0, r.killed ?? 0, r.modified);
    }
    db.close();
  }

  function writeConvDb(e: TestEnv, id: string, modMs?: number, sub = '.gemini/antigravity-cli'): string {
    const p = posix.join(e.home, sub, 'conversations', `${id}.db`);
    e.write(p, '');
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob)');
    db.close();
    if (modMs !== undefined) utimesSync(p, modMs / 1000, modMs / 1000);
    return p;
  }

  test('command lines and conversation db names', () => {
    const a = sid(1);
    expect(agyArgv(['agy', '--conversation', a])).toBe(a);
    expect(agyArgv(['agy', `--conversation=${a}`])).toBe(a);
    expect(agyArgv(['agy', '--resume', a])).toBe(a);
    expect(agyArgv(['agy', `--resume=${a}`])).toBe(a);
    expect(agyArgv(['agy', '-r', a])).toBe(a);
    expect(agyArgv(['agy', '--', '--resume', a])).toBe('');
    expect(agyArgv(['agy', '--resume', a.toUpperCase()])).toBe('');
    expect(agyResumedArgv(['agy', '--continue'])).toBe(true);
    expect(agyResumedArgv(['agy', '-c'])).toBe(true);
    expect(agyResumedArgv(['agy'])).toBe(false);
    expect(agyConvId(`${a}.db`)).toBe(a);
    expect(agyConvId(`${a}.db-wal`)).toBe(a);
    expect(agyConvId(`${a}.db-shm`)).toBe(a);
    expect(agyConvId('other.db')).toBe('');
  });

  test('resolves via argv, open /proc fd (mapping subagent to parent), conversation_summaries.db start/guess/resumed, locate and describe', async () => {
    const e = newEnv();
    e.procs.set(100, { ppid: 1, pgid: 100, start });
    const s1 = sid(1);
    const s2 = sid(2);
    const sSub = sid(3);

    // Argv wins immediately.
    expect(await e.r.resolve('agy', { pid: 100, argv: ['agy', '--resume', s1], cwd })).toEqual(found(s1, SessionFrom.Argv));

    // conversation_summaries.db: single fresh root session -> SessionFrom.Start; subagents & killed skipped.
    const db1 = writeConvDb(e, s1, start + 1000);
    writeConvDb(e, sSub, start + 2000);
    writeSummaries(e, [
      { id: s1, workspaces: [`file://${cwd}`], modified: new Date(start + 1000).toISOString().replace('T', ' ').replace('Z', '+00:00') },
      { id: sSub, workspaces: [`file://${cwd}`], parent: s1, depth: 1, modified: new Date(start + 2000).toISOString() },
      { id: sid(9), workspaces: [`file://${cwd}`], killed: 1, modified: new Date(start + 3000).toISOString() },
    ]);
    const stampBefore = await e.r.stamp('agy', { pid: 100, argv: ['agy'], cwd }, found('', ''));
    expect(stampBefore).not.toBe('');
    expect(await e.r.resolve('agy', { pid: 100, argv: ['agy'], cwd })).toEqual(found(s1, SessionFrom.Start));

    // locate & describe work for agy via conversation_summaries.db (even with empty trajectory_metadata_blob).
    const located = await e.r.locate('agy', s1);
    expect(located.path).toBe(db1);
    const info = await e.r.describe('agy', s1);
    expect(info.cwd).toBe(cwd);
    expect(info.started).toBeGreaterThan(0);

    // Older session before start: ignored for plain `agy`, matched as Guess for `agy --continue`.
    const oldTime = start - 2 * HOUR;
    const e2 = newEnv();
    e2.procs.set(100, { ppid: 1, pgid: 100, start });
    writeConvDb(e2, s2, oldTime);
    writeSummaries(e2, [{ id: s2, workspaces: [`file://${cwd}`], modified: new Date(oldTime).toISOString() }]);
    expect(await e2.r.resolve('agy', { pid: 100, argv: ['agy'], cwd })).toBeNull();
    expect(await e2.r.resolve('agy', { pid: 100, argv: ['agy', '--continue'], cwd })).toEqual(found(s2, SessionFrom.Guess));

    // Open FD on Linux (/proc/<pid>/fd) maps a subagent DB back to its root parent conversation.
    const pf = newProcfs(start - HOUR);
    const e3 = newEnv();
    e3.procRoot = pf.root;
    const subDb = writeConvDb(e3, sSub, start);
    writeConvDb(e3, s1, start);
    writeSummaries(e3, [
      { id: s1, workspaces: [`file://${cwd}`], modified: new Date(start).toISOString() },
      { id: sSub, workspaces: [`file://${cwd}`], parent: s1, depth: 1, modified: new Date(start).toISOString() },
    ]);
    pf.add(200, 1, 200, 'agy', start, [], { '5': `${subDb}-wal` });
    expect(await e3.r.resolve('agy', { pid: 200, argv: ['agy'], cwd })).toEqual(found(s1, SessionFrom.FD));

    // A symlinked conversation_summaries.db file itself is refused by safeOpenDb.
    const e4 = newEnv();
    e4.procs.set(100, { ppid: 1, pgid: 100, start });
    const outsideDir = e4.tempDir();
    writeSummaries(e4, [{ id: s1, workspaces: [`file://${cwd}`], modified: new Date(start + 1000).toISOString() }], outsideDir);
    const agyDir = posix.join(e4.home, '.gemini/antigravity-cli');
    mkdirSync(agyDir, { recursive: true, mode: 0o700 });
    symlinkSync(posix.join(outsideDir, 'conversation_summaries.db'), posix.join(agyDir, 'conversation_summaries.db'));
    expect(await e4.r.resolve('agy', { pid: 100, argv: ['agy'], cwd })).toBeNull();
  });

  test('Claude Code readRecord succeeds when ~/.claude is a symlink to a private directory, but still rejects a symlinked record file', async () => {
    const e = newEnv();
    const startT = e.now - MIN;
    e.procs.set(100, { ppid: 1, pgid: 100, start: startT });
    const target = posix.join(e.tempDir(), 'real-claude');
    e.record(target, 100, sid(5), cwd, startT);
    symlinkSync(target, posix.join(e.home, '.claude'));
    expect(await e.r.resolve('claude', { pid: 100, argv: ['claude'], cwd })).toEqual(found(sid(5), SessionFrom.PID));

    // Replacing the record file itself with a symlink must still be refused.
    const recPath = posix.join(target, 'sessions', '100.json');
    const outside = e.write(posix.join(e.tempDir(), 'outside.json'), readFileSync(recPath, 'utf8'));
    unlinkSync(recPath);
    symlinkSync(outside, recPath);
    expect(await e.r.resolve('claude', { pid: 100, argv: ['claude'], cwd })).toBeNull();
  });
});
