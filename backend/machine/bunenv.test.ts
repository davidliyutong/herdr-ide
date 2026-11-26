import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dropForeignRuntimeVars } from './self.ts';
import { FOREIGN_RUNTIME_VARS, UNSET_FOREIGN_RUNTIME_VARS, withoutForeignRuntimeVars } from '#shared/lib/bunenv.ts';

test("what would make a Bun executable run other code is left out of a child's environment and dropped from the node's own", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/bin',
    HOME: '/h',
    BUN_JSC_X: '1',
    BUN_CONFIG_VERBOSE_FETCH: 'curl',
    BUN_CONFIG_MAX_HTTP_REQUESTS: '1',
  };
  for (const k of FOREIGN_RUNTIME_VARS) env[k] = 'x';
  const out = withoutForeignRuntimeVars(env);
  expect(out).toEqual({ PATH: '/bin', HOME: '/h', BUN_JSC_X: '1' });
  // The input is left as it was.
  expect(env.BUN_OPTIONS).toBe('x');
  dropForeignRuntimeVars(env);
  expect(env).toEqual({ PATH: '/bin', HOME: '/h', BUN_JSC_X: '1' });
  expect([...FOREIGN_RUNTIME_VARS].sort()).toEqual([
    'BUN_BE_BUN',
    'BUN_INSPECT',
    'BUN_INSPECT_CONNECT_TO',
    'BUN_INSPECT_NOTIFY',
    'BUN_INSPECT_PRELOAD',
    'BUN_OPTIONS',
  ]);
});

test('the ssh command unsets them, the configuration variables by their prefix, in a POSIX shell', () => {
  const r = spawnSync('/bin/sh', ['-c', `${UNSET_FOREIGN_RUNTIME_VARS}; env`], {
    env: {
      PATH: '/usr/bin:/bin',
      KEEP: '1',
      BUN_OPTIONS: 'x',
      BUN_INSPECT: 'x',
      BUN_CONFIG_VERBOSE_FETCH: 'curl',
      BUN_CONFIG_X_Y: '1',
      NOT_BUN_CONFIG_Z: '1',
    },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  const names = r.stdout.split('\n').map((l) => l.split('=')[0]);
  expect(names).toContain('KEEP');
  expect(names).toContain('NOT_BUN_CONFIG_Z');
  for (const k of ['BUN_OPTIONS', 'BUN_INSPECT', 'BUN_CONFIG_VERBOSE_FETCH', 'BUN_CONFIG_X_Y']) expect(names).not.toContain(k);
});
