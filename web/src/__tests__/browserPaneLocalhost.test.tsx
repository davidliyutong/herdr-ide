// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://localhost:5173/"}
//
// With the UI on localhost the pages load from 127.0.0.1; and a loopback
// page of the local machine needs no forward.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { useStore } from '../state/store';
import { fakeBrowserApi, flush, mountPane, type Harness } from './browserHarness';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

let h: Harness | undefined;
afterEach(() => {
  h?.unmount();
  h = undefined;
  vi.unstubAllGlobals();
});

const iframe = () => document.querySelector<HTMLIFrameElement>('.browser-layer iframe');

describe('a page with the UI on localhost', () => {
  it('loads a forwarded page from 127.0.0.1', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 }, { asked: true });
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://127.0.0.1:3000/docs');
  });

  it('loads a loopback page of the local machine from the other name, without a forward', async () => {
    const calls = fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:8080/x' });
    await act(async () => useStore.setState((s) => ({ machines: { ...s.machines, a: { ...s.machines.a, kind: 'local' } } })));
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://127.0.0.1:8080/x');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
