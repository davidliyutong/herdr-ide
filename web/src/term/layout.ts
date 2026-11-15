// The arrangement of a machine's panes that every client shares: workspaces
// (a name and a directory), each with tabs, each a tree of split panes whose
// leaves are terminals, VS Code views and previews of a file. It is the
// document "layout" in the machine's terminal core
// (docs/features/22-terminal-protocol.md), tested with the vectors in
// design/testdata/layout. The functions return new values and never change
// their arguments; a layout is its own document value, and fields this
// version does not know are kept at every level.

export const LAYOUT_DOCUMENT = 'layout';
/** The id of the workspace a version 1 document's tabs are read into. */
export const DEFAULT_WORKSPACE_ID = 'default';

export type Axis = 'horizontal' | 'vertical';

/** Fields of a newer client, written back as they were. */
type Extra = { [key: string]: unknown };

/** A terminal of the machine's terminal core, by its address. */
export type TerminalLeaf = Extra & { terminal: string };
/** VS Code of the machine for a folder ("" for the one code-server opens). */
export type CodeView = Extra & { id: string; folder: string };
export type CodeLeaf = Extra & { code: CodeView };
/** A file or directory of the machine, shown by the preview. */
export type PreviewView = Extra & { id: string; path: string };
export type PreviewLeaf = Extra & { preview: PreviewView };
/** A pane: a terminal, a VS Code view or a preview. */
export type Leaf = TerminalLeaf | CodeLeaf | PreviewLeaf;
/** ratio is the first child's share, 0.1 to 0.9. */
export type Split = Extra & { split: Axis; ratio: number; children: [Node, Node] };
/** A leaf, a split, or a node of a kind this version does not know, kept as it is. */
export type Node = Leaf | Split | Extra;

export type Tab = Extra & {
  /** Set only when the user named the tab. */
  name?: string;
  root: Node;
  /** The pane with the keyboard focus (paneKey). */
  focused: string;
};

