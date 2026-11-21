// The terminals shown last stay mounted while others are shown.
import { beforeEach, describe, expect, it } from 'vitest';
import { keepPanes as keep, resetKeptPanes, type KeptPane } from '../keptPanes';

const KEEP_HIDDEN = 6;
const keepPanes = (shown: KeptPane[], open: (k: KeptPane) => boolean, limit = KEEP_HIDDEN) => keep(shown, limit, open);

const rect = { x: 0, y: 0, w: 1, h: 1 };
const p = (pane: string, m = 'm'): KeptPane => ({ m, pane, rect });
const names = (list: KeptPane[]) => list.map((k) => `${k.m}:${k.pane}`);
const all = () => true;

describe('kept panes', () => {
  beforeEach(resetKeptPanes);

  it('keeps the terminals shown before, the latest first, not the ones shown', () => {
    expect(keepPanes([p('a')], all)).toEqual([]);
    expect(names(keepPanes([p('b'), p('c')], all))).toEqual(['m:a']);
    expect(names(keepPanes([p('a')], all))).toEqual(['m:b', 'm:c']);
    // The same address on another machine is another terminal.
    expect(names(keepPanes([p('a', 'n')], all))).toEqual(['m:a', 'm:b', 'm:c']);
  });

  it('drops a terminal that closed and those shown longest ago', () => {
    keepPanes([p('a')], all);
    keepPanes([p('b')], all);
    expect(names(keepPanes([p('c')], (k) => k.pane !== 'a'))).toEqual(['m:b']);
    for (let i = 0; i < KEEP_HIDDEN + 3; i++) keepPanes([p(`t${i}`)], all);
    const kept = keepPanes([p('z')], all);
    expect(kept).toHaveLength(KEEP_HIDDEN);
    expect(kept[0].pane).toBe(`t${KEEP_HIDDEN + 2}`);
    // The setting: fewer are kept at once, and none with 0.
    expect(keepPanes([p('y')], all, 2)).toHaveLength(2);
    expect(keepPanes([p('x')], all, 0)).toEqual([]);
  });
});
