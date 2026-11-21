// @vitest-environment jsdom
//
// Editors of files gone from their machine (plugins/files/gone.ts): the
// titles of their tabs and headers are struck through, their tooltips say
// so, also for a tab not shown, and the mark goes once the file is back; an
// editor keeps its text, unsaved changes too. Reveal in Finder in the
// explorer's and an editor tab's menus, only for the core's own machine
// and when the core offers it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true, retry: () => {} } }));
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));
vi.mock('../plugins/monaco', () => ({
  setLanguage: vi.fn(),
  createEditor: vi.fn(async () => {
    let model: { value: string; getValue(): string; setValue(v: string): void } | undefined;
    const editor = {
      setModel: (m: typeof model) => (model = m),
      getModel: () => model,
      getValue: () => model?.getValue() ?? '',
      onKeyDown: () => ({ dispose() {} }),
      onDidChangeModelContent: () => ({ dispose() {} }),
      createDecorationsCollection: () => ({ clear() {} }),
      updateOptions() {},
      focus() {},
      dispose() {},
    };
    const monaco = {
      Uri: { from: (o: unknown) => o },
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      editor: {
        getModel: () => null,
        OverviewRulerLane: { Left: 1 },
        createModel: () => {
          let v = '';
          let version = 1;
          return {
            getValue: () => v,
            setValue: (x: string) => ((v = x), version++),
            getAlternativeVersionId: () => version,
            getVersionId: () => version,
            onDidChangeContent: () => ({ dispose() {} }),
            dispose() {},
          };
        },
      },
    };
    return { monaco, editor };
  }),
}));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { t } from '../i18n';
import { Workspace } from '../components/Workspace';
import { definePlugins } from '../plugins/registry';
import { filesPlugin } from '../plugins/files';
import { recheckGone, useGoneFiles } from '../plugins/files/gone';
import { menuFor, useRevealable } from '../plugins/files/ops';
import { showRoot } from '../plugins/files/tree';
import { tabMenu } from '../menus';
import { actions } from '../actions';
import { useSettings } from '../settings';
import { isItem, type MenuEntry, type MenuItem } from '../contextMenu';
import { FakeCore, settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
definePlugins([filesPlugin]);

/** The files on the machine, by path. */
let files: Record<string, string>;
let reveals: string[];
let revealable: boolean;
/** How many times the page asked whether reveal is offered. */
let asks: number;

const editor = (id: string, path: string) => ({ root: { view: { id, plugin: 'files', kind: 'editor', path } }, focused: `view:${id}` });
const preview = (id: string, path: string) => ({ root: { preview: { id, path } }, focused: `preview:${id}` });
const labels = (entries: MenuEntry[]) => entries.filter((e): e is MenuItem => isItem(e)).map((e) => e.label);

describe('editors of files gone', () => {
  let host: HTMLDivElement;
  let root: Root;
  let core: FakeCore;
  const flush = () => act(async () => settle());
  const tabLabel = (i: number) => host.querySelectorAll<HTMLElement>('.tab .tab-label')[i];
  const check = async () => {
    await act(async () => recheckGone());
    await flush();
  };

  beforeEach(async () => {
    files = { '/home/u/a.txt': 'alpha', '/home/u/b.txt': 'beta', '/home/u/c.js': 'const c = 1;', '/home/u/d.js': 'const d = 1;' };
    reveals = [];
    revealable = true;
    asks = 0;
    useRevealable.setState({}, true);
    useGoneFiles.setState({ gone: {} });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      const method = init?.method ?? 'GET';
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
      const p = url.searchParams.get('path') ?? '';
      if (url.pathname === '/api/m/m/file') {
        if (!(p in files)) return new Response('not found', { status: 404 });
        const headers = { ETag: `W/"${files[p].length.toString(16)}-1"`, 'Content-Length': String(files[p].length) };
        return new Response(method === 'HEAD' ? null : files[p], { status: 200, headers });
      }
      if (url.pathname === '/api/m/m/list') {
        // Only the home directory is one: a preview of a file tries it first.
        if (p !== '/home/u') return json({ error: 'not a directory' }, 404);
        return json({
          dir: { path: p, is_dir: true },
          entries: Object.keys(files).map((f) => ({ name: f.slice(8), is_dir: false, size: 1 })),
        });
      }
      if (url.pathname === '/api/m/m/p/files/stat') {
        const { paths } = JSON.parse(String(init!.body)) as { paths: string[] };
        return json({ entries: paths.map((path) => ({ path, exists: path in files, size: files[path]?.length ?? 0, mtime: 1 })) });
      }
      if (url.pathname === '/api/m/m/p/files/reveal') {
        if (method === 'GET') return (asks++, json({ available: revealable }));
        reveals.push((JSON.parse(String(init!.body)) as { path: string }).path);
        return json({ paths: [] });
      }
      return json({});
    });
    core = new FakeCore();
    core.machine('m', [], {
      version: 2,
      workspaces: [
        {
          id: 'wwwwwwww',
          name: 'w',
          cwd: '/home/u',
          tabs: [
            editor('ea', '/home/u/a.txt'),
            editor('eb', '/home/u/b.txt'),
            preview('pc', '/home/u/c.js'),
            preview('pd', '/home/u/d.js'),
          ],
          selected: 0,
        },
      ],
      selected: 0,
    });
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([
      { id: 'm', label: 'm', kind: 'local', status: 'ready', info: { home: '/home/u', os: 'darwin' } } as unknown as MachineState,
    ]);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    await flush();
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('strikes through the titles of files gone, also of a tab not shown, until they are back', async () => {
    await check();
    expect(host.querySelectorAll('.is-gone')).toHaveLength(0);
    // The file of the tab not shown is deleted.
    delete files['/home/u/b.txt'];
    await check();
    expect(tabLabel(1).classList).toContain('is-gone');
    expect(tabLabel(1).title).toContain(t('files.gone'));
    expect(tabLabel(0).classList).not.toContain('is-gone');
    // The shown one's: its tab and its header, and the text stays.
    delete files['/home/u/a.txt'];
    await check();
    expect(tabLabel(0).classList).toContain('is-gone');
    const header = host.querySelector<HTMLElement>('.pane-title')!;
    expect(header.classList).toContain('is-gone');
    expect(header.title).toContain(t('files.gone'));
    // Back again: the marks go.
    files['/home/u/a.txt'] = 'alpha';
    files['/home/u/b.txt'] = 'beta';
    await check();
    expect(host.querySelectorAll('.is-gone')).toHaveLength(0);
    expect(tabLabel(1).title).not.toContain(t('files.gone'));
  });

  it('strikes through the titles of previews of files gone, a tab not shown too, and keeps what they showed', async () => {
    const shown = () => host.querySelector('.text-preview')?.textContent ?? '';
    const show = async (i: number) => {
      await act(async () => actions.selectTab('m', 'wwwwwwww', i));
      await flush();
      await flush();
    };
    await check();
    delete files['/home/u/d.js'];
    await check();
    expect(tabLabel(3).classList).toContain('is-gone');
    expect(tabLabel(3).title).toContain(t('files.gone'));
    expect(tabLabel(2).classList).not.toContain('is-gone');
    // The preview shown: its tab and its header.
    await show(2);
    expect(shown()).toContain('const c = 1;');
    delete files['/home/u/c.js'];
    await check();
    expect(tabLabel(2).classList).toContain('is-gone');
    const header = host.querySelector<HTMLElement>('.pane-title')!;
    expect(header.classList).toContain('is-gone');
    expect(header.title).toContain(t('files.gone'));
    // What it showed stays, also when it is drawn again: no error instead.
    expect(shown()).toContain('const c = 1;');
    await show(0);
    await show(2);
    expect(shown()).toContain('const c = 1;');
    expect(host.querySelector('.preview .error')).toBeNull();
    // Back, with other text: the marks go and the preview shows it as it is.
    files['/home/u/c.js'] = 'const c = 2;';
    files['/home/u/d.js'] = 'const d = 1;';
    await check();
    await flush();
    expect(host.querySelectorAll('.is-gone')).toHaveLength(0);
    expect(shown()).toContain('const c = 2;');
  });

  it('marks no preview while the explorer is off', async () => {
    const values = useSettings.getState().values;
    try {
      await act(async () => useSettings.setState({ values: { ...values, 'plugins.files.enabled': { value: false, source: 'global' } } }));
      await flush();
      useGoneFiles.setState({ gone: { 'm\n/home/u/c.js': true, 'm\n/home/u/d.js': true } });
      await flush();
      expect(tabLabel(3).classList).not.toContain('is-gone');
      expect(tabLabel(3).title).not.toContain(t('files.gone'));
    } finally {
      await act(async () => useSettings.setState({ values }));
    }
  });

  it('offers Reveal in Finder for the core’s own machine when the core does', async () => {
    const item = (entries: MenuEntry[]) =>
      entries.filter((e): e is MenuItem => isItem(e)).find((e) => e.label === t('files.revealInFinder'));
    // The editor's tab.
    const reveal = item(tabMenu('m', 'wwwwwwww', 1));
    expect(reveal).toBeDefined();
    await act(async () => reveal!.run?.());
    await flush();
    expect(reveals).toEqual(['/home/u/b.txt']);
    // The explorer's rows and its root.
    await act(async () => showRoot('m', '/home/u'));
    expect(item(menuFor('m', ['/home/u/a.txt'], () => false))).toBeDefined();
    await act(async () => item(menuFor('m', [], () => false))!.run?.());
    await flush();
    expect(reveals).toEqual(['/home/u/b.txt', '/home/u']);
    // Read-only mode runs nothing on the computer.
    useStore.getState().setReadOnly(true);
    expect(item(menuFor('m', ['/home/u/a.txt'], () => false))).toBeUndefined();
    useStore.getState().setReadOnly(false);
    // A core that does not offer it (a page on another computer).
    useRevealable.setState({}, true);
    revealable = false;
    labels(tabMenu('m', 'wwwwwwww', 1));
    await flush();
    expect(item(tabMenu('m', 'wwwwwwww', 1))).toBeUndefined();
    expect(item(menuFor('m', ['/home/u/a.txt'], () => false))).toBeUndefined();
  });

  it('offers no Reveal in Finder for another machine, nor asks the core', async () => {
    useRevealable.setState({}, true);
    asks = 0;
    useStore
      .getState()
      .setMachines([
        { id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u', os: 'darwin' } } as unknown as MachineState,
      ]);
    expect(labels(tabMenu('m', 'wwwwwwww', 1))).not.toContain(t('files.revealInFinder'));
    await flush();
    expect(labels(tabMenu('m', 'wwwwwwww', 1))).not.toContain(t('files.revealInFinder'));
    expect(useRevealable.getState().m).toBe(false);
    expect(asks).toBe(0);
  });
});
