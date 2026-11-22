// The commands that are no plugin's (declared in
// internal/keybindings/commands.go): whether each can run now and what runs
// it, by id. Plugins bring theirs in their definitions (plugins/api.ts);
// keymap.ts looks both up. The app imports this module at its start
// (App.tsx), which defines the table.

import { actions, attentionList, current, spotOpen } from './actions';
import { hasClosed } from './closedPanes';
import { fullDiskAccessAvailable, openFullDiskAccess } from './fullDiskAccess';
import { defineCommands } from './keymap';
import { openPaneMenu } from './menus';
import { canGo } from './paneHistory';
import type { CommandDef } from './plugins/api';
import { activePanels } from './plugins/registry';
import { paneHandle } from './state/panes';
import { useStore } from './state/store';
import * as L from './term/layout';
import { findStep, openFind, useFind } from './vt/find';
import { currentZoom, zoom, zoomAvailable, ZOOM_LEVELS } from './zoom';

const store = () => useStore.getState();
/** Whether the page may change things. */
const changes = () => !store().readOnly;
const focused = () => actions.focusedContext();
/** Tabs of the selected workspace. */
const tabCount = () => current()?.ws?.tabs.length ?? 0;
/** Panes of the selected tab. */
const paneCount = () => {
  const tab = current()?.tab;
  return tab ? L.tabPanes(tab).length : 0;
};
const workspaceCount = () => current()?.layout?.workspaces.length ?? 0;
const hasPane = () => !!focused()?.pane;
const hasTerminal = () => !!focused()?.terminal;
const hasTab = () => !!current()?.tab;
const hasWorkspace = () => !!current()?.ws;
const zoomable = () => zoomAvailable(store().readOnly);

/** When pane.close last ran, and how soon after it another run counts as
 * the key held (the desktop app's menu repeats without saying so; the first
 * repeat comes after the system's delay, about 400 ms by default). */
let lastPaneClose = 0;
const HELD_CLOSE_MS = 600;

/** Whether the selected workspace has no tab left: closing a pane closes it. */
function emptyWorkspace(): boolean {
  const ws = current()?.ws;
  return !!ws && ws.tabs.length === 0;
}

/** Runs fn with the focused pane, when there is one. */
const withPane = (fn: (m: string, pane: string) => void) => () => {
  const c = focused();
  if (c?.pane) fn(c.m, c.pane);
};

/** Runs fn with the selected tab, when there is one. */
const withTab = (fn: (m: string, ws: string, index: number) => void) => () => {
  const c = actions.currentTab();
  if (c) fn(c.m, c.ws, c.index);
};

/** The next or previous match of the open search, or the search opened in
 * the focused terminal. */
const find = (forward: boolean) => () => {
  const c = focused();
  if (useFind.getState().terminal) findStep(forward);
  else if (c?.terminal) openFind(c.m, c.terminal);
};

/** tab.select1 to tab.select9; the ninth is the last tab, as in browsers. */
const selectTab: Record<string, CommandDef> = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
    `tab.select${n}`,
    { enabled: () => tabCount() > 1, run: () => actions.switchTab(n === 9 ? { last: true } : { index: n - 1 }) },
  ]),
);