export type Workspace = Extra & {
  id: string;
  /** The user's name for it; empty for none (workspaceTitle). */
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
const id = (v: unknown) => isObject(v) && typeof v.id === 'string' && v.id !== '';

/** The key of a VS Code view's pane: what a tab's focus and the functions
 * here name it by. Terminals go by their address. */
export const codeKey = (id: string) => `code:${id}`;
export const previewKey = (id: string) => `preview:${id}`;

export const isTerminalLeaf = (node: Node): node is TerminalLeaf => typeof node.terminal === 'string' && node.terminal !== '';
export const isCodeLeaf = (node: Node): node is CodeLeaf => !isTerminalLeaf(node) && id(node.code);
export const isPreviewLeaf = (node: Node): node is PreviewLeaf =>
  !isTerminalLeaf(node) && !isCodeLeaf(node) && id(node.preview) && text((node.preview as Extra).path) !== '';

/** A pane's key: a terminal's address, code:<id> or preview:<id>; undefined
 * for splits and nodes of unknown kinds. */
export function paneKey(node: Node): string | undefined {
  if (isTerminalLeaf(node)) return node.terminal;
  if (isCodeLeaf(node)) return codeKey(node.code.id);
  if (isPreviewLeaf(node)) return previewKey(node.preview.id);
  return undefined;
}

export const isLeaf = (node: Node): node is Leaf => paneKey(node) !== undefined;

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

/** The leaves of a tree, in order. */
export function leavesOf(node: Node): Leaf[] {
  if (isLeaf(node)) return [node];
  return isSplit(node) ? [...leavesOf(node.children[0]), ...leavesOf(node.children[1])] : [];
}

/** The keys of a tree's panes, in order. */
export const panesOf = (node: Node): string[] => leavesOf(node).map((l) => paneKey(l)!);

/** The addresses of a tree's terminals, in order. */
export const terminalsOf = (node: Node): string[] => leavesOf(node).flatMap((l) => (isTerminalLeaf(l) ? [l.terminal] : []));

export const tabPanes = (tab: Tab): string[] => panesOf(tab.root);
export const tabTerminals = (tab: Tab): string[] => terminalsOf(tab.root);
export const workspaceTerminals = (ws: Workspace): string[] => ws.tabs.flatMap(tabTerminals);
export const layoutTerminals = (layout: Layout): string[] => layout.workspaces.flatMap(workspaceTerminals);
export const selectedWorkspace = (layout: Layout): Workspace | undefined => layout.workspaces[layout.selected];
export const selectedTab = (layout: Layout): Tab | undefined => {
  const ws = selectedWorkspace(layout);
  return ws?.tabs[ws.selected];
};
/** The selected tab's focused pane. */
export const focusedPane = (layout: Layout): string | undefined => selectedTab(layout)?.focused || undefined;

/** The selected tab's focused pane when it is a terminal. */
export function focusedTerminal(layout: Layout): string | undefined {
  const tab = selectedTab(layout);
  return tab && tabTerminals(tab).includes(tab.focused) ? tab.focused : undefined;
}

/** Where a pane is: the indexes of its workspace and tab. */
export function locate(layout: Layout, key: string): { workspace: number; tab: number } | null {
  for (const [w, ws] of layout.workspaces.entries()) {
    const t = ws.tabs.findIndex((tab) => tabPanes(tab).includes(key));
    if (t >= 0) return { workspace: w, tab: t };
  }
  return null;
}

/** The names earlier versions gave the workspaces they made themselves, in
 * the languages they had: a workspace with one has no name of the user's. */
const GENERATED_NAMES = new Set(['Workspace', '工作区']);

/** The last component of a directory as a workspace is named after it: "~"
 * for the home directory or none, "/" for the root. */
export function folderName(cwd: string, home = ''): string {
  const strip = (p: string) => p.trim().replace(/\/+$/, '');
  const dir = strip(cwd);
  if (!cwd.trim() || dir === '~' || (home && dir === strip(home))) return '~';
  return dir ? dir.slice(dir.lastIndexOf('/') + 1) : '/';
}

/** A workspace's name as shown: the user's, else the folder of dir (the
 * directory of its only pane, when it has one pane), else its own folder's
 * (folderName). An emptied name gives it its folder's again. */
export function workspaceTitle(ws: Pick<Workspace, 'name' | 'cwd'>, home?: string, dir?: string): string {
  const name = ws.name.trim();
  return name && !GENERATED_NAMES.has(name) ? name : folderName(dir || ws.cwd, home);
}

/** A workspace's pane when it has exactly one. */
export function soleLeaf(ws: Workspace): Leaf | null {
  const panes = ws.tabs.flatMap((tab) => panesOf(tab.root).map((key) => [tab, key] as const));
  return panes.length === 1 ? leafOf(panes[0][0].root, panes[0][1]) : null;
}

/** The focused pane of a workspace's selected tab. */
export function focusedLeaf(ws: Workspace): Leaf | null {
  const tab = ws.tabs[ws.selected];
  return tab ? leafOf(tab.root, tab.focused) : null;
}

/** The layout with the workspace of pane key given dir as its directory
 * when key is its first and only pane and it has no directory yet: a
 * workspace is named after the folder its first pane started in. A
 * workspace whose directory the user emptied keeps none: its new terminals
 * start in the focused one's. */
export function adoptDirectory(layout: Layout, key: string, dir: string): Layout {
  const at = locate(layout, key);
  const ws = at && layout.workspaces[at.workspace];
  if (!ws || ws.cwd || !dir) return layout;
  const sole = soleLeaf(ws);
  return sole && paneKey(sole) === key ? withWorkspace(layout, at.workspace, { ...ws, cwd: dir }) : layout;
}

/** A folder without trailing slashes, so one folder is one VS Code view. */
export function normFolder(folder: string): string {
  return folder.length > 1 ? folder.replace(/\/+$/, '') || '/' : folder;
}

/** Whether path is folder or below it. */
export function folderHolds(folder: string, path: string): boolean {
  const f = normFolder(folder);
  return !!f && (path === f || path.startsWith(f === '/' ? '/' : f + '/'));
}

/** A short random id for a new workspace or pane. */
export function newId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join('');
}

// Reading a document.

function parseNode(raw: Extra): Node {
  if (typeof raw.terminal === 'string' && raw.terminal) return { ...raw };
  if (id(raw.code)) {
    const code = raw.code as Extra;
    return { ...raw, code: { ...code, id: code.id as string, folder: text(code.folder) } };
  }
  if (isPreviewLeaf(raw)) return { ...raw, preview: { ...raw.preview } };
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
  const panes = panesOf(root);
  return {
    ...extra,
    ...(typeof name === 'string' && name ? { name } : {}),
    root,
    focused: typeof focused === 'string' && panes.includes(focused) ? focused : (panes[0] ?? ''),
  };
}

