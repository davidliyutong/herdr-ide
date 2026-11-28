import { describe, expect, it, vi } from 'vitest';
import { MAX_CONCURRENT_ATTACHES, TermConnection, type Socket, type StreamHandler } from '../term/connection';
import {
  adoptDirectory,
  closePane,
  closeTab,
  closeWorkspace,
  codeViews,
  createWorkspace,
  editWorkspace,
  focusedLeaf,
  dropOnPane,
  dropTabOnPane,
  emptyLayout,
  focusDirection,
  focusedPane,
  focusedTerminal,
  focusPane,
  layoutTerminals,
  locate,
  moveTab,
  pinTab,
  moveTabs,
  moveTabsToWorkspace,
  moveWorkspaces,
  movePane,
  moveToNewTab,
  moveWorkspace,
  newId,
  openPane,
  openTerminal,
  parseLayout,
  pruneLayout,
  renameTab,
  renameWorkspace,
  sameLayout,
  selectedWorkspace,
  selectTab,
  selectWorkspace,
  setPreviewPath,
  setViewFields,
  setTerminalFields,
  soleLeaf,
  workspaceTitle,
  setRatio,
  splitFocused,
  splitPane,
  swapPanes,
  tabPanes,
  type Axis,
  type Layout,
  type Leaf,
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

/** A vector of spec/vectors/layout. */
interface LayoutVector {
  description: string;
  input: unknown;
  ops: Array<Record<string, unknown>>;
  changed: boolean;
  expected: unknown;
  /** The workspaces' names as shown (workspaceTitle), with home as the
   * machine's home directory. */
  titles?: { home: string; names: string[] };
}

const vectors = import.meta.glob<LayoutVector>('../../../spec/vectors/layout/*.json', { eager: true, import: 'default' });

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
    case 'pinTab':
      return pinTab(layout, s('workspace'), n('tab'), op.pinned as boolean);
    case 'moveTabs':
      return moveTabs(layout, s('workspace'), op.tabs as number[], n('slot'));
    case 'moveTabsToWorkspace':
      return moveTabsToWorkspace(layout, s('workspace'), op.tabs as number[], s('target'));
    case 'moveWorkspaces':
      return moveWorkspaces(layout, op.workspaces as string[], n('slot'));
    case 'selectTab':
      return selectTab(layout, s('workspace'), n('tab'));
    case 'splitFocused':
      return splitFocused(layout, op.axis as Axis, s('terminal'));
    case 'closeTerminal':
      return closePane(layout, s('terminal'));
    case 'closePane':
      return closePane(layout, s('pane'));
    case 'openPane':
      return openPane(layout, op.leaf as Leaf, op.workspace as string | undefined);
    case 'splitPane':
      return splitPane(layout, s('target'), op.axis as Axis, op.leaf as Leaf, op.before === true);
    case 'setPreviewPath':
      return setPreviewPath(layout, s('pane'), s('path'));
    case 'setViewFields':
      return setViewFields(layout, s('pane'), op.fields as Record<string, unknown>);
    case 'setTerminalFields':
      return setTerminalFields(layout, s('terminal'), op.fields as Record<string, unknown>);
    case 'prune':
      return pruneLayout(layout, new Set(op.live as string[]));
    case 'setRatio':
      return setRatio(layout, op.path as boolean[], n('ratio'));
    case 'focus':
      return focusPane(layout, s('terminal') ?? s('pane'));
    case 'swap':
      return swapPanes(layout, s('a'), s('b'));
    case 'moveTerminal':
    case 'movePane':
      return movePane(layout, s('terminal') ?? s('pane'), s('target'), op.axis as Axis, op.before === true);
    case 'moveToNewTab':
      return moveToNewTab(layout, s('terminal') ?? s('pane'), s('workspace'));
    case 'focusDirection':
      return focusDirection(layout, op.dir as Direction);
    case 'dropOnPane':
      return dropOnPane(layout, s('terminal') ?? s('pane'), s('target'), op.zone as DropZone);
    case 'dropTabOnPane':
      return dropTabOnPane(layout, s('workspace'), n('tab'), s('target'), op.zone as DropZone);
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
      if (vector.titles) expect(result.workspaces.map((w) => workspaceTitle(w, vector.titles!.home))).toEqual(vector.titles.names);
    });
  }

  it('compares layouts as documents and makes workspace ids', () => {
    const a = parseLayout({ selected: 0, version: 2, workspaces: [] });
    expect(sameLayout(a, { workspaces: [], selected: 0, version: 2 })).toBe(true);
    expect(sameLayout(a, { ...a, extra: 1 })).toBe(false);
    expect(sameLayout(emptyLayout, parseLayout('nonsense'))).toBe(true);
    const id = newId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(newId()).not.toBe(id);
    let layout = openTerminal(createWorkspace(emptyLayout, id, 'x', '/w'), 't1');
    layout = splitFocused(layout, 'vertical', 't2');
    expect(layoutTerminals(layout)).toEqual(['t1', 't2']);
    expect(focusedTerminal(layout)).toBe('t2');
    expect(selectedWorkspace(layout)?.cwd).toBe('/w');
    expect(locate(layout, 't2')).toEqual({ workspace: 0, tab: 0 });
    expect(locate(layout, 't3')).toBeNull();
  });

  it('names panes of every kind and lists the VS Code views of a workspace', () => {
    let layout = openTerminal(createWorkspace(emptyLayout, 'w', '', '/w'), 't1');
    layout = splitPane(layout, 't1', 'horizontal', { code: { id: 'c1', folder: '/w' } });
    layout = openPane(layout, { code: { id: 'c2', folder: '/w/docs' } });
    expect(focusedPane(layout)).toBe('code:c2');
    expect(focusedTerminal(layout)).toBeUndefined();
    expect(layoutTerminals(layout)).toEqual(['t1']);
    expect(tabPanes(layout.workspaces[0].tabs[0])).toEqual(['t1', 'code:c1']);
    expect(codeViews(layout.workspaces[0]).map((v) => [v.key, v.view.folder, v.tab])).toEqual([
      ['code:c1', '/w', 0],
      ['code:c2', '/w/docs', 1],
    ]);
  });

  it('names a workspace by manual name, then fixed path basename, then dynamic pane directory', () => {
    // A workspace without a directory takes its first pane's, once.
    let layout = openTerminal(createWorkspace(emptyLayout, 'w', ''), 't1');
    layout = adoptDirectory(layout, 't1', '/home/u/app');
    expect(layout.workspaces[0].cwd).toBe('/home/u/app');
    layout = splitFocused(layout, 'vertical', 't2');
    expect(adoptDirectory(layout, 't2', '/home/u/lib')).toBe(layout);
    // The home directory, where a terminal without one starts, is not taken.
    const bare = openTerminal(createWorkspace(emptyLayout, 'w', ''), 't1');
    expect(adoptDirectory(bare, 't1', '/home/u/', '/home/u')).toBe(bare);
    expect(adoptDirectory(bare, 't1', '/home/u', '/home/u').workspaces[0].cwd).toBe('');
    expect(adoptDirectory(bare, 't1', '/home/u/app', '/home/u').workspaces[0].cwd).toBe('/home/u/app');
    const ws = () => layout.workspaces[0];
    expect(soleLeaf(ws())).toBeNull();
    expect(workspaceTitle(ws(), '/home/u')).toBe('app');
    // Fixed path takes priority over dynamic pane cwd even when one pane is left and it cds elsewhere.
    layout = closePane(layout, 't1');
    expect(soleLeaf(ws())).toEqual({ terminal: 't2' });
    expect(workspaceTitle(ws(), '/home/u', '/home/u/lib')).toBe('app');
    expect(workspaceTitle(ws(), '/home/u', '/home/u')).toBe('app');
    expect(workspaceTitle({ name: '', cwd: '/home/u/projects/veldr/' }, '/home/u', '/tmp/other')).toBe('veldr');
    expect(workspaceTitle({ name: 'Workspace', cwd: '/home/u/projects/veldr' }, '/home/u', '/tmp/other')).toBe('veldr');
    // Without a fixed path, the workspace follows the dynamic pane directory.
    expect(workspaceTitle({ name: '', cwd: '' }, '/home/u', '/home/u/lib')).toBe('lib');
    expect(workspaceTitle({ name: '', cwd: '' }, '/home/u', '/home/u')).toBe('~');
    // Explicit manual name wins over both fixed path and dynamic directory.
    expect(workspaceTitle({ ...ws(), name: 'mine' }, '/home/u', '/home/u/lib')).toBe('mine');
  });

  it('edits a workspace; one without a directory keeps none', () => {
    let layout = openTerminal(createWorkspace(emptyLayout, 'w', '', '/home/u/app'), 't1');
    layout = splitFocused(layout, 'vertical', 't2');
    layout = editWorkspace(layout, 'w', 'mine', '/srv');
    expect(layout.workspaces[0]).toMatchObject({ name: 'mine', cwd: '/srv' });
    expect(editWorkspace(layout, 'w', 'mine', '/srv')).toBe(layout);
    layout = editWorkspace(layout, 'w', '', '');
    expect(layout.workspaces[0]).toMatchObject({ name: '', cwd: '' });
    // A new pane does not give an emptied directory back: new terminals
    // start in the focused pane's.
    layout = splitFocused(layout, 'horizontal', 't3');
    expect(adoptDirectory(layout, 't3', '/home/u/lib')).toBe(layout);
    expect(focusedLeaf(layout.workspaces[0])).toEqual({ terminal: 't3' });
  });
});

