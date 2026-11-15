// The arrangement of a machine's terminals that every client shares:
// workspaces (a name and a directory), each with tabs, each a tree of split
// panes whose leaves are terminals. It is the document "layout" in the
// machine's terminal core (docs/features/22-terminal-protocol.md), tested
// with the vectors in design/testdata/layout. The functions return new
// values and never change their arguments; a layout is its own document
// value, and fields this version does not know are kept at every level.

export const LAYOUT_DOCUMENT = 'layout';
/** The id of the workspace a version 1 document's tabs are read into. */
export const DEFAULT_WORKSPACE_ID = 'default';

export type Axis = 'horizontal' | 'vertical';

/** Fields of a newer client, written back as they were. */
type Extra = { [key: string]: unknown };

export type Leaf = Extra & { terminal: string };
/** ratio is the first child's share, 0.1 to 0.9. */
export type Split = Extra & { split: Axis; ratio: number; children: [Node, Node] };
/** A leaf, a split, or a node of a kind this version does not know, kept as it is. */
export type Node = Leaf | Split | Extra;

export type Tab = Extra & {
  /** Set only when the user named the tab. */
  name?: string;
  root: Node;
  /** The terminal with the keyboard focus. */
  focused: string;
};

export type Workspace = Extra & {
  id: string;
  name: string;
  /** Where new terminals start; empty for none. */
  cwd: string;
  tabs: Tab[];
  selected: number;
};

export type Layout = Extra & { version: 2; workspaces: Workspace[]; selected: number };

export const emptyLayout: Layout = { version: 2, workspaces: [], selected: 0 };

const isObject = (v: unknown): v is Extra => typeof v === 'object' && v !== null && !Array.isArray(v);
const clampRatio = (ratio: number) => Math.min(Math.max(ratio, 0.1), 0.9);
const clampIndex = (index: number, count: number) => (count ? Math.min(Math.max(index, 0), count - 1) : 0);
const readIndex = (v: unknown, count: number) => (typeof v === 'number' && Number.isInteger(v) ? clampIndex(v, count) : 0);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export const isLeaf = (node: Node): node is Leaf => typeof node.terminal === 'string' && node.terminal !== '';

export function isSplit(node: Node): node is Split {
  const children = node.children;
  return (
    !isLeaf(node) &&
    (node.split === 'horizontal' || node.split === 'vertical') &&
    Array.isArray(children) &&
    children.length === 2 &&
    children.every(isObject)
  );
}

export function terminalsOf(node: Node): string[] {
  if (isLeaf(node)) return [node.terminal];
  return isSplit(node) ? [...terminalsOf(node.children[0]), ...terminalsOf(node.children[1])] : [];
}

export const tabTerminals = (tab: Tab): string[] => terminalsOf(tab.root);
export const workspaceTerminals = (ws: Workspace): string[] => ws.tabs.flatMap(tabTerminals);
export const layoutTerminals = (layout: Layout): string[] => layout.workspaces.flatMap(workspaceTerminals);
export const selectedWorkspace = (layout: Layout): Workspace | undefined => layout.workspaces[layout.selected];
export const selectedTab = (layout: Layout): Tab | undefined => {
  const ws = selectedWorkspace(layout);
  return ws?.tabs[ws.selected];
};
export const focusedTerminal = (layout: Layout): string | undefined => selectedTab(layout)?.focused || undefined;

/** Where a terminal is: the indexes of its workspace and tab. */
export function locate(layout: Layout, address: string): { workspace: number; tab: number } | null {
  for (const [w, ws] of layout.workspaces.entries()) {
    const t = ws.tabs.findIndex((tab) => tabTerminals(tab).includes(address));
    if (t >= 0) return { workspace: w, tab: t };
  }
  return null;
}

/** A short random id for a new workspace. */
export function newWorkspaceId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join('');
}

// Reading a document.

function parseNode(raw: Extra): Node {
  if (typeof raw.terminal === 'string' && raw.terminal) return { ...raw };
  const { split, ratio, children, ...extra } = raw;
  if ((split === 'horizontal' || split === 'vertical') && Array.isArray(children) && children.length === 2 && children.every(isObject)) {
    const r = typeof ratio === 'number' && Number.isFinite(ratio) ? clampRatio(ratio) : 0.5;
    return { ...extra, split, ratio: r, children: [parseNode(children[0]), parseNode(children[1])] };
  }
  return raw;
}