function parseWorkspace(raw: unknown, seen: ReadonlySet<string>): Workspace | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return null;
  const { id: wsId, name, cwd, tabs: rawTabs, selected, ...extra } = raw;
  const tabs = (Array.isArray(rawTabs) ? rawTabs : []).map(parseTab).filter((t): t is Tab => t !== null);
  return { ...extra, id: wsId as string, name: text(name), cwd: text(cwd), tabs, selected: readIndex(selected, tabs.length) };
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

const workspaceIndex = (layout: Layout, wsId: string) => layout.workspaces.findIndex((w) => w.id === wsId);

/** The layout with the workspace at index replaced, and selected when select is set. */
function withWorkspace(layout: Layout, index: number, ws: Workspace, select = false): Layout {
  return { ...layout, workspaces: layout.workspaces.map((w, i) => (i === index ? ws : w)), ...(select ? { selected: index } : {}) };
}

function updateWorkspace(layout: Layout, wsId: string, change: (ws: Workspace) => Workspace): Layout {
  const index = workspaceIndex(layout, wsId);
  if (index < 0) return layout;
  const ws = change(layout.workspaces[index]);
  return ws === layout.workspaces[index] ? layout : withWorkspace(layout, index, ws);
}

/** Adds an empty workspace at the end and selects it; nothing for an id in use. */
export function createWorkspace(layout: Layout, wsId: string, name: string, cwd = ''): Layout {
  if (!wsId || workspaceIndex(layout, wsId) >= 0) return layout;
  return {
    ...layout,
    workspaces: [...layout.workspaces, { id: wsId, name, cwd, tabs: [], selected: 0 }],
    selected: layout.workspaces.length,
  };
}

export function renameWorkspace(layout: Layout, wsId: string, name: string): Layout {
  return updateWorkspace(layout, wsId, (ws) => (ws.name === name ? ws : { ...ws, name }));
}

/** Sets a workspace's name and directory; an empty directory has its new
 * terminals start in the focused one's. */
export function editWorkspace(layout: Layout, wsId: string, name: string, cwd: string): Layout {
  return updateWorkspace(layout, wsId, (ws) => (ws.name === name && ws.cwd === cwd ? ws : { ...ws, name, cwd }));
}

/** Removes a workspace with its tabs; its terminals keep running until the caller ends them. */
export function closeWorkspace(layout: Layout, wsId: string): Layout {
  const index = workspaceIndex(layout, wsId);
  if (index < 0) return layout;
  const workspaces = layout.workspaces.filter((_, i) => i !== index);
  return { ...layout, workspaces, selected: afterRemoval(layout.selected, index, layout.workspaces.length) };
}

export function moveWorkspace(layout: Layout, wsId: string, to: number): Layout {
  const from = workspaceIndex(layout, wsId);
  const target = clampIndex(to, layout.workspaces.length);
  if (from < 0 || from === target) return layout;
  return { ...layout, workspaces: moved(layout.workspaces, from, target), selected: afterMove(layout.selected, from, target) };
}

