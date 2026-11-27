// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://app.localhost/"}
//
// In the desktop app the UI lives on https://<slug>.localhost (not 127.0.0.1
// or localhost) and renders browser panes in an isolated <webview> partition
// (persist:browser). Both forwarded remote ports and local loopback services
// must load on localhost without tripping the browser-only host rule.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

const shell = vi.hoisted(() => ({ current: { browser: { onOpen: () => () => {} } } as undefined | { browser?: object } }));
vi.mock('../shell', () => ({
  get desktopShell() {
    return shell.current;
  },
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { t } from '../i18n';
import type { MachineState } from '../lib/machine';
import { linkPlace, parseAddress } from '../plugins/browser/api';
import { useStore } from '../state/store';
import { fakeBrowserApi, flush, json, mountPane, type Harness } from './browserHarness';

let h: Harness | undefined;
afterEach(() => {
  h?.unmount();
  h = undefined;
  shell.current = { browser: { onOpen: () => () => {} } };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const webview = () => document.querySelector<HTMLElement>('.browser-layer webview');

describe('desktop app browser panes on https://<slug>.localhost', () => {
  it('loads a remote machine’s forwarded port in a webview on localhost', async () => {
    fakeBrowserApi({ forward: () => json({ m: 'a', port: 3000, local: 41000, created: '', connections: 0 }) });
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 }, { asked: true });
    await flush();
    expect(webview()?.getAttribute('src')).toBe('http://localhost:41000/docs');
    expect(webview()?.getAttribute('partition')).toBe('persist:browser');
    expect(h.host.textContent).not.toContain(t('browser.error.host'));
  });

  it('loads a local machine’s loopback page in a webview on localhost without a forward', async () => {
    const calls = fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:8080/x' });
    await act(async () => useStore.setState((s) => ({ machines: { ...s.machines, a: { ...s.machines.a, kind: 'local' } } })));
    await flush();
    expect(webview()?.getAttribute('src')).toBe('http://localhost:8080/x');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('routes local and remote loopback links into browser panes', () => {
    useStore
      .getState()
      .setMachines([
        { id: 'a', label: 'Box', kind: 'ssh', status: 'ready' } as unknown as MachineState,
        { id: 'l', label: 'Mac', kind: 'local', status: 'ready' } as unknown as MachineState,
      ]);
    expect(linkPlace('a', 'http://localhost:3000/', 'loopback')).toBe('forward');
    expect(linkPlace('l', 'http://localhost:3000/', 'loopback')).toBe('pane');
    expect(linkPlace('l', 'https://localhost/', 'loopback')).toBe('pane');
  });

  it('refuses only the app’s own host, allowing https://localhost/ on port 443', () => {
    expect(parseAddress('https://app.localhost/')).toEqual({ kind: 'refused', own: true });
    expect(parseAddress('http://app.localhost/api/x')).toEqual({ kind: 'refused', own: true });
    expect(parseAddress('https://localhost/')).toEqual({ kind: 'page', url: 'https://localhost/', loopback: true, port: 443 });
  });
});