function parseTab(raw: unknown): Tab | null {
  if (!isObject(raw) || !isObject(raw.root)) return null;
  const { name, root: rawRoot, focused, ...extra } = raw;
  const root = parseNode(rawRoot);
  const terminals = terminalsOf(root);
  return {
    ...extra,
    ...(typeof name === 'string' && name ? { name } : {}),
    root,
    focused: typeof focused === 'string' && terminals.includes(focused) ? focused : (terminals[0] ?? ''),
  };
}

function parseWorkspace(raw: unknown, seen: ReadonlySet<string>): Workspace | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return null;
  const { id, name, cwd, tabs: rawTabs, selected, ...extra } = raw;
  const tabs = (Array.isArray(rawTabs) ? rawTabs : []).map(parseTab).filter((t): t is Tab => t !== null);
  return { ...extra, id: id as string, name: text(name), cwd: text(cwd), tabs, selected: readIndex(selected, tabs.length) };
}

/**
 * The layout a document's value holds. A version 1 document (tabs at the top)
 * is one workspace with those tabs; anything unreadable is left out.
 */
export function parseLayout(value: unknown): Layout {
  if (!isObject(value)) return emptyLayout;
  const { version, workspaces: rawWorkspaces, tabs, selected, ...extra } = value;
  if (Array.isArray(rawWorkspaces)) {
    const seen = new Set<string>();
    const workspaces: Workspace[] = [];
    for (const raw of rawWorkspaces) {
      const ws = parseWorkspace(raw, seen);
      if (ws) {
        seen.add(ws.id);
        workspaces.push(ws);
      }
    }
    return { ...extra, ...(tabs === undefined ? {} : { tabs }), version: 2, workspaces, selected: readIndex(selected, workspaces.length) };
  }
  if (Array.isArray(tabs)) {
    const ws = parseWorkspace({ id: DEFAULT_WORKSPACE_ID, name: '', cwd: '', tabs, selected }, new Set())!;
    return { ...extra, version: 2, workspaces: [ws], selected: 0 };
  }
  return { ...extra, version: 2, workspaces: [], selected: 0 };
}

// Changing a layout.

