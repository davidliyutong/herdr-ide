// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// A web link clicked in a document of a machine (markdown/MarkdownBody.tsx)
// opens as one Cmd/Ctrl+clicked in that machine's terminals does
// (terminal/openLink.ts openWebLink): a loopback address in a browser pane
// of a new tab, a remote machine's through its forward, any other address
// outside the app. The document is not trusted and a link's text may hide
// its address: the link names it in its tooltip, and the click is not the
// user asking for a forward, which the pane asks for (or uses when it
// exists).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
import { BrowserLayer } from '../plugins/browser/BrowserLayer';
import { resetFrames } from '../plugins/browser/frames';
import { PluginPane } from '../components/PluginPane';
import { Markdown } from '../markdown/Markdown';
import { t } from '../i18n';
import { FakeCore, settle } from './fakeTerms';
import { click, fakeBrowserApi, flush, json } from './browserHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let core: FakeCore;
let open: ReturnType<typeof vi.spyOn>;
let host: HTMLDivElement;
let root: Root;
const views = () => L.pluginViews(core.model.layout('a')!.workspaces[0], 'browser', 'page').map((v) => v.view);
const set = (key: string, value: unknown) =>
  useSettings.setState((s) => ({ values: { ...s.values, [key]: { value, source: 'global' } } }) as Partial<typeof s>);

const TEXT = [
  '[app](http://localhost:3000/x)',
  '',
  '[site](https://example.com/a)',
  '',
  '[mail](mailto:a@example.com)',
  '',
  '[Install guide](http://localhost:2375/containers/json)',
  '',
  '![shot](https://img.example/p.png)',
].join('\n');

/** The browser pane of the view the click opened, rendered as the
 * workspace draws it, with the frame layer. */
async function mountView(): Promise<Root> {
  const [v] = L.pluginViews(core.model.layout('a')!.workspaces[0], 'browser', 'page');
  const el = document.createElement('div');
  document.body.append(el);
  const r = createRoot(el);
  await act(async () =>
    r.render(
      createElement(
        'div',
        null,
        createElement(PluginPane, { m: 'a', pane: v.key, view: v.view, focused: true }),
        createElement(BrowserLayer),
      ),
    ),
  );
  await flush();
  return r;
}
const iframe = () => document.querySelector<HTMLIFrameElement>('.browser-layer iframe');
const askButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === t('browser.askForward'));

async function show(base?: { m: string; dir: string }) {
  await act(async () => root.render(createElement(Markdown, { text: TEXT, base })));
  await vi.waitFor(() => expect(host.querySelector('.markdown-plain')).toBeNull(), { timeout: 5000 });
}

/** Clicks the link of that text; whether the page took the click. */
async function press(text: string): Promise<boolean> {
  const a = [...host.querySelectorAll('a')].find((e) => e.textContent === text)!;
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  // jsdom does not navigate: a click left to the browser does nothing here.
  await act(async () => void a.dispatchEvent(ev));
  await settle();
  await settle();
  return ev.defaultPrevented;
}

