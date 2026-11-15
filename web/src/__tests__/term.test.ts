import { describe, expect, it } from 'vitest';
import { TermConnection, type Socket, type StreamHandler } from '../term/connection';
import {
  closeTab,
  closeTerminal,
  closeWorkspace,
  createWorkspace,
  dropOnPane,
  emptyLayout,
  focusDirection,
  focusedTerminal,
  focusTerminal,
  layoutTerminals,
  locate,
  moveTab,
  moveTerminal,
  moveToNewTab,
  moveWorkspace,
  newWorkspaceId,
  openTerminal,
  parseLayout,
  pruneLayout,
  renameTab,
  renameWorkspace,
  sameLayout,
  selectedWorkspace,
  selectTab,
  selectWorkspace,
  setRatio,
  splitFocused,
  swapTerminals,
  type Axis,
  type Layout,
  type Direction,
  type DropZone,
} from '../term/layout';
import {
  decodeFrame,
  directoryOf,
  displayName,
  encodeFrame,
  frameGrid,
  FRAME_AUTOMATIC,
  FRAME_DATA,
  FRAME_RESIZE,
  statusOf,
  TermError,
} from '../term/protocol';
import { TerminalStore } from '../term/store';

describe('terminal protocol', () => {
  it('encodes and decodes frames', () => {
    const frame = encodeFrame(0x01020304, FRAME_AUTOMATIC, new TextEncoder().encode('ab'));
    expect([...frame]).toEqual([4, 3, 2, 1, 6, 97, 98]);
    expect(decodeFrame(frame)).toEqual({ stream: 0x01020304, kind: 6, payload: new Uint8Array([97, 98]) });
    expect(decodeFrame(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    // A frame inside a larger buffer keeps its own offset.
    const inside = new Uint8Array([9, 9, ...encodeFrame(7, FRAME_RESIZE, new Uint8Array([100, 0, 30, 1]))]).subarray(2);
    expect(frameGrid(decodeFrame(inside)!)).toEqual({ cols: 100, rows: 286 });
    expect(frameGrid(decodeFrame(encodeFrame(7, FRAME_DATA, new Uint8Array([1, 0, 2, 0])))!)).toBeNull();
  });

  it('names terminals', () => {
    expect(displayName({ address: 't1', name: 'build', title: 'x' })).toBe('build');
    expect(displayName({ address: 't1', title: 'vim a.txt' })).toBe('vim a.txt');
    expect(displayName({ address: 't1', foreground: { name: 'zsh' } })).toBe('zsh');
    expect(displayName({ address: 't1', argv: ['/bin/bash', '-l'] })).toBe('bash');
    expect(displayName({ address: 't1' })).toBe('t1');
    expect(statusOf({ address: 't1', status: { state: 'working' } })).toBe('working');
    expect(statusOf({ address: 't1', status: null })).toBeUndefined();
    expect(directoryOf({ address: 't1', cwd: '/a', foreground: { cwd: '/b' } })).toBe('/b');
    expect(directoryOf({ address: 't1', cwd: '/a' })).toBe('/a');
  });
});

describe('terminal store', () => {
  it('applies snapshots and events', () => {
    const store = new TerminalStore();
    expect(store.apply({ t: 'pong' })).toBe(false);
    store.apply({ t: 'backend', m: 'x', state: 'ready', code: '', version: '0.1.21' });
    expect(store.backends.get('x')).toEqual({ phase: 'ready', code: '', version: '0.1.21' });
    store.apply({
      t: 'snapshot',
      m: 'x',
      terminals: [
        { address: 't2', state: 'live', created_ms: 20, pid: 5, foreground: { name: 'zsh' } },
        { address: 't1', state: 'live', created_ms: 10, future_field: 7 },
      ],
    });
    expect(store.terminals('x').map((t) => t.address)).toEqual(['t1', 't2']);
    const event = (type: string, terminal: string, data: unknown) => store.apply({ t: 'event', m: 'x', type, terminal, data });
    event('status', 't1', { status: { state: 'working' }, records: {}, reported: true });
    expect(statusOf(store.terminal('x', 't1')!)).toBe('working');
    event('status', 't1', { status: null, records: {}, reported: true });
    expect(statusOf(store.terminal('x', 't1')!)).toBeUndefined();
    expect(store.terminal('x', 't1')!.future_field).toBe(7);
    event('title', 't1', { title: 'make' });
    event('size', 't1', { cols: 120, rows: 40 });
    expect(store.terminal('x', 't1')).toMatchObject({ title: 'make', cols: 120 });
    event('foreground', 't1', { pid: 9, name: 'vim', argv: ['vim'], cwd: '/' });
    expect(displayName({ ...store.terminal('x', 't1')!, title: '' })).toBe('vim');
    event('foreground', 't1', null);
    expect(store.terminal('x', 't1')!.foreground).toBeUndefined();
    event('finished', 't2', { reason: 'exited', exit_code: 0 });
    expect(store.terminal('x', 't2')).toMatchObject({ state: 'finished', reason: 'exited' });
    expect(store.terminal('x', 't2')!.foreground).toBeUndefined();
    event('created', 't3', { address: 't3', state: 'live', created_ms: 30 });
    event('labels', 't3', { labels: { app: 'x' } });
    expect(store.terminal('x', 't3')!.labels).toEqual({ app: 'x' });
    expect(event('removed', 't2', {})).toBe(true);
    expect(store.terminals('x').map((t) => t.address)).toEqual(['t1', 't3']);
    expect(event('title', 't9', { title: 'x' })).toBe(false);
    store.apply({ t: 'backend', m: 'x', state: 'error', code: 'disconnected', version: '' });
    expect(store.terminals('x')).toEqual([]);
  });
});

/** A vector of design/testdata/layout. */
interface LayoutVector {
  description: string;
  input: unknown;
  ops: Array<Record<string, unknown>>;
  changed: boolean;
  expected: unknown;
}

const vectors = import.meta.glob<LayoutVector>('../../../design/testdata/layout/*.json', { eager: true, import: 'default' });

function applyOp(layout: Layout, op: Record<string, unknown>): Layout {
  const s = (key: string) => op[key] as string;
  const n = (key: string) => op[key] as number;
  switch (op.op) {
    case 'createWorkspace':
      return createWorkspace(layout, s('id'), s('name'), s('cwd'));
    case 'renameWorkspace':
      return renameWorkspace(layout, s('workspace'), s('name'));
    case 'closeWorkspace':
      return closeWorkspace(layout, s('workspace'));
    case 'moveWorkspace':
      return moveWorkspace(layout, s('workspace'), n('to'));
    case 'selectWorkspace':
      return selectWorkspace(layout, s('workspace'));
    case 'openTerminal':
      return openTerminal(layout, s('terminal'), op.workspace as string | undefined);
    case 'renameTab':
      return renameTab(layout, s('workspace'), n('tab'), s('name'));
    case 'closeTab':
      return closeTab(layout, s('workspace'), n('tab'));
    case 'moveTab':
      return moveTab(layout, s('workspace'), n('from'), n('to'));
    case 'selectTab':
      return selectTab(layout, s('workspace'), n('tab'));
    case 'splitFocused':
      return splitFocused(layout, op.axis as Axis, s('terminal'));
    case 'closeTerminal':
      return closeTerminal(layout, s('terminal'));
    case 'prune':
      return pruneLayout(layout, new Set(op.live as string[]));
    case 'setRatio':
      return setRatio(layout, op.path as boolean[], n('ratio'));
    case 'focus':
      return focusTerminal(layout, s('terminal'));
    case 'swap':
      return swapTerminals(layout, s('a'), s('b'));
    case 'moveTerminal':
      return moveTerminal(layout, s('terminal'), s('target'), op.axis as Axis, op.before === true);
    case 'moveToNewTab':
      return moveToNewTab(layout, s('terminal'), s('workspace'));
    case 'focusDirection':
      return focusDirection(layout, op.dir as Direction);
    case 'dropOnPane':
      return dropOnPane(layout, s('terminal'), s('target'), op.zone as DropZone);
  }
  throw new Error(`unknown op ${String(op.op)}`);
}

describe('layout', () => {
  it('has vectors', () => {
    expect(Object.keys(vectors).length).toBeGreaterThan(5);
  });

  for (const [path, vector] of Object.entries(vectors)) {
    it(path.split('/').pop()!, () => {
      const input = parseLayout(vector.input);
      const before = JSON.stringify(input);
      const result = vector.ops.reduce(applyOp, input);
      expect(JSON.stringify(input)).toBe(before); // arguments never change
      expect(result).toEqual(vector.expected);
      expect(sameLayout(result, parseLayout(vector.expected))).toBe(true);
      expect(sameLayout(input, result)).toBe(!vector.changed);
      // The document reads back as the same layout.
      expect(sameLayout(parseLayout(JSON.parse(JSON.stringify(result))), result)).toBe(true);
    });
  }

  it('compares layouts as documents and makes workspace ids', () => {
    const a = parseLayout({ selected: 0, version: 2, workspaces: [] });
    expect(sameLayout(a, { workspaces: [], selected: 0, version: 2 })).toBe(true);
    expect(sameLayout(a, { ...a, extra: 1 })).toBe(false);
    expect(sameLayout(emptyLayout, parseLayout('nonsense'))).toBe(true);
    const id = newWorkspaceId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(newWorkspaceId()).not.toBe(id);
    let layout = openTerminal(createWorkspace(emptyLayout, id, 'x', '/w'), 't1');
    layout = splitFocused(layout, 'vertical', 't2');
    expect(layoutTerminals(layout)).toEqual(['t1', 't2']);
    expect(focusedTerminal(layout)).toBe('t2');
    expect(selectedWorkspace(layout)?.cwd).toBe('/w');
    expect(locate(layout, 't2')).toEqual({ workspace: 0, tab: 0 });
    expect(locate(layout, 't3')).toBeNull();
  });
});

/** A socket the test drives: what the client sent, and messages from the core. */
class FakeSocket implements Socket {
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: Array<Record<string, unknown> | Uint8Array> = [];
  send(data: string | Uint8Array) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close() {
    this.onclose?.();
  }
  text(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  frame(stream: number, kind: number, payload: string | number[]) {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
    this.onmessage?.({ data: encodeFrame(stream, kind, bytes).buffer });
  }
}

describe('terminal connection', () => {
  it('subscribes, calls, attaches and moves bytes', async () => {
    const sockets: FakeSocket[] = [];
    const conn = new TermConnection(() => {
      sockets.push(new FakeSocket());
      return sockets[sockets.length - 1];
    });
    const messages: unknown[] = [];
    const ups: boolean[] = [];
    conn.onMessage = (m) => messages.push(m);
    conn.onConnection = (up) => ups.push(up);
    conn.subscribe('x');
    await expect(conn.call('x', 'terminal.list')).rejects.toMatchObject({ kind: 'unavailable' });
    conn.start();
    const s = sockets[0];
    expect(s.binaryType).toBe('arraybuffer');
    s.onopen!();
    expect(s.sent).toEqual([{ t: 'sub', m: 'x' }]);
    conn.subscribe('x'); // once
    conn.subscribe('y');
    expect(s.sent.slice(1)).toEqual([{ t: 'sub', m: 'y' }]);
    s.text({ t: 'snapshot', m: 'x', terminals: [] });
    expect(messages).toEqual([{ t: 'snapshot', m: 'x', terminals: [] }]);

    const listed = conn.call('x', 'terminal.list', { all: true });
    expect(s.sent[2]).toEqual({ t: 'call', rid: 1, m: 'x', method: 'terminal.list', params: { all: true } });
    s.text({ t: 'res', rid: 1, result: { terminals: [] } });
    await expect(listed).resolves.toEqual({ terminals: [] });
    const killed = conn.call('x', 'terminal.kill', { terminal: 't9' });
    s.text({ t: 'res', rid: 2, error: { kind: 'not_found', message: 'no terminal t9' } });
    await expect(killed).rejects.toBeInstanceOf(TermError);
    await expect(killed).rejects.toMatchObject({ kind: 'not_found' });

    const events: string[] = [];
    const handler: StreamHandler = {
      output: (d) => events.push('out:' + new TextDecoder().decode(d)),
      resized: (c, r) => events.push(`size:${c}x${r}`),
      closed: (reason, code) => events.push(`closed:${reason}:${code}`),
    };
    const attached = conn.attach({ machine: 'x', terminal: 't1', cols: 80, rows: 24, history: 100 }, handler);
    expect(s.sent[4]).toEqual({ t: 'attach', rid: 3, m: 'x', terminal: 't1', cols: 80, rows: 24, history: 100, observe: false });
    // The reply and the stream's first frames arrive together.
    s.text({ t: 'attached', rid: 3, s: 5 });
    s.frame(5, FRAME_RESIZE, [100, 0, 30, 0]);
    s.frame(5, FRAME_DATA, 'paint');
    s.frame(9, FRAME_DATA, 'for a stream nobody has');
    expect(await attached).toBe(5);
    expect(events).toEqual(['size:100x30', 'out:paint']);

    conn.write(5, new TextEncoder().encode('ls\r'));
    conn.write(5, new Uint8Array([27]), true);
    conn.ack(5, 5);
    conn.ack(5, 0);
    conn.resize(5, 120, 40);
    conn.focus(5, true);
    conn.write(6, new Uint8Array([1])); // not a stream of ours
    expect(s.sent.slice(5)).toEqual([
      encodeFrame(5, FRAME_DATA, new TextEncoder().encode('ls\r')),
      encodeFrame(5, FRAME_AUTOMATIC, new Uint8Array([27])),
      { t: 'ack', s: 5, n: 5 },
      { t: 'resize', s: 5, cols: 120, rows: 40 },
      { t: 'focus', s: 5, focused: true },
    ]);
    s.text({ t: 'closed', s: 5, reason: 'exited', exit_code: 3 });
    expect(events[2]).toBe('closed:exited:3');
    conn.write(5, new Uint8Array([1]));
    expect(s.sent.length).toBe(10);

    // The connection goes: calls and streams end, and it comes back subscribed.
    const again = conn.attach({ machine: 'x', terminal: 't1', cols: 80, rows: 24 }, handler);
    s.text({ t: 'attached', rid: 4, s: 6 });
    await again;
    const pending = conn.call('x', 'terminal.list');
    s.onclose!();
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    expect(events[3]).toBe('closed:disconnected:undefined');
    expect(ups).toEqual([true, false]);
    expect(conn.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect(sockets.length).toBe(2);
    sockets[1].onopen!();
    expect(sockets[1].sent).toEqual([
      { t: 'sub', m: 'x' },
      { t: 'sub', m: 'y' },
    ]);
    conn.detach(6); // gone with the old connection: nothing is sent
    conn.unsubscribe('y');
    expect(sockets[1].sent[2]).toEqual({ t: 'unsub', m: 'y' });
    conn.close();
    await new Promise((r) => setTimeout(r, 600));
    expect(sockets.length).toBe(2);
  });
});
