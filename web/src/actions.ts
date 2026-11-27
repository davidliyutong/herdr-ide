// User-level commands shared by buttons, the keymap and the command palette.
// Workspaces, tabs and panes are edits of the shown machine's layout
// document plus terminal.run and terminal.kill on its terminal core
// (state/terms.ts); closing ends the programs after asking when one runs.
// VS Code and previews are panes too: they open as a tab or beside the pane
// they came from (docs/features/05-vscode-panes.md).

import * as L from './term/layout';
import { describeView, ensurePluginLoaded, isPluginOn, viewStatus, viewUnopened } from './plugins/registry';
import {
  confirmDetachedTabs,
  detachedRecordForPane,
  detachedRecordForTab,
  focusDetachedRecord,
  getDetachedCurrent,
  isDetachedWindow,
  useDetachedTabs,
} from './detachedWindow';
import { isLive, type TerminalRecord } from './term/protocol';
import { terms, useTerms } from './state/terms';
import { useStore } from './state/store';
import { saveWorkspacePresets } from './state/workspacePresets';
import { withView, unsavedPanes } from './state/panes';
import { settingValue } from './settings';
import { aggregate, agentOf, agentStatus, statusRank, terminalTitle, type AgentStatus } from './lib/machine';
import { mediaExt } from './terminal/links';
import { bridge, hasFrame, type BridgeCommand } from './lib/bridge';
import { reloadFrame, setStopped } from './codeFrames';
import { closingGroup, rememberClosed, rememberWorkspace, takeClosed, undoMs, type ClosedRecord } from './closedPanes';
import { nameList } from './state/multiSelect';
import { confirmUnsaved } from './unsaved';
import { go, paneOpen, type Spot } from './paneHistory';
import { hasMessage, t } from './i18n';
import { confirmCheckDialog, confirmDialog, editWorkspaceDialog, newWorkspaceDialog } from './dialog';
import type { MessageKey } from './i18n/en';

export interface AttentionItem {
  m: string;
  /** The pane's key: a terminal's address, view:<id> for a plugin's pane,
   * or an unopened conversation id (chat:<id>). */
  terminal: string;
  /** The terminal's record; none for a plugin's pane. */
  record?: TerminalRecord;
  /** The plugin's pane, for one. */
  view?: L.PluginView;
  /** A conversation/agent without an open pane yet. */
  unopened?: { title: string; directory?: string; open: () => void };
  status: AgentStatus;
}

/** Statuses that represent an unread / attention-requesting indicator badge
 * (suppressed when a tab or workspace is muted). */
const isAttentionStatus = (s: AgentStatus | undefined): boolean => s === 'blocked' || s === 'done';

/** Terminals with an agent (or a status their program reports), the
 * plugins' panes with a status, and active/attention-needing plugin
 * conversations without an open pane on every machine followed, by how
 * much they need the user; terminals before panes, panes before unopened
 * chats within the same status. Muted panes' unread/attention statuses
 * (blocked, done) are omitted. */
export function attentionList(): AttentionItem[] {
  const s = useStore.getState();
  const tm = useTerms.getState().machines;
  const out: AttentionItem[] = [];
  for (const m of s.order) {
    const layout = tm[m]?.layout;
    for (const r of Object.values(tm[m]?.terminals ?? {})) {
      const status = agentStatus(r);
      if (!isLive(r) || !status || (!agentOf(r) && status === 'idle')) continue;
      if (isAttentionStatus(status) && layout && L.paneMuted(layout, r.address)) continue;
      out.push({ m, terminal: r.address, record: r, status });
    }
  }
  for (const m of s.order) {
    const layout = tm[m]?.layout;
    for (const { key, view } of layout ? L.layoutViews(layout) : []) {
      const status = viewStatus(m, view);
      if (!status) continue;
      if (isAttentionStatus(status) && layout && L.paneMuted(layout, key)) continue;
      out.push({ m, terminal: key, view, status });
    }
  }
  for (const m of s.order) {
    for (const u of viewUnopened(m)) {
      out.push({ m, terminal: u.id, unopened: u, status: u.status });
    }
  }
  return out.sort((a, b) => statusRank[b.status] - statusRank[a.status]);
}

/** Opens or focuses an item from the attention list. */
export function focusAttention(item: AttentionItem) {
  if (item.unopened) item.unopened.open();
  else actions.focusPane(item.m, item.terminal);
}

/** What an attention item is called first: its agent, else its pane's
 * title (a terminal's; a plugin's pane's, a chat's). */
export function attentionName(i: AttentionItem): string {
  return (i.record && agentOf(i.record)) ?? i.unopened?.title ?? attentionTitle(i);
}

/** An attention item's pane's title. */
export function attentionTitle(i: AttentionItem): string {
  if (i.unopened) return i.unopened.title;
  return i.view ? describeView(i.m, i.view).title : terminalTitle(i.record, i.terminal);
}

/** The status of a pane: a terminal's agent's, a plugin's pane's. */
export function paneStatus(m: string, leaf: L.Leaf): AgentStatus | undefined {
  if (L.isTerminalLeaf(leaf)) return agentStatus(useTerms.getState().machines[m]?.terminals[leaf.terminal]);
  return L.isPluginLeaf(leaf) ? viewStatus(m, leaf.view) : undefined;
}

/** The status a tab shows: the highest of its panes' (aggregate), suppressing
 * unread/attention statuses (blocked, done) when the tab or its workspace is
 * muted. */
export function tabStatus(m: string, tab: L.Tab, muted = false): AgentStatus | undefined {
  const hideUnread = muted || !!tab.muted;
  return aggregate(
    L.leavesOf(tab.root).map((leaf) => {
      const s = paneStatus(m, leaf);
      return hideUnread && isAttentionStatus(s) ? undefined : s;
    }),
  );
}

/** The status a workspace shows: the highest of its tabs', suppressing
 * unread/attention statuses from muted tabs or when the workspace is muted. */
export function workspaceStatus(m: string, ws: L.Workspace): AgentStatus | undefined {
  return aggregate(ws.tabs.map((tab) => tabStatus(m, tab, !!ws.muted)));
}

/** Each pane's share of its tab, from the split tree. */
export const paneRects = L.paneRects;

/** The shown machine's selected workspace and tab, and the focused pane. */
/** Whether a pane of the history is still open. */
export const spotOpen = (s: Spot) => paneOpen(useTerms.getState().machines[s.m]?.layout, s.pane);

/** Updates focus to `key` in `layout`: in a detached window, updates only
 * that tab's focused pane without mutating `layout.selected` or `ws.selected`
 * so the main window never jumps workspaces or tabs. */
export function focusPaneInLayout(layout: L.Layout, key: string): L.Layout {
  if (!isDetachedWindow()) return L.focusPane(layout, key);
  const at = L.locate(layout, key);
  if (!at) return layout;
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  if (tab.focused === key) return layout;
  const tabs = ws.tabs.map((t, i) => (i === at.tab ? { ...t, focused: key } : t));
  const workspaces = layout.workspaces.map((w, i) => (i === at.workspace ? { ...w, tabs } : w));
  return { ...layout, workspaces };
}

