// @vitest-environment jsdom
//
// The end of the terminal history plugin's page in Settings: for the
// machine shown, the snapshots it keeps and their size, whether the
// terminal core's own restore_screen is on, and Clear, which asks first,
// is off in read-only mode and with nothing to clear, and reads the list
// again once done.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { formatSize } from '../lib/files';
import { HistorySettingsExtra, listTotals } from '../plugins/history/SettingsExtra';
import { parseList } from '../plugins/history/api';
import type { MachineState } from '../lib/machine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gpu: MachineState = { id: 'gpu', label: 'gpu-box', kind: 'ssh', target: 'u@gpu', status: 'ready', enabled: true, updated_at: 0 };

const LIST = {
  restoreScreen: true,
  terminals: [
    { terminal: 't1', pid: 2, at: 2000, lines: 10, bytes: 1000, cols: 80, rows: 24, previous: { pid: 1, at: 1000, bytes: 2048 } },
    // Only a previous generation.
    { terminal: 't2', pid: 0, at: 0, bytes: 0, previous: { pid: 5, at: 900, bytes: 24 } },
  ],
};

describe('the history plugin’s settings page', () => {
  let host: HTMLElement;
  let root: Root;
  let requests: string[];
  let list: unknown;

  beforeEach(() => {
    requests = [];
    list = LIST;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (url === '/api/m/gpu/p/history' && method === 'GET') return new Response(JSON.stringify(list), { status: 200 });
      if (url === '/api/m/gpu/p/history' && method === 'DELETE') {
        list = { restoreScreen: true, terminals: [] };
        return new Response('{"removed":2}', { status: 200 });
      }
      return new Response('{"error":"offline"}', { status: 409 });
    });
    useStore.setState({ machines: { gpu }, order: ['gpu'], machineId: 'gpu' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useDialog.setState({ current: undefined });
    vi.unstubAllGlobals();
  });

  async function render(readOnly = false) {
    await act(async () => root.render(createElement(HistorySettingsExtra, { readOnly })));
    await act(async () => {});
  }
  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const clearButton = () => q('button[data-action=clear]') as HTMLButtonElement;

  it('counts every generation the machine keeps and their size', () => {
    expect(listTotals(parseList(LIST))).toEqual({ count: 3, bytes: 1000 + 2048 + 24 });
  });

  it('says what the shown machine keeps and that its terminal core restores screens itself', async () => {
    await render();
    expect(requests).toEqual(['GET /api/m/gpu/p/history']);
    expect(q('[data-summary]')!.textContent).toBe(`gpu-box keeps 3 snapshots of terminal output, ${formatSize(1000 + 2048 + 24)} in all.`);
    expect(q('[data-restore-screen]')!.dataset.restoreScreen).toBe('on');
    expect(q('[data-restore-screen]')!.textContent).toContain('never changes the terminal core’s configuration file');
    expect(clearButton().disabled).toBe(false);
  });

  it('says when the terminal core does not restore screens, and has nothing to clear without snapshots', async () => {
    list = { restoreScreen: false, terminals: [] };
    await render();
    expect(q('[data-summary]')!.textContent).toBe('gpu-box keeps no snapshots.');
    expect(q('[data-restore-screen]')!.dataset.restoreScreen).toBe('off');
    expect(clearButton().disabled).toBe(true);
  });

  it('cannot clear in read-only mode', async () => {
    await render(true);
    expect(q('[data-summary]')!.textContent).toContain('3 snapshots');
    expect(clearButton().disabled).toBe(true);
  });

  it('says why it cannot list a machine that is not connected', async () => {
    list = undefined;
    vi.stubGlobal('fetch', async () => new Response('{"error":"offline"}', { status: 409 }));
    await render();
    expect(q('[data-summary]')!.textContent).toBe('The machine is not connected.');
    expect(clearButton().disabled).toBe(true);
  });

  it('clears after asking, and reads the list again', async () => {
    await render();
    await act(async () => clearButton().click());
    const ask = useDialog.getState().current;
    expect(ask).toMatchObject({ kind: 'confirm', danger: true, title: 'Clear saved output?' });
    expect(ask?.kind === 'confirm' && ask.message).toContain('gpu-box');
    // Cancelled: nothing removed.
    await act(async () => ask?.kind === 'confirm' && ask.resolve(false));
    expect(requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);

    await act(async () => clearButton().click());
    const again = useDialog.getState().current;
    await act(async () => again?.kind === 'confirm' && again.resolve(true));
    await act(async () => {});
    expect(requests).toEqual(['GET /api/m/gpu/p/history', 'DELETE /api/m/gpu/p/history', 'GET /api/m/gpu/p/history']);
    expect(q('[data-removed]')!.textContent).toBe('Removed the snapshots of 2 terminals.');
    expect(q('[data-summary]')!.textContent).toBe('gpu-box keeps no snapshots.');
    expect(clearButton().disabled).toBe(true);
  });
});
