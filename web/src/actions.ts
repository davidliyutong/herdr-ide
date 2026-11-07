// User-level commands shared by buttons, the keymap and the command palette.

import { conn } from './lib/conn';
import type { LayoutNode, Pane, Snapshot } from './lib/herdr';
import { paneCwd, statusRank, workspaceTabs } from './lib/herdr';
import { activeTabId, useStore } from './state/store';
import { getTerm } from './terminal/registry';
import { mediaExt } from './terminal/links';
import { bridge } from './lib/bridge';
import { t } from './i18n';
import { confirmDialog, newWorkspaceDialog } from './dialog';

export interface AttentionItem {
  m: string;
  pane: Pane;
}

/** Agent panes across all machines ordered by how much they need the user. */
export function attentionList(): AttentionItem[] {
  const s = useStore.getState();
  const out: AttentionItem[] = [];
  for (const m of s.order) {
    for (const p of s.machines[m]?.snapshot?.panes ?? []) {
      if (p.agent) out.push({ m, pane: p });
    }
  }
  return out.sort((a, b) => statusRank[b.pane.agent_status] - statusRank[a.pane.agent_status]);
}

type Rect = { x: number; y: number; w: number; h: number };

export function paneRects(node: LayoutNode, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()) {
  if (node.type === 'pane') {
    out.set(node.pane_id, r);
    return out;
  }
  if (node.direction === 'right') {
    const w1 = r.w * node.ratio;
    paneRects(node.first, { x: r.x, y: r.y, w: w1, h: r.h }, out);
    paneRects(node.second, { x: r.x + w1, y: r.y, w: r.w - w1, h: r.h }, out);
  } else {
    const h1 = r.h * node.ratio;
    paneRects(node.first, { x: r.x, y: r.y, w: r.w, h: h1 }, out);
    paneRects(node.second, { x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 }, out);
  }
  return out;
}

function current() {
  const s = useStore.getState();
  const m = s.machineId;
  const snap = m ? s.machines[m]?.snapshot : undefined;
  const ws = s.workspaceId;
  if (!m || !snap || !ws) return undefined;
  const tab = activeTabId(s, m, snap, ws);
  const layout = tab ? s.machines[m]?.layouts?.[tab] : undefined;
  const focused = s.focused?.m === m ? s.focused.pane : undefined;
  return { s, m, snap, ws, tab, layout, focused };
}

function focusPane(m: string, pane: string) {
  useStore.getState().focusPane({ m, pane });
  // The terminal mounts on the next render when the pane is new.
  setTimeout(() => getTerm(m, pane)?.focus(), 30);
}

function report(e: unknown) {
  console.warn(e);
  const msg = e instanceof Error ? e.message : String(e);
  useStore.getState().toast?.(msg);
}

function cwdOf(snap: Snapshot | undefined, pane?: string) {
  return paneCwd(snap?.panes.find((p) => p.pane_id === pane));
}

