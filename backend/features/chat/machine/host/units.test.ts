import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as chat from '#shared/proto/chatproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import { AGENT_SESSION_VARS, Environment, agentEnv, agentVar, loginEnv, lookPath, parseEnv } from './env.ts';
import { ELISION, capStderr, checkAnswers, checkContent, clip, cutMiddle, cutStrings, fit, masked, promptTitle } from './events.ts';
import { startOptions } from './host.ts';
import { LogFile, teeLogger } from './log.ts';
import { cleanAbs, trustable } from './trust.ts';
import { Client, eventually } from './testing.ts';

setDefaultTimeout(30_000);

const dirs: string[] = [];
const temp = (prefix = 'chu-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the agents' environment", () => {
  test("env's output: variables, values of several lines, bash's functions and what came before dropped", () => {
    const out = 'Welcome!\nPATH=/a:/b\nMULTI=one\ntwo\nBASH_FUNC_f%%=() {  echo hi\n}\nX=1\nX=2\n';
    expect(parseEnv(out)).toEqual({ PATH: '/a:/b', MULTI: 'one\ntwo', X: '2' });
  });

  test("what agents get: the user's variables without the terminal's, ssh's and the agents' sessions'", () => {
    const user = {
      PATH: '/p',
      HOME: '/h',
      HC_TERMINAL_ID: 't',
      HC_SCOPE: 's',
      HC_SOCKET: 'k',
      SSH_CONNECTION: 'x',
      TMUX: 'y',
      TERM_PROGRAM: 'z',
      COLORTERM: 'c',
      PWD: '/old',
      CLAUDECODE: '1',
      HERDR_PANE_ID: '1',
      ANTHROPIC_API_KEY: 'k',
    };
    expect(agentEnv(user, { B: '2', A: '1', 'BAD=': 'x' }, '/work')).toEqual({
      PATH: '/p',
      HOME: '/h',
      HC_SCOPE: 's',
      HC_SOCKET: 'k',
      ANTHROPIC_API_KEY: 'k',
      PWD: '/work',
      A: '1',
      B: '2',
    });
    expect(agentVar('CODEX_HOME')).toBe(true);
    for (const k of AGENT_SESSION_VARS) expect(agentVar(k)).toBe(false);
  });

  test("a program by the PATH's absolute directories, or its absolute path", async () => {
    const d = temp();
    const bin = join(d, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'agent'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'plain'), 'x', { mode: 0o644 });
    expect(await lookPath('agent', { PATH: `relative:${bin}` })).toBe(join(bin, 'agent'));
    expect(await lookPath('plain', { PATH: bin })).toBeNull();
    expect(await lookPath(join(bin, 'agent'), {})).toBe(join(bin, 'agent'));
    expect(await lookPath('./agent', { PATH: bin })).toBeNull();
    expect(await lookPath('', { PATH: bin })).toBeNull();
  });

  test("the login shell's environment, its bounds, and the host's own when it tells none", async () => {
    const d = temp();
    const shell = join(d, 'shell');
    writeFileSync(shell, '#!/bin/sh\necho "from the profile"\nprintf "PATH=/login/bin\\nFROM_LOGIN=yes\\n"\n', { mode: 0o755 });
    const procs = new AgentProcesses();
    const signal = new AbortController().signal;
    expect(await loginEnv(shell, { procs, env: { PATH: '/usr/bin:/bin' }, home: d, signal })).toEqual({
      PATH: '/login/bin',
      FROM_LOGIN: 'yes',
    });
    // No PATH, too much, too slow, a program it left running.
    writeFileSync(shell, '#!/bin/sh\necho X=1\n', { mode: 0o755 });
    await expect(loginEnv(shell, { procs, env: { PATH: '/usr/bin:/bin' }, home: d, signal })).rejects.toThrow('no PATH');
    writeFileSync(shell, '#!/bin/sh\nyes PATH=/x | head -c 200000\n', { mode: 0o755 });
    await expect(
      loginEnv(shell, { procs, env: { PATH: '/usr/bin:/bin' }, home: d, signal, timing: { shellOutput: 1000 } }),
    ).rejects.toThrow('more than');
    writeFileSync(shell, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    await expect(loginEnv(shell, { procs, env: { PATH: '/usr/bin:/bin' }, home: d, signal, timing: { shellMs: 200 } })).rejects.toThrow(
      'did not answer',
    );
    writeFileSync(shell, `#!/bin/sh\nsleep 30 &\necho $! > ${d}/left\necho PATH=/p\n`, { mode: 0o755 });
    expect(await loginEnv(shell, { procs, env: { PATH: '/usr/bin:/bin' }, home: d, signal })).toEqual({ PATH: '/p' });
    const left = Number(readFileSync(join(d, 'left'), 'utf8'));
    await eventually('the program it left is gone', () => {
      try {
        process.kill(left, 0);
        return false;
      } catch {
        return true;
      }
    });
    // The host's own when the shell does not tell; kept, and asked again
    // when a startup file changes.
    let asked = 0;
    const logs: string[] = [];
    const env = new Environment({
      logger: (l) => logs.push(l),
      procs,
      hostEnv: { PATH: '/host', HOME: d },
      home: d,
      lookup: async () => {
        asked++;
        if (asked === 1) throw new Error('no shell');
        return { PATH: `/login${asked}` };
      },
    });
    expect(await env.get(signal)).toEqual({ PATH: '/host', HOME: d });
    expect(logs[0]).toContain('using the host');
    // Kept for the failure's while.
    expect(await env.get(signal)).toEqual({ PATH: '/host', HOME: d });
    expect(asked).toBe(1);
    writeFileSync(join(d, '.profile'), 'export X=1\n');
    expect(await env.get(signal)).toEqual({ PATH: '/login2' });
    expect(await env.get(signal)).toEqual({ PATH: '/login2' });
    expect(asked).toBe(2);
  });
});

