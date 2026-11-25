import { expect, test } from 'bun:test';
import { buildBundle, forbiddenInputs } from './bundle.ts';

test('the machine bundle carries the machine side only', async () => {
  const { js, inputs } = await buildBundle('test');
  expect(inputs).toContain('hosts/machine/main.ts');
  expect(inputs.some((p) => p.startsWith('machine/'))).toBe(true);
  expect(forbiddenInputs(inputs)).toEqual([]);
  // No module Bun would resolve at run time (a package left external).
  expect(js).not.toMatch(/\brequire\(["'](?!node:|bun:)[^"']+["']\)/);
  expect(js.length).toBeLessThan(8 << 20);
});

test('what a bundle may not include', () => {
  expect(
    forbiddenInputs([
      'kernel/agent.ts',
      'hosts/bun/main.ts',
      'hosts/common/compose.ts',
      'features/files/core.ts',
      'features/files/testdata/agent.ts',
      'features/files/machine.ts',
      'features/git/machine/read.ts',
      'machine/agent.ts',
      '../web/src/main.ts',
    ]),
  ).toEqual([
    'kernel/agent.ts',
    'hosts/bun/main.ts',
    'hosts/common/compose.ts',
    'features/files/core.ts',
    'features/files/testdata/agent.ts',
    '../web/src/main.ts',
  ]);
});
