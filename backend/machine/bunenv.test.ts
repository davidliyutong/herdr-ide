import { expect, test } from 'bun:test';
import { dropForeignRuntimeVars } from './self.ts';
import { FOREIGN_RUNTIME_VARS, withoutForeignRuntimeVars } from '#shared/lib/bunenv.ts';

test("what would make a Bun executable run other code is left out of a child's environment and dropped from the node's own", () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/h', BUN_JSC_X: '1' };
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
