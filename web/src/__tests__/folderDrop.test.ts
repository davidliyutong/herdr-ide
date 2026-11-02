// @vitest-environment jsdom
//
// In the desktop app, folders dropped from Finder on the sidebar become
// workspaces on the local machine; other dropped files are skipped with a
// note, and read-only mode or a browser (no desktop bridge) takes no drop.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const calls: Array<{ m: string; method: string; params: Record<string, unknown> }> = [];
vi.mock('../lib/conn', () => ({
  conn: {
    api: (m: string, method: string, params: Record<string, unknown>) => {
      calls.push({ m, method, params });
      return Promise.resolve(method === 'workspace.create' ? { workspace: { workspace_id: 'w9' }, root_pane: { pane_id: 'p9' } } : {});
    },
    send: () => {},
    sendNow: () => {},
    setTheme: () => {},
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Files the fake desktop bridge knows the paths of. */
const onDisk = new Map<File, string>();
const shell = {
  onShortcut: () => () => {},
  shortcutsChanged() {},
  recordShortcut() {},
  onRecordedKey: () => () => {},
  setTheme() {},
  pathForFile: (f: File) => onDisk.get(f) ?? '',
};

/** A dropped item: a folder or a file from Finder. */
function item(name: string, path: string, folder: boolean): DataTransferItem {
  const file = new File([], name);
  onDisk.set(file, path);
  return {
    kind: 'file',
    type: '',
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory: folder }),
  } as unknown as DataTransferItem;
}

function dragEvent(type: string, items: DataTransferItem[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], items, dropEffect: 'none' } });
  return ev;
}

let store: typeof import('../state/store');
let drop: typeof import('../folderDrop');
let Sidebar: typeof import('../components/Sidebar').Sidebar;
let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  (globalThis as { desktopShell?: unknown }).desktopShell = shell;
  store = await import('../state/store');
  drop = await import('../folderDrop');
  Sidebar = (await import('../components/Sidebar')).Sidebar;
});

beforeEach(() => {
  calls.length = 0;
  store.useStore.setState({
    readOnly: false,
    toasts: [],
    order: ['local', 'ws2'],
    machines: {
      local: { id: 'local', label: 'Mac', kind: 'local', session: 'default', enabled: true, status: 'ready' },
      ws2: { id: 'ws2', label: 'ws2', kind: 'ssh', session: 'default', enabled: true, status: 'ready' },
    },
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Sidebar)));
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

describe('dropped folders', () => {
  it('picks the folders among the dropped items', () => {
    const r = drop.droppedFolders([item('app', '/Users/u/app', true), item('a.png', '/Users/u/a.png', false)], shell.pathForFile);
    expect(r).toEqual({ folders: ['/Users/u/app'], others: 1 });
  });

  it('become workspaces on the local machine', async () => {
    const aside = host.querySelector('aside')!;
    const items = [
      item('app', '/Users/u/Projects/app', true),
      item('lib', '/Users/u/Projects/lib', true),
      item('a.png', '/Users/u/a.png', false),
    ];
    const over = dragEvent('dragover', items);
    act(() => {
      aside.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(host.querySelector('.sidebar-drop')?.textContent).toContain('Mac');
    await act(async () => {
      aside.dispatchEvent(dragEvent('drop', items));
    });
    expect(host.querySelector('.sidebar-drop')).toBeNull();
    expect(calls.filter((c) => c.method === 'workspace.create')).toEqual([
      { m: 'local', method: 'workspace.create', params: { cwd: '/Users/u/Projects/app', label: undefined, focus: false } },
      { m: 'local', method: 'workspace.create', params: { cwd: '/Users/u/Projects/lib', label: undefined, focus: false } },
    ]);
    expect(store.useStore.getState().toasts.map((t) => t.msg)).toEqual([
      'Only folders become workspaces; 1 other dropped item(s) skipped.',
    ]);
  });

  it('are not taken in read-only mode', () => {
    act(() => store.useStore.setState({ readOnly: true }));
    const over = dragEvent('dragover', [item('app', '/Users/u/app', true)]);
    act(() => {
      host.querySelector('aside')!.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(false);
    expect(host.querySelector('.sidebar-drop')).toBeNull();
  });

  it('are not taken in a browser, which has no desktop bridge', async () => {
    vi.resetModules();
    delete (globalThis as { desktopShell?: unknown }).desktopShell;
    const browser = await import('../folderDrop');
    const fresh = await import('../state/store');
    fresh.useStore.setState({ machines: store.useStore.getState().machines });
    expect(drop.folderDropTarget()?.id).toBe('local');
    expect(browser.folderDropTarget()).toBeUndefined();
    (globalThis as { desktopShell?: unknown }).desktopShell = shell;
  });
});
