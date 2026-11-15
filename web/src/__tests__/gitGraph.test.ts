// The Git graph's lanes (plugins/git/graph.ts) and rows
// (plugins/git/GraphPane.tsx): straight lines while a lane lives, merges
// and branches as lines into and out of a dot, lanes reused once free,
// parents off the page running out of the last row.

import { describe, expect, it } from 'vitest';
import { layoutGraph, type GraphCommit } from '../plugins/git/graph';
import { badgesOf, graphRows, matches, UNCOMMITTED } from '../plugins/git/GraphPane';
import type { Commit, StatusFile } from '../plugins/git/api';

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });
/** A row's lines as "from>to" strings. */
const lines = (segs: { from: number; to: number }[]) => segs.map((s) => `${s.from}>${s.to}`).sort();

describe('layoutGraph', () => {
  it('draws a linear history in one lane', () => {
    const g = layoutGraph([c('a', 'b'), c('b', 'c'), c('c')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(g.rows.map((r) => [lines(r.up), lines(r.down)])).toEqual([
      [[], ['0>0']],
      [['0>0'], ['0>0']],
      [['0>0'], []],
    ]);
    expect(g.width).toBe(1);
    expect(new Set(g.rows.map((r) => r.color)).size).toBe(1);
  });

  it('opens a lane for a merged branch and closes it at the fork', () => {
    // m merges f into a line from a; f branched off a.
    const g = layoutGraph([c('m', 'a', 'f'), c('f', 'a'), c('a')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(lines(g.rows[0].down)).toEqual(['0>0', '0>1']);
    expect(lines(g.rows[1].up)).toEqual(['0>0', '1>1']);
    expect(lines(g.rows[1].down)).toEqual(['0>0', '1>1']);
    expect(lines(g.rows[2].up)).toEqual(['0>0', '1>0']);
    expect(g.rows[2].down).toEqual([]);
    expect(g.width).toBe(2);
    // The branch has a color of its own.
    expect(g.rows[1].color).not.toBe(g.rows[0].color);
  });

  it('draws an octopus merge into three lanes', () => {
    const g = layoutGraph([c('o', 'a', 'b', 'c'), c('c'), c('b'), c('a')]);
    expect(lines(g.rows[0].down)).toEqual(['0>0', '0>1', '0>2']);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 2, 1, 0]);
    expect(lines(g.rows[1].up)).toEqual(['0>0', '1>1', '2>2']);
    expect(lines(g.rows[1].down)).toEqual(['0>0', '1>1']);
    expect(lines(g.rows[3].up)).toEqual(['0>0']);
    expect(g.width).toBe(3);
  });

  it('gives parallel branches lanes side by side that end in their base', () => {
    const g = layoutGraph([c('t1', 'b'), c('t2', 'b'), c('t3', 'b'), c('t4', 'b'), c('b', 'r'), c('r')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 2, 3, 0, 0]);
    expect(lines(g.rows[3].up)).toEqual(['0>0', '1>1', '2>2']);
    expect(lines(g.rows[4].up)).toEqual(['0>0', '1>0', '2>0', '3>0']);
    expect(lines(g.rows[4].down)).toEqual(['0>0']);
    expect(g.rows[4].width).toBe(4);
    expect(g.rows[5].width).toBe(1);
    expect(new Set(g.rows.slice(0, 4).map((r) => r.color)).size).toBe(4);
  });

  it('reuses a lane once its branch ended', () => {
    // x branches off a and ends there; y starts later and takes lane 1.
    const g = layoutGraph([c('a2', 'a1'), c('x', 'a1'), c('a1', 'a0'), c('y', 'a0'), c('a0')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(g.width).toBe(2);
  });

  it('runs lanes of parents off the page out of the last row', () => {
    const g = layoutGraph([c('m', 'p1', 'p2'), c('q', 'p3')]);
    expect(lines(g.rows[0].down)).toEqual(['0>0', '0>1']);
    expect(g.rows[1].lane).toBe(2);
    expect(lines(g.rows[1].down)).toEqual(['0>0', '1>1', '2>2']);
  });

  it('joins a merge parent another lane waits for', () => {
    // m2 merges a commit (b) that the lane of f already waits for.
    const g = layoutGraph([c('f', 'b'), c('m2', 'a', 'b'), c('b', 'a'), c('a')]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // The join goes into lane 0, which keeps its straight line.
    expect(lines(g.rows[1].down)).toEqual(['0>0', '1>0', '1>1']);
    expect(g.rows[1].down.find((s) => s.from === 1 && s.to === 0)!.color).toBe(g.rows[0].color);
  });

  it('cycles colors through the palette', () => {
    const tips = Array.from({ length: 10 }, (_, i) => c(`t${i}`, 'base'));
    const g = layoutGraph([...tips, c('base')], 4);
    expect(g.rows.slice(0, 10).map((r) => r.color)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
  });
});

const commit = (hash: string, date: number, ...parents: string[]): Commit => ({
  hash,
  parents,
  date,
  author: 'Ann',
  email: 'ann@x',
  subject: `subject ${hash}`,
});

describe('graph rows', () => {
  it('puts the working tree on HEAD and stashes by date above their base', () => {
    const commits = [commit('c3', 30, 'c2'), commit('c2', 20, 'c1'), commit('c1', 10)];
    const stashes = [
      { index: 0, hash: 's0', base: 'c2', date: 35, message: 'newest' },
      { index: 1, hash: 's1', base: 'c1', date: 15, message: 'between' },
      { index: 2, hash: 's2', base: 'gone', date: 1, message: 'base not shown' },
    ];
    const files: StatusFile[] = [{ path: 'a', x: '.', y: 'M', kind: 'changed' }];
    const rows = graphRows(commits, stashes, 'c3', files);
    expect(rows.map((r) => r.hash)).toEqual([UNCOMMITTED, 's0', 'c3', 'c2', 's1', 'c1']);
    expect(rows[0].parents).toEqual(['c3']);
    expect(rows.find((r) => r.hash === 's0')!.parents).toEqual(['c2']);
    // Without changes no working-tree row; ignored files do not count.
    expect(graphRows(commits, [], 'c3', [{ path: 'x', x: '!', y: '!', kind: 'ignored' }])[0].hash).toBe('c3');
  });

  it('lays the rows out with the stash as a branch of its base', () => {
    const rows = graphRows(
      [commit('c2', 20, 'c1'), commit('c1', 10)],
      [{ index: 0, hash: 's', base: 'c1', date: 30, message: 'm' }],
      'c2',
      [],
    );
    const g = layoutGraph(rows);
    expect(rows.map((r) => r.hash)).toEqual(['s', 'c2', 'c1']);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
  });

  it('collects badges per commit, the current branch first', () => {
    const refs = [
      { name: 'refs/tags/v1', hash: 'a' },
      { name: 'refs/remotes/origin/main', hash: 'a' },
      { name: 'refs/heads/dev', hash: 'a' },
      { name: 'refs/heads/main', hash: 'a' },
      { name: 'refs/heads/old', hash: 'b' },
    ];
    const b = badgesOf(refs, 'main', 'a', true);
    expect(b.get('a')!.map((x) => `${x.kind}:${x.name}${x.current ? '*' : ''}`)).toEqual([
      'branch:main*',
      'branch:dev',
      'remote:origin/main',
      'tag:v1',
    ]);
    expect(
      badgesOf(refs, 'main', 'a', false)
        .get('a')!
        .some((x) => x.kind === 'remote'),
    ).toBe(false);
    // Detached: a HEAD badge.
    expect(
      badgesOf(refs, undefined, 'b', true)
        .get('b')!
        .map((x) => x.kind),
    ).toEqual(['head', 'branch']);
  });

  it('finds commits by subject, author, e-mail and hash', () => {
    const [r] = graphRows([commit('abc123', 1)], [], undefined, []);
    expect(matches(r, 'SUBJECT')).toBe(true);
    expect(matches(r, 'ann@')).toBe(true);
    expect(matches(r, 'abc')).toBe(true);
    expect(matches(r, 'zzz')).toBe(false);
    expect(matches(r, '123')).toBe(true);
    expect(matches(r, '')).toBe(true);
  });
});
