// @vitest-environment jsdom
//
// The agents plugin's conversation over a terminal, in the workspace with
// the real terminal pane (vt/pane.ts) over a scripted core: the terminal
// under the conversation is attached once with the pane's grid, draws
// nothing, and keeps its grid while the conversation shrinks to the upper
// part (the agent waits for the user), leaves it whole (its dialog drawn
// at the top of its screen) and covers it again: no resize reaches the
// core, nothing attaches anew. Renderers and the cell's
// measure are stand-ins (jsdom has neither WebGL nor fonts); the emulator
// is the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));
vi.mock('../components/PaneHeader', () => ({ PaneHeader: () => createElement('div', { className: 'pane-header' }) }));

const { renderers } = vi.hoisted(() => ({ renderers: [] as Array<{ disposed: boolean }> }));
vi.mock('../vt/renderer', async (actual) => {
  const real = await actual<typeof import('../vt/renderer')>();
  return {
    ...real,
    createRenderer: () => {
      const r = { disposed: false };
      renderers.push(r);
      return {
        kind: 'webgl' as const,
        setMetrics() {},
        invalidate() {},
        render() {},
        resize() {},
        dispose: () => void (r.disposed = true),
      };
    },
  };
});
// A cell of 8 by 16 device pixels.
vi.mock('../vt/atlas', async (actual) => {
  const real = await actual<typeof import('../vt/atlas')>();
  return {
    ...real,
    measureCell: (_ctx: unknown, o: { fontWeight: 400 | 500 }, dpr: number) => ({
      cw: 8,
      ch: 16,
      fontPx: 13,
      family: 'monospace',
      weight: o.fontWeight,
      baseline: 12,
      dpr,
    }),
  };
});
// The emulator, loaded from the web UI's directory (under jsdom the
// module's URL is no file's).
vi.mock('../vt/module', async (actual) => {
  const real = await actual<typeof import('../vt/module')>();
  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string): Uint8Array<ArrayBuffer> };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  const vt = real.vtFromBytes(fs.readFileSync(`${cwd}/src/vt/ghostty-vt.wasm`));
  return { ...real, loadVt: () => Promise.resolve(vt) };
});

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { FakeCore, settle } from './fakeTerms';
import { Workspace } from '../components/Workspace';
import { allPlugins, definePlugins } from '../plugins/registry';
import { agentsPlugin } from '../plugins/agents';
import { resetFeeds } from '../plugins/agents/transcript';
import { coverOf, useCovers } from '../state/covers';
import { encodeFrame, FRAME_DATA } from '../term/protocol';
import { useSettings } from '../settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111';

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

describe('the conversation over a terminal', () => {
  let host: HTMLDivElement;
  let root: Root;
  let core: FakeCore;
  let answer: ((body: unknown) => void) | undefined;
  const saved = [...allPlugins()];
  const size = Object.getOwnPropertyDescriptors(Element.prototype);

  beforeEach(async () => {
    renderers.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    // A terminal's pane is laid out at 800 by 400 CSS pixels.
    const px = (w: number) =>
      function (this: Element) {
        return this.classList?.contains('term-host') ? w : 0;
      };
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: px(800) });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: px(400) });
    // The surfaces' layer is the terminal's area; the conversation's upper
    // part covers its first 152 pixels.
    const rect = (height: number) =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('pane-surfaces')) return rect(400);
      if (this.matches('.agents-surface[data-mode="peek"]')) return rect(152);
      return rect(this.classList.contains('agents-surface') ? 400 : 0);
    });
    // The transcript's reads: the first one answered by the test, the
    // others never.
    answer = undefined;
    vi.stubGlobal('fetch', (input: string) =>
      String(input).includes('/p/agents/tail') && !answer
        ? new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))
        : new Promise<Response>(() => {}),
    );
    useSettings.setState({ values: {} });
    definePlugins([agentsPlugin]);
    resetFeeds();
    core = new FakeCore();
    core.machine('a', [FakeCore.term('t1', { agent: 'claude', agent_status: 'idle', agent_session: S1, agent_session_source: 'pid' })], {
      version: 2,
      workspaces: [
        { id: 'w1', name: '', cwd: '/home/u', tabs: [{ root: { terminal: 't1', render: 'native' }, focused: 't1' }], selected: 0 },
      ],
      selected: 0,
    });
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'a', label: 'Box', kind: 'local', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    s.selectMachine('a');
    core.model.subscribe('a');
    await settle();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetFeeds();
    useCovers.setState({ covers: {} });
    definePlugins(saved);
    for (const k of ['clientWidth', 'clientHeight'] as const) Object.defineProperty(Element.prototype, k, size[k]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const flush = async () => {
    for (let i = 0; i < 4; i++) await act(async () => void (await settle()));
  };
  const sent = (t: string) => core.sent.filter((m) => m.t === t);
  const surface = () => host.querySelector<HTMLElement>('.pane-surfaces > *');
  /** The terminal's program writes text on its stream (the first one). */
  const output = (text: string) => {
    const socket = (core as unknown as { socket: { onmessage(ev: { data: unknown }): void } }).socket;
    socket.onmessage({ data: encodeFrame(1, FRAME_DATA, new TextEncoder().encode(text)).buffer });
  };

  it('keeps the terminal’s grid while the conversation shrinks and covers it again', async () => {
    await act(async () => root.render(createElement(Workspace)));
    await flush();
    // Covered from the first frame: attached with the pane's grid, nothing drawn.
    expect(surface()!.dataset.mode).toBe('loading');
    expect(sent('attach')).toHaveLength(1);
    expect(sent('attach')[0]).toMatchObject({ terminal: 't1', cols: 100, rows: 25 });
    expect(renderers).toEqual([]);
    await act(async () => answer!({ tails: [{ kind: 'claude', session: S1, file: 'f1', first: 0, next: 512, events: [] }] }));
    await flush();
    expect(surface()!.dataset.mode).toBe('native');

    // The agent waits for the user: the upper part, the terminal drawn below at its size.
    core.event('a', 'agent', 't1', { agent_status: 'blocked', status: { state: 'blocked', msg: 'approve Bash: ls' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('peek');
    expect(surface()!.hasAttribute('data-whole')).toBe(false);
    expect(coverOf('a', 't1')).toBe('part');
    expect(renderers).toHaveLength(1);
    expect(renderers[0].disposed).toBe(false);
    // Its dialog drawn at the top of a cleared screen: the terminal whole,
    // read from the emulator's screen.
    output('\x1b[2J\x1b[H\r\n  Update available!\r\n\r\n> 1. Update now\r\n  2. Skip');
    await vi.waitFor(
      async () => {
        await flush();
        expect(surface()!.hasAttribute('data-whole')).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(host.querySelector<HTMLElement>('.agents-strip[data-reason="waiting"]')!.dataset.edge).toBe('bottom');
    expect(coverOf('a', 't1')).toBeUndefined();
    expect(renderers).toHaveLength(1);
    expect(renderers[0].disposed).toBe(false);
    // Answered: covered again, the renderer given up.
    core.event('a', 'agent', 't1', { agent_status: 'working', status: { state: 'working' } });
    await flush();
    expect(surface()!.dataset.mode).toBe('native');
    expect(renderers[0].disposed).toBe(true);

    expect(sent('resize')).toEqual([]);
    expect(sent('attach')).toHaveLength(1);
    expect(sent('detach')).toEqual([]);
  });
});