/** The selection after moving the item at from to to: it stays on its item. */
function afterMove(selected: number, from: number, to: number): number {
  if (selected === from) return to;
  if (from < selected && selected <= to) return selected - 1;
  if (to <= selected && selected < from) return selected + 1;
  return selected;
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The selection after removing the item at index of count: its next item, else the one before. */
const afterRemoval = (selected: number, index: number, count: number) =>
  clampIndex(index < selected || (index === selected && index === count - 1) ? selected - 1 : selected, count - 1);

const workspaceIndex = (layout: Layout, id: string) => layout.workspaces.findIndex((w) => w.id === id);

/** The layout with the workspace at index replaced, and selected when select is set. */
function withWorkspace(layout: Layout, index: number, ws: Workspace, select = false): Layout {
  return { ...layout, workspaces: layout.workspaces.map((w, i) => (i === index ? ws : w)), ...(select ? { selected: index } : {}) };
}

function updateWorkspace(layout: Layout, id: string, change: (ws: Workspace) => Workspace): Layout {
  const index = workspaceIndex(layout, id);
  if (index < 0) return layout;
  const ws = change(layout.workspaces[index]);
  return ws === layout.workspaces[index] ? layout : withWorkspace(layout, index, ws);
}

/** Adds an empty workspace at the end and selects it; nothing for an id in use. */
export function createWorkspace(layout: Layout, id: string, name: string, cwd = ''): Layout {
  if (!id || workspaceIndex(layout, id) >= 0) return layout;
  return { ...layout, workspaces: [...layout.workspaces, { id, name, cwd, tabs: [], selected: 0 }], selected: layout.workspaces.length };
}

export function renameWorkspace(layout: Layout, id: string, name: string): Layout {
  return updateWorkspace(layout, id, (ws) => (ws.name === name ? ws : { ...ws, name }));
}

/** Removes a workspace with its tabs; its terminals keep running until the caller ends them. */
export function closeWorkspace(layout: Layout, id: string): Layout {
  const index = workspaceIndex(layout, id);
  if (index < 0) return layout;
  const workspaces = layout.workspaces.filter((_, i) => i !== index);
  return { ...layout, workspaces, selected: afterRemoval(layout.selected, index, layout.workspaces.length) };
}

export function moveWorkspace(layout: Layout, id: string, to: number): Layout {
  const from = workspaceIndex(layout, id);
  const target = clampIndex(to, layout.workspaces.length);
  if (from < 0 || from === target) return layout;
  return { ...layout, workspaces: moved(layout.workspaces, from, target), selected: afterMove(layout.selected, from, target) };
}

export function selectWorkspace(layout: Layout, id: string): Layout {
  const index = workspaceIndex(layout, id);
  return index < 0 || index === layout.selected ? layout : { ...layout, selected: index };
}

/** Names a tab; an empty name gives it its terminal's name again. */
export function renameTab(layout: Layout, workspace: string, tab: number, name: string): Layout {
  return updateWorkspace(layout, workspace, (ws) => {
    const current = ws.tabs[tab];
    if (!current || (current.name ?? '') === name) return ws;
    const { name: _, ...rest } = current;
    return { ...ws, tabs: ws.tabs.map((t, i) => (i === tab ? (name ? { ...rest, name } : rest) : t)) };
  });
}

/** Removes a tab; its terminals keep running until the caller ends them. */
export function closeTab(layout: Layout, workspace: string, tab: number): Layout {
  return updateWorkspace(layout, workspace, (ws) =>
    ws.tabs[tab] ? { ...ws, tabs: ws.tabs.filter((_, i) => i !== tab), selected: afterRemoval(ws.selected, tab, ws.tabs.length) } : ws,
  );
}

export function moveTab(layout: Layout, workspace: string, from: number, to: number): Layout {
  return updateWorkspace(layout, workspace, (ws) => {
    const target = clampIndex(to, ws.tabs.length);
    if (!ws.tabs[from] || from === target) return ws;
    return { ...ws, tabs: moved(ws.tabs, from, target), selected: afterMove(ws.selected, from, target) };
  });
}

/** Selects a tab and its workspace. */
export function selectTab(layout: Layout, workspace: string, tab: number): Layout {
  const index = workspaceIndex(layout, workspace);
  const ws = layout.workspaces[index];
  if (!ws?.tabs[tab] || (layout.selected === index && ws.selected === tab)) return layout;
  return withWorkspace(layout, index, ws.selected === tab ? ws : { ...ws, selected: tab }, true);
}

/** Selects a terminal's workspace and tab and gives it the focus. */
export function focusTerminal(layout: Layout, address: string): Layout {
  const at = locate(layout, address);
  if (!at) return layout;
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  if (layout.selected === at.workspace && ws.selected === at.tab && tab.focused === address) return layout;
  const tabs = ws.tabs.map((t, i) => (i === at.tab ? { ...t, focused: address } : t));
  return withWorkspace(layout, at.workspace, { ...ws, tabs, selected: at.tab }, true);
}

/** Opens a terminal in a new tab of a workspace (the selected one by default) and selects it; an open one is focused where it is. */
export function openTerminal(layout: Layout, address: string, workspace?: string): Layout {
  if (!address) return layout;
  if (locate(layout, address)) return focusTerminal(layout, address);
  const index = workspace === undefined ? layout.selected : workspaceIndex(layout, workspace);
  const ws = layout.workspaces[index];
  if (!ws) return layout;
  const tabs = [...ws.tabs, { root: { terminal: address }, focused: address }];
  return withWorkspace(layout, index, { ...ws, tabs, selected: tabs.length - 1 }, true);
}

function splitting(node: Node, target: string, axis: Axis, added: Node, before: boolean): Node {
  if (isLeaf(node)) {
    if (node.terminal !== target) return node;
    return { split: axis, ratio: 0.5, children: before ? [added, node] : [node, added] };
  }
  if (!isSplit(node)) return node;
  const [a, b] = node.children;
  return { ...node, children: [splitting(a, target, axis, added, before), splitting(b, target, axis, added, before)] };
}

function removing(node: Node, address: string): Node | null {
  if (isLeaf(node)) return node.terminal === address ? null : node;
  if (!isSplit(node)) return node;
  const [a, b] = node.children;
  const first = removing(a, address);
  const second = removing(b, address);
  if (!first) return second;
  if (!second) return first;
  return first === a && second === b ? node : { ...node, children: [first, second] };
}

/** The other child of the split holding the leaf of address. */
function siblingOf(node: Node, address: string): Node | null {
  if (!isSplit(node)) return null;
  const [a, b] = node.children;
  if (isLeaf(a) && a.terminal === address) return b;
  if (isLeaf(b) && b.terminal === address) return a;
  return siblingOf(a, address) ?? siblingOf(b, address);
}

function leafOf(node: Node, address: string): Leaf | null {
  if (isLeaf(node)) return node.terminal === address ? node : null;
  return isSplit(node) ? (leafOf(node.children[0], address) ?? leafOf(node.children[1], address)) : null;
}

function findLeaf(layout: Layout, address: string): Leaf | null {
  const at = locate(layout, address);
  return at && leafOf(layout.workspaces[at.workspace].tabs[at.tab].root, address);
}

/** Splits the focused terminal of the selected tab, the new terminal second and focused. */
export function splitFocused(layout: Layout, axis: Axis, address: string): Layout {
  const ws = selectedWorkspace(layout);
  const tab = ws?.tabs[ws.selected];
  if (!ws || !tab || !address || locate(layout, address) || !tabTerminals(tab).includes(tab.focused)) return layout;
  const next = { ...tab, root: splitting(tab.root, tab.focused, axis, { terminal: address }, false), focused: address };
  return withWorkspace(layout, layout.selected, { ...ws, tabs: ws.tabs.map((t, i) => (i === ws.selected ? next : t)) });
}

/**
 * Removes a terminal from every tab: its sibling takes its parent's place and
 * the focus, and a tab without terminals goes. Workspaces stay.
 */
export function closeTerminal(layout: Layout, address: string): Layout {
  let changed = false;
  const workspaces = layout.workspaces.map((ws) => {
    if (!workspaceTerminals(ws).includes(address)) return ws;
    changed = true;
    const tabs: Tab[] = [];
    let selected = ws.selected;
    for (const [index, tab] of ws.tabs.entries()) {
      const root = removing(tab.root, address);
      if (root === tab.root) {
        tabs.push(tab);
      } else if (root) {
        const terminals = terminalsOf(root);
        const sibling = terminalsOf(siblingOf(tab.root, address) ?? root)[0];
        tabs.push({ ...tab, root, focused: terminals.includes(tab.focused) ? tab.focused : (sibling ?? terminals[0] ?? '') });
      } else if (index < ws.selected || (index === ws.selected && index === ws.tabs.length - 1)) {
        selected--;
      }
    }
    return { ...ws, tabs, selected: clampIndex(selected, tabs.length) };
  });
  return changed ? { ...layout, workspaces } : layout;
}

/** Drops terminals that no longer exist. */
export function pruneLayout(layout: Layout, live: ReadonlySet<string>): Layout {
  return layoutTerminals(layout)
    .filter((a) => !live.has(a))
    .reduce(closeTerminal, layout);
}

/** Sets the ratio of the split at path (false: first child, true: second) in the selected tab. */
export function setRatio(layout: Layout, path: readonly boolean[], ratio: number): Layout {
  const ws = selectedWorkspace(layout);
  const tab = ws?.tabs[ws.selected];
  if (!ws || !tab || !Number.isFinite(ratio)) return layout;
  const at = (node: Node, rest: readonly boolean[]): Node => {
    if (!isSplit(node)) return node;
    if (!rest.length) return { ...node, ratio: clampRatio(ratio) };
    const [step, ...tail] = rest;
    const [a, b] = node.children;
    return { ...node, children: step ? [a, at(b, tail)] : [at(a, tail), b] };
  };
  const next = { ...tab, root: at(tab.root, path) };
  return withWorkspace(layout, layout.selected, { ...ws, tabs: ws.tabs.map((t, i) => (i === ws.selected ? next : t)) });
}

/** Swaps the panes of two terminals, also across tabs and workspaces; each keeps the focus it had. */
export function swapTerminals(layout: Layout, a: string, b: string): Layout {
  const leafA = findLeaf(layout, a);
  const leafB = findLeaf(layout, b);
  if (a === b || !leafA || !leafB) return layout;
  const swap = (node: Node): Node => {
    if (isLeaf(node)) return node.terminal === a ? leafB : node.terminal === b ? leafA : node;
    return isSplit(node) ? { ...node, children: [swap(node.children[0]), swap(node.children[1])] } : node;
  };
  const workspaces = layout.workspaces.map((ws) => ({
    ...ws,
    tabs: ws.tabs.map((tab) => {
      const root = swap(tab.root);
      const terminals = terminalsOf(root);
      const focused = terminals.includes(tab.focused) ? tab.focused : tab.focused === a ? b : tab.focused === b ? a : tab.focused;
      return { ...tab, root, focused };
    }),
  }));
  return { ...layout, workspaces };
}

/** Moves a terminal's pane beside another terminal's (after it, or before), selects it and gives it the focus. */
export function moveTerminal(layout: Layout, address: string, target: string, axis: Axis, before = false): Layout {
  const leaf = findLeaf(layout, address);
  if (!leaf || address === target || !locate(layout, target)) return layout;
  const removed = closeTerminal(layout, address);
  const at = locate(removed, target)!;
  const ws = removed.workspaces[at.workspace];
  const tabs = ws.tabs.map((t, i) => (i === at.tab ? { ...t, root: splitting(t.root, target, axis, leaf, before), focused: address } : t));
  return withWorkspace(removed, at.workspace, { ...ws, tabs, selected: at.tab }, true);
}

/** Moves a terminal's pane into a new tab at the end of a workspace and selects it. */
export function moveToNewTab(layout: Layout, address: string, workspace: string): Layout {
  const leaf = findLeaf(layout, address);
  if (!leaf || workspaceIndex(layout, workspace) < 0) return layout;
  const removed = closeTerminal(layout, address);
  const index = workspaceIndex(removed, workspace);
  const ws = removed.workspaces[index];
  const tabs = [...ws.tabs, { root: leaf, focused: address }];
  return withWorkspace(removed, index, { ...ws, tabs, selected: tabs.length - 1 }, true);
}

/** A part of a tab, as shares of its width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each terminal's share of its tab, from the split tree. */
export function paneRects(node: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (isLeaf(node)) {
    out.set(node.terminal, r);
    return out;
  }
  if (!isSplit(node)) return out;
  const [a, b] = node.children;
  if (node.split === 'horizontal') {
    const w1 = r.w * node.ratio;
    paneRects(a, { x: r.x, y: r.y, w: w1, h: r.h }, out);
    paneRects(b, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h }, out);
  } else {
    const h1 = r.h * node.ratio;
    paneRects(a, { x: r.x, y: r.y, w: r.w, h: h1 }, out);
    paneRects(b, { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 }, out);
  }
  return out;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** The terminal of the selected tab beside the focused one in a direction:
 * of the panes wholly on that side, the one whose centre is nearest, a step
 * across counting twice a step along. The first pane when none is focused;
 * undefined when nothing is there. */
export function neighbor(layout: Layout, dir: Direction): string | undefined {
  const tab = selectedTab(layout);
  if (!tab) return undefined;
  const rects = paneRects(tab.root);
  const from = rects.get(tab.focused);
  if (!from) return rects.keys().next().value;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const eps = 1e-6;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [id, r] of rects) {
    if (id === tab.focused) continue;
    const ok =
      dir === 'left'
        ? r.x + r.w <= from.x + eps
        : dir === 'right'
          ? r.x >= from.x + from.w - eps
          : dir === 'up'
            ? r.y + r.h <= from.y + eps
            : r.y >= from.y + from.h - eps;
    if (!ok) continue;
    const dx = Math.abs(r.x + r.w / 2 - cx);
    const dy = Math.abs(r.y + r.h / 2 - cy);
    const score = dir === 'left' || dir === 'right' ? dx + 2 * dy : dy + 2 * dx;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Focuses the terminal beside the focused one (neighbor). */
export function focusDirection(layout: Layout, dir: Direction): Layout {
  const next = neighbor(layout, dir);
  return next ? focusTerminal(layout, next) : layout;
}

/** Where on a pane another one is dropped: its middle swaps them, an edge
 * places the dropped pane on that side. */
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** The zone of a point given as shares (0 to 1) of the pane's width and
 * height: the middle (0.3 to 0.7 both ways), else the nearest edge. */
export function dropZone(fx: number, fy: number): DropZone {
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center';
  const d: Record<Exclude<DropZone, 'center'>, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/** The layout after dropping a terminal's pane on a zone of another's. */
export function dropOnPane(layout: Layout, address: string, target: string, zone: DropZone): Layout {
  if (zone === 'center') return swapTerminals(layout, address, target);
  const axis: Axis = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
  return moveTerminal(layout, address, target, axis, zone === 'left' || zone === 'top');
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => jsonEqual(v, (b as unknown[])[i]));
  const x = a as Extra;
  const y = b as Extra;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => Object.hasOwn(y, k) && jsonEqual(x[k], y[k]));
}

/** Whether two layouts are the same document. */
export function sameLayout(a: Layout, b: Layout): boolean {
  return jsonEqual(a, b);
}
