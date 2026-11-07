// @vitest-environment jsdom
//
// Files dropped on the page. In the desktop app, folders dropped from Finder
// on the sidebar become workspaces on the local machine; other dropped files
// are skipped with a note, and read-only mode or a browser (no desktop
// bridge) takes no drop. Files dropped on a pane become the paths to paste:
// where they are for the desktop app's local machine, else uploaded to the
// pane's machine. Drops nothing takes are refused. Folders dropped on the
// desktop app's Dock icon become workspaces on the local machine too, once it
// is connected.

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
/** What the page gave the bridge for folders dropped on the Dock icon. */
let openFolder: ((path: string) => void) | undefined;
const shell = {
  onOpenFolder: (fn: (path: string) => void) => {
    openFolder = fn;
    return () => {
      openFolder = undefined;
    };
  },
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
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], items, dropEffect: 'move' } });
  return ev as Event & { dataTransfer: { dropEffect: string } };
}

/** Upload requests; a directory named /readonly takes no file. */
const uploads: string[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    uploads.push(url);
    const q = new URL(url, 'http://core').searchParams;
    const dir = q.get('dir') ?? '/home/u/uploads';
    if (dir === '/readonly')
      return { ok: false, json: async () => ({ error: 'agent fs.write: open /readonly/.tmp-1: permission denied' }) };
    return { ok: true, json: async () => ({ name: q.get('name'), size: 0, path: `${dir}/${q.get('name')}` }) };
  }),
);

let store: typeof import('../state/store');
let drop: typeof import('../drop');
let Sidebar: typeof import('../components/Sidebar').Sidebar;
let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  (globalThis as { desktopShell?: unknown }).desktopShell = shell;
  store = await import('../state/store');
  drop = await import('../drop');
  Sidebar = (await import('../components/Sidebar')).Sidebar;
});

