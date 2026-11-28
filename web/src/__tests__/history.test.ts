// @vitest-environment jsdom
//
// The terminal history plugin's side in the page (plugins/history): which
// snapshot shows what a terminal leaf held before (its own terminal's
// generation of another program, else the one of the terminal it took
// the place of; none where the terminal core restored the screen itself,
// as the machine's capture of the new program tells, or until then as the
// terminal core's restore_screen suggests, the list read again a capture later),
// the bytes read once per snapshot and refused beyond one generation's
// size, the note with the time they were saved, the preludes taken away
// again, and the list read soon, then at most every 5 s, never while the
// page is hidden. The hub's routes are a scripted fetch; the machines'
// terminals and layouts are set in the page's state directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useTerms, type MachineTerms } from '../state/terms';
import { useSettings } from '../settings';
import { onPrelude, preludeOf, PRELUDE_MAX_COLS, PRELUDE_MAX_ROWS, setPrelude } from '../state/preludes';
import { useStore } from '../state/store';
import type { Layout, TerminalLeaf } from '../term/layout';
import type { TerminalRecord } from '../term/protocol';
import { parseList, HISTORY_MAX_BYTES, type HistoryEntry } from '../plugins/history/api';
import {
  CAPTURE,
  CAPTURE_WAITS,
  INTERVAL,
  LIST_GAP_MS,
  LIST_SETTLE_MS,
  MAX_CONCURRENT_READS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  awaitsCapture,
  captureOn,
  chooseSnapshot,
  intervalOf,
  historyCleared,
  retryAfter,
  noteOf,
  savedAt,
  startHistory,
} from '../plugins/history/follow';

const rec = (address: string, pid: number, extra: Record<string, unknown> = {}): TerminalRecord => ({
  address,
  state: 'live',
  pid,
  argv: ['/bin/zsh'],
  cwd: '/home/u',
  labels: {},
  ...extra,
});
const entry = (terminal: string, pid: number, at: number, previous?: { pid: number; at: number }, restored?: boolean): HistoryEntry => ({
  terminal,
  pid,
  at,
  lines: 10,
  bytes: 100,
  cols: 80,
  rows: 24,
  ...(restored ? { restored } : {}),
  ...(previous ? { previous: { ...previous, lines: 10, bytes: 100, cols: 80, rows: 24 } } : {}),
});
const entries = (...list: HistoryEntry[]) => new Map(list.map((e) => [e.terminal, e]));

