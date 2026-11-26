// A machine's workspaces after its terminal core started again: terminals
// that ended with the core are started again in their place, and a
// terminal that lost its agent asks for it back, once.
import { describe, expect, it } from 'vitest';
import * as L from '../term/layout';
import { endedWithCore, rememberAgents, replaceTerminal, takeResume } from '../restore';
import { FakeHub, settle } from './fakeTerms';
import { useStore } from '../state/store';

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
});
