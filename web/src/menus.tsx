// Context menus of pane headers (also their "more" button), tabs,
// workspaces, machines and the terminals' text. They call the same commands as the buttons and bindings;
// read-only mode has no items that change anything (the terminals' text
// keeps copying and opening links), so elsewhere the browser's menu shows.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ClipboardPaste,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileDiff,
  FolderDown,
  FolderPlus,
  GitGraph,
  KeyRound,
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
  ServerPlus,
  Settings,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { actions, current, workspaceTitle } from './actions';
import { CodeIcon } from './components/icons';
import type { MenuEntry } from './contextMenu';
import { downloadDialog } from './dialog';
import { canDownload, downloadPath } from './download';
import { t } from './i18n';
import { keyHint } from './keymap';
import { mediaExt, openLink, resolvePath, safeUrl, type LinkContext } from './terminal/links';
import { useStore } from './state/store';
import { conn } from './lib/conn';
import { terms } from './state/terms';
import * as L from './term/layout';

/** A command's key, as menu items show it; none when it is unbound. */
const hint = (action: string) => keyHint(action) || undefined;

/** Bindings act on the current tab or workspace, so other targets show none. */
const hintIf = (current: boolean, action: string) => (current ? hint(action) : undefined);

const workspaceOf = (m: string, ws: string) => terms.layout(m)?.workspaces.find((w) => w.id === ws);

/** A pane's menu: what it is (a terminal's name, VS Code's window, a
 * preview's file), splitting it (a new terminal in its directory), showing
 * it alone, moving it to another workspace, a terminal's folder in VS Code, closing it. */
export function paneMenu(m: string, pane: string): MenuEntry[] {
  const s = useStore.getState();
  if (s.readOnly) return [];
  const layout = terms.layout(m);
  const leaf = layout ? L.findLeaf(layout, pane) : null;
  const zoomed = s.zoomed?.m === m && s.zoomed.pane === pane;
  const arrange: MenuEntry[] = [
    {
      label: t('command.pane.splitRight'),
      hint: hint('pane.splitRight'),
      icon: <Columns2 />,
      run: () => void actions.split(m, pane, 'right'),
    },
    {
      label: t('command.pane.splitDown'),
      hint: hint('pane.splitDown'),
      icon: <Rows2 />,
      run: () => void actions.split(m, pane, 'down'),
    },
    {
      label: t(zoomed ? 'menu.restorePane' : 'command.pane.zoom'),
      hint: hint('pane.zoom'),
      icon: zoomed ? <Minimize2 /> : <Maximize2 />,
      run: () => actions.zoom(m, pane),
    },
  ];
  // Into a new tab of another workspace of the machine, or of a new one.
  const here = layout && L.locate(layout, pane);
  const others = (layout?.workspaces ?? []).filter((_, i) => i !== here?.workspace);
  arrange.push({
    label: t('menu.moveToWorkspace'),
    icon: <ArrowRightLeft />,
    submenu: [
      ...others.map((w) => ({ label: workspaceTitle(m, w), run: () => actions.movePaneToWorkspace(m, pane, w.id) })),
      ...(others.length ? ['sep' as const] : []),
      { label: t('command.workspace.new'), icon: <FolderPlus />, run: () => void actions.movePaneToNewWorkspace(m, pane) },
    ],
  });
  const close: MenuEntry = {
    label: t('command.pane.close'),
    hint: hint('pane.close'),
    icon: <X />,
    danger: true,
    run: () => void actions.closePane(m, pane),
  };
  if (leaf && L.isCodeLeaf(leaf)) {
    const machine = s.machines[m]?.label ?? m;
    return [
      { label: t('code.reload'), icon: <RotateCw />, run: () => actions.reloadCode(m, leaf.code.id) },
      'sep',
      ...arrange,
      'sep',
      { label: t('code.stop', { machine }), icon: <Power />, run: () => void actions.stopCode(m) },
      'sep',
      close,
    ];
  }
  if (leaf && L.isPreviewLeaf(leaf)) {
    const path = leaf.preview.path;
    return [
      { label: t('preview.openInCode'), icon: <CodeIcon />, run: () => void actions.openInCode(m, path, 1, undefined, pane) },
      ...(canDownload(m) ? [{ label: t('preview.download'), icon: <Download />, run: () => void downloadPath(m, path) }] : []),
      'sep',
      ...arrange,
      'sep',
      close,
    ];
  }
  const cwd = terms.directory(m, pane);
  return [
    { label: t('menu.renamePane'), icon: <Pencil />, run: () => actions.startRename('pane', m, pane) },
    'sep',
    ...arrange,
    'sep',
    { label: t('command.code.open'), hint: hint('code.open'), icon: <CodeIcon />, run: () => void actions.openCode(m, cwd) },
    { label: t('command.code.diff'), hint: hint('code.diff'), icon: <FileDiff />, run: () => void actions.openDiff(m, cwd, pane) },
    {
      label: t('command.code.gitGraph'),
      hint: hint('code.gitGraph'),
      icon: <GitGraph />,
      run: () => void actions.openGitGraph(m, cwd, pane),
    },
    'sep',
    close,
  ];
}

