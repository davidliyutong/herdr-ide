// What a window shows of one machine: tabs, each a tree of split panes whose
// leaves are terminals. It is the document "layout" in the machine's
// terminal core, shared with the macOS application (Layout.swift): the
// functions here return new values and never change their arguments.

export const LAYOUT_DOCUMENT = 'layout';

export type Axis = 'horizontal' | 'vertical';

/** A leaf is {terminal}, a split {split, ratio, children}; ratio is the first child's share, 0.1 to 0.9. */
export type Node = { terminal: string } | { split: Axis; ratio: number; children: [Node, Node] };

export interface Tab {
  root: Node;
  /** The terminal with the keyboard focus. */
  focused: string;
}

export interface Layout {
  tabs: Tab[];
  selected: number;
}

export const emptyLayout: Layout = { tabs: [], selected: 0 };

const clamp = (ratio: number) => Math.min(Math.max(ratio, 0.1), 0.9);

export function terminalsOf(node: Node): string[] {
  return 'terminal' in node ? [node.terminal] : [...terminalsOf(node.children[0]), ...terminalsOf(node.children[1])];
}

export function layoutTerminals(layout: Layout): string[] {
  return layout.tabs.flatMap((t) => terminalsOf(t.root));
}

function parseNode(value: unknown): Node | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.terminal === 'string' && v.terminal) return { terminal: v.terminal };
  if ((v.split !== 'horizontal' && v.split !== 'vertical') || !Array.isArray(v.children) || v.children.length !== 2) return null;
  const first = parseNode(v.children[0]);
  const second = parseNode(v.children[1]);
  if (!first || !second) return null;
  return { split: v.split, ratio: clamp(typeof v.ratio === 'number' ? v.ratio : 0.5), children: [first, second] };
}

/** The layout a document's value holds; an unreadable one is empty. */
export function parseLayout(value: unknown): Layout {
  const v = value as { tabs?: unknown; selected?: unknown } | null;
  if (!v || !Array.isArray(v.tabs)) return emptyLayout;
  const tabs: Tab[] = [];
  for (const raw of v.tabs as Array<Record<string, unknown>>) {
    const root = parseNode(raw?.root);
    if (!root) return emptyLayout;
    const terminals = terminalsOf(root);
    tabs.push({ root, focused: typeof raw.focused === 'string' && terminals.includes(raw.focused) ? raw.focused : terminals[0] });
  }
  const selected = typeof v.selected === 'number' && Number.isInteger(v.selected) ? v.selected : 0;
  return { tabs, selected: tabs.length ? Math.min(Math.max(selected, 0), tabs.length - 1) : 0 };
}

function splitting(node: Node, address: string, axis: Axis, added: string): Node {
  if ('terminal' in node) {
    return node.terminal === address ? { split: axis, ratio: 0.5, children: [node, { terminal: added }] } : node;
  }
  return { ...node, children: [splitting(node.children[0], address, axis, added), splitting(node.children[1], address, axis, added)] };
}

function removing(node: Node, address: string): Node | null {
  if ('terminal' in node) return node.terminal === address ? null : node;
  const first = removing(node.children[0], address);
  const second = removing(node.children[1], address);
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}

/** Opens a terminal in a new tab and selects it; an open one is selected where it is. */
export function openTerminal(layout: Layout, address: string): Layout {
  const index = layout.tabs.findIndex((t) => terminalsOf(t.root).includes(address));
  if (index >= 0) {
    return { tabs: layout.tabs.map((t, i) => (i === index ? { ...t, focused: address } : t)), selected: index };
  }
  return { tabs: [...layout.tabs, { root: { terminal: address }, focused: address }], selected: layout.tabs.length };
}

/** Splits the focused terminal of the selected tab; null without one. */
export function splitFocused(layout: Layout, axis: Axis, added: string): Layout | null {
  const tab = layout.tabs[layout.selected];
  if (!tab || !terminalsOf(tab.root).includes(tab.focused)) return null;
  const next = { root: splitting(tab.root, tab.focused, axis, added), focused: added };
  return { ...layout, tabs: layout.tabs.map((t, i) => (i === layout.selected ? next : t)) };
}

/** Removes a terminal from every tab; a tab without terminals goes. */
export function closeTerminal(layout: Layout, address: string): Layout {
  const tabs: Tab[] = [];
  let selected = layout.selected;
  layout.tabs.forEach((tab, index) => {
    const root = removing(tab.root, address);
    if (!root) {
      if (index < layout.selected || (index === layout.selected && index === layout.tabs.length - 1)) selected--;
      return;
    }
    const terminals = terminalsOf(root);
    tabs.push({ root, focused: terminals.includes(tab.focused) ? tab.focused : terminals[0] });
  });
  return { tabs, selected: tabs.length ? Math.min(Math.max(selected, 0), tabs.length - 1) : 0 };
}

/** Drops terminals that no longer exist. */
export function pruneLayout(layout: Layout, live: ReadonlySet<string>): Layout {
  return layoutTerminals(layout)
    .filter((a) => !live.has(a))
    .reduce(closeTerminal, layout);
}

/** Sets the ratio of the split at path (false: first child, true: second) in the selected tab. */
export function setRatio(layout: Layout, path: boolean[], ratio: number): Layout {
  const tab = layout.tabs[layout.selected];
  if (!tab) return layout;
  const at = (node: Node, rest: boolean[]): Node => {
    if ('terminal' in node) return node;
    if (!rest.length) return { ...node, ratio: clamp(ratio) };
    const [step, ...tail] = rest;
    return { ...node, children: step ? [node.children[0], at(node.children[1], tail)] : [at(node.children[0], tail), node.children[1]] };
  };
  return { ...layout, tabs: layout.tabs.map((t, i) => (i === layout.selected ? { ...t, root: at(t.root, path) } : t)) };
}

export function sameLayout(a: Layout, b: Layout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
