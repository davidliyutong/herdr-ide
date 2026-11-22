// A coding agent's terminal leaf: render, session and before checked when a
// document is read (the vector design/testdata/layout/agent-leaves.json
// runs with the others in term.test.ts), changed by setTerminalFields, and
// kept by every other operation, also by the rules that restore terminals
// after their core started again, as an older client keeps them.
import { describe, expect, it } from 'vitest';
import * as L from '../term/layout';
import { rememberAgents, replaceTerminal, takeResume } from '../restore';
import { FakeCore } from './fakeTerms';
import vector from '../../../design/testdata/layout/agent-leaves.json';

const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
const S2 = '1b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
const agent = { render: 'native' as const, session: S1, before: 't0' };

const layoutOf = (...tabs: L.Node[]): L.Layout =>
  L.parseLayout({
    version: 2,
    workspaces: [{ id: 'w', name: '', cwd: '', tabs: tabs.map((root) => ({ root, focused: '' })), selected: 0 }],
    selected: 0,
  });
const leaves = (l: L.Layout) => l.workspaces.flatMap((w) => w.tabs.flatMap((t) => L.leavesOf(t.root)));
const leaf = (l: L.Layout, key: string) => L.findLeaf(l, key) as L.TerminalLeaf;

describe('agent leaves', () => {
  it('read only the values a document may hold', () => {
    const l = L.parseLayout(vector.input);
    expect(leaf(l, 't1')).toEqual({ terminal: 't1', ...agent, agent: 'claude', pid: 42 });
    // Of another type or shape: left out, the other fields kept.
    expect(leaf(l, 't2')).toEqual({ terminal: 't2', font: 12 });
    expect(leaf(l, 't3')).toEqual({ terminal: 't3' });
    for (const [field, value] of [
      ['render', 'Native'],
      ['render', 'cli'],
      ['render', 1],
      ['session', `${S1} `],
      ['session', S1.toUpperCase()],
      ['session', `${S1};id`],
      ['session', '$(id)'],
      ['session', 'x\ny'],
      ['before', ''],
      ['before', 'a/b'],
      ['before', 'x'.repeat(65)],
      ['before', 'a b'],
      ['before', null],
      // What could be read as a path or an option is no address.
      ['before', '.'],
      ['before', '..'],
      ['before', '-rf'],
      ['before', '_t1'],
      ['before', 't1.old'],
      ['before', 't1\n'],
    ] as const) {
      expect(leaf(layoutOf({ terminal: 't1', [field]: value }), 't1'), `${field} ${String(value)}`).toEqual({ terminal: 't1' });
    }
    // Every form of a core's address: letters and digits, then "_" and "-" too.
    for (const before of ['t1', 't3q', 'T12', '7', 't1-old_2', 'Ab-c_9'.padEnd(64, 'x')])
      expect(leaf(layoutOf({ terminal: 't1', before }), 't1').before, before).toBe(before);
    expect(L.isAddress('t3q')).toBe(true);
    expect(L.isAddress('x'.repeat(65))).toBe(false);
    expect(L.isAddress(1)).toBe(false);
    expect(L.isSessionId(S1)).toBe(true);
    expect(L.isSessionId(undefined)).toBe(false);
  });

  it('change by setTerminalFields, and only there', () => {
    const l = layoutOf({ terminal: 't1', agent: 'claude', pid: 7 }, { code: { id: 'c1', folder: '' } });
    const native = L.setTerminalFields(l, 't1', { render: 'native', session: S1 });
    expect(leaf(native, 't1')).toEqual({ terminal: 't1', agent: 'claude', pid: 7, render: 'native', session: S1 });
    expect(l.workspaces[0].tabs[0].root).toEqual({ terminal: 't1', agent: 'claude', pid: 7 });
    // Nothing changes: the same layout.
    expect(L.setTerminalFields(native, 't1', { render: 'native' })).toBe(native);
    expect(L.setTerminalFields(native, 't9', { render: 'native' })).toBe(native);
    expect(L.setTerminalFields(native, 'code:c1', { render: 'native' })).toBe(native);
    // Back to the terminal; a value the document could not hold removes
    // the field; the address stays.
    const cli = L.setTerminalFields(native, 't1', { render: undefined, session: 'x; rm -rf ~', terminal: 't2' });
    expect(leaf(cli, 't1')).toEqual({ terminal: 't1', agent: 'claude', pid: 7 });
  });

  it('change only render, session and before', () => {
    const l = layoutOf({ terminal: 't1', agent: 'claude', pid: 7, resume: 'claude' });
    // The fields restore.ts keeps, and any other, are not changed here.
    expect(L.setTerminalFields(l, 't1', { agent: 'codex', pid: 1, resume: undefined, note: 'x', terminal: 't2' })).toBe(l);
    const both = L.setTerminalFields(l, 't1', { session: S1, agent: null, note: 1 });
    expect(leaf(both, 't1')).toEqual({ terminal: 't1', agent: 'claude', pid: 7, resume: 'claude', session: S1 });
    expect(L.setTerminalFields(both, 't1', { before: 't3q' }).workspaces[0].tabs[0].root).toMatchObject({ before: 't3q' });
    expect(L.setTerminalFields(both, 't1', { before: '..' })).toBe(both);
  });

  it('write nothing through a prototype', () => {
    const l = layoutOf({ terminal: 't1' });
    // As a patch read from JSON has them: own keys named __proto__ and the like.
    const patch = JSON.parse(
      '{"__proto__": {"render": "native", "polluted": true}, "constructor": {"prototype": {"polluted": true}}, "prototype": {"render": "native"}}',
    );
    expect(L.setTerminalFields(l, 't1', patch)).toBe(l);
    const native = L.setTerminalFields(l, 't1', { ...patch, render: 'native' });
    const t1 = leaf(native, 't1');
    expect(t1).toEqual({ terminal: 't1', render: 'native' });
    expect(Object.getPrototypeOf(t1)).toBe(Object.prototype);
    expect(Object.keys(t1)).toEqual(['terminal', 'render']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).render).toBeUndefined();
  });

  it('change each leaf of an address from its own fields in a malformed document', () => {
    // Two leaves of one address, as no client writes but a document may hold.
    const l = layoutOf({
      split: 'horizontal',
      ratio: 0.5,
      children: [
        { terminal: 't1', render: 'native', agent: 'claude' },
        { terminal: 't1', before: 't0', font: 12 },
      ],
    });
    expect(leaves(l)).toHaveLength(2);
    const next = L.setTerminalFields(l, 't1', { session: S1 });
    expect(leaves(next)).toEqual([
      { terminal: 't1', render: 'native', agent: 'claude', session: S1 },
      { terminal: 't1', before: 't0', font: 12, session: S1 },
    ]);
    // A field removed where it is, nothing added where it was not.
    expect(leaves(L.setTerminalFields(next, 't1', { render: null }))).toEqual([
      { terminal: 't1', agent: 'claude', session: S1 },
      { terminal: 't1', before: 't0', font: 12, session: S1 },
    ]);
  });

  it('are kept by the other operations, as an older client keeps fields it does not know', () => {
    let l = layoutOf({ split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1', ...agent }, { terminal: 't2' }] });
    l = L.renameTab(l, 'w', 0, 'agents');
    l = L.setRatio(l, [], 0.3);
    l = L.pinTab(l, 'w', 0, true);
    l = L.splitPane(l, 't2', 'vertical', { terminal: 't3' });
    l = L.closePane(l, 't2');
    l = L.focusPane(l, 't1');
    l = L.mapTerminals(l, (x) => (x.terminal === 't3' ? { ...x, label: 'x' } : x));
    expect(leaf(l, 't1')).toEqual({ terminal: 't1', ...agent });
    // Moved to a tab of its own and back beside another pane.
    l = L.moveToNewTab(l, 't1', 'w');
    l = L.movePane(l, 't1', 't3', 'horizontal', true);
    expect(leaf(l, 't1')).toEqual({ terminal: 't1', ...agent });
    // A document written and read again.
    expect(leaf(L.parseLayout(JSON.parse(JSON.stringify(l))), 't1')).toEqual({ terminal: 't1', ...agent });
  });

  it('are kept when a terminal that ended with its core is replaced and its agent remembered', () => {
    const l = layoutOf({ terminal: 't1', ...agent, agent: 'claude', pid: 7 });
    const replaced = replaceTerminal(l, 't1', 't5');
    // It says which terminal it took the place of.
    expect(leaves(replaced)).toEqual([{ terminal: 't5', ...agent, before: 't1', resume: 'claude' }]);
    const taken = takeResume(replaced, 't5')!;
    expect(leaves(taken.layout)).toEqual([{ terminal: 't5', ...agent, before: 't1' }]);
    const remembered = rememberAgents(
      taken.layout,
      () => FakeCore.term('t5', { pid: 9, agent: 'claude' }),
      () => false,
    );
    expect(leaves(remembered)).toEqual([{ terminal: 't5', ...agent, before: 't1', agent: 'claude', pid: 9 }]);
    const other = L.setTerminalFields(remembered, 't5', { session: S2 });
    expect(leaf(other, 't5').session).toBe(S2);
  });
});
