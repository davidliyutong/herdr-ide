// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// Cmd/Ctrl+click on a URL in a terminal (terminal/links.ts openLink): a
// browser pane in a new tab where one can show it, else outside the app.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shell = vi.hoisted(() => ({ current: undefined as undefined | { browser?: object } }));
vi.mock('../shell', () => ({
  get desktopShell() {
    return shell.current;
  },
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { useSettings } from '../settings';
import { definePlugins } from '../plugins/registry';
import { browserPlugin } from '../plugins/browser';
import { forwardGranted, resetGrants, useForwards } from '../plugins/browser/api';
import { openLink } from '../terminal/links';
import { FakeCore, settle } from './fakeTerms';
import { fakeBrowserApi, json } from './browserHarness';

let core: FakeCore;
let open: ReturnType<typeof vi.spyOn>;
const tabs = () => core.model.layout('a')!.workspaces[0].tabs;
const views = () => L.pluginViews(core.model.layout('a')!.workspaces[0], 'browser', 'page').map((v) => v.view);
const set = (key: string, value: unknown) =>
  useSettings.setState((s) => ({ values: { ...s.values, [key]: { value, source: 'global' } } }) as Partial<typeof s>);
const click = async (text: string, m = 'a') => {
  openLink({ kind: 'url', text }, { m });
  await settle();
  await settle();
};
const machine = (id: string, kind: 'local' | 'ssh') =>
  ({ id, label: id, kind, status: 'ready', info: { home: '/home/u' } }) as unknown as MachineState;

beforeEach(async () => {
  shell.current = undefined;
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  definePlugins([browserPlugin]);
  set('plugins.browser.enabled', true);
  set('browser.openLinks', 'pane');
  resetGrants();
  useForwards.setState({ forwards: [], available: true });
  core = new FakeCore();
  for (const id of ['a', 'l'])
    core.machine(id, [FakeCore.term('s1')], {
      version: 1,
      workspaces: [{ id: 'w1', name: '', cwd: '', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
      selected: 0,
    });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([machine('a', 'ssh'), machine('l', 'local')]);
  s.selectMachine('a');
  core.model.subscribe('a');
  core.model.subscribe('l');
  await settle();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  definePlugins([]);
});

describe('a loopback URL in a terminal of a remote machine', () => {
  it('opens a new tab with a browser pane of that machine’s port', async () => {
    await click('http://localhost:3000/docs?x=1');
    expect(tabs().length).toBe(2);
    expect(views()).toMatchObject([{ url: 'http://localhost:3000/docs?x=1', m: 'a', port: 3000 }]);
    expect(open).not.toHaveBeenCalled();
    // The click is the user asking for that port: its pane makes the forward.
    expect(forwardGranted('a', 3000)).toBe(true);
    expect(forwardGranted('a', 8080)).toBe(false);
    // Every loopback name is the machine's own; the port is the URL's.
    await click('http://127.0.0.1:8080/');
    await click('http://0.0.0.0:5174/a');
    await click('http://[::1]:9000/');
    expect(views().map((v) => [v.url, v.port])).toEqual([
      ['http://localhost:3000/docs?x=1', 3000],
      ['http://localhost:8080/', 8080],
      ['http://localhost:5174/a', 5174],
      ['http://localhost:9000/', 9000],
    ]);
    expect(tabs().length).toBe(5);
  });

  it('opens outside when forwards are not available to this client', async () => {
    useForwards.setState({ available: false });
    await click('http://localhost:3000/');
    expect(open).toHaveBeenCalledWith('http://localhost:3000/', '_blank', 'noopener');
    expect(tabs().length).toBe(1);
    expect(forwardGranted('a', 3000)).toBe(false);
  });

  it('opens nothing for the core’s own address, under either loopback name', async () => {
    // The UI is on 127.0.0.1:5173; a machine's port of that number reads
    // as the core's address and is not opened from a text.
    for (const url of ['http://127.0.0.1:5173/api/m/a/hc/stop', 'http://localhost:5173/', 'http://[::1]:5173/x', 'https://localhost:5173/'])
      await click(url);
    expect(open).not.toHaveBeenCalled();
    expect(tabs().length).toBe(1);
    expect(forwardGranted('a', 5173)).toBe(false);
  });

  it('asks the core whether forwards are available when it does not know yet', async () => {
    useForwards.setState({ available: undefined });
    const calls = fakeBrowserApi({ forwards: () => json({ forwards: [], available: false }) });
    await click('http://localhost:3000/');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/p/browser/forwards']);
    expect(open).toHaveBeenCalledTimes(1);
    expect(tabs().length).toBe(1);
  });
});

describe('a loopback URL in a terminal of the local machine', () => {
  it('opens a browser pane without a forward when the UI is on a loopback host', async () => {
    useStore.getState().selectMachine('l');
    await click('http://localhost:3000/x', 'l');
    const [v] = L.pluginViews(core.model.layout('l')!.workspaces[0], 'browser', 'page');
    expect(v.view.url).toBe('http://localhost:3000/x');
    expect(v.view.m).toBeUndefined();
    expect(v.view.port).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    // No forward is involved, so none is asked for.
    expect(forwardGranted('l', 3000)).toBe(false);
  });
});

describe('any other URL', () => {
  it('opens outside in a browser', async () => {
    await click('https://example.com/a');
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener');
    expect(tabs().length).toBe(1);
  });

  it('opens in a browser pane in the desktop app, whose webview takes any address', async () => {
    shell.current = { browser: {} };
    await click('https://example.com/a');
    expect(open).not.toHaveBeenCalled();
    expect(views()).toMatchObject([{ url: 'https://example.com/a' }]);
    expect(views()[0].m).toBeUndefined();
  });

  it('never opens other schemes in a pane', async () => {
    shell.current = { browser: {} };
    await click('mailto:a@example.com');
    expect(open).toHaveBeenCalledWith('mailto:a@example.com', '_blank', 'noopener');
    await click('javascript:alert(1)');
    expect(open).toHaveBeenCalledTimes(1);
    expect(tabs().length).toBe(1);
  });
});

describe('with the setting at external, or the plugin off', () => {
  it('opens everything outside', async () => {
    shell.current = { browser: {} };
    set('browser.openLinks', 'external');
    await click('http://localhost:3000/');
    await click('https://example.com/');
    expect(open).toHaveBeenCalledTimes(2);
    expect(tabs().length).toBe(1);
    set('browser.openLinks', 'pane');
    set('plugins.browser.enabled', false);
    await click('http://localhost:3000/');
    await click('https://example.com/');
    expect(open).toHaveBeenCalledTimes(4);
    expect(tabs().length).toBe(1);
    set('plugins.browser.enabled', true);
    await click('http://localhost:3000/');
    expect(open).toHaveBeenCalledTimes(4);
    expect(tabs().length).toBe(2);
  });
});