describe('the snapshot a leaf shows', () => {
  const leaf: TerminalLeaf = { terminal: 't1' };

  it('is its own terminal’s previous generation once the terminal core gave it a new program', () => {
    const c = chooseSnapshot(leaf, rec('t1', 200), entries(entry('t1', 200, 5000, { pid: 100, at: 3000 })), false);
    expect(c).toMatchObject({ terminal: 't1', generation: 'previous', snapshot: { pid: 100, at: 3000 } });
  });

  it('is its current generation while the machine has not captured the new program yet', () => {
    const c = chooseSnapshot(leaf, rec('t1', 200), entries(entry('t1', 100, 3000)), false);
    expect(c).toMatchObject({ terminal: 't1', generation: 'current', snapshot: { pid: 100, at: 3000 } });
  });

  it('is none while the program that ran is the one running', () => {
    expect(chooseSnapshot(leaf, rec('t1', 100), entries(entry('t1', 100, 3000)), false)).toBeUndefined();
    expect(chooseSnapshot(leaf, rec('t1', 100), entries(entry('t1', 100, 3000, { pid: 100, at: 1000 })), false)).toBeUndefined();
    // A terminal that is not live has no program to compare with.
    expect(chooseSnapshot(leaf, rec('t1', 200, { state: 'finished' }), entries(entry('t1', 100, 3000)), false)).toBeUndefined();
    expect(chooseSnapshot(leaf, undefined, entries(entry('t1', 100, 3000)), false)).toBeUndefined();
  });

  it('is the replaced terminal’s current generation, else its previous one', () => {
    const replacing: TerminalLeaf = { terminal: 't2', before: 't1' };
    expect(chooseSnapshot(replacing, rec('t2', 300), entries(entry('t1', 100, 3000, { pid: 90, at: 1000 })), false)).toMatchObject({
      terminal: 't1',
      generation: 'current',
      snapshot: { pid: 100, at: 3000 },
    });
    expect(chooseSnapshot(replacing, rec('t2', 300), entries(entry('t1', 0, 0, { pid: 90, at: 1000 })), false)).toMatchObject({
      terminal: 't1',
      generation: 'previous',
      snapshot: { pid: 90, at: 1000 },
    });
    expect(chooseSnapshot(replacing, rec('t2', 300), entries(entry('t9', 100, 3000)), false)).toBeUndefined();
  });

  it('takes its own terminal’s first, and only a valid other address as the one replaced', () => {
    const both = entries(entry('t2', 300, 6000, { pid: 250, at: 4000 }), entry('t1', 100, 3000));
    expect(chooseSnapshot({ terminal: 't2', before: 't1' }, rec('t2', 300), both, false)).toMatchObject({ terminal: 't2' });
    for (const before of ['../t1', 't1.prev', '', 't2', 42])
      expect(chooseSnapshot({ terminal: 't2', before } as TerminalLeaf, rec('t2', 300), entries(entry('t1', 1, 1)), false)).toBeUndefined();
  });

  it('is none where the capture of the new program shows the screen the terminal core restored itself', () => {
    const restored = entries(entry('t1', 200, 5000, { pid: 100, at: 3000 }, true));
    const notRestored = entries(entry('t1', 200, 5000, { pid: 100, at: 3000 }));
    for (const restoreScreen of [true, false]) {
      expect(chooseSnapshot(leaf, rec('t1', 200), restored, restoreScreen)).toBeUndefined();
      // Not restored (a power loss, or restore_screen off): shown, whatever the setting says.
      expect(chooseSnapshot(leaf, rec('t1', 200), notRestored, restoreScreen)).toMatchObject({ generation: 'previous' });
      expect(awaitsCapture(leaf, rec('t1', 200), restored)).toBe(false);
    }
    // The record's reason does not matter (the terminal core clears it on a kept terminal that is live again).
    expect(chooseSnapshot(leaf, rec('t1', 200, { reason: 'stopped_by_restart' }), restored, false)).toBeUndefined();
    expect(chooseSnapshot(leaf, rec('t1', 200, { reason: 'server_stop' }), notRestored, true)).toMatchObject({ generation: 'previous' });
    // A restored flag of another program than the running one says nothing about it.
    expect(chooseSnapshot(leaf, rec('t1', 300), restored, false)).toMatchObject({ generation: 'current', snapshot: { pid: 200 } });
  });

  it('follows the terminal core’s restore_screen until the machine captured the new program', () => {
    for (const list of [entries(entry('t1', 100, 3000)), entries(entry('t1', 0, 0, { pid: 100, at: 3000 }))]) {
      expect(chooseSnapshot(leaf, rec('t1', 200), list, true)).toBeUndefined();
      expect(chooseSnapshot(leaf, rec('t1', 200), list, false)).toMatchObject({ snapshot: { pid: 100 } });
      expect(awaitsCapture(leaf, rec('t1', 200), list)).toBe(true);
    }
    // Nothing to wait for: the same program, no record, another terminal's snapshot.
    expect(awaitsCapture(leaf, rec('t1', 100), entries(entry('t1', 100, 3000)))).toBe(false);
    expect(awaitsCapture(leaf, undefined, entries(entry('t1', 100, 3000)))).toBe(false);
    expect(awaitsCapture({ terminal: 't2', before: 't1' }, rec('t2', 300), entries(entry('t1', 100, 3000)))).toBe(false);
    // The terminal core never shows another terminal's screen.
    expect(chooseSnapshot({ terminal: 't2', before: 't1' }, rec('t2', 300), entries(entry('t1', 100, 3000)), true)).toMatchObject({
      terminal: 't1',
    });
  });

  it('comes from a list without the entries that are not a terminal’s', () => {
    const l = parseList({
      restoreScreen: true,
      terminals: [
        { terminal: 't1', pid: 1, at: 2, lines: 3, bytes: 4, cols: 5, rows: 6, restored: true, previous: { pid: 7, at: 8 } },
        { terminal: 't4', pid: 1, at: 2, restored: 'yes' },
        { terminal: '../x', pid: 1, at: 2 },
        { terminal: 't2', pid: -1, at: 2 },
        { terminal: 't3', pid: 1 },
        null,
      ],
    });
    expect(l.restoreScreen).toBe(true);
    expect(l.terminals).toEqual([
      {
        terminal: 't1',
        pid: 1,
        at: 2,
        lines: 3,
        bytes: 4,
        cols: 5,
        rows: 6,
        restored: true,
        previous: { pid: 7, at: 8, lines: 0, bytes: 0, cols: 0, rows: 0 },
      },
      { terminal: 't4', pid: 1, at: 2, lines: 0, bytes: 0, cols: 0, rows: 0 },
    ]);
    expect(parseList(null)).toEqual({ terminals: [], restoreScreen: false });
  });

  it('is said below the output with the time it was saved, in the user’s locale', () => {
    const at = Date.UTC(2026, 10, 21, 19, 40);
    const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
    expect(savedAt(at)).toBe(time);
    expect(noteOf(at)).toBe(`-- output saved ${time}; the program above has ended --`);
    expect(time).toContain('2026');
  });
});

/** The hub's history routes of machine a, scripted, with every request. */
class FakeHistory {
  list: { terminals: unknown[]; restoreScreen: boolean } = { terminals: [], restoreScreen: false };
  /** Bytes by "terminal generation", with the pid and time they are of. */
  data = new Map<string, { bytes: Uint8Array<ArrayBuffer>; pid: number; at: number; length?: number; cols?: number; rows?: number }>();
  requests: string[] = [];
  fail = false;
  /** Fails the next lists or reads with this answer. */
  failLists = 0;
  failReads = 0;
  failWith = { status: 409, body: '{"error":"offline"}' };
  /** The adopt route's answer, made when it is asked. */
  adopt: () => Response = () => new Response('{"adopted":true}', { status: 200 });