export const actions = {
  async split(m: string, pane: string, direction: 'right' | 'down') {
    const snap = useStore.getState().machines[m]?.snapshot;
    try {
      const res = await conn.api(m, 'pane.split', { target_pane_id: pane, direction, cwd: cwdOf(snap, pane), focus: false });
      const id = res?.pane?.pane_id;
      if (id) focusPane(m, id);
    } catch (e) {
      report(e);
    }
  },

  async zoom(m: string, pane: string) {
    await conn.api(m, 'pane.zoom', { pane_id: pane, mode: 'toggle' }).catch(report);
    focusPane(m, pane);
  },

  async closePane(m: string, pane: string) {
    const p = useStore.getState().machines[m]?.snapshot?.panes.find((x) => x.pane_id === pane);
    if (
      p?.agent &&
      p.agent_status === 'working' &&
      !(await confirmDialog({
        title: t('confirm.closePaneTitle'),
        message: t('confirm.closeWorkingPane', { agent: p.agent }),
        confirm: t('confirm.close'),
        danger: true,
      }))
    )
      return;
    await conn.api(m, 'pane.close', { pane_id: pane }).catch(report);
  },

  async newTab(m?: string, ws?: string) {
    const c = current();
    m ??= c?.m;
    ws ??= c?.ws;
    if (!m || !ws) return;
    // The focused pane's cwd, when it is in that workspace.
    const focused = c?.m === m ? c.snap.panes.find((p) => p.pane_id === c.focused && p.workspace_id === ws) : undefined;
    try {
      const res = await conn.api(m, 'tab.create', { workspace_id: ws, cwd: paneCwd(focused), focus: false });
      const tab = res?.tab?.tab_id;
      if (tab) useStore.getState().selectTab(m, ws, tab);
      const root = res?.root_pane?.pane_id;
      if (root) focusPane(m, root);
    } catch (e) {
      report(e);
    }
  },

  /** Closes a tab, asking first when an agent in it is working, or always
   * with `confirm` (the desktop app's close-tab shortcut). */
  async closeTab(m: string, tab: string, opts: { confirm?: boolean } = {}) {
    const snap = useStore.getState().machines[m]?.snapshot;
    const panes = snap?.panes.filter((p) => p.tab_id === tab) ?? [];
    const busy = panes.filter((p) => p.agent && p.agent_status === 'working');
    if (
      (busy.length || opts.confirm) &&
      !(await confirmDialog({
        title: t('confirm.closeTabTitle'),
        message: busy.length
          ? t('confirm.closeWorkingTab', { n: busy.length })
          : t('confirm.closeTabPanes', { n: Math.max(panes.length, 1) }),
        confirm: t('confirm.close'),
        danger: true,
      }))
    )
      return;
    await conn.api(m, 'tab.close', { tab_id: tab }).catch(report);
  },

  /** Enables or disables a machine (saved by the core over herdr's catalog).
   * Disabling a connected machine asks first: its agent disconnects and
   * VS Code there stops; its panes keep running in herdr. */
  async setMachineEnabled(m: string, enabled: boolean) {
    const st = useStore.getState().machines[m];
    if (
      !enabled &&
      st?.status !== 'disabled' &&
      !(await confirmDialog({
        title: t('confirm.disableMachineTitle', { machine: st?.label ?? m }),
        message: t('confirm.disableMachine'),
        confirm: t('menu.disableMachine'),
        danger: true,
      }))
    )
      return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(t('machine.enableFailed', { detail: (await res.text()).trim() || String(res.status) }));
    } catch (e) {
      report(e);
    }
  },

  async newWorkspace(m?: string, cwd?: string) {
    const c = current();
    m ??= c?.m;
    if (!m) return;
    let label: string | undefined;
    if (cwd === undefined) {
      const def = (c?.m === m && c.focused && cwdOf(c.snap, c.focused)) || useStore.getState().machines[m]?.info?.home || '~';
      const input = await newWorkspaceDialog(m, def);
      if (!input) return;
      cwd = input.cwd;
      label = input.label || undefined;
    }
    try {
      const res = await conn.api(m, 'workspace.create', { cwd, label, focus: false });
      const ws = res?.workspace?.workspace_id;
      if (ws) useStore.getState().selectWorkspace(m, ws);
      const root = res?.root_pane?.pane_id;
      if (root) focusPane(m, root);
    } catch (e) {
      report(e);
    }
  },

  async closeWorkspace(m: string, ws: string) {
    const label = useStore.getState().machines[m]?.snapshot?.workspaces.find((w) => w.workspace_id === ws)?.label ?? ws;
    if (
      !(await confirmDialog({
        title: t('confirm.closeWorkspaceTitle'),
        message: t('confirm.closeWorkspace', { label }),
        confirm: t('confirm.close'),
        danger: true,
      }))
    )
      return;
    await conn.api(m, 'workspace.close', { workspace_id: ws }).catch(report);
  },

  /** Moves a tab to a slot of its workspace's tab order: 0 is before the
   * first tab, the tab count after the last (herdr's insert_index). */
  async moveTab(m: string, tab: string, index: number) {
    try {
      const res = await conn.api(m, 'tab.move', { tab_id: tab, insert_index: index });
      if (res?.tabs) useStore.getState().setOrder(m, { tabs: res.tabs });
    } catch (e) {
      useStore.getState().toast(t('workspace.moveFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  },

  /** Moves a workspace to a slot of its machine's workspace order. */
  async moveWorkspace(m: string, ws: string, index: number) {
    try {
      const res = await conn.api(m, 'workspace.move', { workspace_id: ws, insert_index: index });
      if (res?.workspaces) useStore.getState().setOrder(m, { workspaces: res.workspaces });
    } catch (e) {
      useStore.getState().toast(t('sidebar.moveFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  },

  /** Starts renaming in place; the tab, workspace or pane header shows an editor. */
  startRename(kind: 'pane' | 'tab' | 'workspace', m: string, id: string) {
    const s = useStore.getState();
    if (kind === 'workspace' && !s.sidebarOpen) s.toggleSidebar();
    s.setRenaming({ kind, m, id });
  },

  async renameTab(m: string, tab: string, label: string) {
    if (!label) return;
    await conn.api(m, 'tab.rename', { tab_id: tab, label }).catch(report);
  },

  async renameWorkspace(m: string, ws: string, label: string) {
    if (!label) return;
    await conn.api(m, 'workspace.rename', { workspace_id: ws, label }).catch(report);
  },

  /** An empty label clears the pane's name (its terminal title shows again). */
  async renamePane(m: string, pane: string, label: string) {
    await conn.api(m, 'pane.rename', { pane_id: pane, label: label || null }).catch(report);
  },

  focusDirection(dir: 'left' | 'right' | 'up' | 'down') {
    const c = current();
    if (!c?.layout) return;
    const rects = paneRects(c.layout.root);
    const from = c.focused ? rects.get(c.focused) : undefined;
    if (!from) {
      const first = rects.keys().next().value;
      if (first) focusPane(c.m, first);
      return;
    }
    const cx = from.x + from.w / 2;
    const cy = from.y + from.h / 2;
    let best: string | undefined;
    let bestScore = Infinity;
    for (const [id, r] of rects) {
      if (id === c.focused) continue;
      const ok =
        dir === 'left'
          ? r.x + r.w <= from.x + 1e-6
          : dir === 'right'
            ? r.x >= from.x + from.w - 1e-6
            : dir === 'up'
              ? r.y + r.h <= from.y + 1e-6
              : r.y >= from.y + from.h - 1e-6;
      if (!ok) continue;
      const dx = r.x + r.w / 2 - cx;
      const dy = r.y + r.h / 2 - cy;
      const score = dir === 'left' || dir === 'right' ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (best) focusPane(c.m, best);
  },

  cyclePane(step: number) {
    const c = current();
    if (!c?.layout) return;
    const ids = [...paneRects(c.layout.root).keys()];
    if (!ids.length) return;
    const i = c.focused ? ids.indexOf(c.focused) : -1;
    focusPane(c.m, ids[(i + step + ids.length) % ids.length]);
  },

  switchTab(step: number | { index: number }) {
    const c = current();
    if (!c) return;
    const tabs = workspaceTabs(c.snap, c.ws);
    if (!tabs.length) return;
    let next;
    if (typeof step === 'number') {
      const i = tabs.findIndex((t) => t.tab_id === c.tab);
      next = tabs[(i + step + tabs.length) % tabs.length];
    } else next = tabs[step.index];
    if (next) useStore.getState().selectTab(c.m, c.ws, next.tab_id);
  },

  focusAgent(m: string, pane: string) {
    const s = useStore.getState();
    const p = s.machines[m]?.snapshot?.panes.find((x) => x.pane_id === pane);
    if (!p) return;
    s.selectWorkspace(m, p.workspace_id);
    s.selectTab(m, p.workspace_id, p.tab_id);
    // A "done" agent is then marked as seen in herdr (seen.ts).
    focusPane(m, pane);
  },

  focusedContext() {
    const c = current();
    if (!c) return undefined;
    return { m: c.m, pane: c.focused, cwd: c.focused ? cwdOf(c.snap, c.focused) : undefined };
  },

  openPath(m: string, path: string, line?: number, col?: number) {
    if (mediaExt.test(path) || !line) {
      if (mediaExt.test(path)) return useStore.getState().openDock({ kind: 'preview', m, path });
    }
    // Code (or unknown) files go to VS Code at the given position; fall back
    // to the preview panel when code-server is unavailable.
    bridge.openFile(m, path, line, col).catch(() => useStore.getState().openDock({ kind: 'preview', m, path }));
  },

  openPreview(m: string, path: string) {
    useStore.getState().openDock({ kind: 'preview', m, path });
  },

  openCode(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
  },

  openDiff(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
    bridge.command(m, folder, { cmd: 'openDiff', repo: folder }).catch(report);
  },

  openGitGraph(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
    bridge.command(m, folder, { cmd: 'gitGraph', repo: folder }).catch(report);
  },

  toggleSidebar() {
    useStore.getState().toggleSidebar();
  },

  currentTab() {
    const c = current();
    if (!c?.tab) return undefined;
    const t = c.snap.tabs.find((x) => x.tab_id === c.tab);
    return { m: c.m, tab: c.tab, label: t?.label ?? '' };
  },

  /** Jump to the agent that most needs attention (blocked first, then done). */
  openAttention() {
    const best = attentionList()[0];
    if (best) actions.focusAgent(best.m, best.pane.pane_id);
  },

  async runInNewPane(m: string, command: string, cwd?: string) {
    const c = current();
    const target = c?.m === m ? c.focused : undefined;
    try {
      const res = await conn.api(m, 'pane.split', { target_pane_id: target, direction: 'down', cwd, focus: false });
      const id = res?.pane?.pane_id;
      if (!id) return;
      await conn.api(m, 'pane.send_text', { pane_id: id, text: command + '\r' });
      focusPane(m, id);
    } catch (e) {
      report(e);
    }
  },

  /** Split the focused pane and start a coding agent in the new pane. */
  async startAgent(kind: string) {
    const c = current();
    if (!c) return;
    const target = c.focused;
    const cwd = target ? cwdOf(c.snap, target) : undefined;
    try {
      const res = await conn.api(c.m, 'pane.split', { target_pane_id: target, direction: 'right', cwd, focus: false });
      const pane = res?.pane?.pane_id;
      if (!pane) return;
      focusPane(c.m, pane);
      const name = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
      // agent.start waits for the shell prompt and the agent to become ready.
      await conn.api(c.m, 'agent.start', { name, kind, pane_id: pane, timeout_ms: 60000 });
    } catch (e) {
      report(e);
    }
  },

  sendLiteral(text: string) {
    const c = current();
    if (c?.focused) getTerm(c.m, c.focused)?.input(text);
  },
};
