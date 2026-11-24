// Moving tabs from a previous name's layout (plugins/migrate/plan.ts).
import { describe, expect, it } from 'vitest';
import * as L from '../term/layout';
import { movedTerminal, placeTabs, takeTabs, type OldTerminal } from '../plugins/migrate/plan';

const SESSION = '0b5c1a7e-2f3d-4c6b-9a8e-1d2c3b4a5f6e';
const OLD_SESSION = '11111111-2222-4333-8444-555555555555';

const tab = (root: L.Node, focused: string, extra: Record<string, unknown> = {}): L.Tab => ({ root, focused, ...extra });
const split = (a: L.Node, b: L.Node): L.Split => ({ split: 'horizontal', ratio: 0.5, children: [a, b] });

function previous(): L.Layout {
  return {
    version: 2,
    selected: 0,
    workspaces: [
      {
        id: 'w1',
        name: 'api',
        cwd: '/srv/api',
        selected: 0,
        tabs: [
          tab(
            split({ terminal: 't1', agent: 'claude', pid: 10, session: OLD_SESSION }, { code: { id: 'c1', folder: '/srv/api' } }),
            'code:c1',
            { name: 'work' },
          ),
          tab({ terminal: 't2' }, 't2'),
        ],
      },
      { id: 'w2', name: '', cwd: '', selected: 0, tabs: [tab({ terminal: 't3' }, 't3')] },
    ],
  };
}

describe('takeTabs', () => {
  it('takes picked tabs out, and a workspace whose every tab moves', () => {
    const t = takeTabs(previous(), [
      { workspace: 'w1', tab: 0 },
      { workspace: 'w2', tab: 0 },
      { workspace: 'w2', tab: 7 },
    ]);
    expect(t.rest.workspaces.map((w) => w.id)).toEqual(['w1']);
    expect(t.rest.workspaces[0].tabs.map((x) => L.tabTerminals(x))).toEqual([['t2']]);
    expect(t.groups.map((g) => [g.name, g.tabs.length])).toEqual([
      ['api', 1],
      ['', 1],
    ]);
    expect(t.terminals).toEqual(['t1', 't3']);
  });
});

describe('movedTerminal', () => {
  it('asks for the agent the machine found, in its session', () => {
    const info: OldTerminal = { address: 't1', agent: 'claude', session: SESSION };
    const leaf = movedTerminal({ terminal: 't1', agent: 'claude', pid: 10, session: OLD_SESSION, before: 't0' }, 'n1', info);
    expect(leaf).toEqual({ terminal: 'n1', resume: 'claude', session: SESSION });
  });
  it('without the machine finding one, the agent its leaf remembered', () => {
    expect(movedTerminal({ terminal: 't1', agent: 'codex', pid: 3, session: OLD_SESSION }, 'n1')).toEqual({
      terminal: 'n1',
      resume: 'codex',
      session: OLD_SESSION,
    });
  });
  it('a shell asks for nothing; an agent found without a session continues the latest', () => {
    expect(movedTerminal({ terminal: 't1' }, 'n1', { address: 't1', program: 'vim' })).toEqual({ terminal: 'n1' });
    expect(movedTerminal({ terminal: 't1', session: OLD_SESSION }, 'n1', { address: 't1', agent: 'claude' })).toEqual({
      terminal: 'n1',
      resume: 'claude',
    });
  });
});

describe('placeTabs', () => {
  let n = 0;
  const newId = () => `id${++n}`;
  it('puts the tabs in the workspace of their name and directory, else a new one, with new ids and focus', () => {
    n = 0;
    const t = takeTabs(previous(), [
      { workspace: 'w1', tab: 0 },
      { workspace: 'w2', tab: 0 },
    ]);
    const mine: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [{ id: 'm1', name: 'api', cwd: '/srv/api', selected: 0, tabs: [tab({ terminal: 'x1' }, 'x1')] }],
    };
    const started = new Map([
      ['t1', 'n1'],
      ['t3', 'n3'],
    ]);
    const info = new Map<string, OldTerminal>([['t1', { address: 't1', agent: 'claude', session: SESSION }]]);
    const out = placeTabs(mine, t.groups, started, info, newId);
    expect(out.workspaces.map((w) => [w.id, w.name, w.tabs.length])).toEqual([
      ['m1', 'api', 2],
      ['id2', '', 1],
    ]);
    const moved = out.workspaces[0].tabs[1];
    expect(moved.name).toBe('work');
    expect(L.leavesOf(moved.root)).toEqual([
      { terminal: 'n1', resume: 'claude', session: SESSION },
      { code: { id: 'id1', folder: '/srv/api' } },
    ]);
    expect(moved.focused).toBe('code:id1');
    expect(out.workspaces[0].selected).toBe(1);
    expect(out.selected).toBe(1);
  });
  it('drops a terminal that got no new one; a tab left without panes goes', () => {
    n = 0;
    const t = takeTabs(previous(), [
      { workspace: 'w1', tab: 0 },
      { workspace: 'w1', tab: 1 },
    ]);
    const out = placeTabs(L.emptyLayout, t.groups, new Map(), new Map(), newId);
    expect(out.workspaces).toHaveLength(1);
    expect(out.workspaces[0].tabs).toHaveLength(1);
    expect(L.leavesOf(out.workspaces[0].tabs[0].root)).toEqual([{ code: { id: 'id1', folder: '/srv/api' } }]);
    expect(out.workspaces[0].tabs[0].focused).toBe('code:id1');
  });
});