  install() {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://page');
      const method = init?.method ?? 'GET';
      this.requests.push(`${method} ${u.pathname}${u.search}`);
      const failed = () => new Response(this.failWith.body, { status: this.failWith.status });
      if (this.fail) return failed();
      if (u.pathname === '/api/m/a/p/history' && method === 'GET') {
        if (this.failLists > 0 && this.failLists--) return failed();
        return new Response(JSON.stringify(this.list), { status: 200 });
      }
      if (u.pathname === '/api/m/a/p/history/adopt' && method === 'POST') return this.adopt();
      if (u.pathname === '/api/m/a/p/history/read') {
        if (this.failReads > 0 && this.failReads--) return failed();
        const d = this.data.get(`${u.searchParams.get('terminal')} ${u.searchParams.get('generation')}`);
        if (!d) return new Response('{"error":"not_found"}', { status: 404 });
        const headers: Record<string, string> = { 'X-History-Pid': String(d.pid), 'X-History-At': String(d.at) };
        if (d.length !== undefined) headers['Content-Length'] = String(d.length);
        if (d.cols !== undefined) headers['X-History-Cols'] = String(d.cols);
        if (d.rows !== undefined) headers['X-History-Rows'] = String(d.rows);
        return new Response(d.bytes, { status: 200, headers });
      }
      return new Response('{"error":"unknown"}', { status: 404 });
    });
  }

  lists = () => this.requests.filter((r) => r === 'GET /api/m/a/p/history').length;
  reads = () => this.requests.filter((r) => r.startsWith('GET /api/m/a/p/history/read'));
  adopts = () => this.requests.filter((r) => r.startsWith('POST /api/m/a/p/history/adopt'));
}

function layoutOf(...leaves: TerminalLeaf[]): Layout {
  return {
    version: 2,
    selected: 0,
    workspaces: [{ id: 'w', name: '', cwd: '', selected: 0, tabs: leaves.map((leaf) => ({ root: leaf, focused: leaf.terminal })) }],
  };
}

/** Machine a's terminals and layout, as the page's model publishes them. */
function machine(records: TerminalRecord[], layout: Layout, phase: 'ready' | 'starting' | 'error' = 'ready') {
  const terminals: Record<string, TerminalRecord> = {};
  for (const r of records) terminals[r.address] = r;
  const a: MachineTerms = { backend: { phase, code: '', version: '' }, terminals, layout };
  useTerms.setState({ connected: true, machines: { a } });
}

function capture(on: boolean | undefined, machines: Record<string, boolean> = {}) {
  useSettings.setState((s) => ({
    values: { ...s.values, [CAPTURE]: { value: on ?? false, source: on === undefined ? 'default' : 'global', machines } },
  }));
}

