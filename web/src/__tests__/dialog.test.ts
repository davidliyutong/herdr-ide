// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  completionParts,
  confirmCheckDialog,
  confirmDialog,
  editWorkspaceDialog,
  expandPath,
  folderProblem,
  newWorkspaceDialog,
  useDialog,
} from '../dialog';

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
    expect(useDialog.getState().current?.kind).toBe('workspace');
    const req = useDialog.getState().current!;
    if (req.kind === 'workspace') req.resolve({ cwd: '/x', label: '' });
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

describe('expandPath and folderProblem', () => {
  it('expands like the agent and tells the problems apart', () => {
    expect(expandPath('~', '/home/u')).toBe('/home/u');
    expect(expandPath('~/x/', '/home/u/')).toBe('/home/u/x');
    expect(expandPath('x/y', '/home/u')).toBe('/home/u/x/y');
    expect(expandPath('/opt/', '/home/u')).toBe('/opt');
    expect(folderProblem(new Error('readdir /a: not a directory'))).toBe('file');
    expect(folderProblem(new Error('open /a: no such file or directory'))).toBe('missing');
    expect(folderProblem(new Error('open /root: permission denied'))).toBe('denied');
    expect(folderProblem(new Error('Failed to fetch'))).toBeUndefined();
  });
});

describe('workspace dialog', () => {
  const folders: Record<string, string | Error> = {
    '~/x': '/home/u/x',
    '/home/u/file': new Error('readdir /home/u/file: not a directory'),
  };
  const mount = async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URLSearchParams(url.split('?')[1]).get('path')!;
        const r = folders[path] ?? new Error(`open ${path}: no such file or directory`);
        return r instanceof Error
          ? { ok: false, statusText: 'x', json: async () => ({ error: r.message }) }
          : { ok: true, json: async () => ({ dir: { name: 'x', path: r, is_dir: true, size: 0, mode: 0, mtime: 0 }, entries: [] }) };
      }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Dialogs)));
    return { host, root };
  };
  const type = async (host: HTMLElement, value: string) => {
    const input = host.querySelector<HTMLInputElement>('.dialog-body input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  };
  const create = () => document.querySelector<HTMLButtonElement>('.dialog-actions .primary')!;
  const unmount = async (root: ReturnType<typeof createRoot>) => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  };

  it('stores the absolute path the machine resolved and shows it', async () => {
    const { host, root } = await mount();
    const res = newWorkspaceDialog('m', '');
    await act(async () => {});
    await type(host, '~/x');
    expect(host.querySelector('.muted.small')?.textContent).toContain('→ /home/u/x');
    await act(async () => create().click());
    expect(await res).toEqual({ cwd: '/home/u/x', label: '' });
    await unmount(root);
  });

  it('reports a missing folder or a file while typing and disables Create', async () => {
    const { host, root } = await mount();
    const res = newWorkspaceDialog('m', '');
    await act(async () => {});
    await type(host, '/nope');
    expect(host.querySelector('.error')?.textContent).toBe('No such folder on the machine.');
    expect(create().disabled).toBe(true);
    await type(host, '/home/u/file');
    expect(host.querySelector('.error')?.textContent).toBe('Not a folder.');
    expect(create().disabled).toBe(true);
    await type(host, '~/x');
    expect(host.querySelector('.error')).toBeNull();
    expect(create().disabled).toBe(false);
    await act(async () => create().click());
    expect((await res)?.cwd).toBe('/home/u/x');
    await unmount(root);
  });

  it('creates a workspace without a directory from an empty field, new or edited', async () => {
    const { host, root } = await mount();
    const res = newWorkspaceDialog('m', '/home/u');
    await act(async () => {});
    await type(host, '');
    await act(async () => create().click());
    expect(await res).toEqual({ cwd: '', label: '' });
    const edit = editWorkspaceDialog('m', '/home/u', 'w');
    await act(async () => {});
    await type(host, '');
    await act(async () => create().click());
    expect(await edit).toEqual({ cwd: '', label: 'w' });
    await unmount(root);
  });
});