describe('trusted folders', () => {
  test('what may not be trusted', async () => {
    const home = temp('chu-home-');
    const proj = join(home, 'proj');
    mkdirSync(proj, { mode: 0o755 });
    expect((await trustable(proj, home)).ino).toBeGreaterThan(0n);
    await expect(trustable('/', home)).rejects.toMatchObject({ code: 'unsafe_folder' });
    await expect(trustable(home, home)).rejects.toMatchObject({ code: 'unsafe_folder' });
    // Above the home.
    await expect(trustable(join(home, '..'), home)).rejects.toMatchObject({ code: 'unsafe_folder' });
    const shared = join(home, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o775);
    await expect(trustable(shared, home)).rejects.toMatchObject({ code: 'unsafe_folder' });
    const open = join(home, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const below = join(open, 'p');
    mkdirSync(below, { mode: 0o755 });
    await expect(trustable(below, home)).rejects.toMatchObject({ code: 'unsafe_folder' });
    // A link: the directory it leads to.
    symlinkSync(proj, join(home, 'link'));
    expect(await trustable(join(home, 'link'), home)).toEqual(await trustable(proj, home));
    await expect(trustable(join(home, 'none'), home)).rejects.toMatchObject({ code: 'bad_request' });
    expect(cleanAbs('/a/b')).toBe(true);
    for (const p of ['', 'a', '/a/', '/a/../b', '/a//b', '/a/.']) expect(cleanAbs(p)).toBe(false);
  });
});

describe('events', () => {
  test("cutMiddle cuts at characters' starts; cutStrings keeps what is short", () => {
    expect(cutMiddle('é'.repeat(10), 5)).toBe('éé' + ELISION + 'éé');
    const raw = { a: 'short', n: 12, b: ['x'.repeat(3 * chat.TOOL_OUTPUT_END)] };
    const cut = cutStrings(raw) as typeof raw;
    expect(cut.a).toBe('short');
    expect(Buffer.byteLength(cut.b[0]!)).toBe(2 * chat.TOOL_OUTPUT_END + Buffer.byteLength(ELISION));
    const small = { a: 'b' };
    expect(cutStrings(small)).toBe(small);
  });

  test('fit: small events as they are, a tool call cut, anything else a notice', () => {
    const ev: chat.Event = {
      t: 'update',
      item: 'm1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    };
    expect(fit(ev)!.ev).toBe(ev);
    const big: chat.Event = {
      t: 'update',
      item: 'm2',
      seq: 3,
      at: 'now',
      update: { sessionUpdate: 'agent_message_chunk', text: 'x'.repeat(chat.MAX_EVENT) },
    };
    const f = fit(big)!;
    expect(f.ev).toMatchObject({ seq: 3, t: 'notice', item: 'm2', at: 'now', params: { t: 'update' } });
    expect((f.ev.params as { bytes: number }).bytes).toBeGreaterThan(chat.MAX_EVENT);
  });

  test('the end of standard error; secret answers masked; titles; clip', () => {
    const e = capStderr({ code: 'x', message: 'm', stderr: 'a'.repeat(chat.MAX_STDERR) + 'éz' });
    expect(Buffer.byteLength(e.stderr!)).toBeLessThanOrEqual(chat.MAX_STDERR);
    expect(e.stderr!.endsWith('éz')).toBe(true);
    expect(masked([{ id: 'pw', question: 'p', secret: true }], { pw: ['hunter2'], other: ['x'] })).toEqual({
      pw: ['••••••'],
      other: ['x'],
    });
    expect(promptTitle([{ type: 'image' }, { type: 'text', text: '\n  first line \nsecond' }])).toBe('first line');
    expect(clip('a\tb\u0001c', 3)).toBe('a b');
    expect(clip('😀😀😀', 2)).toBe('😀😀');
  });

  test("a prompt's content and a question's answers are checked", () => {
    expect(checkContent([{ type: 'text', text: 'hi' }])).toBe(false);
    expect(
      checkContent([
        { type: 'image', mimeType: 'image/png', data: 'aGk=' },
        { type: 'resource_link', uri: 'file:///a' },
      ]),
    ).toBe(true);
    for (const bad of [
      [],
      [{ type: 'text' }],
      [{ type: 'audio' }],
      [{ type: 'image', mimeType: 'text/plain', data: 'aGk=' }],
      [{ type: 'image', mimeType: 'image/png', data: '!!' }],
      ['x'],
    ])
      expect(() => checkContent(bad)).toThrow();
    expect(() =>
      checkContent([{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(chat.MAX_IMAGE + 1).toString('base64') }]),
    ).toThrow('5 MiB');
    const qs: chat.Question[] = [
      { id: 'c', question: '?', options: [{ label: 'red' }, { label: 'blue' }] },
      { id: 'w', question: 'why', allowOther: true },
      { id: 'm', question: 'many', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
    ];
    expect(checkAnswers(qs, { c: ['red'], w: ['because'], m: ['a', 'b'] })).toBeDefined();
    for (const bad of [{}, { c: ['green'] }, { c: ['red', 'blue'] }, { x: ['red'] }, { c: [] }, { w: [''] }])
      expect(() => checkAnswers(qs, bad)).toThrow();
  });
});

describe("the host's log", () => {
  test('started again past its bound, the one before kept, 0600', async () => {
    const base = temp();
    const log = await LogFile.open(base, 100);
    const lines = teeLogger('p: ', (t) => log.write(t));
    for (let i = 0; i < 10; i++) lines(`line ${i} ${'x'.repeat(20)}`);
    await log.close();
    const { readdirSync, statSync } = await import('node:fs');
    const files = readdirSync(base).sort();
    expect(files.some((f) => f.startsWith('chat-host-') && f.endsWith('.log'))).toBe(true);
    expect(files.some((f) => f.startsWith('chat-host.old-'))).toBe(true);
    for (const f of files) expect(statSync(join(base, f)).mode & 0o777).toBe(0o600);
    const cur = readFileSync(
      join(
        base,
        files.find((f) => f.startsWith('chat-host-'))!,
      ),
      'utf8',
    );
    expect(cur.length).toBeLessThanOrEqual(100);
    expect(cur).toContain('line 9');
    expect(cur.startsWith('p: ')).toBe(true);
  });
});

describe("the host's end on the terminal core's signals", () => {
  const HOST = join(import.meta.dir, '..', '..', 'testdata', 'hostmain.ts');

  async function hostWithAgent(env: Record<string, string>) {
    const home = mkdtempSync('/tmp/cs');
    dirs.push(home);
    const run = join(home, 'r');
    const base = join(home, 'b');
    const cwd = join(home, 'w');
    mkdirSync(run, { mode: 0o700 });
    mkdirSync(cwd);
    const child = spawn(process.execPath, [HOST, 'chat-host', '--base', base, '--run', run], {
      env: { ...process.env, HOME: home, TEST_HOST_PROCS: '1', ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    const sock = join(run, chat.SOCKET_NAME);
    let c!: Client;
    await eventually('the host serves', async () => {
      try {
        c = await Client.dial(sock);
        return true;
      } catch {
        return false;
      }
    });
    await c.send({ op: chat.Op.New, kind: 'fake', cwd });
    const res = (await c.next()) as chat.Response;
    c.close();
    expect(res.ok).toBe(true);
    let pid = 0;
    await eventually('the agent runs', async () => {
      const s = await Client.dial(sock);
      await s.send({ op: chat.Op.HostStatus });
      const st = ((await s.next()) as chat.Response).hostStatus;
      s.close();
      pid = st?.sessions?.[0]?.pid ?? 0;
      return pid > 0 && st?.sessions?.[0]?.state === 'idle';
    });
    return { child, exited, pid };
  }

  const groupGone = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  test("SIGTERM ends the agents' groups and the host", async () => {
    const { child, exited, pid } = await hostWithAgent({});
    expect(groupGone(pid)).toBe(false);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    await eventually("the agent's group is gone", () => groupGone(pid), 3000);
  });

  test('an agent that ignores SIGTERM is killed', async () => {
    const { child, exited, pid } = await hostWithAgent({ TEST_HOST_STUBBORN: '1' });
    const t0 = Date.now();
    child.kill('SIGHUP');
    expect(await exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    await eventually("the agent's group is gone", () => groupGone(pid), 3000);
  });
});

test("a new chat's options in their bounds: models non-empty valid values, at most MAX_START_MODELS", () => {
  expect(startOptions(undefined)).toEqual({});
  expect(startOptions({ model: 'm', models: ['n', 'o'], mode: chat.Mode.Plan })).toEqual({
    model: 'm',
    models: ['n', 'o'],
    mode: chat.Mode.Plan,
  });
  expect(startOptions({ models: [] })).toEqual({});
  for (const bad of [
    { models: ['ok', ''] },
    { models: ['a\nb'] },
    { models: 'm' as unknown as string[] },
    { models: [1] as unknown as string[] },
    { models: Array.from({ length: chat.MAX_START_MODELS + 1 }, (_, i) => `m${i}`) },
    { mode: 'yolo' },
  ])
    expect(startOptions(bad)).toBeUndefined();
});
