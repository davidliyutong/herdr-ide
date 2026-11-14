// Context menus of pane headers, tabs, workspaces and the panes' text. They
// call the same commands as the buttons and bindings; read-only mode has no
// items that change anything (the panes' text keeps copying and opening
// links), so elsewhere the browser's menu shows there.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileDiff,
  FolderDown,
  GitGraph,
  Link,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Wrench,
  Rows2,
  SquareCode,
  Trash2,
  X,
} from 'lucide-react';
import { actions } from './actions';
import type { MenuEntry } from './contextMenu';
import { downloadDialog } from './dialog';
import { canDownload, downloadPath } from './download';
import { t } from './i18n';
import { keyHint } from './keymap';
import { paneCwd, workspaceTabs } from './lib/herdr';
import { herdrMissing } from './lib/localHerdr';
import { mediaExt, openLink, resolvePath, safeUrl, type LinkContext } from './terminal/links';
import { activeTabId, useStore } from './state/store';

/** Bindings act on the current tab or workspace, so other targets show none. */
const hintIf = (current: boolean, action: string) => (current ? keyHint(action) : undefined);

/** Moves an item of `ids` one place (`by` -1 or 1) from where it is when the
 * menu item runs, as the order may have changed since the menu opened. */
function moveBy(ids: () => string[], id: string, by: -1 | 1, move: (index: number) => void) {
  const all = ids();
  const i = all.indexOf(id);
  if (i < 0 || i + by < 0 || i + by >= all.length) return;
  // insert_index is a slot of the current order: after the next item is i+2.
  move(by < 0 ? i - 1 : i + 2);
}

const tabIds = (m: string, ws: string) => {
  const snap = useStore.getState().machines[m]?.snapshot;
  return snap ? workspaceTabs(snap, ws).map((x) => x.tab_id) : [];
};
const workspaceIds = (m: string) => useStore.getState().machines[m]?.snapshot?.workspaces.map((w) => w.workspace_id) ?? [];

export function paneMenu(m: string, pane: string, zoomed: boolean): MenuEntry[] {
  const s = useStore.getState();
  if (s.readOnly) return [];
  const cwd = paneCwd(s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === pane));
  // The right click focused the pane, so its bindings apply to it.
  return [
    { label: t('menu.renamePane'), icon: <Pencil />, run: () => actions.startRename('pane', m, pane) },
    'sep',
    { label: t('action.split_vertical'), hint: keyHint('split_vertical'), icon: <Columns2 />, run: () => actions.split(m, pane, 'right') },
    { label: t('action.split_horizontal'), hint: keyHint('split_horizontal'), icon: <Rows2 />, run: () => actions.split(m, pane, 'down') },
    {
      label: t(zoomed ? 'menu.restore' : 'menu.zoom'),
      hint: keyHint('zoom'),
      icon: zoomed ? <Minimize2 /> : <Maximize2 />,
      run: () => actions.zoom(m, pane),
    },
    'sep',
    { label: t('menu.openCode'), hint: keyHint('open_code'), icon: <SquareCode />, run: () => actions.openCode(m, cwd) },
    { label: t('menu.diff'), hint: keyHint('open_diff'), icon: <FileDiff />, run: () => actions.openDiff(m, cwd) },
    { label: t('menu.gitGraph'), hint: keyHint('open_git_graph'), icon: <GitGraph />, run: () => actions.openGitGraph(m, cwd) },
    'sep',
    { label: t('action.close_pane'), hint: keyHint('close_pane'), icon: <X />, danger: true, run: () => actions.closePane(m, pane) },
  ];
}

