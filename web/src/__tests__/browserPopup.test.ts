// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// A window that a page shown in a pane opens (the desktop app's webview
// reports it; plugins/browser/api.ts openPopup) becomes a browser tab. A
// page asked for it, not the user: it leads into no machine. A loopback
// address is this computer's own, an address on a forward's local port is
// that forward's while it exists, and no forward is made for either.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { definePlugins } from '../plugins/registry';
import { browserPlugin } from '../plugins/browser';
import { forwardGranted, grantForward, openBrowserTab, openPopup, resetGrants, revokeForward, useForwards } from '../plugins/browser/api';
import { t } from '../i18n';
import { FakeHub, settle } from './fakeTerms';
import { click, fakeBrowserApi, flush, json, mountPane, type Call, type Harness } from './browserHarness';

let hub: FakeHub;
let calls: Call[];
const tabs = (m: string) => hub.model.layout(m)!.workspaces[0].tabs;
const views = (m: string) => L.pluginViews(hub.model.layout(m)!.workspaces[0], 'browser', 'page').map((v) => v.view);
const machine = (id: string, kind: 'local' | 'ssh') =>
  ({ id, label: id, kind, status: 'ready', info: { home: '/home/u' } }) as unknown as MachineState;
const popup = async (url: string) => {
  await openPopup(url);
  await settle();
};

describe('a popup of a page in a pane', () => {
  beforeEach(async () => {
    definePlugins([browserPlugin]);
    resetGrants();
    useForwards.setState({ forwards: [], available: true });
    calls = fakeBrowserApi();
    hub = new FakeHub();
    for (const id of ['a', 'b'])
      hub.machine(id, [FakeHub.term('s1')], {
        version: 1,
        workspaces: [{ id: 'w1', name: '', cwd: '', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
        selected: 0,
      });
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([machine('a', 'ssh'), machine('b', 'ssh')]);
    s.selectMachine('a');
    hub.model.subscribe('a');
    hub.model.subscribe('b');
    await settle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    definePlugins([]);
  });

  it('opens a loopback address as this computer’s own, never as a port of the machine shown', async () => {
    // The machine shown is a remote one: the same address typed by the
    // user would be its port 2375, through a forward.
    await popup('http://localhost:2375/containers/json');
    await popup('http://127.0.0.1:9229/json');
    await popup('http://[::1]:8500/v1/kv/?recurse');
    expect(views('a').map((v) => [v.url, v.m, v.port])).toEqual([
      ['http://localhost:2375/containers/json', undefined, undefined],
      ['http://localhost:9229/json', undefined, undefined],
      ['http://localhost:8500/v1/kv/?recurse', undefined, undefined],
    ]);
    expect(tabs('a').length).toBe(4);
    for (const port of [2375, 9229, 8500]) expect(forwardGranted('a', port)).toBe(false);
    // The hub was asked for nothing.
    expect(calls).toEqual([]);
    // The user's own way to the same address is the machine's port.
    await openBrowserTab('a', 'http://localhost:2375/containers/json');
    expect(views('a').at(-1)).toMatchObject({ url: 'http://localhost:2375/containers/json', m: 'a', port: 2375 });
    expect(forwardGranted('a', 2375)).toBe(true);
  });

  it('opens an address on the local port of a forward that exists as that forward’s machine and port', async () => {
    useForwards.setState({
      forwards: [
        { m: 'a', port: 3000, local: 41000, created: '', connections: 0 },
        { m: 'b', port: 8000, local: 42000, created: '', connections: 0 },
      ],
    });
    await popup('http://localhost:41000/docs?x=1#top');
    expect(views('a').map((v) => [v.url, v.m, v.port])).toEqual([['http://localhost:3000/docs?x=1#top', 'a', 3000]]);
    // Another machine's forward: a tab of that machine, whose layout the
    // view is then in.
    await popup('http://127.0.0.1:42000/');
    expect(views('b').map((v) => [v.url, v.m, v.port])).toEqual([['http://localhost:8000/', 'b', 8000]]);
    expect(useStore.getState().machineId).toBe('b');
    // Bound to the forward, which the page did not get to make again.
    expect(forwardGranted('a', 3000)).toBe(false);
    expect(forwardGranted('b', 8000)).toBe(false);
    expect(calls).toEqual([]);
    // A forward's own port on the machine is not its local one.
    useStore.getState().selectMachine('a');
    await popup('http://localhost:3000/');
    expect(views('a').at(-1)).toMatchObject({ url: 'http://localhost:3000/' });
    expect(views('a').at(-1)!.m).toBeUndefined();
    expect(views('a').at(-1)!.port).toBeUndefined();
  });

  it('opens any other address as it is', async () => {
    await popup('https://example.com/a?b#c');
    await popup('http://192.168.1.5:8080/');
    expect(views('a').map((v) => [v.url, v.m, v.port])).toEqual([
      ['https://example.com/a?b#c', undefined, undefined],
      ['http://192.168.1.5:8080/', undefined, undefined],
    ]);
    expect(calls).toEqual([]);
  });

  it('opens nothing for what is no http(s) page, nor for the hub’s own address', async () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'blob:http://127.0.0.1:5173/x',
      'ws://localhost:3000/',
      '',
      'not a url',
      // The UI is on 127.0.0.1:5173.
      'http://127.0.0.1:5173/',
      'http://localhost:5173/api/m/a/hc/stop',
      'http://[::1]:5173/',
    ])
      await popup(url);
    expect(tabs('a').length).toBe(1);
    expect(tabs('b').length).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('the pane of a popup’s view', () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.unmount();
    h = undefined;
    vi.unstubAllGlobals();
  });
  const iframe = () => document.querySelector<HTMLIFrameElement>('.browser-layer iframe');

  it('loads a loopback address from this computer, with no forward and no question', async () => {
    const calls = fakeBrowserApi();
    // Machine a of the harness is a remote one.
    h = await mountPane({ url: 'http://localhost:2375/containers/json' });
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:2375/containers/json');
    expect(h.host.querySelector('.browser-chip')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('asks before it makes the forward again, once the forward it was bound to ended', async () => {
    const calls = fakeBrowserApi({ forward: (b) => json({ m: 'a', port: b.port, local: 41000, created: '', connections: 0 }) });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/p/browser/forwards']);
    expect(iframe()).toBeNull();
    expect(h.host.querySelector('.browser-slot')?.textContent).toContain(t('browser.ask', { machine: 'Box', port: 3000 }));
    await click([...h.host.querySelectorAll('button')].find((b) => b.textContent === t('browser.askForward')));
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:41000/');
  });
});

describe('a forward the user stopped', () => {
  it('is asked for again: stopping takes the port back', () => {
    resetGrants();
    grantForward('a', 3000);
    expect(forwardGranted('a', 3000)).toBe(true);
    revokeForward('a', 3000);
    expect(forwardGranted('a', 3000)).toBe(false);
    // Another machine's same port is another grant.
    grantForward('b', 3000);
    revokeForward('a', 3000);
    expect(forwardGranted('b', 3000)).toBe(true);
  });
});
