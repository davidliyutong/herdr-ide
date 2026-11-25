import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, lutimesSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Access } from '#shared/proto/agentproto/index.ts';
import { dirsOf } from '#shared/host/hostdirs.ts';
import { discard } from '#shared/lib/log.ts';
import { cleanEnv, hiddenEnv } from './env.ts';
import { TerminalCore } from './hc.ts';
import { housekeepOnce, ownDirs, pruneHosts, pruneOlder, pruneStaged } from './housekeeping.ts';
import { FDA_SCRIPT, accessOf, filesAccess, privacyStatus, terminalsAccess } from './privacy.ts';
import { FakeCore } from './testdata/fakehc.ts';
import { tempHome } from './testing.ts';

const h = tempHome();
afterAll(() => h.remove());
const DAY = 24 * 60 * 60_000;
const age = (p: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(p, t, t);
};

describe('housekeeping', () => {
  test('old uploads go; this build and this host are touched', async () => {
    const base = join(h.home, '.x');
    const host = join(base, 'hosts', 'me');
    mkdirSync(join(base, 'uploads', 'old'), { recursive: true });
    mkdirSync(join(base, 'uploads', 'new'), { recursive: true });
    mkdirSync(host, { recursive: true });
    const build = join(h.home, '.x', 'agent', 'v1');
    mkdirSync(build, { recursive: true });
    age(join(base, 'uploads', 'old'), 8 * DAY);
    age(build, 10 * DAY);
    age(host, 10 * DAY);
    await housekeepOnce(base, host, discard, new Date(), ownDirs(join(build, 'veldr')));
    expect(existsSync(join(base, 'uploads', 'old'))).toBe(false);
    expect(existsSync(join(base, 'uploads', 'new'))).toBe(true);
    for (const d of [build, host]) expect(Date.now() - statSync(d).mtimeMs).toBeLessThan(DAY);
    expect(ownDirs('/home/u/src/machine/main.ts')).toEqual([]);
  });

  test("other hosts' files go after 30 days unused, but their terminal core's executable until 180", async () => {
    const dir = join(h.home, 'hosts');
    for (const name of ['me', 'idle', 'gone', 'recent']) mkdirSync(join(dir, name, 'hc'), { recursive: true });
    for (const name of ['idle', 'gone']) writeFileSync(join(dir, name, 'node.log'), '');
    age(join(dir, 'idle'), 40 * DAY);
    age(join(dir, 'gone'), 200 * DAY);
    age(join(dir, 'me'), 400 * DAY);
    await pruneHosts(dir, 'me', new Date(), discard);
    expect(existsSync(join(dir, 'idle', 'hc'))).toBe(true);
    expect(existsSync(join(dir, 'idle', 'node.log'))).toBe(false);
    expect(Date.now() - statSync(join(dir, 'idle')).mtimeMs).toBeGreaterThan(39 * DAY);
    expect(existsSync(join(dir, 'gone'))).toBe(false);
    expect(existsSync(join(dir, 'me'))).toBe(true);
    expect(existsSync(join(dir, 'recent'))).toBe(true);
  });
});

describe('housekeeping follows no link', () => {
  test('an old directory a link in hosts/ names keeps its files; an old link in uploads/ goes, its target stays', async () => {
    const outside = join(h.home, 'outside');
    mkdirSync(join(outside, 'keep'), { recursive: true });
    writeFileSync(join(outside, 'keep', 'f'), 'mine');
    // Between 30 and 180 days: the age at which a host directory's files go.
    age(outside, 40 * DAY);
    const dir = join(h.home, 'linked-hosts');
    mkdirSync(dir);
    symlinkSync(outside, join(dir, 'planted'));
    lutimesSync(join(dir, 'planted'), new Date(Date.now() - 400 * DAY), new Date(Date.now() - 400 * DAY));
    await pruneHosts(dir, 'me', new Date(), discard);
    expect(existsSync(join(outside, 'keep', 'f'))).toBe(true);
    const uploads = join(h.home, 'uploads-links');
    mkdirSync(uploads);
    symlinkSync(outside, join(uploads, 'l'));
    lutimesSync(join(uploads, 'l'), new Date(Date.now() - 9 * DAY), new Date(Date.now() - 9 * DAY));
    await pruneOlder(uploads, Date.now() - 7 * DAY, discard);
    expect(existsSync(join(uploads, 'l'))).toBe(false);
    expect(existsSync(join(outside, 'keep', 'f'))).toBe(true);
  });

  test('what an interrupted install left in a build directory goes after an hour', async () => {
    const agents = join(h.home, 'a', 'agent');
    const v = join(agents, 'v1');
    mkdirSync(v, { recursive: true });
    for (const f of ['.upload.123', 'veldr.upload.77', 'veldr', '.upload.new']) writeFileSync(join(v, f), '');
    writeFileSync(join(v, '.upload.456'), '');
    for (const f of ['.upload.123', 'veldr.upload.77', 'veldr', '.upload.new']) age(join(v, f), 2 * 60 * 60_000);
    await pruneStaged([agents], Date.now() - 60 * 60_000, discard);
    expect(existsSync(join(v, '.upload.123'))).toBe(false);
    expect(existsSync(join(v, 'veldr.upload.77'))).toBe(false);
    expect(existsSync(join(v, 'veldr'))).toBe(true);
    expect(existsSync(join(v, '.upload.new'))).toBe(true);
    expect(existsSync(join(v, '.upload.456'))).toBe(true); // recent: an upload running
  });
});