/** Triggers lazy loading of the vault plugin before workspace dialogs so
 * workspace preset links and their saver are registered (including inside
 * detached windows where the right rail never mounted). */
async function ensureVaultReady() {
  if (isPluginOn('vault')) await ensurePluginLoaded('vault').catch(() => {});
}

export function current() {
  if (isDetachedWindow()) {
    const det = getDetachedCurrent();
    if (!det) return undefined;
    const layout = useTerms.getState().machines[det.m]?.layout;
    const ws = layout?.workspaces.find((w) => w.id === det.wsId);
    const tab = ws?.tabs[det.tabIndex];
    if (!layout || !ws || !tab) return undefined;
    return { m: det.m, layout, ws, tabIndex: det.tabIndex, tab, focused: tab.focused || undefined };
  }
  const m = useStore.getState().machineId;
  const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
  if (!m || !layout) return undefined;
  const ws = L.selectedWorkspace(layout);
  if (!ws) return { m, layout, ws: undefined, tabIndex: 0, tab: undefined, focused: undefined };
  const records = useDetachedTabs.getState().records;
  const visible = ws.tabs.map((tb, i) => ({ tb, i })).filter(({ tb }) => !detachedRecordForTab(m, tb, records));
  const entry = visible.find((x) => x.i === ws.selected) ?? visible[0];
  return { m, layout, ws, tabIndex: entry?.i ?? 0, tab: entry?.tb, focused: entry?.tb.focused || undefined };
}

/** Puts the keyboard in a pane once it is on screen. */
function focusDom(m: string, pane: string) {
  withView(m, pane, (h) => h.focus());
}

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

/** The directory a pane works in: a terminal's (its foreground program's),
 * a VS Code pane's folder, a preview's file's directory. */
export function paneDirectory(m: string, leaf: L.Leaf | null | undefined): string | undefined {
  if (!leaf) return undefined;
  if (L.isTerminalLeaf(leaf)) return terms.directory(m, leaf.terminal);
  if (L.isCodeLeaf(leaf)) return leaf.code.folder || undefined;
  if (L.isPluginLeaf(leaf)) return describeView(m, leaf.view).directory;
  return L.isPreviewLeaf(leaf) ? dirname(leaf.preview.path) : undefined;
}

/** Where a pane opened from another one goes: the workspace and tab of from
 * (the shown machine's focused pane when there is none), with from when it
 * is in the layout. */
function originOf(m: string, layout: L.Layout, from?: string) {
  if (from === undefined && useStore.getState().machineId === m) from = L.focusedPane(layout);
  const at = from ? L.locate(layout, from) : null;
  const ws = at ? layout.workspaces[at.workspace] : L.selectedWorkspace(layout);
  return { ws, tab: at ? at.tab : (ws?.selected ?? 0), from: at ? from : undefined };
}

/** Opens a new pane beside from (to its right), else in a new tab of ws. */
function openBeside(m: string, leaf: L.Leaf, ws: L.Workspace | undefined, from?: string) {
  terms.mutate(m, (l) => {
    const next = from ? L.splitPane(l, from, 'horizontal', leaf) : l;
    return next !== l ? next : L.openPane(l, leaf, ws?.id);
  });
}

/** Shows a VS Code pane (and its machine) and gives it the keyboard; runs
 * cmd there. fresh: the pane was just opened. Asking for VS Code starts it
 * again on a machine whose code-server was stopped from this page. */
async function showCode(m: string, key: string, view: { id: string; folder: string }, fresh: boolean, cmd?: BridgeCommand) {
  setStopped(m, false);
  useStore.getState().selectMachine(m);
  terms.mutate(m, (l) => L.focusPane(l, key));
  focusDom(m, key);
  if (cmd) await bridge.command(m, view.id, view.folder, cmd, fresh).catch(report);
}

/** A VS Code window in a split beside from: the VS Code pane of that tab for
 * folder, else a new one; then cmd there (diff, Git Graph). */
async function codeBeside(m: string, folder: string | undefined, from: string | undefined, cmd: BridgeCommand) {
  await whenLoaded(m);
  const layout = terms.layout(m)!;
  const o = originOf(m, layout, from);
  const f = L.normFolder(folder ?? o.ws?.cwd ?? '');
  const found = o.ws ? L.codeViews(o.ws).find((v) => v.tab === o.tab && L.normFolder(v.view.folder) === f) : undefined;
  if (found) return showCode(m, found.key, found.view, !hasFrame(m, found.view.id), cmd);
  const view = { id: L.newId(), folder: f };
  openBeside(m, { code: view }, o.ws, o.from);
  await showCode(m, L.codeKey(view.id), view, true, cmd);
}

function report(e: unknown) {
  console.warn(e);
  const msg = e instanceof Error ? e.message : String(e);
  useStore.getState().toast?.(msg);
}

/** The translations of the hub's error codes for machine requests. */
const machineErrors: Record<string, MessageKey> = {
  label_taken: 'machine.labelTaken',
  machine_exists: 'machine.exists',
  invalid: 'machine.invalid',
  invalid_target: 'machine.invalidTarget',
  unknown: 'machine.gone',
  local: 'machine.localOnly',
  save: 'machine.notSaved',
};

/** The reason a machine request failed, from the hub's error code (with
 * the system's reason when the file could not be saved). */
async function machineError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  const key = body.error ? machineErrors[body.error] : undefined;
  if (body.error === 'save' && body.detail) return t('machine.notSavedBecause', { detail: body.detail });
  if (key) return t(key);
  return body.detail || body.error || String(res.status);
}

/** How long a new machine is watched for a login it needs. */
const LOGIN_WAIT_MS = 2 * 60_000;

/** Opens the authentication terminal once a machine just added turns
 * auth_required; stops watching once it connected or failed otherwise. */
function awaitLogin(m: string) {
  const decide = (): 'login' | 'done' | undefined => {
    // The machine may reach the store after the reply that added it.
    const st = useStore.getState().machines[m];
    if (st?.status === 'ready' || st?.status === 'error' || st?.status === 'disabled') return 'done';
    return st?.status === 'auth_required' ? 'login' : undefined;
  };
  let off = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (d: 'login' | 'done' | undefined) => {
    if (!d) return false;
    off();
    clearTimeout(timer);
    if (d === 'login' && useStore.getState().sshLogin) useStore.getState().openAuth(m);
    return true;
  };
  if (settle(decide())) return;
  off = useStore.subscribe(() => void settle(decide()));
  timer = setTimeout(() => off(), LOGIN_WAIT_MS);
}

/** Records panes about to close for Undo Close (each list a tab's, all
 * brought back by one undo), has their terminals end when it can no
 * longer bring them back, and says how to bring them back. */
function closeWithUndo(m: string, layout: L.Layout, tabs: string[][], message: string) {
  const group = closingGroup();
  const now = Date.now();
  const closed = tabs.flatMap((panes) => rememberClosed(m, layout, panes, now, group) ?? []);
  undoable(m, closed, message);
}

/** Has the terminals of records end when Undo Close can no longer bring
 * them back, and says how to bring them back (nothing without records). */
