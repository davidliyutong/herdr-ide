// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { completionParts, confirmCheckDialog, confirmDialog, newWorkspaceDialog, useDialog } from '../dialog';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

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