beforeEach(() => {
  calls.length = 0;
  uploads.length = 0;
  store.useStore.setState({
    readOnly: false,
    toasts: [],
    order: ['local', 'ws2'],
    machines: {
      local: { id: 'local', label: 'Mac', kind: 'local', session: 'default', enabled: true, status: 'ready' },
      ws2: { id: 'ws2', label: 'ws2', kind: 'ssh', session: 'default', enabled: true, status: 'ready', info: { home: '/home/u' } },
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
  it('are read with their paths, telling folders from files', () => {
    const r = drop.droppedItems([item('app', '/Users/u/app', true), item('a.png', '/Users/u/a.png', false)]);
    expect(r.map(({ path, folder }) => ({ path, folder }))).toEqual([
      { path: '/Users/u/app', folder: true },
      { path: '/Users/u/a.png', folder: false },
    ]);
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
    const browser = await import('../drop');
    const fresh = await import('../state/store');
    fresh.useStore.setState({ machines: store.useStore.getState().machines });
    expect(drop.folderDropTarget()?.id).toBe('local');
    expect(browser.folderDropTarget()).toBeUndefined();
    // Nor are files dropped on a local pane where they are: they are uploaded.
    expect(drop.filesAreOn('local')).toBe(true);
    expect(browser.filesAreOn('local')).toBe(false);
    (globalThis as { desktopShell?: unknown }).desktopShell = shell;
  });
});

describe('folders dropped on the Dock icon', () => {
  const creates = () => calls.filter((c) => c.method === 'workspace.create').map((c) => [c.m, c.params.cwd]);
  const toasts = () => store.useStore.getState().toasts.map((t) => t.msg);
  const local = (status: string) => ({ id: 'local', label: 'Mac', kind: 'local', session: 'default', enabled: true, status });

  afterEach(() => vi.useRealTimers());

  it('become workspaces on the local machine once it connects, in order', async () => {
    // Launched by the drop: the page does not know its machines yet.
    store.useStore.setState({ machines: {}, order: [] });
    const off = drop.takeOpenedFolders();
    openFolder!('/Users/u/Projects/app');
    openFolder!('/Users/u/Projects/lib');
    await act(async () => store.useStore.setState({ machines: { local: local('connecting') } as never, order: ['local'] }));
    expect(creates()).toEqual([]);
    await act(async () => store.useStore.setState({ machines: { local: local('ready') } as never }));
    expect(creates()).toEqual([
      ['local', '/Users/u/Projects/app'],
      ['local', '/Users/u/Projects/lib'],
    ]);
    expect(toasts()).toEqual([]);
    off();
    expect(openFolder).toBeUndefined();
  });

  it('are not opened, with a note, when the local machine does not connect or is disabled', async () => {
    vi.useFakeTimers();
    store.useStore.setState({ machines: { local: local('connecting') } as never });
    drop.openFolder('/Users/u/app');
    await vi.advanceTimersByTimeAsync(drop.OPEN_WAIT_MS - 1);
    expect(toasts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(toasts()).toEqual(['1 folder(s) dropped on the Dock icon not opened: the local machine is not connected.']);

    store.useStore.setState({ toasts: [], machines: { local: local('disabled') } as never });
    drop.openFolder('/Users/u/app');
    drop.openFolder('/Users/u/lib');
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts()).toHaveLength(1);
    expect(creates()).toEqual([]);
  });
});

describe('files dropped on a pane', () => {
  const toasts = () => store.useStore.getState().toasts.map((t) => t.msg);
  const dropped = () =>
    drop.droppedItems([
      item('My Project', '/Users/u/My Project', true),
      item('a.png', '/Users/u/a.png', false),
      item("it's.txt", "/Users/u/it's.txt", false),
    ]);

  it('of the local machine are pasted where they are, folders too', async () => {
    expect(await drop.droppedPaths('local', dropped())).toBe(`'/Users/u/My Project' /Users/u/a.png '/Users/u/it'\\''s.txt' `);
    expect(uploads).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it("of another machine are uploaded into the pane's directory there; folders are skipped", async () => {
    expect(await drop.droppedPaths('ws2', dropped(), '/home/u/proj')).toBe(`/home/u/proj/a.png '/home/u/proj/it'\\''s.txt' `);
    expect(uploads).toEqual([
      '/api/m/ws2/upload?name=a.png&dir=%2Fhome%2Fu%2Fproj',
      '/api/m/ws2/upload?name=it%27s.txt&dir=%2Fhome%2Fu%2Fproj',
    ]);
    expect(toasts()).toEqual(['Folders cannot be uploaded; 1 skipped.', 'Uploading 2 file(s) into ~/proj on ws2…']);
  });

  it('go to the upload directory when the pane has none or it takes no file', async () => {
    const file = () => drop.droppedItems([item('a.png', '/Users/u/a.png', false)]);
    expect(await drop.droppedPaths('ws2', file())).toBe('/home/u/uploads/a.png ');
    expect(await drop.droppedPaths('ws2', file(), '/readonly')).toBe('/home/u/uploads/a.png ');
    expect(uploads).toEqual([
      '/api/m/ws2/upload?name=a.png',
      '/api/m/ws2/upload?name=a.png&dir=%2Freadonly',
      '/api/m/ws2/upload?name=a.png',
    ]);
    expect(toasts()).toContain('Could not save into /readonly (permission denied); uploading to the upload folder instead.');
  });
});

describe('drops nothing takes', () => {
  it('are refused, so the browser does not open the file', () => {
    drop.refuseStrayFileDrops();
    const stray = dragEvent('dragover', []);
    act(() => {
      document.body.dispatchEvent(stray);
    });
    expect(stray.defaultPrevented).toBe(true);
    expect(stray.dataTransfer.dropEffect).toBe('none');
    const onSidebar = dragEvent('dragover', [item('app', '/Users/u/app', true)]);
    act(() => {
      host.querySelector('aside')!.dispatchEvent(onSidebar);
    });
    expect(onSidebar.dataTransfer.dropEffect).toBe('copy');
  });
});
