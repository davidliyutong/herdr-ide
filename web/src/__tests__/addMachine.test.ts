import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { addMachineProblem, addMachineQuery } from '../components/AddMachineDialog';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/herdr';

const form = (target: string, label = '', session = '') => ({ target, label, session });

describe('the add machine form', () => {
  it('takes ssh destinations that cannot read as options', () => {
    for (const ok of ['gpu', 'user@gpu.example.com', 'ssh://u@h:2222', ' gpu ']) expect(addMachineProblem(form(ok)), ok).toBeUndefined();
    for (const bad of ['', '  ', '-oProxyCommand=x', 'a b', 'gpü', 'x'.repeat(256)])
      expect(addMachineProblem(form(bad)), bad).toBe('target');
    expect(addMachineProblem(form('gpu', 'Any label at all', 'work-2'))).toBeUndefined();
    expect(addMachineProblem(form('gpu', '', 'my work'))).toBe('session');
    expect(addMachineProblem(form('gpu', '', '-x'))).toBe('session');
  });

  it('sends trimmed values and leaves out empty ones', () => {
    const q = new URLSearchParams(addMachineQuery(form(' u@gpu ', ' GPU box ', ''), 100, 30));
    expect(Object.fromEntries(q)).toEqual({ target: 'u@gpu', label: 'GPU box', cols: '100', rows: '30' });
    expect(new URLSearchParams(addMachineQuery(form('gpu', '', 'work'), 80, 24)).get('session')).toBe('work');
  });
});

describe('a removed machine', () => {
  it('takes its panel and focus along', () => {
    const m = (id: string) => ({ id, label: id, kind: 'ssh', status: 'ready', saved: true }) as unknown as MachineState;
    const s = useStore.getState();
    s.setMachines([m('a'), m('b')]);
    s.openDock({ kind: 'code', m: 'b', folder: '/src' });
    s.focusPane({ m: 'b', pane: 'p1' });
    s.setMachines([m('a'), m('b')]);
    expect(useStore.getState().dock?.m).toBe('b');
    s.setMachines([m('a')]);
    const after = useStore.getState();
    expect(after.dock).toBeUndefined();
    expect(after.lastCode).toBeUndefined();
    expect(after.focused).toBeUndefined();
    expect(after.order).toEqual(['a']);
  });
});
