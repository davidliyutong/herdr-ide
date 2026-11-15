// The lanes of the Git graph (GraphPane.tsx): for commits in the order the
// graph shows them (children before their parents, git log --date-order),
// the lane of each commit's dot and the lines that cross its row.
//
// A lane waits for one commit: the parent of the commit drawn last in it.
// A commit takes the first lane waiting for it (else the first free lane,
// else a new one, as a branch's tip does); other lanes waiting for it end
// in its dot (they were branches off it). Its first parent continues its
// lane; each other parent joins the lane already waiting for it or opens
// a new one (a merged branch). Lanes keep their place while they live, so
// a line is straight until it ends; a lane that ended is free again.
// A parent that is not among the commits (a later page, a shallow clone)
// keeps its lane running out of the last row.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A line inside a row: from lane `from` at one edge to lane `to` at the
 * other. Lines of `up` run from the row's top to its middle, lines of
 * `down` from its middle to its bottom. */
export interface Segment {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** The lane of the commit's dot. */
  lane: number;
  color: number;
  up: Segment[];
  down: Segment[];
  /** The lanes the row draws (the highest lane in it, plus one). */
  width: number;
}

export interface Graph {
  rows: GraphRow[];
  /** The widest row's width. */
  width: number;
}

/** Lays out the lanes of commits (see the file's comment). colors is the
 * size of the palette lanes' colors cycle through. */
export function layoutGraph(commits: GraphCommit[], colors = 8): Graph {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  let maxWidth = 0;
  const rows: GraphRow[] = [];

  const freeLane = (not = -1) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== not) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  const open = (i: number, hash: string) => {
    lanes[i] = hash;
    laneColor[i] = nextColor++ % colors;
  };

  for (const c of commits) {
    const up: Segment[] = [];
    const down: Segment[] = [];
    let lane = lanes.indexOf(c.hash);
    // Lines from above: lanes waiting for this commit end in its dot,
    // the others pass.
    const waiting: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) waiting.push(i);
    });
    if (lane < 0) {
      lane = freeLane();
      laneColor[lane] = nextColor++ % colors;
    }
    for (let i = 0; i < lanes.length; i++) {
      const h = lanes[i];
      if (h === null) continue;
      up.push({ from: i, to: h === c.hash ? lane : i, color: laneColor[i] });
    }
    const color = laneColor[lane];
    for (const i of waiting) if (i !== lane) lanes[i] = null;
    // Below: the first parent continues the lane, the others join or
    // open lanes.
    const [first, ...others] = c.parents;
    lanes[lane] = first ?? null;
    const joins: Segment[] = [];
    const opened = new Set<number>();
    for (const p of others) {
      let k = lanes.indexOf(p);
      if (k < 0) {
        k = freeLane(lane);
        open(k, p);
        opened.add(k);
      }
      joins.push({ from: lane, to: k, color: laneColor[k] });
    }
    // Lanes that go on run straight down; a lane opened for a merged
    // parent starts at the dot instead (its join).
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && !opened.has(i)) down.push({ from: i, to: i, color: laneColor[i] });
    }
    down.push(...joins);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    let width = lane + 1;
    for (const s of up) width = Math.max(width, s.from + 1, s.to + 1);
    for (const s of down) width = Math.max(width, s.from + 1, s.to + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ lane, color, up, down, width });
  }
  return { rows, width: maxWidth };
}