function undoable(m: string, closed: ClosedRecord[], message: string, always = false) {
  for (const c of closed) for (const a of c.terminals) terms.closeLater(m, a, c.deadline);
  if (closed.length || always)
    useStore.getState().toast(message, { label: t('closed.undo'), run: () => actions.undoClose(), ttl: undoMs() });
}

/** Names as a confirmation lists them: quoted, the first few, then how many more. */
export const quotedNames = (names: readonly string[]) =>
  nameList(
    names.map((name) => t('list.quoted', { name })),
    t('list.sep'),
    (n) => t('list.more', { n }),
  );

/** The tabs of a layout holding these panes (one each), as the workspace
 * of the first and their indexes in it. */
function tabsAt(layout: L.Layout, keys: readonly string[]): { ws: L.Workspace; indexes: number[] } | undefined {
  const at = keys.map((k) => L.locate(layout, k)).filter((x) => x !== null);
  if (!at.length) return undefined;
  const ws = layout.workspaces[at[0].workspace];
  const indexes = [...new Set(at.filter((a) => a.workspace === at[0].workspace).map((a) => a.tab))].sort((a, b) => a - b);
  return { ws, indexes };
}

/** Enables or disables a machine (PUT /api/m/{id}/enabled); failures are reported. */
async function putEnabled(m: string, enabled: boolean) {
  try {
    const res = await fetch(`/api/m/${encodeURIComponent(m)}/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(t('machine.enableFailed', { detail: await machineError(res) }));
  } catch (e) {
    report(e);
  }
}

/** The slot of an insertion (0 before the first item, n after the last) as
 * the index the moved item ends at. */
export const slotIndex = (from: number, slot: number) => (slot > from ? slot - 1 : slot);

const axisOf = (dir: 'right' | 'down'): L.Axis => (dir === 'right' ? 'horizontal' : 'vertical');

let lastReveal = 0;
/** A strictly increasing reveal token so repeated jumps to the same line trigger again. */
const nextReveal = () => (lastReveal = Math.max(Date.now(), lastReveal + 1));

/** Starts, restarts or stops a machine's terminal core
 * (POST /api/m/{id}/hc/{action}) without asking; one action at a time per
 * machine. Failures are reported. */
async function runCore(m: string, action: 'start' | 'restart' | 'stop') {
  const s = useStore.getState();
  const machine = s.machines[m]?.label ?? m;
  if (s.hcBusy[m]) return;
  s.setHcBusy(m, true);
  try {
    const res = await fetch(`/api/m/${encodeURIComponent(m)}/hc/${action}`, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const code = `backend.${body.error}`;
      throw new Error(t('core.failed', { machine, error: hasMessage(code) ? t(code) : body.error || String(res.status) }));
    }
    s.toast(t(action === 'stop' ? 'core.stopped' : action === 'restart' ? 'core.restarted' : 'core.started', { machine }));
    // A started core is followed again.
    if (action !== 'stop') terms.subscribe(m);
  } catch (e) {
    report(e);
  } finally {
    useStore.getState().setHcBusy(m, false);
  }
}

export const actions = {
  /** Splits a pane: the new terminal starts in its directory (a VS Code
   * pane's folder, a preview's file's directory). */
  async split(m: string, pane: string, dir: 'right' | 'down', argv?: string[]) {
    terms.mutate(m, (l) => focusPaneInLayout(l, pane));
    const layout = terms.layout(m);
    const cwd = layout ? paneDirectory(m, L.findLeaf(layout, pane)) : undefined;
    const at = layout ? L.locate(layout, pane) : null;
    const workspace = at ? layout!.workspaces[at.workspace]?.id : undefined;
    try {
      const address = await terms.run(m, { workspace, split: true, argv, cwd }, (l, a) => {
        const next = L.splitPane(l, pane, axisOf(dir), { terminal: a });
        return next === l ? L.openTerminal(l, a) : next;
      });
      if (address) focusDom(m, address);
    } catch (e) {
      report(e);
    }
  },

  /** Moves a pane into a new tab of another workspace of its machine and
   * shows it there. */
  movePaneToWorkspace(m: string, pane: string, ws: string, create?: { name: string; cwd: string }) {
    const s = useStore.getState();
    if (s.zoomed?.m === m && s.zoomed.pane === pane) s.setZoomed(undefined);
    const moved = terms.mutate(m, (l) =>
      // A new workspace only with the pane in it, which may have closed meanwhile.
      create && L.findLeaf(l, pane)
        ? L.moveToNewTab(L.createWorkspace(l, ws, create.name, create.cwd), pane, ws)
        : L.moveToNewTab(l, pane, ws),
    );
    if (moved) focusDom(m, pane);
  },

  /** Moves a pane into a new workspace: the dialog asks for its directory
   * (the pane's to begin with) and name. */
  async movePaneToNewWorkspace(m: string, pane: string) {
    const layout = terms.layout(m);
    const leaf = layout && L.findLeaf(layout, pane);
    if (!leaf) return;
    void ensureVaultReady();
    const def = paneDirectory(m, leaf) || useStore.getState().machines[m]?.info?.home || '~';
    const input = await newWorkspaceDialog(m, def);
    if (!input) return;
    const id = L.newId();
    actions.movePaneToWorkspace(m, pane, id, { name: input.label, cwd: input.cwd });
    if (input.presets?.length) {
      await ensureVaultReady();
      await saveWorkspacePresets(m, id, input.presets, input.passphrase).catch((e) =>
        useStore
          .getState()
          .toast(
            t('vault.workspace.presetsSaveFailed', { error: e instanceof Error ? e.message : String(e) }),
            undefined,
            undefined,
            'warning',
          ),
      );
    }
  },

  /** Shows a pane alone in its tab, or all of the tab again. */
  zoom(m: string, pane: string) {
    const s = useStore.getState();
    s.setZoomed(s.zoomed?.m === m && s.zoomed.pane === pane ? undefined : { m, pane });
    focusDom(m, pane);
  },

  /** Closes a pane at once, without asking: its terminal ends the undo time
   * later, and Undo Close brings it back until then (closedPanes.ts). */
  async closePane(m: string, pane: string) {
    if (!(await confirmUnsaved(m, [pane]))) return;
    if (!isDetachedWindow() && !(await confirmDetachedTabs(m, [pane]))) return;
    const layout = terms.layout(m);
    if (layout) closeWithUndo(m, layout, [[pane]], t('closed.pane'));
    terms.mutate(m, (l) => L.closePane(l, pane));
  },

  /** Puts back the panes closed last (a pane, a tab's, or the tabs closed
   * together), as they were and where they were, their terminals' programs
   * still running. */
  undoClose() {
    const { tabs, workspaces } = takeClosed();
    // Workspaces first, at their places (the first first), then the tabs
    // at theirs: the first ones first.
    let shown: string | undefined;
    for (const w of workspaces.sort((a, b) => a.index - b.index)) {
      useStore.getState().selectMachine(w.m);
      terms.mutate(w.m, (l) => L.restoreWorkspace(l, w.workspace, w.index, w.known));
      shown = w.m;
    }
    const records = tabs.sort((a, b) => a.index - b.index);
    for (const c of records) {
      const { m } = c;
      const restored = new Map<string, L.Leaf>();
      for (const key of c.closed) {
        const leaf = L.leafOf(c.tab.root, key);
        if (!leaf) continue;
        if (L.isTerminalLeaf(leaf)) {
          // A terminal whose program ended meanwhile stays closed.
          const r = terms.terminal(m, key);
          if (!r || !isLive(r)) continue;
          terms.cancelClose(m, key);
        } else {
          // A view opened again meanwhile stays where it is.
          const layout = terms.layout(m);
          if (layout && L.locate(layout, key)) continue;
        }
        restored.set(key, leaf);
      }
      if (!restored.size) continue;
      useStore.getState().selectMachine(m);
      terms.mutate(m, (l) => L.reopen(l, c, restored));
      shown = m;
    }
    // Each workspace shows the tab it showed, and the last one is shown.
    for (const w of workspaces) {
      terms.mutate(w.m, (l) => {
        const now = l.workspaces.find((x) => x.id === w.workspace.id);
        const back = now && Math.min(w.workspace.selected, now.tabs.length - 1);
        return back !== undefined && back >= 0 ? L.selectTab(l, w.workspace.id, back) : l;
      });
    }
    const layout = shown ? terms.layout(shown) : undefined;
    const focused = layout && L.focusedPane(layout);
    if (shown && focused) focusDom(shown, focused);
  },

  /** A new terminal in a new tab of a workspace (the selected one). */
  async newTab(m?: string, ws?: string, argv?: string[]) {
    m ??= current()?.m ?? useStore.getState().machineId;
    if (!m) return;
    try {
      const address = await terms.run(m, { workspace: ws, argv }, (l, a) =>
        L.openTerminal(l, a, ws && l.workspaces.some((w) => w.id === ws) ? ws : undefined),
      );
      if (address) focusDom(m, address);
    } catch (e) {
      report(e);
    }
  },

  /** Closes a tab at once, without asking: its terminals end the undo time
   * later, and Undo Close brings it back until then. */
  async closeTab(m: string, ws: string, index: number) {
    const layout = terms.layout(m);
    const tab = layout?.workspaces.find((w) => w.id === ws)?.tabs[index];
    if (!layout || !tab) return;
    const panes = L.tabPanes(tab);
    if (!(await confirmUnsaved(m, panes))) return;
    if (!isDetachedWindow() && !(await confirmDetachedTabs(m, panes))) return;
    const liveLayout = terms.layout(m);
    const liveTab = liveLayout?.workspaces.find((w) => w.id === ws)?.tabs[index];
    if (!liveLayout || !liveTab) return;
    closeWithUndo(m, liveLayout, [L.tabPanes(liveTab)], t('closed.tab'));
    terms.mutate(m, (l) => L.closeTab(l, ws, index));
  },

  /** Closes the tabs holding these panes (one each, of one workspace) at
   * once, without asking but for unsaved changes: one Undo Close brings
   * them all back. */
  async closeTabs(m: string, keys: string[]) {
    const before = terms.layout(m);
    const found = before && tabsAt(before, keys);
    if (!found) return;
    if (found.indexes.length === 1) return actions.closeTab(m, found.ws.id, found.indexes[0]);
    const allPanes = found.indexes.flatMap((i) => L.tabPanes(found.ws.tabs[i]));
    if (!(await confirmUnsaved(m, allPanes))) return;
    if (!isDetachedWindow() && !(await confirmDetachedTabs(m, allPanes))) return;
    // Read again: another client may have changed the tabs meanwhile.
    const layout = terms.layout(m);
    const now = layout && tabsAt(layout, keys);
    if (!layout || !now) return;
    const tabs = now.indexes.map((i) => now.ws.tabs[i]);
    closeWithUndo(m, layout, tabs.map(L.tabPanes), t('closed.tabs', { n: tabs.length }));
    terms.mutate(m, (l) => {
      const at = tabsAt(l, keys);
      if (!at) return l;
      // From the last, so the others keep their indexes.
      return [...at.indexes].reverse().reduce((acc, i) => L.closeTab(acc, at.ws.id, i), l);
    });
  },

  /** Closes every tab of a workspace but one (others) or those after it
   * (right), at once, with one Undo, as closeTabs; pinned and detached tabs
   * stay open in their own windows. */
  async closeTabsBeside(m: string, ws: string, index: number, which: 'others' | 'right') {
    const w = terms.layout(m)?.workspaces.find((x) => x.id === ws);
    if (!w?.tabs[index]) return;
    const records = useDetachedTabs.getState().records;
    const keys = w.tabs
      .filter((tab, i) => !tab.pinned && !detachedRecordForTab(m, tab, records) && (which === 'others' ? i !== index : i > index))
      .map((tab) => L.tabPanes(tab)[0]);
    if (keys.length) await actions.closeTabs(m, keys);
  },

  /** Pins a tab (it moves to the end of the pinned ones) or unpins it. */
  muteTab(m: string, ws: string, index: number, muted: boolean) {
    terms.mutate(m, (l) => L.muteTab(l, ws, index, muted));
  },
  muteWorkspace(m: string, ws: string, muted: boolean) {
    terms.mutate(m, (l) => L.muteWorkspace(l, ws, muted));
  },
  pinTab(m: string, ws: string, index: number, pinned: boolean) {
    terms.mutate(m, (l) => L.pinTab(l, ws, index, pinned));
  },

  /** Moves the tabs holding these panes, in their order, as one block to a
   * slot of their workspace's tabs. */
  moveTabs(m: string, keys: string[], slot: number) {
    terms.mutate(m, (l) => {
      const at = tabsAt(l, keys);
      return at ? L.moveTabs(l, at.ws.id, at.indexes, slot) : l;
    });
  },

  /** Moves the tabs holding these panes to the end of another workspace
   * (a new one: create), which is shown with the last of them. */
  moveTabsToWorkspace(m: string, keys: string[], target: string, create?: { name: string; cwd: string }) {
    const moved = terms.mutate(m, (l) => {
      const at = tabsAt(l, keys);
      if (!at) return l;
      return L.moveTabsToWorkspace(create ? L.createWorkspace(l, target, create.name, create.cwd) : l, at.ws.id, at.indexes, target);
    });
    const layout = terms.layout(m);
    const focused = moved && layout && L.focusedPane(layout);
    if (focused) focusDom(m, focused);
  },

  /** Moves tabs into a new workspace: the dialog asks for its directory
   * (the first tab's focused pane's to begin with) and name. */
  async moveTabsToNewWorkspace(m: string, keys: string[]) {
    const layout = terms.layout(m);
    const at = layout && tabsAt(layout, keys);
    if (!at) return;
    void ensureVaultReady();
    const first = at.ws.tabs[at.indexes[0]];
    const def = paneDirectory(m, L.leafOf(first.root, first.focused)) || useStore.getState().machines[m]?.info?.home || '~';
    const input = await newWorkspaceDialog(m, def);
    if (!input) return;
    const id = L.newId();
    actions.moveTabsToWorkspace(m, keys, id, { name: input.label, cwd: input.cwd });
    if (input.presets?.length) {
      await ensureVaultReady();
      await saveWorkspacePresets(m, id, input.presets, input.passphrase).catch((e) =>
        useStore
          .getState()
          .toast(
            t('vault.workspace.presetsSaveFailed', { error: e instanceof Error ? e.message : String(e) }),
            undefined,
            undefined,
            'warning',
          ),
      );
    }
  },

  /** Adds an SSH machine to the hub's machines (docs/features/02) and
   * reports whether it was added. It connects at once; when it needs an
   * interactive login (auth_required) the authentication terminal opens. */
  async addMachine(form: { target: string; label: string }): Promise<boolean> {
    const machine = form.label.trim() || form.target.trim();
    try {
      const res = await fetch('/api/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: form.target.trim(), label: form.label.trim() }),
      });
      if (!res.ok) throw new Error(t('machine.addFailed', { machine, detail: await machineError(res) }));
      const st = (await res.json()) as { id: string };
      useStore.getState().toast(t('addMachine.addedToast', { machine }));
      awaitLogin(st.id);
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  },

  /** Enables or disables a machine (stored by the hub). Disabling a
   * connected machine asks first (and offers to stop its terminal service):
   * its agent disconnects and VS Code there stops; its programs keep running
   * there. Already-offline machines disable directly without asking. */
  async setMachineEnabled(m: string, enabled: boolean) {
    const st = useStore.getState().machines[m];
    const machine = st?.label ?? m;
    let stop = false;
    if (!enabled && st?.status === 'ready' && !st.code) {
      const res = await confirmCheckDialog({
        title: t('confirm.disableMachineTitle', { machine }),
        message: t('confirm.disableMachine'),
        confirm: t('menu.disableMachine'),
        danger: true,
        check: t('confirm.disableStopCore'),
        checked: false,
      });
      if (!res) return;
      stop = res.checked;
    }
    // Stopped before the session ends; a failed stop is reported and the
    // machine is disabled all the same.
    if (stop) await runCore(m, 'stop');
    await putEnabled(m, enabled);
  },

  /** Enables or disables several machines; disabling asks once when any is
   * connected, naming them, and may stop the terminal services of those
   * connected. Already-offline machines disable directly without asking.
   * Machines already so, and those never connected (a code), are left. */
  async setMachinesEnabled(ids: string[], enabled: boolean) {
    const s = useStore.getState();
    const list = ids
      .map((id) => s.machines[id])
      .filter((st) => st && !st.code && (enabled ? st.status === 'disabled' : st.status !== 'disabled'));
    if (list.length <= 1) return list[0] && actions.setMachineEnabled(list[0].id, enabled);
    let stop = false;
    if (!enabled && list.some((st) => st.status === 'ready')) {
      const res = await confirmCheckDialog({
        title: t('confirm.disableMachinesTitle', { n: list.length }),
        message: t('confirm.disableMachines', { machines: quotedNames(list.map((st) => st.label)) }),
        confirm: t('confirm.disable'),
        danger: true,
        check: t('confirm.disableStopCores'),
        checked: false,
      });
      if (!res) return;
      stop = res.checked;
    }
    await Promise.all(
      list.map(async (st) => {
        if (stop && st.status === 'ready') await runCore(st.id, 'stop');
        await putEnabled(st.id, enabled);
      }),
    );
  },

  /** Removes an SSH machine from the hub's machines after asking. */
  async removeMachine(m: string) {
    const st = useStore.getState().machines[m];
    const machine = st?.label ?? m;
    if (
      !(await confirmDialog({
        title: t('confirm.removeMachineTitle', { machine }),
        message: t('confirm.removeMachine', { target: st?.target ?? machine }),
        confirm: t('confirm.remove'),
        danger: true,
      }))
    )
      return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('machine.removeFailed', { machine, detail: await machineError(res) }));
      useStore.getState().toast(t('machine.removed', { machine }));
    } catch (e) {
      report(e);
    }
  },

  /** Removes several SSH machines after asking once, naming them. */
  async removeMachines(ids: string[]) {
    const s = useStore.getState();
    const list = ids.map((id) => s.machines[id]).filter((st) => st?.kind === 'ssh');
    if (list.length <= 1) return list[0] && actions.removeMachine(list[0].id);
    if (
      !(await confirmDialog({
        title: t('confirm.removeMachinesTitle', { n: list.length }),
        message: t('confirm.removeMachines', { machines: quotedNames(list.map((st) => st.label)) }),
        confirm: t('confirm.remove'),
        danger: true,
      }))
    )
      return;
    let removed = 0;
    for (const st of list) {
      try {
        const res = await fetch(`/api/m/${encodeURIComponent(st.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(t('machine.removeFailed', { machine: st.label, detail: await machineError(res) }));
        removed++;
      } catch (e) {
        report(e);
      }
    }
    if (removed) useStore.getState().toast(t('machine.removedMany', { n: removed }));
  },

  /** Renames an SSH machine. */
  async renameMachine(m: string, label: string) {
    const st = useStore.getState().machines[m];
    if (!label || !st || label === st.label) return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(t('machine.renameFailed', { machine: st.label, detail: await machineError(res) }));
    } catch (e) {
      report(e);
    }
  },

  /** Moves a machine to a slot of the machines (0 before the first, the
   * machine count after the last): shown at once, stored by the hub
   * (PUT /api/machines/order), which sends every page the new list. */
  async moveMachine(m: string, slot: number) {
    return actions.moveMachines([m], slot);
  },

  /** Moves machines, in their order, as one block to a slot of the
   * machines; stored as moveMachine does. */
  async moveMachines(ids: string[], slot: number) {
    const before = useStore.getState().order;
    const order = L.movedBlock(
      before,
      ids.map((id) => before.indexOf(id)),
      slot,
    );
    if (order.every((x, i) => x === before[i])) return;
    useStore.setState({ order });
    try {
      const res = await fetch('/api/machines/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (!res.ok) throw new Error(t('machine.orderFailed', { detail: await machineError(res) }));
    } catch (e) {
      if (useStore.getState().order === order) useStore.setState({ order: before });
      report(e);
    }
  },

  /** Starts, restarts or stops a machine's terminal core
   * (POST /api/m/{id}/hc/{action}); restarting and stopping ask first. One
   * action at a time per machine. */
  async terminalCore(m: string, action: 'start' | 'restart' | 'stop') {
    const s = useStore.getState();
    const machine = s.machines[m]?.label ?? m;
    if (s.hcBusy[m]) return;
    if (
      action !== 'start' &&
      !(await confirmDialog({
        title: t(action === 'stop' ? 'core.stopTitle' : 'core.restartTitle', { machine }),
        message: t(action === 'stop' ? 'core.stopInfo' : 'core.restartInfo'),
        confirm: t(action === 'stop' ? 'core.stop' : 'core.restart'),
        danger: action === 'stop',
      }))
    )
      return;
    await runCore(m, action);
  },

  /** Creates a workspace and opens a terminal in it. Without a directory the
   * dialog asks for one and a name; without a name it is shown with its
   * directory's (L.workspaceTitle). */
  async newWorkspace(m?: string, cwd?: string, name = '') {
    m ??= useStore.getState().machineId;
    if (!m) return;
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    let presets: string[] | undefined;
    let passphrase: string | undefined;
    if (cwd === undefined) {
      void ensureVaultReady();
      const c = current();
      const def = (c?.m === m && terms.directory(m, c.focused)) || useStore.getState().machines[m]?.info?.home || '~';
      const input = await newWorkspaceDialog(m, def);
      if (!input) return;
      cwd = input.cwd;
      name = input.label;
      presets = input.presets;
      passphrase = input.passphrase;
    }
    const id = L.newId();
    const own = name.trim();
    const dir = cwd;
    await whenLoaded(m);
    terms.mutate(m, (l) => L.createWorkspace(l, id, own, dir));
    if (presets?.length) {
      await ensureVaultReady();
      await saveWorkspacePresets(m, id, presets, passphrase).catch((e) =>
        useStore
          .getState()
          .toast(
            t('vault.workspace.presetsSaveFailed', { error: e instanceof Error ? e.message : String(e) }),
            undefined,
            undefined,
            'warning',
          ),
      );
    }
    await actions.newTab(m, id);
  },

  /** Closes a workspace at once, without asking: its terminals end
   * the undo time later, and Undo Close brings it back until then. */
  async closeWorkspace(m: string, ws: string) {
    return actions.closeWorkspaces(m, [ws]);
  },

  /** Moves a tab to a slot of its workspace's tabs: 0 is before the first
   * tab, the tab count after the last. */
  moveTab(m: string, ws: string, from: number, slot: number) {
    terms.mutate(m, (l) => L.moveTab(l, ws, from, slotIndex(from, slot)));
  },

  /** Moves a workspace to a slot of its machine's workspaces. */
  moveWorkspace(m: string, ws: string, slot: number) {
    terms.mutate(m, (l) => {
      const from = l.workspaces.findIndex((w) => w.id === ws);
      return from < 0 ? l : L.moveWorkspace(l, ws, slotIndex(from, slot));
    });
  },

  /** Moves workspaces, in their order, as one block to a slot of their machine's. */
  moveWorkspaces(m: string, ids: string[], slot: number) {
    terms.mutate(m, (l) => L.moveWorkspaces(l, ids, slot));
  },

  /** Closes every other workspace of a machine, as closeWorkspaces does. */
  async closeOtherWorkspaces(m: string, ws: string) {
    const others = (terms.layout(m)?.workspaces ?? []).filter((w) => w.id !== ws).map((w) => w.id);
    if (others.length) await actions.closeWorkspaces(m, others);
  },

  /** Closes workspaces of a machine at once, without asking (but for
   * unsaved changes): their terminals end the undo time later, and one Undo
   * Close brings them all back, at their places, until then. */
  async closeWorkspaces(m: string, ids: string[]) {
    const layout = terms.layout(m);
    const list = ids.map((id) => layout?.workspaces.find((w) => w.id === id)).filter((w) => w !== undefined);
    if (!list.length) return;
    const allPanes = list.flatMap((w) => w.tabs.flatMap(L.tabPanes));
    if (!(await confirmUnsaved(m, allPanes))) return;
    if (!isDetachedWindow() && !(await confirmDetachedTabs(m, allPanes))) return;
    // What they hold now: another client may have changed them meanwhile.
    const now = terms.layout(m);
    if (!now) return;
    const group = closingGroup();
    const at = Date.now();
    const closed = list.flatMap((w) => rememberWorkspace(m, now, w.id, at, group) ?? []);
    const message =
      list.length === 1 ? t('closed.workspace', { label: workspaceTitle(m, list[0]) }) : t('closed.workspaces', { n: list.length });
    undoable(m, closed, message, true);
    terms.mutate(m, (l) => ids.reduce((acc, id) => L.closeWorkspace(acc, id), l));
  },

  /** Starts renaming in place; the tab, workspace or pane header shows an editor. */
  startRename(kind: 'pane' | 'tab' | 'workspace' | 'machine', m: string, id: string) {
    const s = useStore.getState();
    if ((kind === 'workspace' || kind === 'machine') && !s.sidebarOpen) s.toggleSidebar();
    s.setRenaming({ kind, m, id });
  },

  /** Names a tab; an empty name gives it its terminal's title again. */
  renameTab(m: string, ws: string, index: number, name: string) {
    terms.mutate(m, (l) => L.renameTab(l, ws, index, name));
  },

  /** Names a workspace; an empty name shows its folder's again. */
  renameWorkspace(m: string, ws: string, name: string) {
    terms.mutate(m, (l) => L.renameWorkspace(l, ws, name.trim()));
  },

  /** Edits a workspace's name and directory in a dialog. An emptied name
   * shows its folder's again; an emptied directory has its new terminals
   * start in the focused pane's. */
  async editWorkspace(m: string, ws: string) {
    const w = terms.layout(m)?.workspaces.find((x) => x.id === ws);
    if (!w) return;
    void ensureVaultReady();
    const input = await editWorkspaceDialog(m, w.cwd, w.name, w.id);
    if (!input) return;
    terms.mutate(m, (l) => L.editWorkspace(l, ws, input.label, input.cwd));
    if (input.presets !== undefined) {
      await ensureVaultReady();
      await saveWorkspacePresets(m, ws, input.presets, input.passphrase).catch((e) =>
        useStore
          .getState()
          .toast(
            t('vault.workspace.presetsSaveFailed', { error: e instanceof Error ? e.message : String(e) }),
            undefined,
            undefined,
            'warning',
          ),
      );
    }
  },

  /** Names a terminal's pane (its "name" label); empty shows its title again. */
  async renamePane(m: string, terminal: string, name: string) {
    await terms.call(m, 'terminal.label', { terminal, labels: { name } }).catch(report);
  },

  /** Shows a machine: its terminals are followed from now on. */
  showMachine(m: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
  },

  selectWorkspace(m: string, ws: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    terms.mutate(m, (l) => L.selectWorkspace(l, ws));
  },

  selectTab(m: string, ws: string, index: number) {
    terms.mutate(m, (l) => L.selectTab(l, ws, index));
  },

  /** Selects a pane's machine, workspace and tab and gives it the focus.
   * When called from the main window for a pane hosted in a detached window,
   * updates that tab's focused pane in place and brings the detached window
   * forward instead of leaving the main window on a hidden tab. */
  focusPane(m: string, pane: string) {
    if (!isDetachedWindow()) {
      const detached = detachedRecordForPane(m, pane);
      if (detached) {
        terms.mutate(m, (l) => {
          const at = L.locate(l, pane);
          if (!at) return l;
          const ws = l.workspaces[at.workspace];
          const tab = ws.tabs[at.tab];
          if (tab.focused === pane) return l;
          const tabs = ws.tabs.map((t, i) => (i === at.tab ? { ...t, focused: pane } : t));
          const workspaces = l.workspaces.map((w, i) => (i === at.workspace ? { ...w, tabs } : w));
          return { ...l, workspaces };
        });
        void focusDetachedRecord(detached);
        return;
      }
    }
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    terms.mutate(m, (l) => focusPaneInLayout(l, pane));
    focusDom(m, pane);
  },

  focusDirection(dir: L.Direction) {
    const c = current();
    if (!c?.ws || !c.tab) return;
    const scoped: L.Layout = { version: c.layout.version, selected: 0, workspaces: [{ ...c.ws, selected: c.tabIndex }] };
    const next = L.neighbor(scoped, dir);
    if (next) actions.focusPane(c.m, next);
  },

  /** Goes back (-1) or forward (1) through the panes focused (paneHistory.ts). */
  goPane(step: -1 | 1) {
    const s = go(step, spotOpen);
    if (s) actions.focusPane(s.m, s.pane);
  },

  cyclePane(step: number) {
    const c = current();
    if (!c?.tab) return;
    const ids = L.tabPanes(c.tab);
    if (!ids.length) return;
    const i = c.focused ? ids.indexOf(c.focused) : -1;
    actions.focusPane(c.m, ids[(i + step + ids.length) % ids.length]);
  },

  /** Selects the next (1) or previous (-1) workspace of the shown machine. */
  cycleWorkspace(step: number) {
    const c = current();
    const n = c?.layout.workspaces.length ?? 0;
    if (!c || n < 2) return;
    actions.selectWorkspace(c.m, c.layout.workspaces[(c.layout.selected + step + n) % n].id);
  },

  /** Selects the next (1) or previous (-1) visible tab, the visible tab at an
   * index, or the last visible one (skipping tabs open in detached windows). */
  switchTab(step: number | { index: number } | { last: true }) {
    const c = current();
    if (!c?.ws) return;
    const records = useDetachedTabs.getState().records;
    const visible = c.ws.tabs.map((tb, i) => ({ tb, i })).filter(({ tb }) => !detachedRecordForTab(c.m, tb, records));
    const n = visible.length;
    if (!n) return;
    let target: number | undefined;
    if (typeof step === 'number') {
      const pos = visible.findIndex((x) => x.i === c.tabIndex);
      target = visible[((pos >= 0 ? pos : 0) + step + n) % n]?.i;
    } else if ('last' in step) {
      target = visible[n - 1]?.i;
    } else {
      target = visible[step.index]?.i;
    }
    if (target !== undefined) actions.selectTab(c.m, c.ws.id, target);
  },

  /** The focused pane (the terminal, when it is one), its machine and the
   * directory it works in, else its workspace's. */
  focusedContext(): { m: string; pane?: string; terminal?: string; cwd?: string } | undefined {
    const c = current();
    if (!c) return undefined;
    const leaf = c.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
    const terminal = leaf && L.isTerminalLeaf(leaf) ? leaf.terminal : undefined;
    const cwd = (leaf ? paneDirectory(c.m, leaf) : undefined) ?? (c.ws?.cwd || undefined);
    return { m: c.m, pane: leaf ? c.focused : undefined, terminal, cwd };
  },

  /** Opens a file in the File Explorer plugin's editor/preview pane: in a tab
   * of the workspace by default (or split beside from with side), reusing an
   * existing editor for the same path or an unedited preview editor. */
  async openEditor(
    m: string,
    path: string,
    o: { preview?: boolean; side?: boolean; line?: number; col?: number; endLine?: number; endCol?: number; from?: string } = {},
  ) {
    await whenLoaded(m);
    const preview = !!o.preview && !o.side;
    const hasLine = typeof o.line === 'number' && o.line > 0;
    const endLine = hasLine && typeof o.endLine === 'number' && o.endLine >= o.line! ? o.endLine : undefined;
    const endCol = endLine !== undefined && typeof o.endCol === 'number' && o.endCol > 0 ? o.endCol : undefined;
    const at = hasLine
      ? {
          line: o.line,
          col: o.col && o.col > 0 ? o.col : 1,
          endLine,
          endCol,
          reveal: nextReveal(),
        }
      : { line: undefined, col: undefined, endLine: undefined, endCol: undefined, reveal: undefined };
    const view = { plugin: 'files', kind: 'editor', path, ...at };
    const tab = !o.side;
    const layout = terms.layout(m);
    const ws = layout ? originOf(m, layout, o.from).ws : undefined;
    const openEditors = ws ? L.pluginViews(ws, 'files', 'editor').map((v) => v.view) : [];
    if (openEditors.some((v) => v.path === path))
      return actions.openView(m, preview ? view : { ...view, preview: false }, { reuse: (v) => v.path === path, tab, from: o.from });
    const replaceable = (v: L.PluginView) => preview && v.preview === true && !unsavedPanes(m, [L.viewKey(v.id)]).length;
    return actions.openView(m, { ...view, preview }, { reuse: replaceable, tab, from: o.from });
  },

  /** Opens a path found in a pane (from; the focused pane by default): by
   * default (files.openLinks = 'editor') in the File Explorer plugin's
   * preview/editor pane (navigating to line/col/endLine when given); when
   * files.openLinks is 'vscode' (or when the files plugin is off) non-media
   * files open in VS Code when its plugin is on, falling back to Quick Look
   * (openPreview). */
  async openPath(m: string, path: string, line?: number, col?: number, from?: string, endLine?: number, endCol?: number) {
    const preferCode = settingValue('files.openLinks') === 'vscode';
    if (preferCode) {
      if (!mediaExt.test(path) && isPluginOn('vscode')) return actions.openInCode(m, path, line, col, from);
      if (isPluginOn('files')) return actions.openEditor(m, path, { preview: true, line, col, endLine, endCol, from });
      return actions.openPreview(m, path, from);
    }
    if (isPluginOn('files')) return actions.openEditor(m, path, { preview: true, line, col, endLine, endCol, from });
    // Without the files plugin (or VS Code), Quick Look shows text as well.
    if (mediaExt.test(path) || !isPluginOn('vscode')) return actions.openPreview(m, path, from);
    return actions.openInCode(m, path, line, col, from);
  },

  /** Opens a file in VS Code at the line, as openPath does for files that
   * are not media; media too (a preview's Open in VS Code). */
  async openInCode(m: string, path: string, line?: number, col?: number, from?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const o = originOf(m, layout, from);
    const cmd: BridgeCommand = { cmd: 'openFile', path, line, col };
    const views = o.ws ? L.codeViews(o.ws) : [];
    const holds = (v: (typeof views)[number]) => L.folderHolds(v.view.folder, path);
    const found = views.find((v) => v.tab === o.tab && holds(v)) ?? views.find(holds) ?? views.find((v) => v.tab === o.tab) ?? views[0];
    if (found) return showCode(m, found.key, found.view, !hasFrame(m, found.view.id), cmd);
    const near = [paneDirectory(m, o.from ? L.findLeaf(layout, o.from) : null), o.ws?.cwd].find((d) => d && L.folderHolds(d, path));
    const view = { id: L.newId(), folder: L.normFolder(near ?? dirname(path)) };
    openBeside(m, { code: view }, o.ws, o.from);
    await showCode(m, L.codeKey(view.id), view, true, cmd);
  },

  /** Shows a file or directory in a preview pane of from's workspace (from:
   * the focused pane by default), the one of from's tab first; else in a new
   * one split beside from. */
  async openPreview(m: string, path: string, from?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const o = originOf(m, layout, from);
    const views = o.ws ? L.previewViews(o.ws) : [];
    const found = views.find((v) => v.tab === o.tab) ?? views[0];
    useStore.getState().selectMachine(m);
    if (found) {
      terms.mutate(m, (l) => L.focusPane(L.setPreviewPath(l, found.key, path), found.key));
      focusDom(m, found.key);
      return;
    }
    const id = L.newId();
    openBeside(m, { preview: { id, path } }, o.ws, o.from);
    focusDom(m, L.previewKey(id));
  },

  /** Shows a plugin's pane in from's workspace (from: the focused pane by
   * default): one of its kind that reuse accepts gets fields, the one of
   * from's tab first, then (for a pane opened as a tab) any of the
   * workspace's; else a new one opens, in a tab of its own (tab: editors,
   * diffs, graphs, as terminals and VS Code open) or split beside from.
   * Returns its key. */
  async openView(
    m: string,
    view: { plugin: string; kind: string } & Record<string, unknown>,
    opts: { from?: string; reuse?: (v: L.PluginView) => boolean; tab?: boolean } = {},
  ) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const o = originOf(m, layout, opts.from);
    useStore.getState().selectMachine(m);
    const views = o.ws ? L.pluginViews(o.ws, view.plugin, view.kind).filter((v) => opts.reuse?.(v.view)) : [];
    // A pane beside from is reused in from's tab only: one in another tab
    // would take the view away from from.
    const found = views.find((v) => v.tab === o.tab) ?? (opts.tab ? views[0] : undefined);
    if (found) {
      terms.mutate(m, (l) => L.focusPane(L.setViewFields(l, found.key, view), found.key));
      focusDom(m, found.key);
      return found.key;
    }
    const id = L.newId();
    if (opts.tab) terms.mutate(m, (l) => L.openPane(l, { view: { ...view, id } }, o.ws?.id));
    else openBeside(m, { view: { ...view, id } }, o.ws, o.from);
    focusDom(m, L.viewKey(id));
    return L.viewKey(id);
  },

  /** Opens VS Code for a folder (the workspace's by default) as a new tab of
   * the selected workspace, or selects the VS Code pane that workspace has
   * for the folder. */
  async openCode(m: string, folder?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const ws = L.selectedWorkspace(layout);
    const home = useStore.getState().machines[m]?.info?.home ?? '';
    const f = L.normFolder(folder ?? (ws?.cwd || home));
    const found = ws && L.codeViews(ws).find((v) => L.normFolder(v.view.folder) === f);
    if (found) return showCode(m, found.key, found.view, false);
    const view = { id: L.newId(), folder: f };
    terms.mutate(m, (l) => L.openPane(l, { code: view }, ws?.id));
    await showCode(m, L.codeKey(view.id), view, true);
  },

  /** Shows a folder's changes (VS Code's multi-file diff) beside a pane. */
  openDiff(m: string, folder?: string, from?: string) {
    return codeBeside(m, folder, from, { cmd: 'openDiff', repo: folder });
  },

  /** Opens Git Graph of a folder's repository beside a pane. */
  openGitGraph(m: string, folder?: string, from?: string) {
    return codeBeside(m, folder, from, { cmd: 'gitGraph', repo: folder });
  },

  /** Loads a VS Code pane's window again. */
  reloadCode(m: string, id: string) {
    reloadFrame(m, id);
  },

  /** Stops a machine's code-server, which frees its memory there: this
   * page's VS Code panes of the machine offer to start it again. */
  async stopCode(m: string) {
    setStopped(m, true);
    await fetch(`/api/m/${encodeURIComponent(m)}/code/stop`, { method: 'POST' }).catch(() => {});
  },

  toggleSidebar() {
    useStore.getState().toggleSidebar();
  },

  /** The selected tab: its machine, workspace, index and name. */
  currentTab() {
    const c = current();
    if (!c?.ws || !c.tab) return undefined;
    return { m: c.m, ws: c.ws.id, index: c.tabIndex, name: tabName(c.m, c.tab) };
  },

  /** Jump to the agent that most needs attention (blocked first, then
   * done): a terminal's, a plugin's pane's, or an unopened chat. */
  openAttention() {
    const best = attentionList()[0];
    if (best) focusAttention(best);
  },
};

