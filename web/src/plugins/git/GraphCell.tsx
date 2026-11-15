// One row of the Git graph's lanes (graph.ts) as SVG: the lines from the
// row's top to its middle and from its middle to its bottom, and the
// commit's dot.

import type { GraphRow } from './graph';

/** The lanes' colors (CSS variables of git.css). */
export const LANE_COLORS = 8;
export const laneColor = (i: number) => `var(--git-lane-${i % LANE_COLORS})`;

/** The SVG path of a line from lane a at y0 to lane b at y1. */
function line(a: number, b: number, y0: number, y1: number, lane: number): string {
  const x0 = a * lane + lane / 2;
  const x1 = b * lane + lane / 2;
  if (a === b) return `M${x0} ${y0}V${y1}`;
  const mid = (y0 + y1) / 2;
  return `M${x0} ${y0}C${x0} ${mid} ${x1} ${mid} ${x1} ${y1}`;
}

export function GraphCell({
  row,
  width,
  height,
  lane,
  kind,
  through,
}: {
  row?: GraphRow;
  width: number;
  height: number;
  /** A lane's width in pixels. */
  lane: number;
  /** The dot: a commit, the working tree's changes (hollow) or a stash
   * (square). */
  kind?: 'commit' | 'uncommitted' | 'stash' | 'head';
  /** Only the lanes going on below this row (a commit's details under
   * it). */
  through?: boolean;
}) {
  const w = Math.max(1, width) * lane;
  if (!row) return <svg className="git-graph-cell" width={w} height={height} aria-hidden />;
  const mid = height / 2;
  const x = row.lane * lane + lane / 2;
  if (through) {
    return (
      <svg className="git-graph-cell" width={w} height={height} aria-hidden>
        {row.down.map((s, i) => (
          <path key={i} d={line(s.to, s.to, 0, height, lane)} stroke={laneColor(s.color)} />
        ))}
      </svg>
    );
  }
  return (
    <svg className="git-graph-cell" width={w} height={height} aria-hidden>
      {row.up.map((s, i) => (
        <path key={'u' + i} d={line(s.from, s.to, 0, mid, lane)} stroke={laneColor(s.color)} />
      ))}
      {row.down.map((s, i) => (
        <path key={'d' + i} d={line(s.from, s.to, mid, height, lane)} stroke={laneColor(s.color)} />
      ))}
      {kind === 'stash' ? (
        <rect x={x - 3.5} y={mid - 3.5} width={7} height={7} fill="var(--bg)" stroke={laneColor(row.color)} />
      ) : (
        <circle
          cx={x}
          cy={mid}
          r={kind === 'head' ? 4.5 : 3.5}
          fill={kind === 'uncommitted' || kind === 'head' ? 'var(--bg)' : laneColor(row.color)}
          stroke={laneColor(row.color)}
          strokeWidth={kind === 'head' ? 2 : 1.5}
          strokeDasharray={kind === 'uncommitted' ? '2 1.5' : undefined}
        />
      )}
    </svg>
  );
}
