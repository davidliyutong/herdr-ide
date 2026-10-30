// Context menus of pane headers, tabs and workspaces. They call the same
// commands as the buttons and bindings; read-only mode has no menu items, so
// the browser's menu shows there.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  FileDiff,
  GitGraph,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Rows2,
  SquareCode,
  X,
} from 'lucide-react';
import { actions } from './actions';
import type { MenuEntry } from './contextMenu';
import { t } from './i18n';
import { keyHint } from './keymap';
import { paneCwd, workspaceTabs } from './lib/herdr';
import { activeTabId, useStore } from './state/store';

/** Bindings act on the current tab or workspace, so other targets show none. */
const hintIf = (current: boolean, action: string) => (current ? keyHint(action) : undefined);

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
    { label: t('menu.moveLeft'), icon: <ArrowLeft />, disabled: i <= 0, run: () => actions.moveTab(m, tab, i - 1) },
    {
      label: t('menu.moveRight'),
      icon: <ArrowRight />,
      disabled: i < 0 || i >= tabs.length - 1,
      run: () => actions.moveTab(m, tab, i + 2),
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
    { label: t('menu.moveUp'), icon: <ArrowUp />, disabled: i <= 0, run: () => actions.moveWorkspace(m, ws, i - 1) },
    { label: t('menu.moveDown'), icon: <ArrowDown />, disabled: i < 0 || i >= n - 1, run: () => actions.moveWorkspace(m, ws, i + 2) },
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