beforeEach(async () => {
  shell.current = undefined;
  resetFrames();
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  definePlugins([browserPlugin]);
  set('plugins.browser.enabled', true);
  set('browser.openLinks', 'loopback');
  resetGrants();
  useForwards.setState({ forwards: [], available: true });
  core = new FakeCore();
  core.machine('a', [FakeCore.term('s1')], {
    version: 1,
    workspaces: [{ id: 'w1', name: '', cwd: '', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  definePlugins([]);
});

describe('a web link of a machine’s document', () => {
  it('names its address in its tooltip, whatever its text', async () => {
    await show({ m: 'a', dir: '/home/u' });
    const title = (text: string) => [...host.querySelectorAll('a')].find((e) => e.textContent === text)?.getAttribute('title');
    expect(title('Install guide')).toBe('http://localhost:2375/containers/json');
    expect(title('app')).toBe('http://localhost:3000/x');
    expect(title('site')).toBe('https://example.com/a');
    expect(title('mail')).toBe('mailto:a@example.com');
    // A remote image is a link to it.
    expect(title('shot')).toBe('https://img.example/p.png');
  });

  it('opens a loopback address as that machine’s port, asking before the forward is made', async () => {
    const calls = fakeBrowserApi();
    await show({ m: 'a', dir: '/home/u' });
    expect(await press('Install guide')).toBe(true);
    expect(views()).toMatchObject([{ url: 'http://localhost:2375/containers/json', m: 'a', port: 2375 }]);
    // The click is no request for the port: nothing is asked of the core.
    expect(forwardGranted('a', 2375)).toBe(false);
    expect(calls).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    const pane = await mountView();
    try {
      // The pane reads the forwards, finds none and asks, naming the
      // machine and the port; the address field has the whole address.
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/p/browser/forwards']);
      expect(document.querySelector('[data-testid="browser-ask"]')?.textContent).toContain(t('browser.ask', { machine: 'a', port: 2375 }));
      expect(document.querySelector<HTMLInputElement>('.browser-address')?.value).toBe('http://localhost:2375/containers/json');
      expect(iframe()).toBeNull();
      // The user's word makes it.
      await click(askButton());
      await flush();
      expect(forwardGranted('a', 2375)).toBe(true);
      expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
        ['/api/m/a/p/browser/forwards', { port: 2375 }],
      ]);
      expect(iframe()?.getAttribute('src')).toBe('http://localhost:2375/containers/json');
    } finally {
      act(() => pane.unmount());
    }
  });

  it('uses the forward that exists without asking', async () => {
    const calls = fakeBrowserApi({
      forwards: () => json({ forwards: [{ m: 'a', port: 3000, local: 41000, created: '', connections: 0 }], available: true }),
      forward: (b) => json({ m: 'a', port: b.port, local: 41000, created: '', connections: 0 }),
    });
    await show({ m: 'a', dir: '/home/u' });
    await press('app');
    expect(calls).toEqual([]);
    const pane = await mountView();
    try {
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/p/browser/forwards', 'POST /api/m/a/p/browser/forwards']);
      expect(iframe()?.getAttribute('src')).toBe('http://localhost:41000/x');
      expect(askButton()).toBeUndefined();
      // Using it is not asking for it.
      expect(forwardGranted('a', 3000)).toBe(false);
    } finally {
      act(() => pane.unmount());
    }
  });

  it('opens any other address outside', async () => {
    await show({ m: 'a', dir: '/home/u' });
    expect(await press('site')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
    expect(views()).toEqual([]);
  });

  it('opens another computer’s address outside in the desktop app too, and in a pane with the setting at all', async () => {
    shell.current = { browser: {} };
    await show({ m: 'a', dir: '/home/u' });
    await press('site');
    expect(open).toHaveBeenCalledTimes(1);
    expect(views()).toEqual([]);
    set('browser.openLinks', 'all');
    await press('site');
    expect(open).toHaveBeenCalledTimes(1);
    expect(views()).toMatchObject([{ url: 'https://example.com/a' }]);
  });

  it('opens everything outside with the setting at external', async () => {
    set('browser.openLinks', 'external');
    await show({ m: 'a', dir: '/home/u' });
    await press('app');
    expect(open).toHaveBeenCalledWith('http://localhost:3000/x', '_blank', 'noopener,noreferrer');
    expect(views()).toEqual([]);
    expect(forwardGranted('a', 3000)).toBe(false);
  });

  it('leaves mail links, and the links of a text of no machine, to the browser', async () => {
    await show({ m: 'a', dir: '/home/u' });
    expect(await press('mail')).toBe(false);
    await show();
    expect(await press('app')).toBe(false);
    expect(await press('site')).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(views()).toEqual([]);
  });
});
