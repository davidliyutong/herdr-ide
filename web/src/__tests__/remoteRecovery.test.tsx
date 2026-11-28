// @vitest-environment jsdom
//
// Remote host offline / reboot / manual-disable -> re-enable recovery for
// open file tabs (EditorPane, PreviewPane, MediaView), gone-file polling
// (gone.ts), and chat panes (plugins/chat/source.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, send: () => {}, connected: true, retry: () => {} } }));

const editorSpy = {
  model: undefined as
    { value: string; version: number; getValue(): string; setValue(v: string): void; getAlternativeVersionId(): number } | undefined,
  restoredStates: [] as unknown[],
  savedState: { cursor: { lineNumber: 12, column: 4 } } as unknown,
};

vi.mock('../plugins/monaco', () => ({
  setLanguage: vi.fn(),
  createEditor: vi.fn(async () => {
    const editor = {
      setModel: (m: typeof editorSpy.model) => (editorSpy.model = m),
      getModel: () => editorSpy.model,
      getValue: () => editorSpy.model?.getValue() ?? '',
      onKeyDown: () => ({ dispose() {} }),
      onDidChangeModelContent: () => ({ dispose() {} }),
      createDecorationsCollection: () => ({ clear() {} }),
      updateOptions() {},
      focus() {},
      layout() {},
      saveViewState: () => editorSpy.savedState,
      restoreViewState: (s: unknown) => void editorSpy.restoredStates.push(s),
      dispose() {},
    };
    const monaco = {
      Uri: { from: (o: unknown) => o },
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 },
      Range: class {
        constructor(
          readonly startLineNumber: number,
          readonly startColumn: number,
          readonly endLineNumber: number,
          readonly endColumn: number,
        ) {}
      },
      editor: {
        EndOfLineSequence: { LF: 0, CRLF: 1 },
        OverviewRulerLane: { Left: 1 },
        getModel: () => null,
        createModel: (initial = '') => {
          let v = initial;
          let version = 1;
          const listeners: Array<() => void> = [];
          return {
            get value() {
              return v;
            },
            get version() {
              return version;
            },
            getValue: () => v,
            setValue: (x: string) => {
              v = x;
              version++;
              listeners.forEach((l) => l());
            },
            getEOL: () => '\n',
            getAlternativeVersionId: () => version,
            getVersionId: () => version,
            onDidChangeContent: (l: () => void) => {
              listeners.push(l);
              return { dispose() {} };
            },
            pushStackElement() {},
            pushEditOperations() {
              return null;
            },
            dispose() {},
          };
        },
      },
    };
    return { monaco, editor };
  }),
}));

import { useStore } from '../state/store';
import type { MachineState, MachineStatus } from '../lib/machine';
import type { EditorViewState } from '../plugins/monaco';
import { EditorPane, keepViewState, resetViewStates } from '../plugins/files/EditorPane';
import { getCachedFile } from '../plugins/files/fileCache';
import { recheckGone, useGoneFiles, watchFile } from '../plugins/files/gone';
import { MediaView, PreviewPane } from '../components/PreviewPane';
import { dropSources, holdSource } from '../plugins/chat/source';
import { liveKey, resetChats, useChats } from '../plugins/chat/state';
import { dropEdit } from '../unsaved';
import { FakeHub, settle } from './fakeTerms';
import { FakeChatHub } from './chatFake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machine = (id: string, status: MachineStatus, hcState?: 'starting' | 'ready' | 'error'): MachineState =>
  ({
    id,
    label: id,
    kind: 'ssh',
    target: `${id}.example`,
    enabled: status !== 'disabled',
    status,
    updated_at: 1,
    ...(hcState ? { hc: { state: hcState } } : {}),
  }) as MachineState;

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => void (await settle()));
};