/** A command without `enabled` can always run. */
export const commands: Record<string, CommandDef> = {
  'app.commandPalette': { run: () => store().setPalette?.('commands') },
  'app.keyboardShortcuts': { run: () => store().openSettings({ page: 'keys' }) },
  'app.settings': { run: () => store().openSettings({}) },
  'app.agentAttention': { enabled: () => attentionList().length > 0, run: () => actions.openAttention() },
  'app.addMachine': { enabled: changes, run: () => store().openAddMachine(true) },
  'app.fullDiskAccess': { enabled: fullDiskAccessAvailable, run: () => openFullDiskAccess() },

  'view.togglePanel': {
    enabled: () => activePanels().length > 0,
    run() {
      const s = store();
      const panels = activePanels();
      if (s.panel && panels.some((p) => p.id === s.panel)) s.setPanel(undefined);
      else s.setPanel((panels.find((p) => p.id === s.lastPanel) ?? panels[0])?.id);
    },
  },
  'view.toggleSidebar': { run: () => actions.toggleSidebar() },
  'view.zoomIn': { enabled: () => zoomable() && currentZoom() < ZOOM_LEVELS[ZOOM_LEVELS.length - 1], run: () => zoom(1) },
  'view.zoomOut': { enabled: () => zoomable() && currentZoom() > ZOOM_LEVELS[0], run: () => zoom(-1) },
  'view.zoomReset': { enabled: () => zoomable() && currentZoom() !== 100, run: () => zoom(0) },

  'workspace.switch': {
    enabled: () => Object.values(store().machines).length > 0,
    run: () => store().setPalette?.('workspaces'),
  },
  'workspace.next': { enabled: () => workspaceCount() > 1, run: () => actions.cycleWorkspace(1) },
  'workspace.previous': { enabled: () => workspaceCount() > 1, run: () => actions.cycleWorkspace(-1) },
  'workspace.new': {
    enabled() {
      const s = store();
      return changes() && !!s.machineId && s.machines[s.machineId]?.status === 'ready';
    },
    run: () => actions.newWorkspace(),
  },
  'workspace.edit': {
    enabled: () => changes() && hasWorkspace(),
    run() {
      const s = store();
      if (s.machineId && s.workspaceId) void actions.editWorkspace(s.machineId, s.workspaceId);
    },
  },
  'workspace.close': {
    enabled: () => changes() && hasWorkspace(),
    run() {
      const s = store();
      if (s.machineId && s.workspaceId) void actions.closeWorkspace(s.machineId, s.workspaceId);
    },
  },
  'workspace.closeOthers': {
    enabled: () => changes() && workspaceCount() > 1,
    run() {
      const cur = current();
      if (cur?.ws) void actions.closeOtherWorkspaces(cur.m, cur.ws.id);
    },
  },

  ...selectTab,
  'tab.new': { enabled: () => changes() && !!current()?.layout, run: () => void actions.newTab() },
  'tab.rename': {
    enabled: () => changes() && hasTab(),
    run: withTab((m, ws, index) => actions.startRename('tab', m, `${ws}:${index}`)),
  },
  'tab.next': { enabled: () => tabCount() > 1, run: () => actions.switchTab(1) },
  'tab.previous': { enabled: () => tabCount() > 1, run: () => actions.switchTab(-1) },
  'tab.close': {
    enabled: () => changes() && hasTab(),
    run: withTab((m, ws, index) => void actions.closeTab(m, ws, index)),
  },
  'tab.closeOthers': {
    enabled() {
      const cur = current();
      return changes() && !!cur?.ws && cur.ws.tabs.some((t, i) => i !== cur.tabIndex && !t.pinned);
    },
    run: withTab((m, ws, index) => void actions.closeTabsBeside(m, ws, index, 'others')),
  },
  'tab.closeRight': {
    enabled() {
      const cur = current();
      return changes() && !!cur?.ws && cur.ws.tabs.some((t, i) => i > cur.tabIndex && !t.pinned);
    },
    run: withTab((m, ws, index) => void actions.closeTabsBeside(m, ws, index, 'right')),
  },
  'tab.pin': {
    enabled() {
      const tab = current()?.tab;
      return changes() && !!tab && !tab.pinned;
    },
    run: withTab((m, ws, index) => actions.pinTab(m, ws, index, true)),
  },
  'tab.unpin': {
    enabled: () => changes() && !!current()?.tab?.pinned,
    run: withTab((m, ws, index) => actions.pinTab(m, ws, index, false)),
  },

  'pane.rename': {
    enabled: () => changes() && hasTerminal(),
    run() {
      const c = focused();
      if (c?.terminal) actions.startRename('pane', c.m, c.terminal);
    },
  },
  'pane.leave': {
    enabled: hasPane,
    run() {
      const active = document.activeElement as HTMLElement | null;
      const header = active?.closest<HTMLElement>('.pane-header');
      if (header) {
        const m = header.dataset.m;
        const pane = header.dataset.pane;
        if (m && pane) {
          actions.focusPane(m, pane);
          return;
        }
      }
      const paneEl = active?.closest<HTMLElement>('.pane');
      const paneHeader = paneEl?.querySelector<HTMLElement>('.pane-header');
      if (paneHeader && active !== paneHeader) {
        paneHeader.focus({ preventScroll: true });
        return;
      }
      const c = focused();
      if (!c?.pane) return;
      const el = document.querySelector<HTMLElement>(`.pane-header[data-m="${CSS.escape(c.m)}"][data-pane="${CSS.escape(c.pane)}"]`);
      if (el && active !== el) el.focus({ preventScroll: true });
      else actions.focusPane(c.m, c.pane);
    },
  },
  'pane.actions': { enabled: () => changes() && hasPane(), run: withPane((m, pane) => openPaneMenu(m, pane)) },
  'pane.splitRight': {
    enabled: () => changes() && hasPane(),
    run: withPane((m, pane) => void actions.split(m, pane, 'right')),
  },
  'pane.splitDown': {
    enabled: () => changes() && hasPane(),
    run: withPane((m, pane) => void actions.split(m, pane, 'down')),
  },
  'pane.close': {
    // With no pane left, it closes the empty workspace.
    enabled: () => changes() && (hasPane() || emptyWorkspace()),
    run() {
      const c = focused();
      const now = Date.now();
      const held = now - lastPaneClose < HELD_CLOSE_MS;
      lastPaneClose = now;
      if (c?.pane) void actions.closePane(c.m, c.pane);
      // A press of its own closes the empty workspace, not a held key that
      // closed its last pane.
      else if (!held && emptyWorkspace()) {
        const cur = current();
        if (cur?.ws) void actions.closeWorkspace(cur.m, cur.ws.id);
      }
    },
  },
  'pane.zoom': { enabled: () => hasPane() && paneCount() > 1, run: withPane((m, pane) => actions.zoom(m, pane)) },
  'pane.focusLeft': { enabled: () => paneCount() > 1, run: () => actions.focusDirection('left') },
  'pane.focusRight': { enabled: () => paneCount() > 1, run: () => actions.focusDirection('right') },
  'pane.focusUp': { enabled: () => paneCount() > 1, run: () => actions.focusDirection('up') },
  'pane.focusDown': { enabled: () => paneCount() > 1, run: () => actions.focusDirection('down') },
  'pane.focusNext': { enabled: () => paneCount() > 1, run: () => actions.cyclePane(1) },
  'pane.focusPrevious': { enabled: () => paneCount() > 1, run: () => actions.cyclePane(-1) },
  'pane.back': { enabled: () => canGo(-1, spotOpen), run: () => actions.goPane(-1) },
  'pane.forward': { enabled: () => canGo(1, spotOpen), run: () => actions.goPane(1) },
  'pane.undoClose': { enabled: () => changes() && hasClosed(), run: () => actions.undoClose() },

  'find.open': {
    enabled: hasTerminal,
    run() {
      const c = focused();
      if (!c?.terminal) return;
      const h = paneHandle(c.m, c.terminal);
      if (h) h.openFind();
      else openFind(c.m, c.terminal);
    },
  },
  'find.next': { enabled: hasTerminal, run: find(true) },
  'find.previous': { enabled: hasTerminal, run: find(false) },
};

defineCommands(commands);
