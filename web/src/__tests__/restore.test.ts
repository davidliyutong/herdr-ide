// A machine's workspaces after its terminal core started again: terminals
// that ended with the core are started again in their place, and a
// terminal that lost its agent asks for it back, once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from '../term/layout';
import {
  AGENT_FORGET_MS,
  endedWithCore,
  keptWhileRestarting,
  missingOnEmptyCore,
  rememberAgents,
  replaceTerminal,
  takeResume,
} from '../restore';
import { FakeHub, settle } from './fakeTerms';
import { useStore } from '../state/store';

afterEach(() => {
  vi.useRealTimers();
  useStore.setState({ readOnly: false });
});

const layoutOf = (...leaves: L.TerminalLeaf[]): L.Layout => ({
  version: 2,
  workspaces: [{ id: 'wwwwwwww', name: '', cwd: '', tabs: leaves.map((leaf) => ({ root: leaf, focused: leaf.terminal })), selected: 0 }],
  selected: 0,
});
const leaves = (l: L.Layout) => l.workspaces.flatMap((w) => w.tabs.flatMap((t) => L.leavesOf(t.root)));
const never = () => false;
/** A terminal's pane, attached, that records what is typed into it. */
const into = (typed: string[]) => ({ attached: true, type: (text: string) => void typed.push(text) });

