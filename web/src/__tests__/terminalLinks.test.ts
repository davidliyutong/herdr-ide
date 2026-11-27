// @vitest-environment jsdom
//
// Which URLs of a terminal's output may be opened (terminal/links.ts
// safeUrl, openLink): absolute http(s) with `//` or mailto, as the browser
// will resolve them, never on the page's own origin (jsdom's
// http://localhost:3000) nor on its port under another name of the
// loopback, which is the same server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { linksAround, safeUrl, type RowText } from '../terminal/links';
import { openLink } from '../terminal/openLink';
import * as L from '../term/layout';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { useSettings } from '../settings';
import { definePlugins } from '../plugins/registry';
import { filesPlugin } from '../plugins/files';
import { vscodePlugin } from '../plugins/vscode';
import { surfaceMenu } from '../menus';
import { isItem } from '../contextMenu';
import { FakeHub, settle } from './fakeTerms';
import { vscodeOn } from './fakeSettings';

describe('safeUrl', () => {
  const cases: [string, boolean][] = [
    ['https://a.example/x', true],
    ['http://a.example', true],
    ['mailto:a@b.example', true],
    ['http://localhost:3001/', true],
    ['http:/api/x', false],
    ['http:x', false],
    ['https:/x', false],
    ['https:x', false],
    ['http://localhost:3000/api/m/x/hc/stop', false],
    ['HTTP://LOCALHOST:3000', false],
    // The page's server under its other names: any loopback host with the
    // page's port, under either scheme.
    ['http://127.0.0.1:3000/api/m/x/hc/stop', false],
    ['http://[::1]:3000/', false],
    ['http://127.0.0.2:3000/', false],
    ['http://127.1:3000/', false],
    ['http://2130706433:3000/', false],
    ['http://app.localhost:3000/', false],
    ['http://[::ffff:127.0.0.1]:3000/', false],
    ['https://localhost:3000/', false],
    ['https://127.0.0.1:3000/', false],
    // Another port is another program, another host another computer.
    ['http://127.0.0.1:3001/', true],
    ['http://127.0.0.1/', true],
    ['http://[::1]:8080/', true],
    ['http://192.168.1.5:3000/', true],
    ['http://a.example:3000/', true],
    ['http://localhost.a.example:3000/', true],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['//a.example/x', false],
    ['/api/x', false],
    ['', false],
  ];
  it.each(cases)('%j', (url, want) => expect(safeUrl(url)).toBe(want));
});

describe('openLink', () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => open.mockRestore());

  it('opens the URL as the browser will resolve it', () => {
    openLink({ kind: 'url', text: 'HTTPS://A.EXAMPLE' }, { m: 'a' });
    expect(open).toHaveBeenCalledWith('https://a.example/', '_blank', 'noopener,noreferrer');
  });

  it('opens nothing that is relative to the page or on its origin', () => {
    for (const text of [
      'http:/api/x',
      'http:x',
      'https:/x',
      'http://localhost:3000/api/x',
      'http://127.0.0.1:3000/api/x',
      'http://[::1]:3000/api/x',
      'javascript:alert(1)',
    ])
      openLink({ kind: 'url', text }, { m: 'a' });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('openLink default file routing (File Explorer preview vs VS Code)', () => {
  let hub: FakeHub;
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(async () => {
    posts.length = 0;
    definePlugins([vscodePlugin, filesPlugin]);
    vscodeOn();
    useSettings.setState((s) => ({
      values: {
        ...s.values,
        'plugins.files.enabled': { value: true, source: 'default' },
        'files.openLinks': { value: 'editor', source: 'default' },
      },
    }));
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    hub = new FakeHub();
    hub.machine('a', [FakeHub.term('s1', { cwd: '/home/u/proj' })], {
      version: 2,
      workspaces: [{ id: 'w1', name: '', cwd: '/home/u/proj', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
      selected: 0,
    });
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('a');
    hub.model.subscribe('a');
    await settle();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens terminal file links in the File Explorer preview editor by default with line ranges', async () => {
    openLink(
      { kind: 'path', text: 'configs/simple_plane/hardware/local/mvtrack.yaml:17-20' },
      { m: 'a', pane: 's1', cwd: '/home/u/proj', home: '/home/u' },
    );
    await settle();
    const ws = hub.model.layout('a')!.workspaces[0];
    const editors = L.pluginViews(ws, 'files', 'editor');
    expect(editors).toHaveLength(1);
    expect(editors[0].view).toMatchObject({
      plugin: 'files',
      kind: 'editor',
      path: '/home/u/proj/configs/simple_plane/hardware/local/mvtrack.yaml',
      preview: true,
      line: 17,
      col: 1,
      endLine: 20,
    });
    // Did not launch or bridge into VS Code.
    expect(L.codeViews(ws)).toHaveLength(0);
    expect(posts).toEqual([]);
  });

  it('routes to VS Code when files.openLinks is set to vscode', async () => {
    useSettings.setState((s) => ({
      values: { ...s.values, 'files.openLinks': { value: 'vscode', source: 'global' } },
    }));
    openLink({ kind: 'path', text: 'src/main.ts:12:4' }, { m: 'a', pane: 's1', cwd: '/home/u/proj', home: '/home/u' });
    await settle();
    const ws = hub.model.layout('a')!.workspaces[0];
    expect(L.pluginViews(ws, 'files', 'editor')).toHaveLength(0);
    expect(L.codeViews(ws)).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ cmd: 'openFile', path: '/home/u/proj/src/main.ts', line: 12, col: 4 });
  });

  it('keeps right-click Open in VS Code working even when default Cmd+Click opens File Explorer preview', async () => {
    const entries = surfaceMenu({
      ctx: { m: 'a', pane: 's1', cwd: '/home/u/proj', home: '/home/u' },
      link: { kind: 'path', text: 'src/app.ts:10-20' },
    });
    const previewItem = entries.filter(isItem).find((i) => i.label.includes('Preview'))!;
    const codeItem = entries.filter(isItem).find((i) => i.label.includes('VS Code'))!;
    previewItem.run!();
    await settle();
    const ws = hub.model.layout('a')!.workspaces[0];
    expect(L.pluginViews(ws, 'files', 'editor')[0].view).toMatchObject({
      path: '/home/u/proj/src/app.ts',
      preview: true,
      line: 10,
      endLine: 20,
    });
    codeItem.run!();
    await settle();
    expect(L.codeViews(hub.model.layout('a')!.workspaces[0])).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ cmd: 'openFile', path: '/home/u/proj/src/app.ts', line: 10 });
  });
});