const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** The menu of a pane's text: copy the selection, paste, and open, copy or
 * download the URL or path under the pointer or selected. Paths open in the
 * preview panel or in VS Code; the item names the file, so a path detection
 * cut short shows. Files of the pane's directory can be chosen to download
 * (not on the desktop app's own machine, where they already are). */
export function surfaceMenu(o: {
  ctx: LinkContext;
  link?: { kind: 'url' | 'path'; text: string };
  copy?: () => void;
  paste?: () => void;
}): MenuEntry[] {
  const out: MenuEntry[] = [{ label: t('surface.copy'), icon: <Copy />, disabled: !o.copy, run: () => o.copy?.() }];
  if (o.paste) out.push({ label: t('surface.paste'), icon: <ClipboardPaste />, run: o.paste });
  const l = o.link;
  if (l?.kind === 'url' && safeUrl(l.text)) {
    out.push(
      'sep',
      { label: t('link.menuOpenUrl', { url: l.text }), icon: <ExternalLink />, run: () => openLink(l, o.ctx) },
      { label: t('link.menuCopyUrl'), icon: <Link />, run: () => copyText(l.text) },
    );
  } else if (l?.kind === 'path') {
    const r = resolvePath(l.text, o.ctx);
    const name = r.path.split('/').pop() || r.path;
    out.push('sep', { label: t('link.menuPreview', { name }), icon: <Eye />, run: () => actions.openPreview(o.ctx.m, r.path) });
    if (!mediaExt.test(r.path))
      out.push({ label: t('link.menuCode', { name }), icon: <SquareCode />, run: () => actions.openPath(o.ctx.m, r.path, r.line, r.col) });
    if (canDownload(o.ctx.m))
      out.push({ label: t('link.menuDownload', { name }), icon: <Download />, run: () => void downloadPath(o.ctx.m, r.path) });
    out.push({ label: t('link.menuCopyPath'), icon: <Copy />, run: () => copyText(r.path) });
  }
  if (canDownload(o.ctx.m)) {
    const dir = o.ctx.cwd || o.ctx.home || '~';
    out.push('sep', { label: t('download.menu'), icon: <FolderDown />, run: () => void downloadDialog(o.ctx.m, dir) });
  }
  return out;
}

/** Adds a machine to herdr's saved machines (AddMachineDialog). */
const addMachineItem = (): MenuEntry => ({
  label: t('menu.addMachine'),
  icon: <Plus />,
  run: () => useStore.getState().openAddMachine(true),
});

/** Reloads herdr's saved machines (also the sidebar's button). */
const refreshMachinesItem = (): MenuEntry => ({
  label: t('menu.refreshMachines'),
  icon: <RefreshCw />,
  run: () => void actions.refreshMachines(),
});

/** The menu of the sidebar's free space: add a machine, reload them. */
export function sidebarMenu(): MenuEntry[] {
  return useStore.getState().readOnly ? [] : [addMachineItem(), refreshMachinesItem()];
}

/** A machine's menu in the sidebar: enable or disable it, manage its
 * herdr: its server (needs the agent connected), and on an SSH machine
 * herdr's own update; rename or remove it in herdr's saved machines, add
 * one or reload them. */
export function machineMenu(m: string): MenuEntry[] {
  const s = useStore.getState();
  const st = s.machines[m];
  if (s.readOnly || !st) return [];
  const out: MenuEntry[] = [];
  if (st.status !== 'disabled') {
    const connected = st.status === 'ready' || st.status === 'degraded';
    // Without a herdr executable there, a restart would stop nothing and
    // start nothing; herdr --remote installs one on an SSH machine.
    const missing = herdrMissing(st);
    out.push(
      { label: t('menu.manageHerdr'), icon: <Wrench />, disabled: st.kind !== 'local' && !connected, run: () => s.openHerdr(m) },
      { label: t('menu.restartHerdr'), icon: <RotateCw />, disabled: !connected || missing, run: () => void actions.restartHerdr(m) },
    );
    if (st.kind !== 'local')
      out.push({
        label: t(missing ? 'menu.installRemoteHerdr' : 'menu.updateRemoteHerdr'),
        icon: <RefreshCw />,
        run: () => s.openRemoteHerdr(m),
      });
    out.push('sep', {
      label: t('menu.disableMachine'),
      icon: <PowerOff />,
      danger: true,
      run: () => void actions.setMachineEnabled(m, false),
    });
  } else {
    out.push({ label: t('menu.enableMachine'), icon: <Power />, run: () => void actions.setMachineEnabled(m, true) });
  }
  // Machines given with --ssh are not herdr's to rename or remove.
  if (st.saved)
    out.push(
      'sep',
      { label: t('menu.renameMachine'), icon: <Pencil />, run: () => actions.startRename('machine', m, m) },
      { label: t('menu.removeMachine'), icon: <Trash2 />, danger: true, run: () => void actions.removeMachine(m) },
    );
  out.push('sep', addMachineItem(), refreshMachinesItem());
  return out;
}

export function tabMenu(m: string, ws: string, tab: string): MenuEntry[] {
  const s = useStore.getState();
  const snap = s.machines[m]?.snapshot;
  if (s.readOnly || !snap) return [];
  const tabs = workspaceTabs(snap, ws);
  const i = tabs.findIndex((x) => x.tab_id === tab);
  const current = s.machineId === m && s.workspaceId === ws && activeTabId(s, m, snap, ws) === tab;
  return [
    { label: t('action.rename_tab'), hint: hintIf(current, 'rename_tab'), icon: <Pencil />, run: () => actions.startRename('tab', m, tab) },
    { label: t('action.new_tab'), hint: keyHint('new_tab'), icon: <Plus />, run: () => actions.newTab(m, ws) },
    'sep',
    {
      label: t('menu.moveLeft'),
      icon: <ArrowLeft />,
      disabled: i <= 0,
      run: () =>
        moveBy(
          () => tabIds(m, ws),
          tab,
          -1,
          (index) => actions.moveTab(m, tab, index),
        ),
    },
    {
      label: t('menu.moveRight'),
      icon: <ArrowRight />,
      disabled: i < 0 || i >= tabs.length - 1,
      run: () =>
        moveBy(
          () => tabIds(m, ws),
          tab,
          1,
          (index) => actions.moveTab(m, tab, index),
        ),
    },
    'sep',
    { label: t('action.close_tab'), hint: hintIf(current, 'close_tab'), icon: <X />, danger: true, run: () => actions.closeTab(m, tab) },
  ];
}

export function workspaceMenu(m: string, ws: string): MenuEntry[] {
  const s = useStore.getState();
  const snap = s.machines[m]?.snapshot;
  if (s.readOnly || !snap) return [];
  const i = snap.workspaces.findIndex((w) => w.workspace_id === ws);
  const n = snap.workspaces.length;
  const current = s.machineId === m && s.workspaceId === ws;
  return [
    {
      label: t('action.rename_workspace'),
      hint: hintIf(current, 'rename_workspace'),
      icon: <Pencil />,
      run: () => actions.startRename('workspace', m, ws),
    },
    { label: t('action.new_tab'), hint: hintIf(current, 'new_tab'), icon: <Plus />, run: () => actions.newTab(m, ws) },
    'sep',
    {
      label: t('menu.moveUp'),
      icon: <ArrowUp />,
      disabled: i <= 0,
      run: () =>
        moveBy(
          () => workspaceIds(m),
          ws,
          -1,
          (index) => actions.moveWorkspace(m, ws, index),
        ),
    },
    {
      label: t('menu.moveDown'),
      icon: <ArrowDown />,
      disabled: i < 0 || i >= n - 1,
      run: () =>
        moveBy(
          () => workspaceIds(m),
          ws,
          1,
          (index) => actions.moveWorkspace(m, ws, index),
        ),
    },
    'sep',
    {
      label: t('action.close_workspace'),
      hint: hintIf(current, 'close_workspace'),
      icon: <X />,
      danger: true,
      run: () => actions.closeWorkspace(m, ws),
    },
  ];
}