const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

/** The menu of a pane's text: copy the selection, paste, and open, copy or
 * download the URL or path under the pointer or selected. Paths open in a
 * preview pane or in VS Code; the item names the file, so a path detection
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
  if (o.find) out.push({ label: t('command.find.open'), hint: hint('find.open'), icon: <Search />, run: o.find });
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
    out.push('sep', {
      label: t('link.menuPreview', { name }),
      icon: <Eye />,
      run: () => void actions.openPreview(o.ctx.m, r.path, o.ctx.pane),
    });
    if (!mediaExt.test(r.path))
      out.push({
        label: t('link.menuCode', { name }),
        icon: <CodeIcon />,
        run: () => void actions.openPath(o.ctx.m, r.path, r.line, r.col, o.ctx.pane),
      });
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
  icon: <ServerPlus />,
  run: () => useStore.getState().openAddMachine(true),
});

/** The menu of the sidebar's free space: add a machine, new workspace. */
export function sidebarMenu(): MenuEntry[] {
  if (useStore.getState().readOnly) return [];
  return [
    { label: t('command.workspace.new'), hint: hint('workspace.new'), icon: <FolderPlus />, run: () => void actions.newWorkspace() },
    addMachineItem(),
  ];
}

/** A machine's menu in the sidebar, in the order of the other menus: what
 * it makes, its settings and name, its connection, troubleshooting (its
 * terminal service: herdr-core), removal. */
export function machineMenu(m: string): MenuEntry[] {
  const s = useStore.getState();
  const st = s.machines[m];
  if (s.readOnly || !st) return [];
  // A machine with a code (a target the core refuses, the local machine
  // where no agent runs) is never connected: it can be renamed or removed
  // only.
  const usable = !st.code;
  const ready = usable && st.status === 'ready';
  const ssh = st.kind === 'ssh';
  const off = !ready || s.hcBusy[m] === true;
  return [
    { label: t('command.workspace.new'), icon: <FolderPlus />, disabled: !ready, run: () => void actions.newWorkspace(m) },
    'sep',
    { label: t('menu.machineSettings'), icon: <Settings />, run: () => s.openSettings({ machine: m }) },
    { label: t('menu.renameMachine'), icon: <Pencil />, run: () => actions.startRename('machine', m, m) },
    ...(ssh
      ? [
          {
            label: t('menu.copyTarget'),
            icon: <Copy />,
            disabled: !st.target,
            run: () => copyText(st.target ?? ''),
          },
        ]
      : []),
    'sep',
    // Moving: among two machines or more.
    ...(s.order.length > 1
      ? [
          {
            label: t('menu.moveUp'),
            icon: <ArrowUp />,
            disabled: s.order.indexOf(m) <= 0,
            run: () => void actions.moveMachine(m, s.order.indexOf(m) - 1),
          },
          {
            label: t('menu.moveDown'),
            icon: <ArrowDown />,
            disabled: s.order.indexOf(m) >= s.order.length - 1,
            run: () => void actions.moveMachine(m, s.order.indexOf(m) + 2),
          },
          'sep' as const,
        ]
      : []),
    ...(usable && st.status === 'auth_required' && ssh && s.sshLogin
      ? [{ label: t('sidebar.authenticate'), icon: <KeyRound />, run: () => s.openAuth(m) }]
      : []),
    ...(usable && (st.status === 'auth_required' || st.status === 'error')
      ? [{ label: t('sidebar.retry'), icon: <RotateCw />, run: () => conn.retry(m) }]
      : []),
    ...(usable && st.status === 'disabled'
      ? [{ label: t('menu.enableMachine'), icon: <Power />, run: () => void actions.setMachineEnabled(m, true) }]
      : []),
    ...(usable && st.status !== 'disabled'
      ? [
          {
            label: t('menu.troubleshooting'),
            icon: <Wrench />,
            submenu: [
              { label: t('menu.restartCore'), icon: <RotateCw />, disabled: off, run: () => void actions.terminalCore(m, 'restart') },
              { label: t('menu.startCore'), icon: <Play />, disabled: off, run: () => void actions.terminalCore(m, 'start') },
              'sep',
              { label: t('menu.stopCore'), icon: <Square />, danger: true, disabled: off, run: () => void actions.terminalCore(m, 'stop') },
            ] as MenuEntry[],
          },
          { label: t('menu.disableMachine'), icon: <PowerOff />, run: () => void actions.setMachineEnabled(m, false) },
        ]
      : []),
    'sep',
    ...(ssh ? [{ label: t('menu.removeMachine'), icon: <Trash2 />, danger: true, run: () => void actions.removeMachine(m) }] : []),
  ];
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
    'sep',
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

/** A workspace's menu: edit its name and directory, new tab in it, move up or down, close. */
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
      label: t('command.workspace.edit'),
      hint: hintIf(isCurrent, 'workspace.edit'),
      icon: <Pencil />,
      run: () => void actions.editWorkspace(m, ws),
    },
    'sep',
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