function mkRow(text: string, cols = text.length, opts: { wrap?: boolean; writtenEnd?: number } = {}): RowText {
  const colOf: number[] = [];
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    colOf.push(c);
    // Treat CJK ideographs as double-width cells for realistic column mapping.
    c += text.charCodeAt(i) > 0x2e80 ? 2 : 1;
  }
  while (c < cols) {
    colOf.push(c);
    text += ' ';
    c++;
  }
  colOf.push(cols);
  return { text, colOf, ...opts };
}

describe('linksAround on narrow screens and wrapped rows', () => {
  it('joins soft-wrapped paths with trailing unwritten padding before wide CJK chars', () => {
    const line0 = '看 /Users/alice/Projects/webh';
    const rows = [mkRow(line0, 32, { wrap: true, writtenEnd: line0.length }), mkRow('erdr/web/src/terminal/links.ts', 32)];
    const links = linksAround(0, 0, rows.length, (y) => rows[y]);
    expect(links.map((l) => l.text)).toEqual(['/Users/alice/Projects/webherdr/web/src/terminal/links.ts']);
    expect(links[0].cells).toHaveLength(2);
    // Hovering the second row finds the same full path.
    expect(linksAround(1, 0, rows.length, (y) => rows[y]).map((l) => l.text)).toEqual([
      '/Users/alice/Projects/webherdr/web/src/terminal/links.ts',
    ]);
  });

  it('preserves explicit trailing spaces on soft-wrapped rows so separate words do not glue', () => {
    const rows = [mkRow('open src/app.ts ', 16, { wrap: true, writtenEnd: 16 }), mkRow('then run tests', 16)];
    const links = linksAround(0, 0, rows.length, (y) => rows[y]);
    expect(links.map((l) => l.text)).toEqual(['src/app.ts']);
  });

  it('joins paths wrapped inside TUI box borders and right-padded narrow columns', () => {
    const boxed = [mkRow('│ /Users/alice/Projects/web │', 29), mkRow('│ herdr/web/src/vt/pane.ts  │', 29)];
    expect(linksAround(0, 0, boxed.length, (y) => boxed[y]).map((l) => l.text)).toEqual([
      '/Users/alice/Projects/webherdr/web/src/vt/pane.ts',
    ]);

    const padded = [mkRow('  /Users/alice/Projects/web', 30), mkRow('  herdr/web/src/vt/pane.ts:42', 30)];
    expect(linksAround(1, 0, padded.length, (y) => padded[y]).map((l) => l.text)).toEqual([
      '/Users/alice/Projects/webherdr/web/src/vt/pane.ts:42',
    ]);
  });

  it('joins narrow slash-wrapped paths without gluing prose after a complete filename', () => {
    const slashWrap = [mkRow('  /Users/alice/Projects/', 28), mkRow('  webherdr/src/main.ts', 28)];
    expect(linksAround(0, 0, slashWrap.length, (y) => slashWrap[y]).map((l) => l.text)).toEqual([
      '/Users/alice/Projects/webherdr/src/main.ts',
    ]);

    const prose = [mkRow('  Please check src/app.ts', 28), mkRow('  and verify line 10', 28)];
    expect(linksAround(0, 0, prose.length, (y) => prose[y]).map((l) => l.text)).toEqual(['src/app.ts']);
  });

  it('preserves column-0 spaces on soft-wrapped continuation rows so following words do not glue onto links', () => {
    const url = 'https://example.com/exact';
    const rows = [mkRow(url, url.length, { wrap: true, writtenEnd: url.length }), mkRow(' nextword here', url.length)];
    expect(linksAround(0, 0, rows.length, (y) => rows[y]).map((l) => l.text)).toEqual([url]);
    expect(linksAround(1, 0, rows.length, (y) => rows[y])).toEqual([]);
  });

  it('does not bridge links across a blank TUI box-bordered row', () => {
    const rows = [
      mkRow('│ /Users/alice/Projects/app.ts │', 32),
      mkRow('│                              │', 32),
      mkRow('│ /Users/alice/Projects/other  │', 32),
    ];
    expect(linksAround(0, 0, rows.length, (y) => rows[y]).map((l) => l.text)).toEqual(['/Users/alice/Projects/app.ts']);
    expect(linksAround(1, 0, rows.length, (y) => rows[y])).toEqual([]);
    expect(linksAround(2, 0, rows.length, (y) => rows[y]).map((l) => l.text)).toEqual(['/Users/alice/Projects/other']);

    const tight = [mkRow('│ src/a.ts│', 11), mkRow('│   │      ', 11), mkRow('│ src/b.ts│', 11)];
    expect(linksAround(0, 0, tight.length, (y) => tight[y]).map((l) => l.text)).toEqual(['src/a.ts']);
    expect(linksAround(2, 0, tight.length, (y) => tight[y]).map((l) => l.text)).toEqual(['src/b.ts']);
  });
});
