import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { discard } from '#shared/lib/log.ts';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL, chatHostFallbackName } from '#shared/proto/agentproto/index.ts';
import { cleanEnv } from './env.ts';
import { killHidden, runHidden, type HiddenOptions } from './hidden.ts';
import { FakeCore } from './testdata/fakehc.ts';
import { tempHome } from './testing.ts';

const h = tempHome();
afterAll(() => h.remove());
let core: FakeCore;
let o: HiddenOptions;
const sock = join(h.home, 'hc.sock');
const argv = ['/opt/agent', 'chat-host', '--base', '/b', '--run', '/r'];

beforeEach(async () => {
  core = new FakeCore();
  await core.listen(sock);
  o = {
    sock,
    home: h.home,
    environ: cleanEnv({
      HOME: h.home,
      PATH: '/usr/bin',
      LC_ALL: 'C.UTF-8',
      XDG_CONFIG_HOME: '/x/config',
      TMPDIR: '/x/tmp',
      OPENAI_API_KEY: 'sk-secret',
      SSH_AUTH_SOCK: '/tmp/a',
      HC_TERMINAL_ID: 't7',
      TMUX: '/tmp/tmux',
      TERMINFO: '/usr/share/terminfo',
    }),
    logger: discard,
  };
});
afterEach(() => core.close());

test("a helper runs as a hidden terminal, in the user's home, with only the user's variables", async () => {
  await runHidden(CHAT_HOST_NAME, argv, o);
  const run = core.calls.find((c) => c.method === 'terminal.run')!.params;
  const { env, ...rest } = run;
  expect(rest).toEqual({
    argv,
    cwd: h.home,
    name: CHAT_HOST_NAME,
    labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST },
    size: { cols: 80, rows: 24 },
    no_parent: true,
    no_notify: true,
    rm: true,
  });
  expect(env).toEqual({ HOME: h.home, PATH: '/usr/bin', LC_ALL: 'C.UTF-8', XDG_CONFIG_HOME: '/x/config', TMPDIR: '/x/tmp' });
});

test('the name is the lock: the helper holding it is success; a user terminal holding it is left alone for a fallback name', async () => {
  await runHidden(CHAT_HOST_NAME, argv, o);
  await runHidden(CHAT_HOST_NAME, [...argv.slice(0, 1).map(() => '/older/build'), ...argv.slice(1)], o);
  expect(core.calls.filter((c) => c.method === 'terminal.run')).toHaveLength(2);
  expect(core.terminals.size).toBe(1);

  core.terminals.clear();
  core.terminals.set('u1', { address: 'u1', name: CHAT_HOST_NAME, state: 'live', argv: ['/bin/zsh'], labels: {} });
  await runHidden(CHAT_HOST_NAME, argv, o);
  const helper = [...core.terminals.values()].find((t) => t.address !== 'u1')!;
  expect(helper.name).toBe(chatHostFallbackName(1));
  expect(core.terminals.get('u1')).toBeDefined();

  // Kill finds the helper under its fallback name, never the user's; a
  // helper's record removed by the kill itself is its end.
  core.killRemoves = true;
  expect(await killHidden(CHAT_HOST_NAME, argv, false, o)).toBe(true);
  expect(await killHidden(CHAT_HOST_NAME, argv, true, o)).toBe(true);
  expect(core.terminals.has(helper.address)).toBe(false);
  expect(core.terminals.has('u1')).toBe(true);
});

test("another helper's name held by a user terminal is refused, and kill leaves it", async () => {
  core.terminals.set('u1', { address: 'u1', name: 'x-helper', state: 'live', argv: ['/bin/zsh'], labels: {} });
  await expect(runHidden('x-helper', ['/bin/helper'], o)).rejects.toThrow(Fail);
  await expect(killHidden('x-helper', ['/bin/helper'], true, o)).rejects.toThrow(/not the helper/);
  expect(core.terminals.has('u1')).toBe(true);
  expect(await killHidden('nobody', ['/bin/helper'], true, o)).toBe(false);
});

test("the terminal core's other errors are its own; without one the code says so", async () => {
  core.fail.set('terminal.run', 'spawn_failed');
  await expect(runHidden(CHAT_HOST_NAME, argv, o)).rejects.toThrow(/spawn_failed/);
  core.close();
  const err = await runHidden(CHAT_HOST_NAME, argv, { ...o, sock: join(h.home, 'none.sock') }).catch((e) => e);
  expect(err).toBeInstanceOf(Fail);
  expect((err as Fail).code).toBe('no_terminal_core');
});