const enc = (s: string) => new TextEncoder().encode(s);
const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
const settle = () => vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 10);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('the history plugin in the page', () => {
  let hub: FakeHistory;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    hub = new FakeHistory();
    hub.install();
    useTerms.setState({ connected: false, machines: {} });
    capture(undefined, { a: true });
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    for (const t of ['t1', 't2', 't3']) setPrelude('a', t, undefined);
    useStore.setState({ readOnly: false });
    setVisibility('visible');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Machine a's terminal t1 with a new program (200) and a snapshot of the one before (100). */
  function restarted() {
    hub.list = { restoreScreen: false, terminals: [entry('t1', 200, 5000, { pid: 100, at: 3000 })] };
    hub.data.set('t1 previous', { bytes: enc('before the restart'), pid: 100, at: 3000 });
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
  }

  it('follows the machines that keep snapshots, by their own setting', () => {
    capture(false, { a: true });
    expect(captureOn('a')).toBe(true);
    expect(captureOn('b')).toBe(false);
    capture(true, { a: false });
    expect(captureOn('a')).toBe(false);
    expect(captureOn('b')).toBe(true);
  });

  it('shows the snapshot of the program before above a terminal, read once', async () => {
    restarted();
    stop = startHistory();
    expect(hub.lists()).toBe(0);
    await settle();
    expect(hub.lists()).toBe(1);
    expect(hub.reads()).toEqual(['GET /api/m/a/p/history/read?terminal=t1&generation=previous']);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    expect(preludeOf('a', 't1')?.note).toBe(noteOf(3000));
    // The layout and the records change, a list is read again: the same snapshot is not read again.
    machine([rec('t1', 200, { title: 'vim' })], layoutOf({ terminal: 't1', label: 'vim' }));
    machine([rec('t1', 200), rec('t2', 400)], layoutOf({ terminal: 't1' }, { terminal: 't2' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(hub.reads()).toHaveLength(1);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
  });

  it('shows the snapshot of the terminal a leaf took the place of', async () => {
    hub.list = { restoreScreen: true, terminals: [entry('t1', 100, 3000)] };
    hub.data.set('t1 current', { bytes: enc('the old terminal'), pid: 100, at: 3000 });
    machine([rec('t2', 300)], layoutOf({ terminal: 't2', before: 't1' }));
    stop = startHistory();
    await settle();
    expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
    expect(preludeOf('a', 't1')).toBeUndefined();
  });

  it('refuses bytes beyond one generation’s size, and does not read them again until the next list', async () => {
    restarted();
    hub.data.set('t1 previous', { bytes: new Uint8Array(HISTORY_MAX_BYTES + 1), pid: 100, at: 3000 });
    stop = startHistory();
    await settle();
    expect(hub.reads()).toHaveLength(1);
    expect(preludeOf('a', 't1')).toBeUndefined();
    // Said too large before the body.
    hub.data.set('t1 previous', { bytes: enc('small'), pid: 100, at: 3000, length: HISTORY_MAX_BYTES + 1 });
    machine([rec('t1', 200, { title: 'x' })], layoutOf({ terminal: 't1' }));
    await settle();
    expect(hub.reads()).toHaveLength(1);
    // A terminal with a new program: the list is read again, and the snapshot.
    machine([rec('t1', 200), rec('t2', 500)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.reads()).toHaveLength(2);
    expect(preludeOf('a', 't1')).toBeUndefined();
    // Exactly one generation's size is taken.
    hub.data.set('t1 previous', { bytes: new Uint8Array(HISTORY_MAX_BYTES).fill(65), pid: 100, at: 3000 });
    machine([rec('t1', 200), rec('t2', 501)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(preludeOf('a', 't1')?.bytes.length).toBe(HISTORY_MAX_BYTES);
  });

  it('takes a snapshot the machine moved since its list as failed, and lists again', async () => {
    restarted();
    hub.list = { restoreScreen: false, terminals: [entry('t1', 100, 3000)] };
    // The machine captured the new program meanwhile: its current generation is another.
    hub.data.set('t1 current', { bytes: enc('the new program'), pid: 200, at: 6000 });
    stop = startHistory();
    await settle();
    expect(hub.reads()).toEqual(['GET /api/m/a/p/history/read?terminal=t1&generation=current']);
    expect(preludeOf('a', 't1')).toBeUndefined();
    hub.list = { restoreScreen: false, terminals: [entry('t1', 200, 6000, { pid: 100, at: 3000 })] };
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
  });

  it('takes a prelude away when its snapshot leaves the list, its leaf the layout, or the setting goes off', async () => {
    restarted();
    stop = startHistory();
    await settle();
    expect(preludeOf('a', 't1')).toBeDefined();
    // Gone from the list (the snapshot aged out): seen at the next list.
    hub.list = { restoreScreen: false, terminals: [] };
    machine([rec('t1', 200), rec('t2', 400)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(preludeOf('a', 't1')).toBeUndefined();

    // Back, then its leaf closed.
    hub.list = { restoreScreen: false, terminals: [entry('t1', 200, 5000, { pid: 100, at: 3000 })] };
    machine([rec('t1', 200), rec('t2', 401)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(preludeOf('a', 't1')).toBeDefined();
    machine([rec('t1', 200), rec('t2', 401)], layoutOf({ terminal: 't2' }));
    expect(preludeOf('a', 't1')).toBeUndefined();

    // Back in the layout: its bytes, dropped with the leaf, are read again.
    machine([rec('t1', 200), rec('t2', 401)], layoutOf({ terminal: 't1' }));
    await settle();
    expect(preludeOf('a', 't1')).toBeDefined();
    expect(hub.reads()).toHaveLength(3);
    // Then the machine's setting turned off.
    capture(undefined, { a: false });
    expect(preludeOf('a', 't1')).toBeUndefined();
  });

  it('takes its preludes away when the plugin stops, and after the snapshots were cleared', async () => {
    restarted();
    stop = startHistory();
    await settle();
    expect(preludeOf('a', 't1')).toBeDefined();
    historyCleared('a');
    expect(preludeOf('a', 't1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(preludeOf('a', 't1')).toBeDefined();
    stop();
    stop = undefined;
    expect(preludeOf('a', 't1')).toBeUndefined();
    // Stopped, it follows nothing.
    machine([rec('t1', 201)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
  });

  it('reads the list once the terminals are known, again after new programs, at most every 5 s', async () => {
    machine([rec('t1', 100)], layoutOf({ terminal: 't1' }), 'starting');
    stop = startHistory();
    await settle();
    expect(hub.lists()).toBe(0);
    machine([rec('t1', 100)], layoutOf({ terminal: 't1' }));
    await settle();
    expect(hub.lists()).toBe(1);
    // Nothing new: no list.
    machine([rec('t1', 100, { title: 'top' })], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS * 2);
    expect(hub.lists()).toBe(1);
    // A burst of restarts and a new terminal: one list soon.
    machine([rec('t1', 101)], layoutOf({ terminal: 't1' }));
    machine([rec('t1', 101), rec('t2', 300)], layoutOf({ terminal: 't1' }));
    await settle();
    expect(hub.lists()).toBe(2);
    // More: one list, 5 s after the last one.
    machine([rec('t1', 102), rec('t2', 300)], layoutOf({ terminal: 't1' }));
    machine([rec('t1', 103), rec('t2', 300)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS - 1000);
    expect(hub.lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(hub.lists()).toBe(3);
  });

  it('reads nothing while the page is hidden, and what is due once it is shown', async () => {
    setVisibility('hidden');
    restarted();
    stop = startHistory();
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS * 3);
    expect(hub.lists()).toBe(0);
    setVisibility('visible');
    await settle();
    expect(hub.lists()).toBe(1);
    expect(preludeOf('a', 't1')).toBeDefined();
  });

  it('reads the list again a capture later while a choice waits for it, and follows what the capture tells', async () => {
    // The terminal core restores screens itself: nothing is shown until the machine captured the new shell.
    hub.list = { restoreScreen: true, terminals: [entry('t1', 100, 3000)] };
    hub.data.set('t1 previous', { bytes: enc('before the restart'), pid: 100, at: 3000 });
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
    useSettings.setState((s) => ({ values: { ...s.values, [INTERVAL]: { value: 30, source: 'global', machines: { a: 10 } } } }));
    expect(intervalOf('a')).toBe(10);
    stop = startHistory();
    await settle();
    expect(hub.lists()).toBe(1);
    expect(preludeOf('a', 't1')).toBeUndefined();
    // It did not restore (a power loss): the capture says so, and the page follows.
    hub.list = { restoreScreen: true, terminals: [entry('t1', 200, 6000, { pid: 100, at: 3000 })] };
    await vi.advanceTimersByTimeAsync(10_000 + LIST_GAP_MS + LIST_SETTLE_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    // Decided: no more lists.
    await vi.advanceTimersByTimeAsync(10 * (10_000 + LIST_GAP_MS));
    expect(hub.lists()).toBe(2);
  });

  it('takes the prelude away when the capture shows the terminal core restored the screen, and waits a bounded number of times', async () => {
    hub.list = { restoreScreen: false, terminals: [entry('t1', 100, 3000)] };
    hub.data.set('t1 current', { bytes: enc('before the restart'), pid: 100, at: 3000 });
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
    stop = startHistory();
    await settle();
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    // The machine has not captured yet: read again CAPTURE_WAITS times, then no more.
    await vi.advanceTimersByTimeAsync((CAPTURE_WAITS + 2) * (intervalOf('a') * 1000 + LIST_GAP_MS + LIST_SETTLE_MS));
    expect(hub.lists()).toBe(1 + CAPTURE_WAITS);
    expect(preludeOf('a', 't1')).toBeDefined();
    // A new program restarts the waits; this time the capture shows the terminal core's line.
    hub.list = { restoreScreen: false, terminals: [entry('t1', 200, 6000, { pid: 100, at: 3000 }, true)] };
    machine([rec('t1', 200), rec('t2', 400)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + LIST_SETTLE_MS);
    expect(preludeOf('a', 't1')).toBeUndefined();
  });

  it('keeps what it showed while the machine does not answer', async () => {
    restarted();
    stop = startHistory();
    await settle();
    hub.fail = true;
    machine([rec('t1', 200), rec('t2', 400)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
  });

  it('gives the prelude the grid the read says, else the list’s, within bounds', async () => {
    restarted();
    hub.data.set('t1 previous', { bytes: enc('before the restart'), pid: 100, at: 3000, cols: 120, rows: 40 });
    stop = startHistory();
    await settle();
    expect(preludeOf('a', 't1')).toMatchObject({ cols: 120, rows: 40 });
    // The read without the headers: the list's (80 by 24).
    hub.data.set('t1 previous', { bytes: enc('before the restart'), pid: 100, at: 3000 });
    historyCleared('a');
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(preludeOf('a', 't1')).toMatchObject({ cols: 80, rows: 24 });
    // A grid out of bounds is none.
    for (const grid of [
      { cols: PRELUDE_MAX_COLS + 1, rows: 24 },
      { cols: 80, rows: PRELUDE_MAX_ROWS + 1 },
      { cols: 1, rows: 24 },
      { cols: 80, rows: 0 },
      { cols: 80.5, rows: 24 },
    ]) {
      setPrelude('a', 't3', enc('x'), 'n', grid);
      expect(preludeOf('a', 't3')?.cols, JSON.stringify(grid)).toBeUndefined();
      expect(preludeOf('a', 't3')?.rows).toBeUndefined();
    }
    setPrelude('a', 't3', enc('x'), 'n', { cols: PRELUDE_MAX_COLS, rows: PRELUDE_MAX_ROWS });
    expect(preludeOf('a', 't3')).toMatchObject({ cols: PRELUDE_MAX_COLS, rows: PRELUDE_MAX_ROWS });
    // Another grid of the same bytes is a change.
    const changed = vi.fn();
    const off = onPrelude('a', 't3', changed);
    setPrelude('a', 't3', enc('x'), 'n', { cols: PRELUDE_MAX_COLS, rows: PRELUDE_MAX_ROWS });
    expect(changed).not.toHaveBeenCalled();
    setPrelude('a', 't3', enc('x'), 'n', { cols: 80, rows: 24 });
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  it('tries a list that failed again after a back-off, as long as it fails', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryAfter)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(retryAfter(1)).toBe(RETRY_MIN_MS);
    expect(retryAfter(50)).toBe(RETRY_MAX_MS);
    restarted();
    hub.failLists = 3;
    stop = startHistory();
    await settle();
    expect(hub.lists()).toBe(1);
    expect(preludeOf('a', 't1')).toBeUndefined();
    // The first list was LIST_SETTLE_MS in, 10 ms ago.
    await vi.advanceTimersByTimeAsync(1990);
    expect(hub.lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(hub.lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.lists()).toBe(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(hub.lists()).toBe(4);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    // Listed: no more tries.
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(hub.lists()).toBe(4);
  });

  it('tries a read that failed for the machine again after a back-off, and one it refused not before the next list', async () => {
    restarted();
    hub.failReads = 2;
    hub.failWith = { status: 400, body: '{"error":"busy"}' };
    stop = startHistory();
    await settle();
    expect(hub.reads()).toHaveLength(1);
    expect(preludeOf('a', 't1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hub.reads()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(hub.reads()).toHaveLength(3);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    expect(hub.lists()).toBe(1);
    // Refused: not tried again until a list says it is there.
    historyCleared('a');
    hub.failReads = 1;
    hub.failWith = { status: 400, body: '{"error":"bad_request"}' };
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.reads()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(hub.reads()).toHaveLength(4);
    expect(preludeOf('a', 't1')).toBeUndefined();
  });

  it('keeps a prelude while the machine comes back, until the list read then says otherwise', async () => {
    restarted();
    stop = startHistory();
    await settle();
    const changed = vi.fn();
    const off = onPrelude('a', 't1', changed);
    // The hub's messages when the machine is back: its backend starting
    // (records dropped), ready, then the terminals' snapshot.
    machine([], layoutOf({ terminal: 't1' }), 'starting');
    machine([], layoutOf({ terminal: 't1' }));
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
    // The connection to the hub went: the layout is not known until it is read again.
    useTerms.setState({ connected: false, machines: { a: { ...useTerms.getState().machines.a, layout: undefined } } });
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(hub.lists()).toBe(2);
    expect(hub.reads()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('before the restart');
    // The list after the return says it is gone: it goes.
    hub.list = { restoreScreen: false, terminals: [] };
    machine([], layoutOf({ terminal: 't1' }));
    machine([rec('t1', 200)], layoutOf({ terminal: 't1' }));
    await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
    expect(preludeOf('a', 't1')).toBeUndefined();
    off();
  });

  /** Machine a's t2, which took the place of t1, and t1's snapshot. */
  function replaced(restoreScreen = false) {
    hub.list = { restoreScreen, terminals: [entry('t1', 100, 3000, { pid: 90, at: 1000 })] };
    hub.data.set('t1 current', { bytes: enc('the old terminal'), pid: 100, at: 3000 });
    // The machine moves t1's newest to t2 as its previous generation.
    hub.adopt = () => {
      hub.list = { restoreScreen, terminals: [entry('t2', 0, 0, { pid: 100, at: 3000 })] };
      hub.data.delete('t1 current');
      hub.data.set('t2 previous', { bytes: enc('the old terminal'), pid: 100, at: 3000 });
      return new Response('{"adopted":true}', { status: 200 });
    };
    machine([rec('t2', 300)], layoutOf({ terminal: 't2', before: 't1' }));
  }

  it('moves the snapshot of the terminal a leaf took the place of to its own, once, and shows it all along', async () => {
    for (const restoreScreen of [false, true]) {
      replaced(restoreScreen);
      hub.requests = [];
      stop = startHistory();
      await settle();
      expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
      expect(hub.adopts()).toEqual(['POST /api/m/a/p/history/adopt?from=t1&to=t2']);
      const changed = vi.fn();
      const off = onPrelude('a', 't2', changed);
      // The list is read again: the snapshot is t2's own now, shown as it was.
      await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
      expect(hub.lists()).toBe(2);
      expect(hub.reads()).toHaveLength(1);
      expect(changed).not.toHaveBeenCalled();
      expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
      // Not again, also when the terminals change.
      machine([rec('t2', 300), rec('t3', 400)], layoutOf({ terminal: 't2', before: 't1' }));
      await vi.advanceTimersByTimeAsync(LIST_GAP_MS + 10);
      expect(hub.adopts()).toHaveLength(1);
      expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
      off();
      stop();
      stop = undefined;
      setPrelude('a', 't2', undefined);
    }
  });

  it('moves nothing from a read-only page, nor again once refused, and tries again after the machine failed', async () => {
    useStore.setState({ readOnly: true });
    replaced();
    stop = startHistory();
    await settle();
    expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
    expect(hub.adopts()).toEqual([]);
    stop();
    useStore.setState({ readOnly: false });

    // Refused: not asked again.
    replaced();
    hub.adopt = () => new Response('{"error":"bad_request"}', { status: 400 });
    hub.requests = [];
    stop = startHistory();
    await settle();
    machine([rec('t2', 300), rec('t3', 400)], layoutOf({ terminal: 't2', before: 't1' }));
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(hub.adopts()).toHaveLength(1);
    expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
    stop();

    // The machine away: asked again after the back-off.
    replaced();
    let tries = 0;
    const moving = hub.adopt;
    hub.adopt = () => (++tries < 3 ? new Response('{"error":"offline"}', { status: 409 }) : moving());
    hub.requests = [];
    stop = startHistory();
    await settle();
    expect(hub.adopts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(hub.adopts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(hub.adopts()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(hub.adopts()).toHaveLength(3);
    expect(hub.list.terminals).toEqual([entry('t2', 0, 0, { pid: 100, at: 3000 })]);
    expect(text(preludeOf('a', 't2')?.bytes)).toBe('the old terminal');
  });

  it('pauses polling while offline or disabled, resets backoff, skips stale pre-reboot list reads, and shows fresh history immediately on reconnect', async () => {
    restarted();
    hub.failLists = 3;
    stop = startHistory();
    await settle();
    // 3 failures ramp backoff up (2s, 4s, 8s...).
    await vi.advanceTimersByTimeAsync(2000 + 4000);
    expect(hub.lists()).toBe(3);

    // Remote machine goes offline / is manually disabled for 10 minutes: ZERO list calls.
    machine([], layoutOf({ terminal: 't1' }), 'error');
    const listsBeforeOffline = hub.lists();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hub.lists()).toBe(listsBeforeOffline);

    // Machine reboots and is re-enabled: backoff resets and fresh list runs within LIST_SETTLE_MS.
    hub.failLists = 0;
    hub.list = { restoreScreen: false, terminals: [entry('t1', 300, 9000, { pid: 200, at: 7000 })] };
    hub.data.set('t1 previous', { bytes: enc('after reboot history'), pid: 200, at: 7000 });
    machine([rec('t1', 300)], layoutOf({ terminal: 't1' }), 'ready');
    await vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 20);
    expect(hub.lists()).toBe(listsBeforeOffline + 1);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('after reboot history');

    // Second disconnect + reconnect with a stale pre-reboot list cached: does NOT
    // read against the stale list before the fresh post-reboot list arrives.
    const readsBefore = hub.reads().length;
    machine([], layoutOf({ terminal: 't1' }), 'error');
    // Prelude stays visible while away.
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('after reboot history');
    hub.list = { restoreScreen: false, terminals: [entry('t1', 400, 12000, { pid: 300, at: 10000 })] };
    hub.data.set('t1 previous', { bytes: enc('second reboot history'), pid: 300, at: 10000 });
    machine([rec('t1', 400)], layoutOf({ terminal: 't1' }), 'ready');
    // Before LIST_SETTLE_MS fires the fresh list, no read against the stale list happened.
    expect(hub.reads()).toHaveLength(readsBefore);
    await vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 20);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('second reboot history');
  });

  it('shows pre-boot history immediately on same-pid reboot when list beats capture and keeps it seamlessly after rotation', async () => {
    capture(true);
    // Pre-boot current snapshot reports pid 0 before capture rotates it, while kept t1 reused pid 100.
    hub.list = { restoreScreen: false, terminals: [entry('t1', 0, 3000)] };
    hub.data.set('t1 current', { bytes: enc('pre-boot same pid'), pid: 0, at: 3000 });
    machine([rec('t1', 100)], layoutOf({ terminal: 't1' }));
    stop = startHistory();
    await settle();
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('pre-boot same pid');
    expect(hub.reads()).toHaveLength(1);

    // Capture later rotates current -> previous (pid 0, at 3000) and writes post-reboot current (pid 100, at 9000).
    const changed = vi.fn();
    const off = onPrelude('a', 't1', changed);
    hub.list = { restoreScreen: false, terminals: [entry('t1', 100, 9000, { pid: 0, at: 3000 })] };
    // Advance past capture wait so follower re-lists: same (pid: 0, at: 3000) key means zero re-read and zero churn.
    await vi.advanceTimersByTimeAsync(30_000 + LIST_GAP_MS + LIST_SETTLE_MS + 20);
    expect(hub.lists()).toBe(2);
    expect(hub.reads()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('pre-boot same pid');
    off();
  });

  it('bounds concurrent snapshot reads during restart recovery to MAX_CONCURRENT_READS', async () => {
    capture(true);
    const total = 10;
    const leaves = Array.from({ length: total }, (_, i) => ({ terminal: `t${i}` }));
    const recs = Array.from({ length: total }, (_, i) => rec(`t${i}`, 200 + i));
    hub.list = {
      restoreScreen: false,
      terminals: Array.from({ length: total }, (_, i) => entry(`t${i}`, 100 + i, 3000 + i)),
    };
    for (let i = 0; i < total; i++) hub.data.set(`t${i} current`, { bytes: enc(`snap-${i}`), pid: 100 + i, at: 3000 + i });

    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/p/history/read')) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => releases.push(r));
        inFlight--;
      }
      return origFetch(url, init);
    });

    machine(recs, {
      version: 2,
      selected: 0,
      workspaces: [{ id: 'w', name: '', cwd: '', selected: 0, tabs: leaves.map((root) => ({ root, focused: root.terminal })) }],
    });
    stop = startHistory();
    await vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 10);
    expect(peak).toBe(MAX_CONCURRENT_READS);
    expect(inFlight).toBe(MAX_CONCURRENT_READS);
    while (releases.length > 0) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(peak).toBe(MAX_CONCURRENT_READS);
    for (let i = 0; i < total; i++) expect(text(preludeOf('a', `t${i}`)?.bytes)).toBe(`snap-${i}`);
  });

  it('ignores pre-disconnect list/adopt completions after reconnect and clears preludes on historyCleared while staleList is set', async () => {
    // 1. Pre-disconnect listHistory resolving after reconnect does not overwrite post-reconnect state or stall fresh listing.
    let staleListSignal: AbortSignal | undefined;
    let resolveStaleList!: (r: Response) => void;
    let interceptFirstList = true;
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/m/a/p/history' && interceptFirstList) {
        interceptFirstList = false;
        staleListSignal = init?.signal ?? undefined;
        return new Promise<Response>((r) => (resolveStaleList = r));
      }
      return origFetch(url, init);
    });

    restarted();
    stop = startHistory();
    await vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 10);
    expect(staleListSignal).toBeDefined();
    expect(staleListSignal?.aborted).toBe(false);

    // Machine disconnects -> aborts pre-disconnect list.
    machine([], layoutOf({ terminal: 't1' }), 'error');
    expect(staleListSignal?.aborted).toBe(true);

    // Machine reconnects with fresh post-reboot history.
    hub.list = { restoreScreen: false, terminals: [entry('t1', 300, 9000, { pid: 200, at: 7000 })] };
    hub.data.set('t1 previous', { bytes: enc('fresh post-reconnect'), pid: 200, at: 7000 });
    machine([rec('t1', 300)], layoutOf({ terminal: 't1' }), 'ready');

    // Stale pre-disconnect list resolves late -> must be ignored and must not block reconnect's fresh list.
    resolveStaleList(
      new Response(JSON.stringify({ restoreScreen: false, terminals: [entry('t1', 200, 5000, { pid: 100, at: 3000 })] }), { status: 200 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(preludeOf('a', 't1')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(LIST_SETTLE_MS + 20);
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('fresh post-reconnect');

    // 2. historyCleared while staleList is true (right after reconnect before fresh list fires) immediately clears preludes.
    machine([], layoutOf({ terminal: 't1' }), 'error');
    expect(text(preludeOf('a', 't1')?.bytes)).toBe('fresh post-reconnect');
    machine([rec('t1', 400)], layoutOf({ terminal: 't1' }), 'ready');
    historyCleared('a');
    expect(preludeOf('a', 't1')).toBeUndefined();
    stop();

    // 3. Pre-disconnect adoptHistory rejecting after disconnect does not schedule offline retries or stall post-reconnect adoption.
    let adoptSignal: AbortSignal | undefined;
    let resolveOldAdopt!: (r: Response) => void;
    let interceptFirstAdopt = true;
    hub = new FakeHistory();
    hub.install();
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/m/a/p/history/adopt') && interceptFirstAdopt) {
        interceptFirstAdopt = false;
        adoptSignal = init?.signal ?? undefined;
        return new Promise<Response>((r) => (resolveOldAdopt = r));
      }
      return baseFetch(url, init);
    });
    hub.list = { restoreScreen: false, terminals: [entry('t1', 100, 3000)] };
    hub.data.set('t1 current', { bytes: enc('old terminal'), pid: 100, at: 3000 });
    machine([rec('t2', 300)], layoutOf({ terminal: 't2', before: 't1' }), 'ready');
    stop = startHistory();
    await settle();
    expect(adoptSignal).toBeDefined();
    expect(adoptSignal?.aborted).toBe(false);

    // Disconnect aborts adopt; even if the old fetch settles with 409 offline, ZERO retries run while offline.
    machine([], layoutOf({ terminal: 't2', before: 't1' }), 'error');
    expect(adoptSignal?.aborted).toBe(true);
    resolveOldAdopt(new Response('{"error":"offline"}', { status: 409 }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(hub.adopts()).toHaveLength(0);

    // Reconnect runs adoption cleanly (was not stuck in busy state).
    machine([rec('t2', 300)], layoutOf({ terminal: 't2', before: 't1' }), 'ready');
    await settle();
    expect(hub.adopts()).toHaveLength(1);
  });
});
