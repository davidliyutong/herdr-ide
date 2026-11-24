// Moving tabs from a previous name's layout (the migrate plugin) into this
// namespace's: pure functions over the two layouts. The previous layout
// loses the moved tabs (a workspace all of whose tabs move goes with
// them); this one gets them in a workspace of the same name and directory,
// a new one when it has none. A terminal of a moved tab gets a new shell in
// its directory and asks for its coding agent back (`resume`, restore.ts),
// in its own session when the machine found it; other panes are copied
// with new ids.
import * as L from '../../term/layout';
import { resumeCommand } from '../../conversation/kinds';

/** A live terminal of the previous namespace, as the machine describes
 * it (agentproto.MigrateTerminal). */
export interface OldTerminal {
  address: string;
  cwd?: string;
  program?: string;
  agent?: string;
  session?: string;
  title?: string;
}

/** A tab picked to move: its workspace's id and its index there. */
export interface Picked {
  workspace: string;
  tab: number;
}

/** Moved tabs of one workspace of the previous layout. */
export interface Group {
  name: string;
  cwd: string;
  tabs: L.Tab[];
}

export interface Taken {
  /** The previous layout without the moved tabs. */
  rest: L.Layout;
  groups: Group[];
  /** The addresses of the moved tabs' terminals. */
  terminals: string[];
}

/** Takes the picked tabs out of the previous layout. */
export function takeTabs(old: L.Layout, picked: readonly Picked[]): Taken {
  let rest = old;
  const groups: Group[] = [];
  const terminals: string[] = [];
  for (const ws of old.workspaces) {
    const indices = [...new Set(picked.filter((p) => p.workspace === ws.id).map((p) => p.tab))]
      .filter((i) => i >= 0 && i < ws.tabs.length)
      .sort((a, b) => a - b);
    if (!indices.length) continue;
    const tabs = indices.map((i) => ws.tabs[i]);
    groups.push({ name: ws.name, cwd: ws.cwd, tabs });
    for (const t of tabs) terminals.push(...L.tabTerminals(t));
    if (indices.length === ws.tabs.length) rest = L.closeWorkspace(rest, ws.id);
    else for (const i of [...indices].reverse()) rest = L.closeTab(rest, ws.id, i);
  }
  return { rest, groups, terminals };
}

const resumable = (agent: unknown): agent is string => typeof agent === 'string' && resumeCommand(agent) !== undefined;

function without(leaf: Record<string, unknown>, ...fields: string[]): Record<string, unknown> {
  const next = { ...leaf };
  for (const f of fields) delete next[f];
  return next;
}

/** A moved terminal's leaf for its new terminal at address: how its pane
 * shows it is kept, what it remembered of its program goes, and it asks for
 * its agent back: the one the machine found running in it, else the one
 * its leaf remembered. */
export function movedTerminal(leaf: L.TerminalLeaf, address: string, info?: OldTerminal): L.TerminalLeaf {
  const next = { ...without(leaf, 'agent', 'pid', 'resume', 'session', 'before'), terminal: address } as L.TerminalLeaf;
  const agent = info?.agent ?? (typeof leaf.agent === 'string' ? leaf.agent : undefined);
  if (!resumable(agent)) return next;
  next.resume = agent;
  const session = info?.agent ? info.session : leaf.session;
  if (L.isSessionId(session)) next.session = session;
  return next;
}

/** The tree with each leaf changed by leaf (null drops it, its split
 * giving way to the other side), the old keys mapped to the new in keys. */
function mapTree(node: L.Node, leaf: (l: L.Leaf) => L.Leaf | null, keys: Map<string, string>): L.Node | null {
  if (L.isSplit(node)) {
    const a = mapTree(node.children[0], leaf, keys);
    const b = mapTree(node.children[1], leaf, keys);
    if (!a || !b) return a ?? b;
    return { ...node, children: [a, b] };
  }
  if (!L.isLeaf(node)) return node;
  const next = leaf(node);
  if (next) keys.set(L.paneKey(node)!, L.paneKey(next)!);
  return next;
}

/** A leaf of a moved tab: a terminal on its new address (started), a
 * view with a new id; null for a terminal that got none. */
function movedLeaf(
  l: L.Leaf,
  started: ReadonlyMap<string, string>,
  info: ReadonlyMap<string, OldTerminal>,
  newId: () => string,
): L.Leaf | null {
  if (L.isTerminalLeaf(l)) {
    const address = started.get(l.terminal);
    return address ? movedTerminal(l, address, info.get(l.terminal)) : null;
  }
  if (L.isCodeLeaf(l)) return { ...l, code: { ...l.code, id: newId() } };
  if (L.isPreviewLeaf(l)) return { ...l, preview: { ...l.preview, id: newId() } };
  if (L.isPluginLeaf(l)) return { ...l, view: { ...l.view, id: newId() } };
  return l;
}

/** The tab as it moves: its panes on their new terminals and ids, its
 * focus following; null when no pane is left. */
export function movedTab(
  tab: L.Tab,
  started: ReadonlyMap<string, string>,
  info: ReadonlyMap<string, OldTerminal>,
  newId = L.newId,
): L.Tab | null {
  const keys = new Map<string, string>();
  const root = mapTree(tab.root, (l) => movedLeaf(l, started, info, newId), keys);
  if (!root) return null;
  const panes = L.panesOf(root);
  const focused = keys.get(tab.focused) ?? panes[0] ?? '';
  return { ...tab, root, focused };
}

/** This namespace's layout with the moved groups: each in the workspace of
 * its name and directory (one with a name), else a new one; the last group's
 * workspace selected. started maps the moved terminals to their new
 * addresses. */
export function placeTabs(
  layout: L.Layout,
  groups: readonly Group[],
  started: ReadonlyMap<string, string>,
  info: ReadonlyMap<string, OldTerminal>,
  newId = L.newId,
): L.Layout {
  let next = layout;
  for (const g of groups) {
    const tabs = g.tabs.flatMap((t) => movedTab(t, started, info, newId) ?? []);
    if (!tabs.length) continue;
    let ws = g.name ? next.workspaces.find((w) => w.name === g.name && w.cwd === g.cwd) : undefined;
    if (!ws) {
      const id = newId();
      next = L.createWorkspace(next, id, g.name, g.cwd);
      ws = next.workspaces.find((w) => w.id === id)!;
    }
    const index = next.workspaces.indexOf(ws);
    const placed: L.Workspace = { ...ws, tabs: [...ws.tabs, ...tabs], selected: ws.tabs.length };
    next = { ...next, workspaces: next.workspaces.map((w, i) => (i === index ? placed : w)), selected: index };
  }
  return next;
}

/** The directory a moved terminal's new shell starts in: its program's,
 * else its workspace's; undefined for the machine's default. */
export function startDirectory(address: string, group: Group, info: ReadonlyMap<string, OldTerminal>): string | undefined {
  return info.get(address)?.cwd || group.cwd || undefined;
}