export function selectWorkspace(layout: Layout, wsId: string): Layout {
  const index = workspaceIndex(layout, wsId);
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

/** Selects a pane's workspace and tab and gives it the focus. */
export function focusPane(layout: Layout, key: string): Layout {
  const at = locate(layout, key);
  if (!at) return layout;
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  if (layout.selected === at.workspace && ws.selected === at.tab && tab.focused === key) return layout;
  const tabs = ws.tabs.map((t, i) => (i === at.tab ? { ...t, focused: key } : t));
  return withWorkspace(layout, at.workspace, { ...ws, tabs, selected: at.tab }, true);
}

/** Opens a pane in a new tab of a workspace (the selected one by default) and
 * selects it; a pane already open is focused where it is. */
export function openPane(layout: Layout, leaf: Leaf, workspace?: string): Layout {
  const key = paneKey(leaf);
  if (!key) return layout;
  if (locate(layout, key)) return focusPane(layout, key);
  const index = workspace === undefined ? layout.selected : workspaceIndex(layout, workspace);
  const ws = layout.workspaces[index];
  if (!ws) return layout;
  const tabs = [...ws.tabs, { root: { ...leaf }, focused: key }];
  return withWorkspace(layout, index, { ...ws, tabs, selected: tabs.length - 1 }, true);
}

/** Opens a terminal in a new tab of a workspace (the selected one by default) and selects it; an open one is focused where it is. */
export function openTerminal(layout: Layout, address: string, workspace?: string): Layout {
  return address ? openPane(layout, { terminal: address }, workspace) : layout;
}

function splitting(node: Node, target: string, axis: Axis, added: Node, before: boolean): Node {
  if (isLeaf(node)) {
    if (paneKey(node) !== target) return node;
    return { split: axis, ratio: 0.5, children: before ? [added, node] : [node, added] };
  }
  if (!isSplit(node)) return node;
  const [a, b] = node.children;
  return { ...node, children: [splitting(a, target, axis, added, before), splitting(b, target, axis, added, before)] };
}

function removing(node: Node, key: string): Node | null {
  if (isLeaf(node)) return paneKey(node) === key ? null : node;
  if (!isSplit(node)) return node;
  const [a, b] = node.children;
  const first = removing(a, key);
  const second = removing(b, key);
  if (!first) return second;
  if (!second) return first;
  return first === a && second === b ? node : { ...node, children: [first, second] };
}

/** The other child of the split holding the leaf of key. */
function siblingOf(node: Node, key: string): Node | null {
  if (!isSplit(node)) return null;
  const [a, b] = node.children;
  if (isLeaf(a) && paneKey(a) === key) return b;
  if (isLeaf(b) && paneKey(b) === key) return a;
  return siblingOf(a, key) ?? siblingOf(b, key);
}

/** The leaf of a pane in a tree. */
export function leafOf(node: Node, key: string): Leaf | null {
  if (isLeaf(node)) return paneKey(node) === key ? node : null;
  return isSplit(node) ? (leafOf(node.children[0], key) ?? leafOf(node.children[1], key)) : null;
}

/** The leaf of a pane anywhere in the layout. */
export function findLeaf(layout: Layout, key: string): Leaf | null {
  const at = locate(layout, key);
  return at && leafOf(layout.workspaces[at.workspace].tabs[at.tab].root, key);
}

/** Splits a pane with a new one, placed after it (or before) and focused; its
 * tab and workspace are selected. Nothing when the new pane is open already. */
export function splitPane(layout: Layout, target: string, axis: Axis, leaf: Leaf, before = false): Layout {
  const key = paneKey(leaf);
  const at = locate(layout, target);
  if (!key || !at || locate(layout, key)) return layout;
  const ws = layout.workspaces[at.workspace];
  const tabs = ws.tabs.map((t, i) =>
    i === at.tab ? { ...t, root: splitting(t.root, target, axis, { ...leaf }, before), focused: key } : t,
  );
  return withWorkspace(layout, at.workspace, { ...ws, tabs, selected: at.tab }, true);
}

/** Splits the focused pane of the selected tab, the new terminal second and focused. */
export function splitFocused(layout: Layout, axis: Axis, address: string): Layout {
  const tab = selectedTab(layout);
  if (!tab || !address || !tabPanes(tab).includes(tab.focused)) return layout;
  return splitPane(layout, tab.focused, axis, { terminal: address });
}

/**
 * Removes a pane from every tab: its sibling takes its parent's place and the
 * focus, and a tab without panes goes. Workspaces stay.
 */
export function closePane(layout: Layout, key: string): Layout {
  let changed = false;
  const workspaces = layout.workspaces.map((ws) => {
    if (!ws.tabs.some((t) => tabPanes(t).includes(key))) return ws;
    changed = true;
    const tabs: Tab[] = [];
    let selected = ws.selected;
    for (const [index, tab] of ws.tabs.entries()) {
      const root = removing(tab.root, key);
      if (root === tab.root) {
        tabs.push(tab);
      } else if (root) {
        const panes = panesOf(root);
        const sibling = panesOf(siblingOf(tab.root, key) ?? root)[0];
        tabs.push({ ...tab, root, focused: panes.includes(tab.focused) ? tab.focused : (sibling ?? panes[0] ?? '') });
      } else if (index < ws.selected || (index === ws.selected && index === ws.tabs.length - 1)) {
        selected--;
      }
    }
    return { ...ws, tabs, selected: clampIndex(selected, tabs.length) };
  });
  return changed ? { ...layout, workspaces } : layout;
}

/** Drops terminals that no longer exist; other panes stay. */
export function pruneLayout(layout: Layout, live: ReadonlySet<string>): Layout {
  return layoutTerminals(layout)
    .filter((a) => !live.has(a))
    .reduce(closePane, layout);
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

/** Swaps two panes, also across tabs and workspaces; each tab keeps the focus it had. */
export function swapPanes(layout: Layout, a: string, b: string): Layout {
  const leafA = findLeaf(layout, a);
  const leafB = findLeaf(layout, b);
  if (a === b || !leafA || !leafB) return layout;
  const swap = (node: Node): Node => {
    if (isLeaf(node)) return paneKey(node) === a ? leafB : paneKey(node) === b ? leafA : node;
    return isSplit(node) ? { ...node, children: [swap(node.children[0]), swap(node.children[1])] } : node;
  };
  const workspaces = layout.workspaces.map((ws) => ({
    ...ws,
    tabs: ws.tabs.map((tab) => {
      const root = swap(tab.root);
      const panes = panesOf(root);
      const focused = panes.includes(tab.focused) ? tab.focused : tab.focused === a ? b : tab.focused === b ? a : tab.focused;
      return { ...tab, root, focused };
    }),
  }));
  return { ...layout, workspaces };
}

/** Moves a pane beside another one (after it, or before), selects it and gives it the focus. */
export function movePane(layout: Layout, key: string, target: string, axis: Axis, before = false): Layout {
  const leaf = findLeaf(layout, key);
  if (!leaf || key === target || !locate(layout, target)) return layout;
  return splitPane(closePane(layout, key), target, axis, leaf, before);
}

/** Moves a pane into a new tab at the end of a workspace and selects it. */
export function moveToNewTab(layout: Layout, key: string, workspace: string): Layout {
  const leaf = findLeaf(layout, key);
  if (!leaf || workspaceIndex(layout, workspace) < 0) return layout;
  return openPane(closePane(layout, key), leaf, workspace);
}

/** Shows another path in a preview pane. */
export function setPreviewPath(layout: Layout, key: string, path: string): Layout {
  const leaf = findLeaf(layout, key);
  if (!leaf || !isPreviewLeaf(leaf) || !path || leaf.preview.path === path) return layout;
  const next: PreviewLeaf = { ...leaf, preview: { ...leaf.preview, path } };
  const swap = (node: Node): Node => {
    if (isLeaf(node)) return paneKey(node) === key ? next : node;
    return isSplit(node) ? { ...node, children: [swap(node.children[0]), swap(node.children[1])] } : node;
  };
  const at = locate(layout, key)!;
  const ws = layout.workspaces[at.workspace];
  return withWorkspace(layout, at.workspace, { ...ws, tabs: ws.tabs.map((t, i) => (i === at.tab ? { ...t, root: swap(t.root) } : t)) });
}

/** A workspace's VS Code views, in the order of its tabs and their trees. */
export function codeViews(ws: Workspace): { key: string; view: CodeView; tab: number }[] {
  return ws.tabs.flatMap((t, tab) =>
    leavesOf(t.root).flatMap((l) => (isCodeLeaf(l) ? [{ key: codeKey(l.code.id), view: l.code, tab }] : [])),
  );
}

/** A workspace's previews, in the order of its tabs and their trees. */
export function previewViews(ws: Workspace): { key: string; view: PreviewView; tab: number }[] {
  return ws.tabs.flatMap((t, tab) =>
    leavesOf(t.root).flatMap((l) => (isPreviewLeaf(l) ? [{ key: previewKey(l.preview.id), view: l.preview, tab }] : [])),
  );
}

/** A part of a tab, as shares of its width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each pane's share of its tab, from the split tree. */
export function paneRects(node: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (isLeaf(node)) {
    out.set(paneKey(node)!, r);
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

/** The pane of the selected tab beside the focused one in a direction: of
 * the panes wholly on that side, the one whose centre is nearest, a step
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
  for (const [key, r] of rects) {
    if (key === tab.focused) continue;
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
      best = key;
    }
  }
  return best;
}

/** Focuses the pane beside the focused one (neighbor). */
export function focusDirection(layout: Layout, dir: Direction): Layout {
  const next = neighbor(layout, dir);
  return next ? focusPane(layout, next) : layout;
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

/** The layout after dropping a pane on a zone of another one. */
export function dropOnPane(layout: Layout, key: string, target: string, zone: DropZone): Layout {
  if (zone === 'center') return swapPanes(layout, key, target);
  const axis: Axis = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
  return movePane(layout, key, target, axis, zone === 'left' || zone === 'top');
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

// ---- reopening closed panes ----

/** A tab as it was when panes of it were closed (all of them when the tab
 * closed), for reopening them. */
export interface Closed {
  /** The workspace of the tab, and the tab's place in it. */
  ws: string;
  index: number;
  tab: Tab;
  /** The panes closed, in the tree's order. */
  closed: string[];
}

/** A tree with leaves replaced (by key) and the others pruned: a split
 * left with one child is that child. */
function rebuild(node: Node, leafFor: (key: string) => Leaf | undefined): Node | null {
  if (isLeaf(node)) return leafFor(paneKey(node)!) ?? null;
  if (!isSplit(node)) return null;
  const [a, b] = node.children;
  const first = rebuild(a, leafFor);
  const second = rebuild(b, leafFor);
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}

/** The split holding a pane directly in a tree, and whether the pane is
 * its first child. */
function parentOf(node: Node, key: string): { split: Split; first: boolean } | null {
  if (!isSplit(node)) return null;
  const [a, b] = node.children;
  if (isLeaf(a) && paneKey(a) === key) return { split: node, first: true };
  if (isLeaf(b) && paneKey(b) === key) return { split: node, first: false };
  return parentOf(a, key) ?? parentOf(b, key);
}

/**
 * Puts closed panes back, as far as they are restored (restored maps a
 * closed pane's key to its new leaf: a new terminal for a terminal, the same
 * view for VS Code and previews). In the tab that holds what is left of the
 * closed one, unchanged since but for the closing, the tab is as it was,
 * with its splits' shares; a tab that changed meanwhile gets each pane split
 * in beside its neighbor of then; a closed tab comes back at its place in
 * its workspace (the selected one when that is gone). The reopened pane, or
 * the tab's focused one, is focused.
 */
export function reopen(layout: Layout, c: Closed, restored: ReadonlyMap<string, Leaf>): Layout {
  const added = new Map([...restored].filter(([, leaf]) => paneKey(leaf)));
  const addedKeys = new Set([...added.values()].map((l) => paneKey(l)!));
  const before = panesOf(c.tab.root);
  const survivors = before.filter((k) => !c.closed.includes(k));
  const at = [...survivors, ...addedKeys].map((k) => locate(layout, k)).find((x) => x !== null) ?? null;
  const keyOf = (old: string) => (added.has(old) ? paneKey(added.get(old)!)! : old);
  const focusOld = added.has(c.tab.focused) ? c.tab.focused : [...added.keys()].pop();
  const focused = focusOld ? keyOf(focusOld) : undefined;

  if (at) {
    const ws = layout.workspaces[at.workspace];
    const tab = ws.tabs[at.tab];
    const now = tabPanes(tab);
    const known = new Set([...survivors, ...addedKeys]);
    let next: Tab;
    if (now.every((k) => known.has(k))) {
      // Unchanged but for the closing: the tab as it was.
      const kept = new Set(now);
      const root = rebuild(c.tab.root, (k) => (added.has(k) ? added.get(k) : kept.has(k) ? leafOf(tab.root, k)! : undefined));
      if (!root) return layout;
      next = { ...tab, root, focused: focused && panesOf(root).includes(focused) ? focused : tab.focused };
    } else {
      // Changed meanwhile: each pane missing beside its neighbor of then.
      let root = tab.root;
      for (const [old, leaf] of added) {
        const key = paneKey(leaf)!;
        if (panesOf(root).includes(key)) continue;
        const parent = parentOf(c.tab.root, old);
        const near = parent ? panesOf(parent.split.children[parent.first ? 1 : 0]).map(keyOf) : [];
        const target = near.find((k) => panesOf(root).includes(k)) ?? panesOf(root)[0];
        if (!target) continue;
        root = splitting(root, target, parent?.split.split ?? 'horizontal', { ...leaf }, parent?.first ?? false);
      }
      if (root === tab.root) return layout;
      next = { ...tab, root, focused: focused && panesOf(root).includes(focused) ? focused : tab.focused };
    }
    const tabs = ws.tabs.map((t, i) => (i === at.tab ? next : t));
    return withWorkspace(layout, at.workspace, { ...ws, tabs, selected: at.tab }, true);
  }

  // The tab is gone: it comes back with what is restored of it.
  const root = rebuild(c.tab.root, (k) => added.get(k));
  if (!root) return layout;
  let index = workspaceIndex(layout, c.ws);
  if (index < 0) index = layout.selected;
  const ws = layout.workspaces[index];
  if (!ws) return layout;
  const place = Math.min(Math.max(c.index, 0), ws.tabs.length);
  const tab: Tab = { ...c.tab, root, focused: focused ?? panesOf(root)[0] };
  const tabs = [...ws.tabs.slice(0, place), tab, ...ws.tabs.slice(place)];
  return withWorkspace(layout, index, { ...ws, tabs, selected: place }, true);
}
