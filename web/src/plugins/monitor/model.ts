// Pure formatting, tree-building, sorting and filtering helpers for the
// System Monitor & Task Manager plugin.
import { match, type MatchRange } from '../../lib/match';
import type { GPUMetric, ProcessInfo, Sensors, TempSensor } from './api';

export type SortKey = 'cpu' | 'mem' | 'pid' | 'name';
export type SortDir = 'asc' | 'desc';
export type MetricLevel = 'ok' | 'warn' | 'hot';

/** Severity level of a percentage gauge (CPU, memory, VRAM, disk). */
export function metricLevel(pct: number): MetricLevel {
  if (pct >= 92) return 'hot';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/** Formats bytes using binary IEC units (B, KiB, MiB, GiB, TiB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

/** Formats a throughput rate in bytes/sec (e.g. 12.4 MB/s). */
export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '0 B/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let v = bytesPerSec / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** Formats uptime seconds as compact human text (e.g. 3d 12h, 4h 18m, 12m). */
export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0m';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${Math.max(1, mins)}m`;
}

/** Formats a percentage with one decimal below 10% and whole numbers above. */
export function formatPct(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Highest utilization or VRAM percentage across all GPUs (for status bar). */
export function peakGpuPct(gpus: readonly GPUMetric[] | undefined): number | undefined {
  if (!gpus?.length) return undefined;
  let max: number | undefined;
  for (const g of gpus) {
    const v = g.utilPct ?? g.memPct;
    if (v !== undefined && (max === undefined || v > max)) max = v;
  }
  return max;
}

/**
 * Severity of a temperature: hot at or above the hardware's high or critical
 * threshold, warn within 10 °C of its high one (15 °C of a critical one when
 * it has no high one). Without thresholds: warn from 80 °C, hot from 90 °C.
 */
export function tempLevel(t: TempSensor): MetricLevel {
  const { tempC, highC, critC } = t;
  if ((critC !== undefined && tempC >= critC) || (highC !== undefined && tempC >= highC)) return 'hot';
  if (highC !== undefined) return tempC >= highC - 10 ? 'warn' : 'ok';
  if (critC !== undefined) return tempC >= critC - 15 ? 'warn' : 'ok';
  if (tempC >= 90) return 'hot';
  if (tempC >= 80) return 'warn';
  return 'ok';
}

/** Rounded degrees Celsius. */
export function formatTemp(c: number): string {
  return `${Math.round(c)}°C`;
}

/** The hottest temperature of a sample, if it has any. */
export function hottestTemp(sensors: Sensors | undefined): TempSensor | undefined {
  let max: TempSensor | undefined;
  for (const t of sensors?.temps ?? []) if (!max || t.tempC > max.tempC) max = t;
  return max;
}

/** Sensors grouped by chip, in the order the machine sent them (sorted by chip). */
export function groupByChip<T extends { chip: string }>(items: readonly T[] | undefined): { chip: string; items: T[] }[] {
  const out: { chip: string; items: T[] }[] = [];
  for (const it of items ?? []) {
    const last = out[out.length - 1];
    if (last && last.chip === it.chip) last.items.push(it);
    else out.push({ chip: it.chip, items: [it] });
  }
  return out;
}

export interface ProcessTreeNode {
  proc: ProcessInfo;
  children: ProcessTreeNode[];
  subtreeCpu: number;
  subtreeRss: number;
  descendantCount: number;
}

export interface DisplayProcessRow {
  proc: ProcessInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  descendantCount: number;
  subtreeCpu: number;
  subtreeRss: number;
  /** True when shown in tree mode only to give context to a matching descendant. */
  ancestorOnly: boolean;
  /** Matched character ranges on proc.name (for Highlight). */
  nameRanges: readonly MatchRange[];
}

function compareValues(a: number | string, b: number | string, dir: SortDir): number {
  const cmp = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : (a as number) - (b as number);
  return dir === 'asc' ? cmp : -cmp;
}

function compareProc(a: ProcessInfo, b: ProcessInfo, key: SortKey, dir: SortDir): number {
  let c = 0;
  switch (key) {
    case 'cpu':
      c = compareValues(a.cpuPct, b.cpuPct, dir);
      break;
    case 'mem':
      c = compareValues(a.rssBytes, b.rssBytes, dir);
      break;
    case 'pid':
      c = compareValues(a.pid, b.pid, dir);
      break;
    case 'name':
      c = compareValues(a.name.toLowerCase(), b.name.toLowerCase(), dir);
      break;
  }
  return c !== 0 ? c : a.pid - b.pid;
}

function compareNode(a: ProcessTreeNode, b: ProcessTreeNode, key: SortKey, dir: SortDir): number {
  let c = 0;
  switch (key) {
    case 'cpu':
      c = compareValues(a.subtreeCpu, b.subtreeCpu, dir);
      break;
    case 'mem':
      c = compareValues(a.subtreeRss, b.subtreeRss, dir);
      break;
    case 'pid':
      c = compareValues(a.proc.pid, b.proc.pid, dir);
      break;
    case 'name':
      c = compareValues(a.proc.name.toLowerCase(), b.proc.name.toLowerCase(), dir);
      break;
  }
  return c !== 0 ? c : a.proc.pid - b.proc.pid;
}

/** Builds a cycle-safe parent→child process forest sorted by subtree usage. */
export function buildProcessTree(processes: readonly ProcessInfo[], sortKey: SortKey, sortDir: SortDir): ProcessTreeNode[] {
  const nodes = new Map<number, ProcessTreeNode>();
  for (const proc of processes) {
    nodes.set(proc.pid, {
      proc,
      children: [],
      subtreeCpu: proc.cpuPct,
      subtreeRss: proc.rssBytes,
      descendantCount: 0,
    });
  }

  // Link children to parents while preventing cycles (defensive against PID reuse).
  const isAncestor = (candidate: number, target: number): boolean => {
    let cur = candidate;
    let steps = 0;
    while (steps++ < 256) {
      if (cur === target) return true;
      const n = nodes.get(cur);
      if (!n || n.proc.ppid === cur || !nodes.has(n.proc.ppid)) return false;
      cur = n.proc.ppid;
    }
    return false;
  };

  const roots: ProcessTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.proc.ppid !== node.proc.pid ? nodes.get(node.proc.ppid) : undefined;
    if (parent && !isAncestor(parent.proc.pid, node.proc.pid)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Aggregate subtree totals bottom-up and sort sibling lists.
  const rollup = (node: ProcessTreeNode) => {
    let cpu = node.proc.cpuPct;
    let rss = node.proc.rssBytes;
    let count = 0;
    for (const ch of node.children) {
      rollup(ch);
      cpu += ch.subtreeCpu;
      rss += ch.subtreeRss;
      count += 1 + ch.descendantCount;
    }
    node.subtreeCpu = Math.round(cpu * 10) / 10;
    node.subtreeRss = rss;
    node.descendantCount = count;
    node.children.sort((a, b) => compareNode(a, b, sortKey, sortDir));
  };

  for (const r of roots) rollup(r);
  roots.sort((a, b) => compareNode(a, b, sortKey, sortDir));
  return roots;
}

/** Matches a query against a process's name, PID, user, or command line. */
export function matchProcess(proc: ProcessInfo, query: string): { matched: boolean; nameRanges: readonly MatchRange[] } {
  const q = query.trim();
  if (!q) return { matched: true, nameRanges: [] };

  const nameHit = match(q, proc.name);
  if (nameHit) return { matched: true, nameRanges: nameHit.ranges };
  if (String(proc.pid).includes(q)) return { matched: true, nameRanges: [] };
  if (match(q, proc.user)) return { matched: true, nameRanges: [] };
  if (match(q, proc.command)) return { matched: true, nameRanges: [] };
  return { matched: false, nameRanges: [] };
}

/** Flattens a process tree for windowed rendering. When query is non-empty,
 * matching nodes and their ancestor chains are shown and expanded. */
export function flattenProcessTree(roots: readonly ProcessTreeNode[], collapsed: ReadonlySet<number>, query: string): DisplayProcessRow[] {
  const q = query.trim();
  const rows: DisplayProcessRow[] = [];

  if (!q) {
    const walk = (node: ProcessTreeNode, depth: number) => {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(node.proc.pid);
      rows.push({
        proc: node.proc,
        depth,
        hasChildren,
        expanded,
        descendantCount: node.descendantCount,
        subtreeCpu: node.subtreeCpu,
        subtreeRss: node.subtreeRss,
        ancestorOnly: false,
        nameRanges: [],
      });
      if (expanded) {
        for (const ch of node.children) walk(ch, depth + 1);
      }
    };
    for (const r of roots) walk(r, 0);
    return rows;
  }

  // Filtered tree: keep nodes that match or have a matching descendant.
  const hits = new Map<number, readonly MatchRange[]>();
  const keep = new Set<number>();

  const mark = (node: ProcessTreeNode): boolean => {
    const m = matchProcess(node.proc, q);
    if (m.matched) hits.set(node.proc.pid, m.nameRanges);
    let anyChild = false;
    for (const ch of node.children) {
      if (mark(ch)) anyChild = true;
    }
    if (m.matched || anyChild) {
      keep.add(node.proc.pid);
      return true;
    }
    return false;
  };
  for (const r of roots) mark(r);

  const walkFiltered = (node: ProcessTreeNode, depth: number) => {
    if (!keep.has(node.proc.pid)) return;
    const keptChildren = node.children.filter((ch) => keep.has(ch.proc.pid));
    const hasChildren = keptChildren.length > 0;
    const directHit = hits.has(node.proc.pid);
    rows.push({
      proc: node.proc,
      depth,
      hasChildren,
      expanded: hasChildren,
      descendantCount: node.descendantCount,
      subtreeCpu: node.subtreeCpu,
      subtreeRss: node.subtreeRss,
      ancestorOnly: !directHit,
      nameRanges: hits.get(node.proc.pid) ?? [],
    });
    for (const ch of keptChildren) walkFiltered(ch, depth + 1);
  };
  for (const r of roots) walkFiltered(r, 0);
  return rows;
}

/** Filters and sorts processes as a flat list. */
export function buildFlatProcessList(
  processes: readonly ProcessInfo[],
  sortKey: SortKey,
  sortDir: SortDir,
  query: string,
): DisplayProcessRow[] {
  const q = query.trim();
  const out: DisplayProcessRow[] = [];
  for (const proc of processes) {
    const m = matchProcess(proc, q);
    if (!m.matched) continue;
    out.push({
      proc,
      depth: 0,
      hasChildren: false,
      expanded: false,
      descendantCount: 0,
      subtreeCpu: proc.cpuPct,
      subtreeRss: proc.rssBytes,
      ancestorOnly: false,
      nameRanges: m.nameRanges,
    });
  }
  out.sort((a, b) => compareProc(a.proc, b.proc, sortKey, sortDir));
  return out;
}

/** Collects all PIDs in a subtree (for expand/collapse subtree actions). */
export function collectSubtreePids(nodes: readonly ProcessTreeNode[], targetPid: number): number[] {
  const find = (list: readonly ProcessTreeNode[]): ProcessTreeNode | undefined => {
    for (const n of list) {
      if (n.proc.pid === targetPid) return n;
      const found = find(n.children);
      if (found) return found;
    }
    return undefined;
  };
  const root = find(nodes);
  if (!root) return [];
  const pids: number[] = [];
  const walk = (n: ProcessTreeNode) => {
    if (n.children.length > 0) pids.push(n.proc.pid);
    for (const ch of n.children) walk(ch);
  };
  walk(root);
  return pids;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface RectBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const sign = (p1: Point2D, p2: Point2D, p3: Point2D) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Returns true while the pointer is traveling from a sidebar machine row
 * toward its floating dashboard card (either inside the aiming triangle
 * between origin and the card's left edge, or inside the padded gap bridge). */
export function pointInSafeCorridor(pt: Point2D, origin: Point2D, card: RectBox, pad = 10): boolean {
  if (card.right <= card.left || card.bottom <= card.top) return false;
  // Already within or immediately bordering the card's left gap.
  if (pt.x >= card.left - pad && pt.x <= card.right && pt.y >= card.top - pad && pt.y <= card.bottom + pad) {
    return true;
  }
  // Aiming triangle from the last point on the machine row to the card's left edge.
  if (origin.x <= card.left && pt.x >= origin.x - 4 && pt.x <= card.left + 4) {
    const topLeft: Point2D = { x: card.left, y: card.top - pad };
    const botLeft: Point2D = { x: card.left, y: card.bottom + pad };
    return pointInTriangle(pt, origin, topLeft, botLeft);
  }
  return false;
}