describe('restore', () => {
  it('tells a terminal that ended with its core from one whose program ended', () => {
    expect(endedWithCore(FakeHub.term('t1', { state: 'finished', reason: 'stopped_by_restart' }))).toBe(true);
    expect(endedWithCore(FakeHub.term('t1', { state: 'finished', reason: 'host_shutdown' }))).toBe(true);
    expect(endedWithCore(FakeHub.term('t1', { state: 'finished', reason: 'exited' }))).toBe(false);
    expect(endedWithCore(FakeHub.term('t1', { reason: 'server_stop' }))).toBe(false);
    expect(endedWithCore(undefined)).toBe(false);
  });

  it('remembers the agent of a terminal and forgets it only after a while without', () => {
    const records = new Map([
      ['t1', FakeHub.term('t1', { pid: 7, agent: 'claude' })],
      ['t2', FakeHub.term('t2', { pid: 8 })],
      ['t3', FakeHub.term('t3', { pid: 9, agent: 'gemini' })],
    ]);
    const get = (a: string) => records.get(a);
    const before = layoutOf({ terminal: 't1' }, { terminal: 't2' }, { terminal: 't3' });
    const l = rememberAgents(before, get, never);
    // Only an agent that can continue a conversation is remembered.
    expect(leaves(l)).toEqual([{ terminal: 't1', agent: 'claude', pid: 7 }, { terminal: 't2' }, { terminal: 't3' }]);
    expect(rememberAgents(l, get, never)).toBe(l);
    // The agent ended: remembered still (a machine going down ends it too).
    records.set('t1', FakeHub.term('t1', { pid: 7 }));
    expect(rememberAgents(l, get, never)).toBe(l);
    expect(leaves(rememberAgents(l, get, (a) => a === 't1'))[0]).toEqual({ terminal: 't1' });
  });

  it('asks for the agent back once the terminal runs another program, and takes the request once', () => {
    const l = layoutOf({ terminal: 't1', agent: 'codex', pid: 7 });
    // The terminal core gave the kept terminal a new shell.
    const after = rememberAgents(l, () => FakeHub.term('t1', { pid: 70 }), never);
    expect(leaves(after)).toEqual([{ terminal: 't1', resume: 'codex' }]);
    const taken = takeResume(after, 't1')!;
    expect(taken.command).toBe('codex resume --last');
    expect(leaves(taken.layout)).toEqual([{ terminal: 't1' }]);
    expect(takeResume(taken.layout, 't1')).toBeUndefined();
    // A name the document made up is no command.
    expect(takeResume(layoutOf({ terminal: 't1', resume: 'rm -rf ~' }), 't1')!.command).toBeUndefined();
    // The agent started by then: nothing is asked for.
    expect(leaves(rememberAgents(after, () => FakeHub.term('t1', { pid: 70, agent: 'codex' }), never))).toEqual([
      { terminal: 't1', agent: 'codex', pid: 70 },
    ]);
  });

  it('puts a new terminal in the place of an ended one, with the focus', () => {
    const l = layoutOf({ terminal: 't1', agent: 'claude', pid: 7 }, { terminal: 't2' });
    const next = replaceTerminal(l, 't1', 't5');
    expect(leaves(next)).toEqual([{ terminal: 't5', before: 't1', resume: 'claude' }, { terminal: 't2' }]);
    expect(next.workspaces[0].tabs[0].focused).toBe('t5');
    expect(replaceTerminal(next, 't1', 't6')).toBe(next);
  });

  it("types nothing in the page whose layout lost to another page's", async () => {
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    const fm = hub.machine('m', [FakeHub.term('t1', { pid: 70 })], layoutOf({ terminal: 't1', resume: 'codex' }));
    const model = hub.install();
    model.subscribe('m');
    await settle();
    // Another page wrote the layout (and typed) meanwhile.
    fm.layout = layoutOf({ terminal: 't1' });
    fm.version++;
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await settle();
    expect(typed).toEqual([]);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't1' }]);
  });

  it('takes nothing for a pane that is not attached, or a terminal that is not live', async () => {
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    const fm = hub.machine('m', [FakeHub.term('t1', { pid: 70 })], layoutOf({ terminal: 't1', resume: 'codex' }));
    const model = hub.install();
    model.subscribe('m');
    await settle();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', { attached: false, type: (text) => void typed.push(text) });
    await settle();
    expect(typed).toEqual([]);
    expect(leaves(fm.layout as L.Layout)).toEqual([{ terminal: 't1', resume: 'codex' }]);
    hub.event('m', 'finished', 't1', { state: 'finished', reason: 'server_stop' });
    await settle();
    model.resumeAgent('m', 't1', into(typed));
    await settle();
    expect(typed).toEqual([]);
    expect(leaves(fm.layout as L.Layout)).toEqual([{ terminal: 't1', resume: 'codex' }]);
  });

  // A machine whose terminal t1 ended with its core, its record and pane kept.
  const ended = () => {
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    hub.next = 3;
    const fm = hub.machine('m', [FakeHub.term('t1', { state: 'finished', reason: 'stopped_by_restart' })], layoutOf({ terminal: 't1' }));
    const handle = hub.handle.bind(hub);
    const removed = (a: string) => hub.calls.some((c) => c.method === 'terminal.rm' && c.params.terminal === a);
    return { hub, fm, handle, removed };
  };

  it('keeps the ended terminal until a layout naming its replacement is written: one that lost starts it again', async () => {
    const { hub, fm, handle, removed } = ended();
    let first = true;
    hub.handle = (msg) => {
      if (first && msg.t === 'call' && msg.method === 'doc.set') {
        first = false;
        // Another page wrote first, a layout that still names t1.
        fm.layout = layoutOf({ terminal: 't1', agent: 'claude', pid: 7 });
        fm.version++;
      }
      handle(msg);
    };
    const model = hub.install();
    model.subscribe('m');
    await settle();
    await settle();
    // t3 lost and ended; t1 stayed and was started again as t4, whose
    // layout was written before t1 was removed.
    expect(hub.calls.some((c) => c.method === 'terminal.kill' && c.params.terminal === 't3')).toBe(true);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't4', before: 't1', resume: 'claude' }]);
    expect(leaves(hub.layout('m')!)).toEqual([{ terminal: 't4', before: 't1', resume: 'claude' }]);
    expect(removed('t1')).toBe(true);
  });

  it('does not end its replacement for a read answered before its own write of it', async () => {
    const { hub, fm, handle, removed } = ended();
    let held: Record<string, unknown> | undefined;
    hub.handle = (msg) => {
      if (!held && msg.t === 'call' && msg.method === 'doc.set') {
        // The write is on its way while a snapshot comes and its read is
        // answered with the layout from before it.
        held = msg;
        return hub.push({ t: 'snapshot', m: 'm', terminals: fm.terminals });
      }
      handle(msg);
    };
    const model = hub.install();
    model.subscribe('m');
    await settle();
    expect(held).toBeDefined();
    expect(removed('t1')).toBe(false);
    handle(held!);
    await settle();
    expect(hub.calls.some((c) => c.method === 'terminal.kill')).toBe(false);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't3', before: 't1' }]);
    expect(leaves(hub.layout('m')!)).toEqual([{ terminal: 't3', before: 't1' }]);
    expect(removed('t1')).toBe(true);
  });

  it('starts terminals that ended with the core again when the layout is read, and types the resume command once', async () => {
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    hub.next = 3;
    hub.machine(
      'm',
      [
        FakeHub.term('t1', { state: 'finished', reason: 'stopped_by_restart', cwd: '/srv/app' }),
        FakeHub.term('t2', { state: 'finished', reason: 'exited' }),
      ],
      layoutOf({ terminal: 't1', agent: 'claude', pid: 7 }, { terminal: 't2' }),
    );
    const model = hub.install();
    model.subscribe('m');
    await settle();
    const now = leaves(model.layout('m')!) as L.TerminalLeaf[];
    // t2's program ended: its tab is gone. t1 has a successor in its directory.
    expect(now).toHaveLength(1);
    expect(now[0].terminal).not.toBe('t1');
    expect(now[0].resume).toBe('claude');
    expect(now[0].before).toBe('t1');
    expect(model.terminal('m', now[0].terminal)?.cwd).toBe('/srv/app');
    const typed: string[] = [];
    model.resumeAgent('m', now[0].terminal, into(typed));
    model.resumeAgent('m', now[0].terminal, into(typed));
    // Typed once the terminal core took the layout without the request, not before.
    expect(typed).toEqual([]);
    await settle();
    expect(typed).toEqual(['claude --continue\r']);
  });

  it('preserves workspaces, kept/restarting terminals, agent sessions and open file tabs across offline -> disable -> re-enable -> reboot', async () => {
    vi.useFakeTimers();
    useStore.setState({ readOnly: false });
    const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
    const editorLeaf: L.PluginLeaf = { view: { id: 'e1', plugin: 'files', kind: 'editor', path: '/srv/proj/a.ts' } };
    const previewLeaf: L.PreviewLeaf = { preview: { id: 'p1', path: '/srv/proj/README.md' } };
    const initial: L.Layout = {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: 'proj',
          cwd: '/srv/proj',
          tabs: [
            { root: { terminal: 't1', agent: 'claude', pid: 7, session: S1 }, focused: 't1' },
            { root: editorLeaf, focused: 'view:e1' },
            { root: previewLeaf, focused: 'preview:p1' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    };
    const hub = new FakeHub();
    const fm = hub.machine('m', [FakeHub.term('t1', { pid: 7, agent: 'claude', agent_session: S1, agent_session_source: 'pid' })], initial);
    const model = hub.install();
    model.subscribe('m');
    await vi.advanceTimersByTimeAsync(10);
    expect(model.layout('m')?.workspaces[0].tabs).toHaveLength(3);

    // Shutdown starts killing the agent before SSH drops, starting the forget timer.
    hub.event('m', 'labels', 't1', { record: FakeHub.term('t1', { pid: 7 }) });
    // Remote host powers off and the user manually disables it.
    hub.push({ t: 'backend', m: 'm', state: 'error', code: 'machine_offline', version: '' });
    const setsBefore = hub.calls.filter((c) => c.method === 'doc.set').length;

    // Disabled for much longer than AGENT_FORGET_MS (30s): layout, agent session
    // and open file tabs stay intact and nothing writes to doc.set.
    await vi.advanceTimersByTimeAsync(AGENT_FORGET_MS * 4);
    expect(model.layout('m')?.workspaces[0].tabs).toHaveLength(3);
    expect(leaves(model.layout('m')!)[0]).toMatchObject({ terminal: 't1', agent: 'claude', pid: 7, session: S1 });
    expect(hub.calls.filter((c) => c.method === 'doc.set')).toHaveLength(setsBefore);

    // Host boots back up and is re-enabled: snapshot arrives with kept t1 in
    // restarting ('lost') state; it must NOT be pruned or have its agent wiped.
    expect(keptWhileRestarting(FakeHub.term('t1', { state: 'lost', keep: true }))).toBe(true);
    fm.terminals = [FakeHub.term('t1', { state: 'lost', keep: true })];
    hub.push({ t: 'backend', m: 'm', state: 'ready', code: '', version: '1.0' });
    hub.push({ t: 'snapshot', m: 'm', terminals: fm.terminals });
    await vi.advanceTimersByTimeAsync(10);
    expect(model.layout('m')?.workspaces[0].tabs).toHaveLength(3);
    expect(leaves(model.layout('m')!)[0]).toMatchObject({ terminal: 't1', agent: 'claude', pid: 7, session: S1 });

    // Core finishes restarting kept t1 — even if Linux reused the exact same pid (7)!
    hub.event('m', 'restarted', 't1', FakeHub.term('t1', { pid: 7, keep: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't1', session: S1, resume: 'claude' }, editorLeaf, previewLeaf]);
  });

  it('restores terminals on an empty core (e.g. >24h disable/reboot) in workspace cwd, keeps file tabs, and recovers if doc is null', async () => {
    useStore.setState({ readOnly: false });
    const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
    const editorLeaf: L.PluginLeaf = { view: { id: 'e1', plugin: 'files', kind: 'editor', path: '/srv/proj/a.ts' } };
    const initial: L.Layout = {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: 'proj',
          cwd: '/srv/proj',
          tabs: [
            { root: { terminal: 't1', agent: 'claude', pid: 7, session: S1 }, focused: 't1' },
            { root: editorLeaf, focused: 'view:e1' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    };
    expect(missingOnEmptyCore(initial, [])).toEqual(['t1']);
    expect(missingOnEmptyCore(initial, [FakeHub.term('t1')])).toEqual([]);

    const hub = new FakeHub();
    hub.next = 3;
    const fm = hub.machine('m', [FakeHub.term('t1', { pid: 7, cwd: '/srv/proj' })], initial);
    const model = hub.install();
    model.subscribe('m');
    await settle();

    // Machine goes offline/disabled for >24h; core returns with no terminal records.
    hub.push({ t: 'backend', m: 'm', state: 'error', code: 'machine_offline', version: '' });
    fm.terminals = [];
    hub.push({ t: 'backend', m: 'm', state: 'ready', code: '', version: '1.0' });
    hub.push({ t: 'snapshot', m: 'm', terminals: [] });
    await settle();
    await settle();
    const afterEmpty = leaves(model.layout('m')!);
    expect(afterEmpty).toEqual([{ terminal: 't3', before: 't1', session: S1, resume: 'claude' }, editorLeaf]);
    expect(model.terminal('m', 't3')?.cwd).toBe('/srv/proj');

    // Even if the rebooted core lost its layout document entirely (value: null)
    // along with all records, an open page recovers its loaded workspaces from memory.
    hub.push({ t: 'backend', m: 'm', state: 'error', code: 'machine_offline', version: '' });
    fm.terminals = [];
    fm.layout = null;
    fm.version = 0;
    hub.push({ t: 'backend', m: 'm', state: 'ready', code: '', version: '1.0' });
    hub.push({ t: 'snapshot', m: 'm', terminals: [] });
    await settle();
    await settle();
    const recovered = leaves(model.layout('m')!);
    expect(recovered).toEqual([{ terminal: 't4', before: 't3', session: S1, resume: 'claude' }, editorLeaf]);
    expect(leaves(hub.layout('m')!)).toEqual(recovered);
  });

  it('retries transient doc.get failure on reconnect', async () => {
    vi.useFakeTimers();
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    hub.machine('m', [FakeHub.term('t1', { pid: 7 })], layoutOf({ terminal: 't1' }));
    const handle = hub.handle.bind(hub);
    let failures = 2;
    hub.handle = (msg) => {
      if (msg.t === 'call' && msg.method === 'doc.get' && failures > 0) {
        failures--;
        hub.push({ t: 'res', rid: msg.rid, error: { kind: 'unavailable', message: 'busy' } });
        return;
      }
      handle(msg);
    };
    const model = hub.install();
    model.subscribe('m');
    await vi.advanceTimersByTimeAsync(10);
    expect(model.layout('m')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't1' }]);
  });

  it('does not drop a same-pid restarted event arriving while loadLayout is in flight', async () => {
    useStore.setState({ readOnly: false });
    const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
    const hub = new FakeHub();
    const fm = hub.machine(
      'm',
      [FakeHub.term('t1', { state: 'lost', keep: true })],
      layoutOf({ terminal: 't1', agent: 'claude', pid: 7, session: S1 }),
    );
    const handle = hub.handle.bind(hub);
    let heldGet: Record<string, unknown> | undefined;
    hub.handle = (msg) => {
      if (!heldGet && msg.t === 'call' && msg.method === 'doc.get') {
        heldGet = msg;
        return;
      }
      handle(msg);
    };
    const model = hub.install();
    model.subscribe('m');
    await settle();
    expect(heldGet).toBeDefined();

    // While doc.get is still in flight, kept t1 finishes restarting with the SAME pid (7).
    const restarted = FakeHub.term('t1', { pid: 7, keep: true });
    fm.terminals = [restarted];
    hub.event('m', 'restarted', 't1', restarted);
    await settle();

    // Now doc.get resolves: pending restart is applied so resume is set instead of forgetting the agent.
    handle(heldGet!);
    await settle();
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't1', session: S1, resume: 'claude' }]);
  });

  it('does not prune sibling terminals when loadLayout runs mid-restore on an empty core', async () => {
    useStore.setState({ readOnly: false });
    const hub = new FakeHub();
    hub.next = 3;
    const initial: L.Layout = {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: 'proj',
          cwd: '/srv/proj',
          tabs: [
            { root: { terminal: 't1', agent: 'claude', pid: 7 }, focused: 't1' },
            { root: { terminal: 't2', agent: 'codex', pid: 8 }, focused: 't2' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    };
    const fm = hub.machine('m', [], initial);
    const handle = hub.handle.bind(hub);
    const heldRuns: Array<Record<string, unknown>> = [];
    hub.handle = (msg) => {
      if (msg.t === 'call' && msg.method === 'terminal.run' && heldRuns.length < 2) {
        heldRuns.push(msg);
        return;
      }
      handle(msg);
    };
    const model = hub.install();
    model.subscribe('m');
    await settle();
    // Both t1 and t2 are restoring in parallel on the empty core.
    expect(heldRuns).toHaveLength(2);

    // t1 finishes first (creating t3 so records.length becomes 1), then another client's
    // doc event triggers loadLayout while t2's terminal.run is still in flight.
    handle(heldRuns[0]);
    await settle();
    fm.version++;
    hub.event('m', 'doc', '', { name: 'layout', version: fm.version });
    await settle();
    // t2 must NOT be pruned while its restore is in flight.
    expect(L.layoutTerminals(model.layout('m')!)).toEqual(['t3', 't2']);

    // t2's terminal.run completes -> replaces t2 cleanly as t4.
    handle(heldRuns[1]);
    await settle();
    await settle();
    expect(leaves(model.layout('m')!)).toEqual([
      { terminal: 't3', before: 't1', resume: 'claude' },
      { terminal: 't4', before: 't2', resume: 'codex' },
    ]);
    expect(hub.calls.some((c) => c.method === 'terminal.kill')).toBe(false);
  });
});
