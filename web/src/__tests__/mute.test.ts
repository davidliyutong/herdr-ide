// Muted tabs and workspaces (term/layout.ts): kept in the layout document,
// and a pane is muted by its tab or its workspace.
import { describe, expect, it } from 'vitest';
import * as L from '../term/layout';

const layout = L.parseLayout({
  version: 2,
  selected: 0,
  workspaces: [
    {
      id: 'w1',
      name: '',
      cwd: '',
      selected: 0,
      tabs: [
        { root: { terminal: 't1' }, focused: 't1' },
        { root: { terminal: 't2' }, focused: 't2' },
      ],
    },
    { id: 'w2', name: '', cwd: '', selected: 0, tabs: [{ root: { terminal: 't3' }, focused: 't3' }] },
  ],
});

describe('muting', () => {
  it('mutes a tab and lets it sound again', () => {
    const muted = L.muteTab(layout, 'w1', 1, true);
    expect(L.paneMuted(muted, 't2')).toBe(true);
    expect(L.paneMuted(muted, 't1')).toBe(false);
    expect(L.parseLayout(JSON.parse(JSON.stringify(muted))).workspaces[0].tabs[1].muted).toBe(true);
    const again = L.muteTab(muted, 'w1', 1, false);
    expect(L.paneMuted(again, 't2')).toBe(false);
    expect('muted' in again.workspaces[0].tabs[1]).toBe(false);
    expect(L.muteTab(again, 'w1', 1, false)).toBe(again);
  });

  it('mutes every tab of a workspace', () => {
    const muted = L.muteWorkspace(layout, 'w1', true);
    expect(L.paneMuted(muted, 't1') && L.paneMuted(muted, 't2')).toBe(true);
    expect(L.paneMuted(muted, 't3')).toBe(false);
    expect(L.parseLayout(JSON.parse(JSON.stringify(muted))).workspaces[0].muted).toBe(true);
    expect(L.paneMuted(L.muteWorkspace(muted, 'w1', false), 't1')).toBe(false);
  });

  it('keeps only true', () => {
    const raw = { version: 2, selected: 0, workspaces: [{ id: 'w', name: '', cwd: '', selected: 0, muted: 'yes', tabs: [] }] };
    expect(L.parseLayout(raw).workspaces[0].muted).toBeUndefined();
  });
});
