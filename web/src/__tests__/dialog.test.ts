// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { completionParts, confirmCheckDialog, confirmDialog, newWorkspaceDialog, useDialog } from '../dialog';

const api = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { useStore } from '../state/store';
import { initSeen } from '../seen';
import type { MachineState } from '../lib/herdr';
import { Dialogs } from '../components/Dialogs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('shows a confirmation checkbox and resolves with its state', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Dialogs)));
    const ask = () => confirmCheckDialog({ title: 'T', message: 'M', confirm: 'Go', check: 'Also stop', checked: true });

    let res = ask();
    await act(async () => {});
    const box = host.querySelector<HTMLInputElement>('.dialog-check input')!;
    expect(host.querySelector('.dialog-check')?.textContent).toBe('Also stop');
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click());
    expect(await res).toEqual({ checked: false });

    res = ask();
    await act(async () => {});
    await act(async () => host.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click());
    expect(await res).toEqual({ checked: true });

    // Cancelled, whatever the box says; a plain confirmation has no box.
    res = ask();
    await act(async () => {});
    await act(async () => host.querySelector<HTMLButtonElement>('.dialog-actions button:not(.primary)')!.click());
    expect(await res).toBeUndefined();
    const plain = confirmDialog({ title: 'T', message: 'M', confirm: 'Go' });
    await act(async () => {});
    expect(host.querySelector('.dialog-check')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('.dialog-actions .primary')!.click());
    expect(await plain).toBe(true);
    await act(async () => root.unmount());
    host.remove();
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