describe('the environment of what the agent starts', () => {
  test("drops terminals', multiplexers' and coding agents' session variables, keeps the product's and agents' configuration", () => {
    const env = cleanEnv({
      PATH: '/bin',
      TMUX: 'x',
      TMUX_PANE: '%1',
      STY: 's',
      ZELLIJ: '0',
      ZELLIJ_SESSION_NAME: 'z',
      HC_SESSION: 'h',
      HERDR_PANE_ID: 'p',
      VELDR_DEBUG: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CONFIG_DIR: '/c',
      CODEX_THREAD_ID: 't',
      CODEX_HOME: '/h',
    });
    expect(env).toEqual({ PATH: '/bin', VELDR_DEBUG: '1', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h' });
    expect(hiddenEnv({ HOME: '/h', OPENAI_API_KEY: 'k', LC_CTYPE: 'C', XDG_DATA_HOME: '/d', SHELL: '/bin/sh' })).toEqual({
      HOME: '/h',
      LC_CTYPE: 'C',
      XDG_DATA_HOME: '/d',
      SHELL: '/bin/sh',
    });
  });
});

describe('Full Disk Access', () => {
  test('EPERM is denied, another error unknown; the first folder that exists is opened', () => {
    expect(accessOf(undefined)).toBe(Access.Granted);
    expect(accessOf('EPERM')).toBe(Access.Denied);
    expect(accessOf('EACCES')).toBe(Access.Unknown);
    mkdirSync(join(h.home, 'f2'));
    expect(filesAccess([join(h.home, 'f1'), join(h.home, 'f2')])).toBe(Access.Granted);
    expect(filesAccess([join(h.home, 'f1')])).toBe(Access.Unknown);
  });

  test('the script tells an open folder, a refused one and none', () => {
    const run = (...dirs: string[]) => Bun.spawnSync(['/bin/sh', '-c', FDA_SCRIPT, 'sh', ...dirs]).exitCode;
    expect(run(join(h.home, 'none'), h.home)).toBe(0);
    expect(run(join(h.home, 'none'))).toBe(3);
  });

  test("the terminals' side runs in the terminal core; without one it is unknown; other systems are unknown", async () => {
    const sock = join(h.home, 'fda.sock');
    expect(await terminalsAccess(sock, [h.home])).toBe(Access.Unknown);
    const core = new FakeCore();
    await core.listen(sock);
    try {
      core.exec = { code: 1 };
      expect(await terminalsAccess(sock, [h.home])).toBe(Access.Denied);
      core.exec = { code: 0 };
      expect(await terminalsAccess(sock, [h.home])).toBe(Access.Granted);
      core.exec = { code: null, timed_out: true };
      expect(await terminalsAccess(sock, [h.home])).toBe(Access.Unknown);
      expect(core.calls.at(-1)?.params.argv).toEqual(['/bin/sh', '-c', FDA_SCRIPT, 'sh', h.home]);
    } finally {
      core.close();
    }
    const hc = new TerminalCore('', dirsOf(join(h.home, '.p')));
    expect(await privacyStatus(h.home, hc, undefined, 'linux')).toEqual({ files: Access.Unknown, terminals: Access.Unknown, hc: hc.bin });
  });
});
