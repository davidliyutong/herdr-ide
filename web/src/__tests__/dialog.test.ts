// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completionParts, confirmDialog, newWorkspaceDialog, useDialog } from '../dialog';

const api = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { useStore } from '../state/store';
import { initSeen } from '../seen';
import type { MachineState } from '../lib/herdr';

describe('completionParts', () => {
  it('splits a typed path into the folder to list and the prefix', () => {
    expect(completionParts('~/src/we')).toEqual(['~/src', 'we']);
    expect(completionParts('/opt/')).toEqual(['/opt', '']);
    expect(completionParts('/us')).toEqual(['/', 'us']);
    expect(completionParts('~')).toEqual(['~', '']);
    expect(completionParts('rel')).toEqual(['', 'rel']);
  });
});

describe('dialogs', () => {
  it('cancels a pending dialog when another one opens', async () => {
    const first = confirmDialog({ title: 'a', message: 'b', confirm: 'c' });
    const second = newWorkspaceDialog('m', '~');
    expect(await first).toBe(false);
    expect(useDialog.getState().current?.kind).toBe('newWorkspace');
    const req = useDialog.getState().current!;
    if (req.kind === 'newWorkspace') req.resolve({ cwd: '/x', label: '' });
    expect(await second).toEqual({ cwd: '/x', label: '' });
  });
});

function machine(status: string, tab = 't1'): MachineState {
  return {
    id: 'm',
    label: 'm',
    status: 'ready',
    snapshot: {
      workspaces: [{ workspace_id: 'w1', active_tab_id: 't1' }],
      tabs: [
        { tab_id: 't1', workspace_id: 'w1' },
        { tab_id: 't2', workspace_id: 'w1' },
      ],
      panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: tab, agent: 'claude', agent_status: status }],
    },
  } as unknown as MachineState;
}

describe('seen', () => {
  beforeEach(() => api.mockClear());
  it('focuses a done pane in herdr once, only when it is on screen', () => {
    initSeen();
    const s = useStore.getState();
    s.upsertMachine(machine('working'));
    s.selectWorkspace('m', 'w1');
    s.focusPane({ m: 'm', pane: 'p1' });
    expect(api).not.toHaveBeenCalled();

    s.upsertMachine(machine('done'));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('m', 'pane.focus', { pane_id: 'p1' });
    s.upsertMachine(machine('done'));
    expect(api).toHaveBeenCalledTimes(1);

    // Finished again in a tab that is not shown: left for the inbox.
    s.upsertMachine(machine('idle', 't2'));
    s.upsertMachine(machine('done', 't2'));
    expect(api).toHaveBeenCalledTimes(1);
  });
});