beforeEach(() => {
  editorSpy.model = undefined;
  editorSpy.restoredStates = [];
  resetViewStates();
  dropEdit('box', 'view:e1');
  resetChats();
  dropSources();
  useGoneFiles.setState({ gone: {} });
  useStore.setState({ machines: {}, order: [], readOnly: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  dropSources();
  resetViewStates();
  dropEdit('box', 'view:e1');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote host reboot and disable -> re-enable recovery', () => {
  it('reloads an EditorPane stuck on offline/disabled error and restores saved view state + unsaved edits when machine returns to ready', async () => {
    const hub = new FakeHub();
    hub.machine('box', [FakeHub.term('t1')], {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: '',
          cwd: '/srv/app',
          tabs: [{ root: { view: { id: 'e1', plugin: 'files', kind: 'editor', path: '/srv/app/main.ts' } }, focused: 'view:e1' }],
          selected: 0,
        },
      ],
      selected: 0,
    });
    hub.install().subscribe('box');
    await settle();

    let online = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://x');
        if (url.pathname === '/api/m/box/file') {
          if (!online) return new Response('machine not connected', { status: 409 });
          const text = 'export const ok = true;\n';
          const headers = { ETag: `W/"${text.length.toString(16)}-1"`, 'Content-Length': String(text.length) };
          return new Response(init?.method === 'HEAD' ? null : text, { status: 200, headers });
        }
        return new Response(JSON.stringify({ entries: [] }), { status: online ? 200 : 409 });
      }),
    );

    useStore.getState().setMachines([machine('box', 'disabled')]);
    const savedCursor = { cursor: { lineNumber: 42, column: 7 } } as unknown as EditorViewState;
    keepViewState('box', 'view:e1', '/srv/app/main.ts', savedCursor);

    const view = { id: 'e1', plugin: 'files', kind: 'editor', path: '/srv/app/main.ts' };
    await act(async () => {
      root.render(createElement(EditorPane, { m: 'box', pane: 'view:e1', view, focused: true }));
    });
    await flush();
    // Stuck on error while disabled, saved view state not lost, 409 neither poisons fileCache nor marks file gone.
    expect(host.querySelector('.files-editor-note.error')).not.toBeNull();
    expect(editorSpy.restoredStates).toEqual([]);
    expect(getCachedFile('box', '/srv/app/main.ts')).toBeUndefined();
    expect(useGoneFiles.getState().gone).toEqual({});

    // Remote host boots back up and user re-enables it: editor auto-reloads and restores view state.
    online = true;
    await act(async () => useStore.getState().upsertMachine(machine('box', 'ready', 'ready')));
    await flush();
    expect(host.querySelector('.files-editor-note.error')).toBeNull();
    expect(editorSpy.model?.getValue()).toBe('export const ok = true;\n');
    expect(editorSpy.restoredStates).toEqual([savedCursor]);

    // Make an unsaved edit, unmount while machine goes offline + disabled, then remount after re-enable.
    act(() => editorSpy.model!.setValue('export const ok = false; // draft\n'));
    await flush();
    expect(host.querySelector('.files-dirty')).not.toBeNull();
    await act(async () => {
      useStore.getState().upsertMachine(machine('box', 'disabled'));
      root.render(null);
    });
    online = false;
    // Remount while still disabled -> unsaved draft stays open!
    await act(async () => {
      root.render(createElement(EditorPane, { m: 'box', pane: 'view:e1', view, focused: true }));
    });
    await flush();
    expect(editorSpy.model?.getValue()).toBe('export const ok = false; // draft\n');
    expect(host.querySelector('.files-dirty')).not.toBeNull();
  });

  it('cancels a stale in-flight EditorPane load and reloads cleanly if the machine flips to ready while loading', async () => {
    let releaseStaleHead!: (r: Response) => void;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://x');
        if (url.pathname === '/api/m/box/file') {
          calls++;
          if (calls === 1) {
            return new Promise<Response>((resolve) => (releaseStaleHead = resolve));
          }
          const text = 'loaded after ready\n';
          const headers = { ETag: `W/"${text.length.toString(16)}-1"`, 'Content-Length': String(text.length) };
          return Promise.resolve(new Response(init?.method === 'HEAD' ? null : text, { status: 200, headers }));
        }
        return Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
      }),
    );

    useStore.getState().setMachines([machine('box', 'disabled')]);
    const view = { id: 'e2', plugin: 'files', kind: 'editor', path: '/srv/app/race.ts' };
    await act(async () => {
      root.render(createElement(EditorPane, { m: 'box', pane: 'view:e2', view, focused: true }));
    });
    await settle();
    expect(calls).toBe(1);
    expect(host.querySelector('.files-editor-note.muted')).not.toBeNull();

    // Machine becomes ready BEFORE the stale offline HEAD (409) resolves.
    await act(async () => useStore.getState().upsertMachine(machine('box', 'ready', 'ready')));
    releaseStaleHead(new Response('machine not connected', { status: 409 }));
    await flush();
    expect(host.querySelector('.files-editor-note.error')).toBeNull();
    expect(editorSpy.model?.getValue()).toBe('loaded after ready\n');
  });

  it('reloads PreviewPane text and recovers MediaView video errors when a disabled machine returns to ready', async () => {
    let online = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://x');
        if (url.pathname === '/api/m/box/list')
          return new Response(JSON.stringify({ error: 'not a directory' }), { status: online ? 404 : 409 });
        if (url.pathname === '/api/m/box/file') {
          if (!online) return new Response('machine not connected', { status: 409 });
          return new Response('hello after reboot', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }),
    );

    useStore.getState().setMachines([machine('box', 'disabled')]);
    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(PreviewPane, { m: 'box', pane: 'preview:p1', path: '/srv/app/notes.txt' }),
          createElement(MediaView, { m: 'box', path: '/srv/app/demo.mp4' }),
        ),
      );
    });
    await flush();
    expect(host.querySelector('.error')?.textContent).toContain('machine not connected');

    // Simulate broken video while machine is disabled.
    const video = host.querySelector('video')!;
    expect(video).not.toBeNull();
    await act(async () => void video.dispatchEvent(new Event('error')));
    expect(host.querySelector('video')).toBeNull();

    // Machine re-enables and returns to ready: text reloads and video remounts cleanly.
    online = true;
    await act(async () => useStore.getState().upsertMachine(machine('box', 'ready', 'ready')));
    await flush();
    expect(host.querySelector('.error')).toBeNull();
    expect(host.textContent).toContain('hello after reboot');
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('skips disabled machines in gone-file polling and rechecks immediately once ready', async () => {
    const statCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://x');
        statCalls.push(url.pathname);
        return new Response(
          JSON.stringify({
            entries: [
              { path: '/srv/a.txt', exists: true },
              { path: '/srv/b.txt', exists: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    useStore.getState().setMachines([machine('online', 'ready'), machine('off', 'disabled')]);
    const stopA = watchFile('online', '/srv/a.txt');
    const stopB = watchFile('off', '/srv/b.txt');
    try {
      await recheckGone();
      // Only the ready machine was polled; disabled machine was skipped without error.
      expect(statCalls).toEqual(['/api/m/online/p/files/stat']);

      // Re-enabling 'off' triggers an immediate recheck and updates gone state.
      useStore.getState().upsertMachine(machine('off', 'ready'));
      await settle();
      expect(statCalls).toContain('/api/m/off/p/files/stat');
      expect(useGoneFiles.getState().gone['off\n/srv/b.txt']).toBe(true);
    } finally {
      stopA();
      stopB();
    }
  });

  it('pauses chat retries while disabled, shows no_terminal_core as offline during startup, and wakes immediately on reconnect', async () => {
    vi.useFakeTimers();
    const chats = new FakeChatHub();
    chats.auto = false;
    chats.install();

    useStore.getState().setMachines([machine('box', 'ready', 'starting')]);
    const cid = 'c00000000000000a1';
    const release = holdSource('box', cid);
    try {
      chats.open();
      expect(chats.ops('attach')).toHaveLength(1);
      // Core is still starting right after reboot: no_terminal_core shows as offline, not failed.
      chats.push({
        t: 'detached',
        sub: chats.ops('attach')[0].sub,
        error: { code: 'no_terminal_core', message: 'terminal core starting' },
      });
      expect(useChats.getState().live[liveKey('box', cid)]?.link).toBe('offline');

      // User disables the machine -> detach pauses retry timers instead of spamming attach while disabled.
      useStore.getState().upsertMachine(machine('box', 'disabled'));
      await vi.advanceTimersByTimeAsync(2000);
      const countAtDisable = chats.ops('attach').length;
      if (countAtDisable > 1) {
        chats.push({
          t: 'detached',
          sub: chats.ops('attach').at(-1)!.sub,
          error: { code: 'offline', message: 'machine disabled' },
        });
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(chats.ops('attach')).toHaveLength(countAtDisable);

      // Machine re-enables and becomes ready -> source wakes immediately (reopening
      // the chat WebSocket if it closed while idle) without waiting for backoff.
      const socketsBefore = chats.sockets.length;
      useStore.getState().upsertMachine(machine('box', 'ready', 'ready'));
      if (chats.sockets.length > socketsBefore) chats.open();
      expect(chats.ops('attach')).toHaveLength(countAtDisable + 1);
    } finally {
      release();
    }
  });
});
