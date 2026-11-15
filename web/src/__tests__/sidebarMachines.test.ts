// @vitest-environment jsdom
//
// The sidebar folds disabled machines, renames a machine in place, in its
// header, shows the workspaces of the machines followed, offers to start a
// terminal core that failed, and says why a machine is never connected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { FakeCore, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { Sidebar } from '../components/Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Sidebar machines', () => {
  let host: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ managed: false, running: true }), { status: 200 })),
  );

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'gpu', label: 'gpu', kind: 'ssh', status: 'disabled' } as unknown as MachineState]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Sidebar)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useStore.getState().setRenaming(undefined);
    vi.unstubAllGlobals();
  });

  it('offers to start the terminal core where it failed, except read-only', async () => {
    const core = new FakeCore();
    core.install();
    await settle();
    const start = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Start Terminal Service');
    await act(async () =>
      useStore.getState().setMachines([{ id: 'gpu', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]),
    );
    // Not followed yet: the machine's terminals are one click away.
    expect(host.textContent).toContain('Show its terminals');
    await act(async () =>
      Array.from(host.querySelectorAll<HTMLElement>('.ws-item'))
        .find((e) => e.textContent === 'Show its terminals')!
        .click(),
    );
    await act(settle);
    expect(useStore.getState().machineId).toBe('gpu');
    expect(host.textContent).toContain('The machine is not connected.');
    await act(async () => start()!.click());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/hc/start');
    await act(async () => useStore.getState().setReadOnly(true));
    expect(start()).toBeUndefined();
  });

  it('lists the workspaces of a followed machine with their agents', async () => {
    const core = new FakeCore();
    core.machine('gpu', [FakeCore.term('t1', { agent: 'claude', agent_status: 'blocked' }), FakeCore.term('t2')], {
      version: 2,
      workspaces: [
        { id: 'aaaaaaaa', name: 'api', cwd: '/srv/api', tabs: [{ root: { terminal: 't1' }, focused: 't1' }], selected: 0 },
        {
          id: 'bbbbbbbb',
          name: 'web',
          cwd: '',
          tabs: [
            { root: { terminal: 't2' }, focused: 't2' },
            { root: { terminal: 't3' }, focused: 't3' },
          ],
          selected: 0,
        },
      ],
      selected: 1,
    });
    core.install();
    await act(async () =>
      useStore.getState().setMachines([{ id: 'gpu', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]),
    );
    await act(async () => useStore.getState().selectMachine('gpu'));
    await act(async () => core.model.subscribe('gpu'));
    await act(settle);
    const items = Array.from(host.querySelectorAll<HTMLElement>('.ws-item[data-ws-id]'));
    expect(items.map((e) => e.querySelector('.ellipsis')?.textContent)).toEqual(['api', 'web']);
    // The second workspace is selected; t3 is gone, so web has one tab.
    expect(items[1].classList.contains('selected')).toBe(true);
    expect(items[0].querySelector('.dot-blocked')).not.toBeNull();
    expect(host.querySelector('.inbox')?.textContent).toContain('claude');
    await act(async () => items[0].click());
    await act(settle);
    expect(core.layout('gpu')?.selected).toBe(0);
  });

  it('folds disabled machines until opened, and unfolds them once enabled', async () => {
    const head = () => host.querySelector<HTMLElement>('.machine-head')!;
    const enable = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Enable Machine');
    expect(host.querySelector('.machine-body')).toBeNull();
    expect(enable()).toBeUndefined();
    await act(async () => head().click());
    expect(enable()).toBeDefined();
    await act(async () => head().click());
    expect(host.querySelector('.machine-body')).toBeNull();

    const setStatus = (status: string) =>
      act(async () => useStore.getState().setMachines([{ id: 'gpu', label: 'gpu', kind: 'ssh', status } as unknown as MachineState]));
    await setStatus('connecting');
    expect(host.querySelector('.machine-body')).not.toBeNull();
    // Folding an enabled machine sticks while it connects.
    await act(async () => head().click());
    await setStatus('ready');
    expect(host.querySelector('.machine-body')).toBeNull();
    await act(async () => head().click());
    await setStatus('disabled');
    expect(host.querySelector('.machine-body')).toBeNull();
  });

  it('shows why a machine with a refused target is never connected, without a retry', async () => {
    await act(async () =>
      useStore
        .getState()
        .setMachines([
          { id: 'gpu', label: 'gpu', kind: 'ssh', status: 'error', code: 'invalid_target', enabled: true } as unknown as MachineState,
        ]),
    );
    expect(host.querySelector('.machine-status')?.textContent).toContain('never connected');
    expect(host.querySelector<HTMLElement>('.machine-head')?.title).toContain('never connected');
    expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Retry')).toBeUndefined();
    // Another error keeps its retry.
    await act(async () =>
      useStore.getState().setMachines([
        {
          id: 'gpu',
          label: 'gpu',
          kind: 'ssh',
          status: 'error',
          error: 'ssh: connection refused',
          enabled: true,
        } as unknown as MachineState,
      ]),
    );
    expect(host.querySelector('.machine-status')?.textContent).toContain('connection refused');
    expect(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Retry')).toBeDefined();
  });

  it('says the local machine needs Linux or macOS where no agent runs on it', async () => {
    await act(async () =>
      useStore.getState().setMachines([
        {
          id: 'local',
          label: 'pc (local)',
          kind: 'local',
          status: 'error',
          code: 'local_unsupported',
          enabled: true,
        } as unknown as MachineState,
      ]),
    );
    expect(host.querySelector('.machine-status')?.textContent).toContain('needs Linux or macOS');
    expect(host.querySelectorAll('.machine-status button')).toHaveLength(0);
  });

  it('offers Sign in only where the core keeps an ssh login, and says what to do elsewhere', async () => {
    const machine = { id: 'gpu', label: 'gpu', kind: 'ssh', status: 'auth_required', enabled: true } as unknown as MachineState;
    await act(async () => useStore.getState().setMachines([machine]));
    const buttons = () => Array.from(host.querySelectorAll('.machine-status button')).map((b) => b.textContent);
    expect(buttons()).toEqual(['Sign in…', 'Retry']);
    await act(async () => useStore.setState({ sshLogin: false }));
    expect(buttons()).toEqual(['Retry']);
    expect(host.querySelector('.machine-status')?.textContent).toContain('ssh-add');
    useStore.setState({ sshLogin: true });
  });

  it('renames a machine in its header', async () => {
    await act(async () => useStore.getState().setRenaming({ kind: 'machine', m: 'gpu', id: 'gpu' }));
    const input = host.querySelector<HTMLInputElement>('.machine-head input');
    expect(input?.value).toBe('gpu');
    input!.value = '  GPU box ';
    await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(useStore.getState().renaming).toBeUndefined();
    expect(host.querySelector('.machine-head input')).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/label');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ label: 'GPU box' }) });
  });
});
