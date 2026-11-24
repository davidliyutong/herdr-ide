import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import targetVectors from '../../../spec/vectors/machines/targets.json';
import { addMachineProblem } from '../components/AddMachineDialog';
import { validTarget } from '../lib/machine';

const form = (target: string, label = '') => ({ target, label });

describe('ssh targets', () => {
  // The vectors backend/kernel/machines runs too.
  it('takes the destinations OpenSSH takes, and nothing that reads as an option or holds a shell character', () => {
    expect(targetVectors.accept.length).toBeGreaterThan(20);
    for (const ok of targetVectors.accept) expect(validTarget(ok), ok).toBe(true);
    for (const bad of targetVectors.reject) expect(validTarget(bad), JSON.stringify(bad)).toBe(false);
    // A lone surrogate is no character.
    expect(validTarget('h\ud800')).toBe(false);
  });
});

describe('the add machine form', () => {
  it('checks the trimmed target', () => {
    for (const ok of [' gpu ', 'user+tag@host', 'me@[fe80::1%en0]:2222', 'ssh://u@h:22', 'gpü'])
      expect(addMachineProblem(form(ok)), ok).toBeUndefined();
    for (const bad of ['', '  ', '-oProxyCommand=x', 'a b', 'h`id`', '$(x)', 'x'.repeat(256)])
      expect(addMachineProblem(form(bad)), bad).toBe('target');
    expect(addMachineProblem(form('gpu', 'Any label at all'))).toBeUndefined();
  });
});
