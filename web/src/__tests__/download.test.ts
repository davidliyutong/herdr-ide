// @vitest-environment jsdom
//
// Downloads from a machine: the pane menu offers a path under the pointer
// and a chooser of the pane's directory (not for the desktop app's own
// machine), the chooser takes several entries and directories in one
// download, a path that names nothing becomes a note, and only the page with
// the focus downloads what VS Code's explorer asked for.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MenuEntry, MenuItem } from '../contextMenu';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), send: () => {}, sendNow: () => {}, setTheme: () => {} } }));

let shell: unknown;
vi.mock('../desktop', () => ({
  get desktopShell() {
    return shell;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: typeof import('../state/store');
let menus: typeof import('../menus');
let download: typeof import('../download');
let dialog: typeof import('../dialog');
let Dialogs: typeof import('../components/Dialogs').Dialogs;

/** Links the page clicked to start downloads. */
const clicked: string[] = [];
const fetches: Array<{ url: string; method: string }> = [];
const dirs: Record<string, { name: string; size: number; is_dir: boolean }[]> = {
  '/home/u/proj': [
    { name: 'src', size: 0, is_dir: true },
    { name: 'a.txt', size: 2048, is_dir: false },
    { name: 'b.png', size: 10, is_dir: false },
  ],
  '/home/u/proj/src': [{ name: 'main.go', size: 5, is_dir: false }],
  '/home/u': [{ name: 'proj', size: 0, is_dir: true }],
};

beforeAll(async () => {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '');
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    fetches.push({ url, method: init?.method ?? 'GET' });
    const u = new URL(url, 'http://core');
    if (u.pathname.endsWith('/list')) {
      const path = u.searchParams.get('path')!;
      const entries = dirs[path];
      if (!entries) return Promise.resolve(new Response(JSON.stringify({ error: 'no such directory' }), { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify({ dir: { name: '', path, is_dir: true }, entries })));
    }
    const missing = u.searchParams.getAll('path').some((p) => p.includes('missing'));
    return Promise.resolve(new Response(null, { status: missing ? 404 : 200 }));
  });
  store = await import('../state/store');
  menus = await import('../menus');
  download = await import('../download');
  dialog = await import('../dialog');
  Dialogs = (await import('../components/Dialogs')).Dialogs;
});

let root: Root | undefined;
beforeEach(() => {
  shell = undefined;
  clicked.length = 0;
  fetches.length = 0;
  store.useStore.setState({
    readOnly: false,
    toasts: [],
    machines: {
      local: { id: 'local', label: 'Mac', kind: 'local', session: 'default', enabled: true, status: 'ready', updated_at: 0 },
      gpu: { id: 'gpu', label: 'gpu', kind: 'ssh', session: 'default', enabled: true, status: 'ready', updated_at: 0 },
    },
  } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  dialog.useDialog.setState({ current: undefined });
});

const labels = (e: MenuEntry[]) => e.map((x) => (x === 'sep' ? '-' : x.label));
const item = (e: MenuEntry[], label: string) => e.find((x): x is MenuItem => x !== 'sep' && x.label === label)!;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const query = (url: string) => new URL(url, 'http://core').searchParams.getAll('path');

describe('pane menu', () => {
  it('downloads a path under the pointer and chooses from the directory', async () => {
    const entries = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u/proj', home: '/home/u' }, link: { kind: 'path', text: 'a.txt' } });
    expect(labels(entries)).toEqual([
      'Copy',
      '-',
      'Preview a.txt',
      'Open a.txt in VS Code',
      'Download a.txt',
      'Copy full path',
      '-',
      'Download files…',
    ]);
    item(entries, 'Download a.txt').run();
    await flush();
    // Checked first, then downloaded with a same-origin link.
    expect(fetches).toEqual([{ url: '/api/m/gpu/download?path=%2Fhome%2Fu%2Fproj%2Fa.txt', method: 'HEAD' }]);
    expect(clicked).toEqual(['/api/m/gpu/download?path=%2Fhome%2Fu%2Fproj%2Fa.txt']);
  });

  it('makes a path that names nothing a note', async () => {
    const entries = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u' }, link: { kind: 'path', text: 'missing.txt' } });
    item(entries, 'Download missing.txt').run();
    await flush();
    expect(clicked).toEqual([]);
    expect(store.useStore.getState().toasts.map((x) => x.msg)).toEqual(['Could not download missing.txt: not found']);
  });

  it('has no downloads for the desktop app’s own machine', () => {
    shell = {};
    const local = menus.surfaceMenu({ ctx: { m: 'local', cwd: '/Users/u' }, link: { kind: 'path', text: 'a.txt' } });
    expect(labels(local).filter((l) => l.startsWith('Download'))).toEqual([]);
    const remote = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u' } });
    expect(labels(remote)).toEqual(['Copy', '-', 'Download files…']);
    // A browser downloads from every machine, the core's own too.
    shell = undefined;
    expect(labels(menus.surfaceMenu({ ctx: { m: 'local', cwd: '/Users/u' } }))).toContain('Download files…');
  });
});

describe('download chooser', () => {
  const render = async (dir: string) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Dialogs)));
    let done = false;
    act(() => void dialog.downloadDialog('gpu', dir).then(() => (done = true)));
    await flush();
    return { host, closed: () => done };
  };
  const rows = (host: HTMLElement) => [...host.querySelectorAll('.download-row:not(.download-all)')].map((r) => r.textContent);
  const check = (host: HTMLElement, name: string) =>
    act(() => host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!.click());
  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find((b) => b.textContent === label)!;

  it('downloads the checked entries of a directory in one go', async () => {
    const { host, closed } = await render('/home/u/proj');
    expect(host.querySelector('.modal-title')?.textContent).toBe('Download from gpu');
    expect(rows(host)).toEqual(['src', 'a.txt2.0 KB', 'b.png10 B']);
    expect(button(host, 'Download').disabled).toBe(true);
    check(host, 'src');
    check(host, 'a.txt');
    expect(host.querySelector('.dialog-actions')?.textContent).toContain('2 selected');
    act(() => button(host, 'Download').click());
    expect(clicked.map(query)).toEqual([['/home/u/proj/src', '/home/u/proj/a.txt']]);
    await flush();
    expect(closed()).toBe(true);
  });

  it('enters directories, goes up and selects all', async () => {
    const { host } = await render('/home/u/proj');
    act(() => host.querySelector<HTMLButtonElement>('button.download-name')!.click());
    await flush();
    expect(host.querySelector('.download-path')?.textContent).toBe('/home/u/proj/src');
    expect(rows(host)).toEqual(['main.go5 B']);
    act(() => host.querySelector<HTMLButtonElement>('.download-path button')!.click());
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('.download-path button')!.click());
    await flush();
    expect(host.querySelector('.download-path')?.textContent).toBe('/home/u');
    act(() => host.querySelector<HTMLInputElement>('.download-all input')!.click());
    act(() => button(host, 'Download').click());
    expect(clicked.map(query)).toEqual([['/home/u/proj']]);
  });

  it('shows why a directory cannot be listed and closes on Escape', async () => {
    const { host, closed } = await render('/nope');
    expect(host.querySelector('.download-list .error')?.textContent).toBe('Could not list /nope: no such directory');
    act(() => {
      host.querySelector('.modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(closed()).toBe(true);
    expect(clicked).toEqual([]);
  });
});

describe('VS Code explorer', () => {
  it('downloads on the page with the focus only', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    download.bridgeDownload('gpu', ['/srv/a', '/srv/b']);
    expect(clicked).toEqual([]);
    focus.mockReturnValue(true);
    download.bridgeDownload('gpu', ['/srv/a', '/srv/b']);
    expect(clicked.map(query)).toEqual([['/srv/a', '/srv/b']]);
    focus.mockRestore();
  });
});