/** A socket the test drives: what the client sent, and messages from the hub. */
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
  it('tells the hub the display a viewer answers programs with, but not for an observer', async () => {
    const socket = new FakeSocket();
    const conn = new TermConnection(() => socket);
    conn.start();
    socket.onopen!();
    const handler: StreamHandler = { output: () => {}, resized: () => {}, closed: () => {} };
    const display = { fg: '#1f1f1f', bg: '#fafafa', cursor: '#333333', cell: [16, 34] as [number, number] };
    const viewer = conn.attach({ machine: 'x', terminal: 't1', cols: 80, rows: 24, display }, handler);
    expect(socket.sent.at(-1)).toMatchObject({ t: 'attach', terminal: 't1', display });
    socket.text({ t: 'attached', rid: 1, s: 7 });
    const s = await viewer;
    conn.facts(s, { ...display, bg: '#000000' });
    expect(socket.sent.at(-1)).toEqual({ t: 'facts', s: 7, display: { ...display, bg: '#000000' } });
    void conn.attach({ machine: 'x', terminal: 't2', cols: 80, rows: 24, observe: true, display }, handler).catch(() => {});
    expect(socket.sent.at(-1)).not.toHaveProperty('display');
    conn.close();
  });

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
    // The wait before connecting again passes on a fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    s.onclose!();
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' });
    expect(events[3]).toBe('closed:disconnected:undefined');
    expect(ups).toEqual([true, false]);
    expect(conn.connected).toBe(false);
    vi.advanceTimersByTime(499);
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    random.mockRestore();
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
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    expect(sockets.length).toBe(2);
  });

  it('queues concurrent attaches beyond MAX_CONCURRENT_ATTACHES so reconnects do not burst into hub busy errors', async () => {
    const socket = new FakeSocket();
    const conn = new TermConnection(() => socket);
    conn.start();
    socket.onopen!();
    const handler: StreamHandler = { output: () => {}, resized: () => {}, closed: () => {} };
    const total = 20;
    const promises = Array.from({ length: total }, (_, i) => conn.attach({ machine: 'x', terminal: `t${i}`, cols: 80, rows: 24 }, handler));
    const sentAttaches = () => socket.sent.filter((m): m is Record<string, unknown> => !(m instanceof Uint8Array) && m.t === 'attach');
    expect(sentAttaches()).toHaveLength(8);
    // Complete attaches as they arrive until all 20 drain cleanly.
    let replied = 0;
    while (replied < total) {
      const batch = sentAttaches().slice(replied);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(8);
      for (const msg of batch) {
        replied++;
        socket.text({ t: 'attached', rid: msg.rid, s: replied });
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await Promise.all(promises)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    conn.close();
  });

  it('never exceeds MAX_CONCURRENT_ATTACHES when new attaches interleave with dequeued microtasks', async () => {
    const sockets: FakeSocket[] = [];
    const conn = new TermConnection(() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    });
    conn.start();
    const socket = sockets[0];
    socket.onopen!();
    const handler: StreamHandler = { output: () => {}, resized: () => {}, closed: () => {} };
    const sentAttaches = (s: FakeSocket) =>
      s.sent.filter((m): m is Record<string, unknown> => !(m instanceof Uint8Array) && m.t === 'attach');

    const promises = Array.from({ length: 12 }, (_, i) => conn.attach({ machine: 'x', terminal: `t${i}`, cols: 80, rows: 24 }, handler));
    expect(sentAttaches(socket)).toHaveLength(MAX_CONCURRENT_ATTACHES);

    // Complete 4 in-flight attaches and synchronously fire 4 new attaches BEFORE
    // dequeued waiters resume their microtasks.
    let replied = 0;
    for (let i = 0; i < 4; i++) {
      const msg = sentAttaches(socket)[replied++];
      socket.text({ t: 'attached', rid: msg.rid, s: replied });
    }
    for (let i = 12; i < 16; i++) {
      promises.push(conn.attach({ machine: 'x', terminal: `t${i}`, cols: 80, rows: 24 }, handler));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(sentAttaches(socket).length - replied).toBeLessThanOrEqual(MAX_CONCURRENT_ATTACHES);

    // Drain remaining attaches verifying in-flight never exceeds the cap.
    while (replied < promises.length) {
      const batch = sentAttaches(socket).slice(replied);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(MAX_CONCURRENT_ATTACHES);
      for (const msg of batch) {
        replied++;
        socket.text({ t: 'attached', rid: msg.rid, s: replied });
      }
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await Promise.all(promises)).toHaveLength(16);

    // If a socket drops right after transferring a slot to a waiter and reconnects
    // before the waiter resumes, the stale waiter must reject cleanly without corrupting the new socket.
    const burst = Array.from({ length: MAX_CONCURRENT_ATTACHES + 1 }, (_, i) =>
      conn.attach({ machine: 'x', terminal: `drop${i}`, cols: 80, rows: 24 }, handler).catch((e: unknown) => e),
    );
    const firstMsg = sentAttaches(socket)[replied];
    socket.text({ t: 'attached', rid: firstMsg.rid, s: 99 }); // transfers slot to waiter #9
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    socket.onclose!();
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    sockets[1].onopen!();
    const results = await Promise.all(burst);
    expect(results[0]).toBe(99);
    expect(results[MAX_CONCURRENT_ATTACHES]).toBeInstanceOf(TermError);
    expect(sentAttaches(sockets[1])).toHaveLength(0);
    conn.close();
  });
});