/** A workspace's name as shown: the user's explicit name, else the basename of
 * its configured fixed directory (ws.cwd) even when its panes navigate
 * elsewhere, else the folder of its only or focused pane when it has no fixed
 * directory; the home directory of its machine as "~". */
export function workspaceTitle(m: string, ws: L.Workspace): string {
  const home = useStore.getState().machines[m]?.info?.home;
  if (ws.cwd.trim()) return L.workspaceTitle(ws, home);
  const leaf = L.soleLeaf(ws) ?? L.focusedLeaf(ws);
  const dir = !leaf
    ? undefined
    : L.isCodeLeaf(leaf)
      ? leaf.code.folder
      : L.isTerminalLeaf(leaf)
        ? terms.directory(m, leaf.terminal)
        : L.isPluginLeaf(leaf)
          ? describeView(m, leaf.view).directory
          : undefined;
  return L.workspaceTitle(ws, home, dir);
}

/** A pane's title: a terminal's (terminalTitle), a VS Code pane's folder
 * name, a preview's file name. */
export function paneTitle(m: string, leaf: L.Leaf | null, key: string): string {
  if (leaf && L.isCodeLeaf(leaf)) return L.folderName(leaf.code.folder, useStore.getState().machines[m]?.info?.home);
  if (leaf && L.isPreviewLeaf(leaf)) return leaf.preview.path.split('/').pop() || leaf.preview.path;
  if (leaf && L.isPluginLeaf(leaf)) return describeView(m, leaf.view).title;
  return terminalTitle(terms.terminal(m, key), key);
}

/** A tab's name: its own, else its focused pane's title. */
export function tabName(m: string, tab: L.Tab): string {
  return tab.name || paneTitle(m, L.leafOf(tab.root, tab.focused), tab.focused);
}

/** What a tab is called in its tab bar: its own name, else its position
 * (1 for the first); its terminals' titles are in its tooltip and their
 * pane headers. */
export function tabLabel(tab: L.Tab, index: number): string {
  return tab.name || String(index + 1);
}

/** Where a terminal is, as places outside the tab bar name it: its
 * workspace and its tab ("website · 2", or the tab's own name); '' when it
 * is in no tab. */
export function terminalPlace(m: string, terminal: string): string {
  const layout = terms.layout(m);
  const at = layout && L.locate(layout, terminal);
  if (!layout || !at) return '';
  const ws = layout.workspaces[at.workspace];
  return `${workspaceTitle(m, ws)} · ${tabLabel(ws.tabs[at.tab], at.tab)}`;
}

/** Resolves once a machine's layout was read. */
function whenLoaded(m: string): Promise<void> {
  if (terms.layout(m)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useTerms.subscribe((s) => {
      if (s.machines[m]?.layout) {
        off();
        resolve();
      }
    });
  });
}
