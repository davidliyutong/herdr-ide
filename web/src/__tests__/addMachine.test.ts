import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { addMachineProblem } from '../components/AddMachineDialog';
import { useStore, currentDock, currentLastCode } from '../state/store';
import type { MachineState } from '../lib/machine';

const form = (target: string, label = '') => ({ target, label });

describe('the add machine form', () => {
  it('takes ssh destinations that cannot read as options', () => {
    for (const ok of ['gpu', 'user@gpu.example.com', 'ssh://u@h:2222', ' gpu ']) expect(addMachineProblem(form(ok)), ok).toBeUndefined();
    for (const bad of ['', '  ', '-oProxyCommand=x', 'a b', 'gpü', 'x'.repeat(256)])
      expect(addMachineProblem(form(bad)), bad).toBe('target');
    expect(addMachineProblem(form('gpu', 'Any label at all'))).toBeUndefined();
  });
});

describe('a removed machine', () => {
  it('takes its panel along', () => {
    const m = (id: string) => ({ id, label: id, kind: 'ssh', status: 'ready' }) as unknown as MachineState;
    const s = useStore.getState();
    s.setMachines([m('a'), m('b')]);
    s.openDock({ kind: 'code', m: 'b', folder: '/src' });
    s.setMachines([m('a'), m('b')]);
    expect(currentDock(useStore.getState())?.m).toBe('b');
    s.setMachines([m('a')]);
    const after = useStore.getState();
    expect(currentDock(after)).toBeUndefined();
    expect(currentLastCode(after)).toBeUndefined();
    expect(after.docks).toEqual({});
    expect(after.order).toEqual(['a']);
  });
});
