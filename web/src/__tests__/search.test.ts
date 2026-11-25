// @vitest-environment jsdom
//
// Project Search (plugins/search): the rows of a result (files, then
// their lines unless collapsed), the panel's search of the focused
// terminal's folder with the matches marked, a new search cancelling the
// one in flight, and a line opening the file explorer's editor at its line
// and column while VS Code is off.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { definePlugins } from '../plugins/registry';
import { filesPlugin } from '../plugins/files';
import { searchPlugin } from '../plugins/search';
import { SearchPanel, DEBOUNCE_MS } from '../plugins/search/SearchPanel';
import { joinPath, matchesOf, resultRows, shortDir, splitPath, stepRow } from '../plugins/search/model';
import { openMatch, paramsFor, runSearch, setSearch, useSearch } from '../plugins/search/state';
import type { SearchParams, SearchResult } from '../plugins/search/api';

definePlugins([filesPlugin, searchPlugin]);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result: SearchResult = {
  engine: 'rg',
  dir: '/home/u/w1',
  matchCount: 3,
  files: [
    {
      path: 'src/a.go',
      matches: [
        {
          line: 3,
          col: 6,
          preview: 'func Needle() {} // needle',
          ranges: [
            [5, 11],
            [20, 26],
          ],
        },
        { line: 9, col: 1, preview: 'needle', ranges: [[0, 6]] },
      ],
    },
    { path: 'b.md', matches: [{ line: 1, col: 3, preview: 'A needle', ranges: [[2, 8]] }] },
  ],
};

describe('model', () => {
  it('lays out a result as files and their lines', () => {
    const rows = resultRows(result, {});
    expect(rows.map((r) => r.id)).toEqual(['f:src/a.go', 'm:0:src/a.go', 'm:1:src/a.go', 'f:b.md', 'm:0:b.md']);
    expect(resultRows(result, { 'src/a.go': true }).map((r) => r.id)).toEqual(['f:src/a.go', 'f:b.md', 'm:0:b.md']);
    expect(matchesOf(result.files[0])).toBe(3);
    expect(splitPath('src/lib/a.go')).toEqual({ name: 'a.go', folder: 'src/lib' });
    expect(splitPath('a.go')).toEqual({ name: 'a.go', folder: '' });
    expect(joinPath('/home/u', 'a/b')).toBe('/home/u/a/b');
    expect(joinPath('/', 'etc/x')).toBe('/etc/x');
    expect(stepRow(rows, undefined, 1)).toBe('f:src/a.go');
    expect(stepRow(rows, 'm:0:b.md', 1)).toBe('m:0:b.md');
    expect(stepRow(rows, 'f:b.md', -1)).toBe('m:1:src/a.go');
    expect(shortDir('/home/u/w1', '/home/u')).toBe('~/w1');
    expect(shortDir('/home/uu', '/home/u')).toBe('/home/uu');
  });

  it('sends only the options that are on', () => {
    setSearch({ query: 'x', regex: false, caseSensitive: true, wholeWord: false, include: ' *.go ', exclude: '' });
    expect(paramsFor('/d')).toEqual({ dir: '/d', query: 'x', caseSensitive: true, include: '*.go' });
  });
});

describe('the panel', () => {
  let hub: FakeHub;
  let host: HTMLDivElement;
  let root: Root;
  let requests: Array<{ p: SearchParams; signal?: AbortSignal }>;
  /** Answers held until released (a slow machine). */
  let hold: Promise<void> | undefined;
  const ws = () => hub.model.layout('a')!.workspaces[0];

  beforeEach(async () => {
    requests = [];
    hold = undefined;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://x');
      if (url.pathname === '/api/m/a/p/search/search') {
        const p = JSON.parse(init!.body as string) as SearchParams;
        requests.push({ p, signal: init?.signal ?? undefined });
        if (hold) await hold;
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (p.query === '(') return new Response(JSON.stringify({ error: 'bad_regex', message: 'bad_regex: missing )' }), { status: 400 });
        return new Response(JSON.stringify({ ...result, dir: p.dir }));
      }
      return new Response('{}');
    });
    hub = new FakeHub();
    hub.machine('a', [FakeHub.term('s1', { cwd: '/home/u/w1' })], {
      version: 2,
      workspaces: [{ id: 'w1', name: '', cwd: '/home/u/w1', tabs: [{ root: { terminal: 's1' }, focused: 's1' }], selected: 0 }],
      selected: 0,
    });
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('a');
    hub.model.subscribe('a');
    await settle();
    useSearch.setState({
      query: '',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      include: '',
      exclude: '',
      scope: undefined,
      result: undefined,
      error: undefined,
      busy: false,
      collapsed: {},
      cursor: undefined,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('searches the focused terminal’s folder and marks the matches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => root.render(createElement(SearchPanel)));
    const input = host.querySelector<HTMLInputElement>('.search-field input')!;
    expect(host.querySelector<HTMLInputElement>('.search-dir')!.value).toBe('~/w1');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await act(async () => settle());
    expect(requests.map((r) => r.p)).toEqual([{ dir: '/home/u/w1', query: 'needle' }]);
    const files = [...host.querySelectorAll('.search-file .tree-label')].map((e) => e.textContent);
    expect(files).toEqual(['a.go', 'b.md']);
    const marks = [...host.querySelectorAll('.search-match')][0].querySelectorAll('mark.match');
    expect([...marks].map((m) => m.textContent)).toEqual(['Needle', 'needle']);
    expect(host.querySelector('.search-status')!.textContent).toContain('3');
  });

  it('cancels the search in flight for a new one, and says why one failed', async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    setSearch({ query: 'one' });
    const first = runSearch('a', '/d');
    setSearch({ query: 'two' });
    const second = runSearch('a', '/d');
    await settle();
    expect(requests.map((r) => r.p.query)).toEqual(['one', 'two']);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(useSearch.getState().result?.key).toContain('two');
    hold = undefined;
    setSearch({ query: '(' });
    await runSearch('a', '/d');
    expect(useSearch.getState().error).toMatch(/regular expression.*missing \)/);
  });

  it('opens a line in the editor at its line and column without VS Code', async () => {
    await act(async () => openMatch('a', '/home/u/w1/src/a.go', 3, 6));
    await settle();
    const v = L.pluginViews(ws(), 'files', 'editor')[0].view;
    expect([v.path, v.line, v.col, v.preview]).toEqual(['/home/u/w1/src/a.go', 3, 6, true]);
    const first = v.reveal;
    // The same place again is asked for again.
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => openMatch('a', '/home/u/w1/src/a.go', 3, 6));
    await settle();
    expect(L.pluginViews(ws(), 'files', 'editor')[0].view.reveal).not.toBe(first);
  });
});
