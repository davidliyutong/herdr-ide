// @vitest-environment jsdom
//
// PreviewPane binary reload behavior: if a previously cached text file turns
// binary on disk, stale text is cleared and evicted rather than remaining
// visible below the binary notice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));

import { PreviewPane } from '../components/PreviewPane';
import { useStore } from '../state/store';
import type { MachineState, MachineStatus } from '../lib/machine';
import { t } from '../i18n';
import { settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machine = (id: string, status: MachineStatus): MachineState =>
  ({
    id,
    label: id,
    kind: 'ssh',
    target: `${id}.example`,
    enabled: status !== 'disabled',
    status,
    updated_at: 1,
  }) as MachineState;

describe('PreviewPane binary transition', () => {
  let host: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await settle()));
  };

  beforeEach(() => {
    useStore.setState({ machines: { m: machine('m', 'ready') }, order: ['m'], readOnly: false });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('clears stale cached text when a file turns binary on disk', async () => {
    let payload: string | Uint8Array<ArrayBuffer> = 'plain cached text';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(payload, { status: 200 })),
    );

    await act(async () => {
      root.render(createElement(PreviewPane, { m: 'm', pane: 'preview:p1', path: '/srv/data.txt' }));
    });
    await flush();
    expect(host.textContent).toContain('plain cached text');
    expect(host.querySelector('.error')).toBeNull();

    // Unmount and remount after the file becomes binary (contains NUL bytes).
    payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(PreviewPane, { m: 'm', pane: 'preview:p1', path: '/srv/data.txt' }));
    });
    await flush();
    expect(host.querySelector('.error')?.textContent).toBe(t('preview.binary'));
    expect(host.textContent).not.toContain('plain cached text');
    expect(host.querySelector('.text-preview')).toBeNull();

    // A subsequent remount does not re-hydrate the evicted stale text either.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(PreviewPane, { m: 'm', pane: 'preview:p1', path: '/srv/data.txt' }));
    });
    await flush();
    expect(host.querySelector('.error')?.textContent).toBe(t('preview.binary'));
    expect(host.textContent).not.toContain('plain cached text');
  });
});
