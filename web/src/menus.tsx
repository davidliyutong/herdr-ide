// Context menus of pane headers, tabs, workspaces, machines and the
// terminals' text. They call the same commands as the buttons and bindings;
// read-only mode has no items that change anything (the terminals' text
// keeps copying and opening links), so elsewhere the browser's menu shows.

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
  Play,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  Rows2,
  Search,
  Square,
  SquareCode,
  Trash2,
  X,
} from 'lucide-react';
import { actions, current } from './actions';
import type { MenuEntry } from './contextMenu';
import { downloadDialog } from './dialog';
import { canDownload, downloadPath } from './download';
import { t } from './i18n';
import { keyHint } from './keymap';
import { mediaExt, openLink, resolvePath, safeUrl, type LinkContext } from './terminal/links';
import { useStore } from './state/store';
import { terms } from './state/terms';
import * as L from './term/layout';

/** A command's key, as menu items show it; none when it is unbound. */
const hint = (action: string) => keyHint(action) || undefined;

/** Bindings act on the current tab or workspace, so other targets show none. */
const hintIf = (current: boolean, action: string) => (current ? hint(action) : undefined);

const workspaceOf = (m: string, ws: string) => terms.layout(m)?.workspaces.find((w) => w.id === ws);

export function paneMenu(m: string, terminal: string): MenuEntry[] {
  const s = useStore.getState();
  if (s.readOnly) return [];
  const cwd = terms.directory(m, terminal);
  const zoomed = s.zoomed?.m === m && s.zoomed.terminal === terminal;
  return [
    { label: t('menu.renamePane'), icon: <Pencil />, run: () => actions.startRename('pane', m, terminal) },
    'sep',
    {
      label: t('command.pane.splitRight'),
      hint: hint('pane.splitRight'),
      icon: <Columns2 />,
      run: () => void actions.split(m, terminal, 'right'),
    },
    {
      label: t('command.pane.splitDown'),
      hint: hint('pane.splitDown'),
      icon: <Rows2 />,
      run: () => void actions.split(m, terminal, 'down'),
    },
    {
      label: t(zoomed ? 'menu.restore' : 'menu.zoom'),
      hint: hint('pane.zoom'),
      icon: zoomed ? <Minimize2 /> : <Maximize2 />,
      run: () => actions.zoom(m, terminal),
    },
    'sep',
    { label: t('menu.openCode'), hint: hint('code.open'), icon: <SquareCode />, run: () => actions.openCode(m, cwd) },
    { label: t('menu.diff'), hint: hint('code.diff'), icon: <FileDiff />, run: () => actions.openDiff(m, cwd) },
    { label: t('menu.gitGraph'), hint: hint('code.gitGraph'), icon: <GitGraph />, run: () => actions.openGitGraph(m, cwd) },
    'sep',
    {
      label: t('command.pane.close'),
      hint: hint('pane.close'),
      icon: <X />,
      danger: true,
      run: () => void actions.closePane(m, terminal),
    },
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
  find?: () => void;
}): MenuEntry[] {
  const out: MenuEntry[] = [{ label: t('surface.copy'), icon: <Copy />, disabled: !o.copy, run: () => o.copy?.() }];
  if (o.paste) out.push({ label: t('surface.paste'), icon: <ClipboardPaste />, run: o.paste });
  if (o.find) out.push({ label: t('find.menu'), hint: hint('find.open'), icon: <Search />, run: o.find });
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

/** Adds an SSH machine (AddMachineDialog). */
const addMachineItem = (): MenuEntry => ({
  label: t('menu.addMachine'),
  icon: <Plus />,
  run: () => useStore.getState().openAddMachine(true),
});

/** The menu of the sidebar's free space: add a machine. */
export function sidebarMenu(): MenuEntry[] {
  return useStore.getState().readOnly ? [] : [addMachineItem()];
}

/** A machine's menu in the sidebar: start, restart or stop its terminal
 * core (needs the agent connected), enable or disable it; rename or remove
 * an SSH machine, add one. */
export function machineMenu(m: string): MenuEntry[] {
  const s = useStore.getState();
  const st = s.machines[m];
  if (s.readOnly || !st) return [];
  const out: MenuEntry[] = [];
  // A machine with a code (a target the core refuses, the local machine
  // where no agent runs) is never connected: it can be renamed or removed
  // only.
  const usable = !st.code;
  if (usable && st.status !== 'disabled') {
    const off = st.status !== 'ready' || s.hcBusy[m] === true;
    out.push(
      { label: t('menu.startCore'), icon: <Play />, disabled: off, run: () => void actions.terminalCore(m, 'start') },
      { label: t('menu.restartCore'), icon: <RotateCw />, disabled: off, run: () => void actions.terminalCore(m, 'restart') },
      { label: t('menu.stopCore'), icon: <Square />, disabled: off, run: () => void actions.terminalCore(m, 'stop') },
      'sep',
      { label: t('menu.disableMachine'), icon: <PowerOff />, danger: true, run: () => void actions.setMachineEnabled(m, false) },
    );
  } else if (usable) {
    out.push({ label: t('menu.enableMachine'), icon: <Power />, run: () => void actions.setMachineEnabled(m, true) });
  }
  // The local machine keeps its host's name and stays.
  if (st.kind === 'ssh')
    out.push(
      'sep',
      { label: t('menu.renameMachine'), icon: <Pencil />, run: () => actions.startRename('machine', m, m) },
      { label: t('menu.removeMachine'), icon: <Trash2 />, danger: true, run: () => void actions.removeMachine(m) },
    );
  out.push('sep', addMachineItem());
  return out;
}

/** A tab's menu: rename, new tab, move left or right, close. */
export function tabMenu(m: string, ws: string, index: number): MenuEntry[] {
  const s = useStore.getState();
  const w = workspaceOf(m, ws);
  if (s.readOnly || !w) return [];
  const c = current();
  const isCurrent = c?.m === m && c.ws?.id === ws && c.tabIndex === index;
  const n = w.tabs.length;
  // A move uses the position when it runs: another client may have moved tabs.
  const move = (by: -1 | 1) => () => {
    const tab = w.tabs[index];
    const now = workspaceOf(m, ws)?.tabs.indexOf(tab) ?? -1;
    if (now >= 0) terms.mutate(m, (l) => L.moveTab(l, ws, now, now + by));
  };
  return [
    {
      label: t('command.tab.rename'),
      hint: hintIf(isCurrent, 'tab.rename'),
      icon: <Pencil />,
      run: () => actions.startRename('tab', m, `${ws}:${index}`),
    },
    { label: t('command.tab.new'), hint: hint('tab.new'), icon: <Plus />, run: () => void actions.newTab(m, ws) },
    'sep',
    { label: t('menu.moveLeft'), icon: <ArrowLeft />, disabled: index <= 0, run: move(-1) },
    { label: t('menu.moveRight'), icon: <ArrowRight />, disabled: index >= n - 1, run: move(1) },
    'sep',
    {
      label: t('command.tab.close'),
      hint: hintIf(isCurrent, 'tab.close'),
      icon: <X />,
      danger: true,
      run: () => void actions.closeTab(m, ws, index),
    },
  ];
}

/** A workspace's menu: rename, new tab in it, move up or down, close. */
export function workspaceMenu(m: string, ws: string): MenuEntry[] {
  const s = useStore.getState();
  const layout = terms.layout(m);
  if (s.readOnly || !layout) return [];
  const i = layout.workspaces.findIndex((w) => w.id === ws);
  const n = layout.workspaces.length;
  const c = current();
  const isCurrent = c?.m === m && c.ws?.id === ws;
  const move = (by: -1 | 1) => () =>
    terms.mutate(m, (l) => {
      const now = l.workspaces.findIndex((w) => w.id === ws);
      return now < 0 ? l : L.moveWorkspace(l, ws, now + by);
    });
  return [
    {
      label: t('command.workspace.rename'),
      hint: hintIf(isCurrent, 'workspace.rename'),
      icon: <Pencil />,
      run: () => actions.startRename('workspace', m, ws),
    },
    { label: t('command.tab.new'), hint: hintIf(isCurrent, 'tab.new'), icon: <Plus />, run: () => void actions.newTab(m, ws) },
    'sep',
    { label: t('menu.moveUp'), icon: <ArrowUp />, disabled: i <= 0, run: move(-1) },
    { label: t('menu.moveDown'), icon: <ArrowDown />, disabled: i < 0 || i >= n - 1, run: move(1) },
    'sep',
    {
      label: t('command.workspace.close'),
      hint: hintIf(isCurrent, 'workspace.close'),
      icon: <X />,
      danger: true,
      run: () => void actions.closeWorkspace(m, ws),
    },
  ];
}
