// @vitest-environment jsdom
//
// The sidebar reloads herdr's machines from its button and renames a saved
// machine in place, in its header.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/herdr';
import { Sidebar } from '../components/Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Sidebar machines', () => {
  let host: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ added: null, removed: null, updated: null }), { status: 200 })),
  );

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'gpu', label: 'gpu', kind: 'ssh', status: 'disabled', saved: true } as unknown as MachineState]);
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

  it('reloads the machines from its button, which read-only browsers lack', async () => {
    const button = host.querySelector<HTMLButtonElement>('button[title^="Reload machines from herdr"]');
    await act(async () => button!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/machines/refresh', { method: 'POST' });
    await act(async () => useStore.getState().setReadOnly(true));
    expect(host.querySelector('button[title^="Reload machines"]')).toBeNull();
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
