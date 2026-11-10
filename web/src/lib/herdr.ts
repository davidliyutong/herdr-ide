// Subset of herdr's public API types (protocol 22) used by the UI.

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Workspace {
  workspace_id: string;
  label: string;
  number: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  focused: boolean;
  pane_count: number;
  tab_count: number;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label: string;
  number: number;
  agent_status: AgentStatus;
  focused: boolean;
  pane_count: number;
}

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  focused: boolean;
  label?: string | null;
}

export interface Snapshot {
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  agents: Pane[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  version: string;
  protocol: number;
}

export type LayoutNode =
  | { type: 'pane'; pane_id: string; cwd?: string | null }
  | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: LayoutNode; second: LayoutNode };

export interface LayoutExport {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id?: string | null;
  root: LayoutNode;
}

export interface AgentInfo {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  home: string;
  user: string;
  herdr_bin?: string;
  herdr_version?: string;
  herdr_error?: string;
}

export type MachineStatus = 'connecting' | 'ready' | 'degraded' | 'auth_required' | 'error' | 'disabled';

export interface MachineState {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  target?: string;
  session: string;
  enabled: boolean;
  /** One of herdr's saved machines, which herdr machine remove removes. */
  saved?: boolean;
  status: MachineStatus;
  error?: string;
  platform?: string;
  info?: AgentInfo;
  snapshot?: Snapshot;
  layouts?: Record<string, LayoutExport>;
  updated_at: number;
}

export interface AgentStatusEvent {
  pane_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
}

export function paneCwd(p?: Pane | null): string | undefined {
  return p?.foreground_cwd || p?.cwd || undefined;
}

export function paneTitle(p: Pane): string {
  return p.label || p.terminal_title_stripped || p.terminal_title || p.agent || p.pane_id;
}

// Status priority for aggregation and attention ordering.
export const statusRank: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

export function shortPath(p: string | undefined, home?: string): string {
  if (!p) return '';
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  return p;
}

/** Tabs of a workspace in herdr's order. `Tab.number` is not the position:
 * it stays with the tab when the tab is moved. */
export function workspaceTabs(snap: Snapshot, ws: string): Tab[] {
  return snap.tabs.filter((t) => t.workspace_id === ws);
}

/** `items` with the entries of `fresh` (a group in its new order, with its
 * new fields) put into the positions the group occupies; unchanged when
 * `fresh` names an item twice or one that `items` lacks. */
export function withOrder<T>(items: T[], id: (x: T) => string, fresh: T[]): T[] {
  const ids = new Set(fresh.map(id));
  if (ids.size !== fresh.length || items.filter((x) => ids.has(id(x))).length !== fresh.length) return items;
  let k = 0;
  return items.map((x) => (ids.has(id(x)) ? fresh[k++] : x));
}
