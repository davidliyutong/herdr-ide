// Keys of the page: every keydown the app sees (terminals route theirs
// through handleKey, the window the others) is matched against the bindings
// in effect on this platform (keybindings.ts), chords included: "ctrl+k c"
// is ctrl+k, then c within 3 s. A key no binding takes is left to the
// terminal; so is the second press of a chord's first stroke, which the
// terminal encodes as any other key. No default binding is a chord. In the
// desktop app the page sees a key before the application menu, which gets
// only the keys the page leaves (desktop.ts).

import { actions, attentionList, current } from './actions';
import { useStore } from './state/store';
import * as L from './term/layout';
import { hasMessage, t } from './i18n';
import { keyLabel, strokeOf } from './keys';
import { platform, useKeys, type Binding, type When } from './keybindings';
import { findStep, openFind, useFind } from './vt/find';
import { paneHandle } from './state/panes';
import { currentZoom, zoom, zoomAvailable, ZOOM_LEVELS } from './zoom';
import { fullDiskAccessAvailable, openFullDiskAccess } from './fullDiskAccess';

/** Where a key is pressed: the main UI, a VS Code pane, or a dialog. */
export type KeyContext = 'terminal' | 'vscode' | 'dialog';

/** What a stroke did: nothing (the key is not the app's), a chord goes on,
 * a command ran, the chord's first stroke was pressed again (this press
 * goes on to the terminal), or an unmatched chord ended and the key is
 * dropped. */
export type StrokeResult =
  { kind: 'none' } | { kind: 'pending' } | { kind: 'run'; command: string } | { kind: 'literal' } | { kind: 'swallow' };

/** Whether a binding for when runs where the key was pressed. A VS Code pane
 * is a pane of the main UI: the main UI's bindings run there too, for the
 * keys VS Code leaves (those it takes never reach the app). */
export function applies(when: When, ctx: KeyContext): boolean {
  return when === 'always' || when === ctx || (when === 'terminal' && ctx === 'vscode');
}

/** One step of the matcher: the result of `stroke` after the strokes of an
 * unfinished chord (`pending`, "" for none), and the chord that goes on. */
export function feedStroke(
  bindings: readonly Binding[],
  pending: string,
  stroke: string,
  ctx: KeyContext,
): { result: StrokeResult; pending: string } {
  const live = bindings.filter((b) => applies(b.when, ctx));
  const seq = pending ? `${pending} ${stroke}` : stroke;
  const exact = live.find((b) => b.key === seq);
  if (exact) return { result: { kind: 'run', command: exact.command }, pending: '' };
  if (live.some((b) => b.key.startsWith(seq + ' '))) return { result: { kind: 'pending' }, pending: seq };
  if (!pending) return { result: { kind: 'none' }, pending: '' };
  if (!pending.includes(' ') && stroke === pending) return { result: { kind: 'literal' }, pending: '' };
  return { result: { kind: 'swallow' }, pending: '' };
}

function bindings(): Binding[] {
  return useKeys.getState().effective;
}

/** Whether a key press is a single-stroke binding of a command. */
export function isCommandKey(ev: KeyboardEvent, command: string): boolean {
  const stroke = strokeOf(ev);
  return !!stroke && bindings().some((b) => b.command === command && b.key === stroke);
}

let pending = '';
let pendingTimer: number | undefined;
const listeners = new Set<(active: boolean) => void>();

/** Calls fn when a chord starts or ends (the status bar shows it). */
export function onChordChange(fn: (active: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setPending(next: string) {
  const was = pending !== '';
  pending = next;
  clearTimeout(pendingTimer);
  if (next) pendingTimer = window.setTimeout(() => setPending(''), 3000);
  if (was !== (next !== '')) listeners.forEach((l) => l(next !== ''));
}

/** The chord typed so far, as shown ("ctrl+k"). */
export function pendingChord(): string {
  return pending ? keyLabel(pending) : '';
}

const modifierKeys = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn']);

/** Where a key event happens: dialogs and the palette take the keyboard. */
export function keyContext(): KeyContext {
  return typeof document !== 'undefined' && document.querySelector('.modal-backdrop, .palette-backdrop') ? 'dialog' : 'terminal';
}

/** Commands a held key repeats, as in browsers and terminals: opening and
 * closing tabs and panes, and stepping through tabs, workspaces, panes and
 * matches. Toggles, dialogs and splits run once per press. */
export const REPEATING_COMMANDS: ReadonlySet<string> = new Set([
  'tab.new',
  'tab.close',
  'tab.next',
  'tab.previous',
  'pane.close',
  'pane.focusLeft',
  'pane.focusRight',
  'pane.focusUp',
  'pane.focusDown',
  'pane.focusNext',
  'pane.focusPrevious',
  'workspace.next',
  'workspace.previous',
  'find.next',
  'find.previous',
]);

/** Key handler of the app (panes and the window). Returns true when the key
 * was the app's; the caller cancels it. */
export function handleKey(ev: KeyboardEvent, ctx: KeyContext = keyContext()): boolean {
  if (ev.type !== 'keydown') return pending !== '';
  if (modifierKeys.has(ev.key)) return pending !== '';
  const stroke = strokeOf(ev);
  if (!stroke) return pending !== '';
  const prev = pending;
  const step = feedStroke(bindings(), pending, stroke, ctx);
  setPending(step.pending);
  switch (step.result.kind) {
    case 'none':
    case 'literal':
      // The terminal encodes the key (the same stroke as the chord's first,
      // for literal) as it encodes every key no binding takes.
      return false;
    case 'pending':
    case 'swallow':
      ev.preventDefault();
      return true;
    case 'run':
      ev.preventDefault();
      // A held key repeats only some commands; a chord's last stroke runs.
      if (ev.repeat && !prev && !REPEATING_COMMANDS.has(step.result.command)) return true;
      runCommand(step.result.command);
      return true;
  }
}

/** Commands whose keys a VS Code pane gives the app before VS Code sees
 * them, so that they act on the pane as on a terminal's: cmd+w closes it
 * (VS Code would close an editor). VS Code keeps every other key. */
export const PANE_COMMANDS: ReadonlySet<string> = new Set(['pane.close']);

/** A key pressed in a VS Code pane, before VS Code: runs a PANE_COMMANDS
 * command bound to it as one stroke, on that pane (focus makes it the
 * focused one), and returns true (the caller keeps it from VS Code). */
export function handleFrameKey(ev: KeyboardEvent, focus: () => void = () => {}): boolean {
  if (ev.type !== 'keydown' || keyContext() === 'dialog' || pending) return false;
  const stroke = strokeOf(ev);
  const b = stroke ? bindings().find((x) => PANE_COMMANDS.has(x.command) && x.key === stroke && applies(x.when, 'vscode')) : undefined;
  if (!b) return false;
  focus();
  if (!ev.repeat || REPEATING_COMMANDS.has(b.command)) runCommand(b.command);
  return true;
}

/** The label of a command, e.g. "New Tab". */
export function commandLabel(id: string): string {
  const k = `command.${id}`;
  return hasMessage(k) ? t(k) : id;
}

/** The key shown for a command: in the desktop app its direct shortcut when
 * it has one, else its first key ("cmd+t", "ctrl+k c"); "" when it has
 * none. */
export function keyHint(command: string): string {
  const keys = useKeys
    .getState()
    .effective.filter((b) => b.command === command)
    .map((b) => b.key);
  const direct = platform() === 'mac' || platform() === 'pc' ? keys.find((k) => !k.includes(' ')) : undefined;
  const key = direct ?? keys[0];
  return key ? keyLabel(key) : '';
}

/** A label with the command's key, as tooltips show it ("Split right
 * (cmd+d)"), or the label alone when the command has no key. */
export function withKey(label: string, command: string): string {
  const key = keyHint(command);
  return key ? t('app.withKey', { label, key }) : label;
}

/** Whether a command exists on this page at all: Open Full Disk Access
 * Settings… only in the desktop app on macOS. The keyboard shortcuts page
 * lists the others. */
export function commandShown(id: string): boolean {
  return id !== 'app.fullDiskAccess' || fullDiskAccessAvailable();
}

/** Whether a command can run now: a pane, tab or workspace for it to act
 * on, something to switch to, a page that may change things. The desktop
 * app's menu shows the others disabled, the palette leaves them out. */
export function commandEnabled(id: string): boolean {
  const s = useStore.getState();
  const c = actions.focusedContext();
  const cur = current();
  const layout = cur?.layout;
  const tabs = cur?.ws?.tabs.length ?? 0;
  const panes = cur?.tab ? L.tabPanes(cur.tab).length : 0;
  const changes = !s.readOnly;
  if (/^tab\.select[1-9]$/.test(id)) return tabs > 1;
  switch (id) {
    case 'workspace.new':
      return changes && !!s.machineId && s.machines[s.machineId]?.status === 'ready';
    case 'tab.new':
      return changes && !!layout;
    case 'workspace.edit':
    case 'workspace.close':
      return changes && !!cur?.ws;
    case 'workspace.next':
    case 'workspace.previous':
      return (layout?.workspaces.length ?? 0) > 1;
    case 'workspace.switch':
      return Object.values(s.machines).length > 0;
    case 'tab.rename':
    case 'tab.close':
      return changes && !!cur?.tab;
    case 'tab.next':
    case 'tab.previous':
      return tabs > 1;
    case 'pane.splitRight':
    case 'pane.splitDown':
    case 'pane.close':
      return changes && !!c?.pane;
    case 'pane.zoom':
      return !!c?.pane && panes > 1;
    case 'pane.focusLeft':
    case 'pane.focusRight':
    case 'pane.focusUp':
    case 'pane.focusDown':
    case 'pane.focusNext':
    case 'pane.focusPrevious':
      return panes > 1;
    case 'find.open':
    case 'find.next':
    case 'find.previous':
      return !!c?.terminal;
    case 'code.open':
    case 'code.diff':
    case 'code.gitGraph':
      return changes && !!c;
    case 'app.agentAttention':
      return attentionList().length > 0;
    case 'app.addMachine':
      return changes;
    case 'app.fullDiskAccess':
      return fullDiskAccessAvailable();
    case 'view.zoomIn':
      return zoomAvailable(s.readOnly) && currentZoom() < ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    case 'view.zoomOut':
      return zoomAvailable(s.readOnly) && currentZoom() > ZOOM_LEVELS[0];
    case 'view.zoomReset':
      return zoomAvailable(s.readOnly) && currentZoom() !== 100;
  }
  return true;
}

/** Runs a command; unknown ones do nothing. */
export function runCommand(id: string) {
  const ctx = actions.focusedContext();
  const s = useStore.getState();
  const select = /^tab\.select([1-9])$/.exec(id);
  if (select) {
    // The ninth is the last tab, as in browsers.
    actions.switchTab(select[1] === '9' ? { last: true } : { index: Number(select[1]) - 1 });
    return;
  }
  switch (id) {
    case 'app.commandPalette':
      s.setPalette?.('commands');
      break;
    case 'app.keyboardShortcuts':
      s.openSettings({ page: 'keys' });
      break;
    case 'app.settings':
      s.openSettings({});
      break;
    case 'app.agentAttention':
      actions.openAttention();
      break;
    case 'app.addMachine':
      s.openAddMachine(true);
      break;
    case 'app.fullDiskAccess':
      openFullDiskAccess();
      break;
    case 'workspace.switch':
      s.setPalette?.('workspaces');
      break;
    case 'workspace.next':
      actions.cycleWorkspace(1);
      break;
    case 'workspace.previous':
      actions.cycleWorkspace(-1);
      break;
    case 'workspace.new':
      actions.newWorkspace();
      break;
    case 'workspace.edit':
      if (s.machineId && s.workspaceId) void actions.editWorkspace(s.machineId, s.workspaceId);
      break;
    case 'workspace.close':
      if (s.machineId && s.workspaceId) void actions.closeWorkspace(s.machineId, s.workspaceId);
      break;
    case 'tab.new':
      void actions.newTab();
      break;
    case 'tab.rename': {
      const c = actions.currentTab();
      if (c) actions.startRename('tab', c.m, `${c.ws}:${c.index}`);
      break;
    }
    case 'tab.next':
      actions.switchTab(1);
      break;
    case 'tab.previous':
      actions.switchTab(-1);
      break;
    case 'tab.close': {
      const c = actions.currentTab();
      if (c) void actions.closeTab(c.m, c.ws, c.index);
      break;
    }
    case 'pane.splitRight':
      if (ctx?.pane) void actions.split(ctx.m, ctx.pane, 'right');
      break;
    case 'pane.splitDown':
      if (ctx?.pane) void actions.split(ctx.m, ctx.pane, 'down');
      break;
    case 'pane.close':
      if (ctx?.pane) void actions.closePane(ctx.m, ctx.pane);
      break;
    case 'pane.zoom':
      if (ctx?.pane) actions.zoom(ctx.m, ctx.pane);
      break;
    case 'pane.focusLeft':
      actions.focusDirection('left');
      break;
    case 'pane.focusRight':
      actions.focusDirection('right');
      break;
    case 'pane.focusUp':
      actions.focusDirection('up');
      break;
    case 'pane.focusDown':
      actions.focusDirection('down');
      break;
    case 'pane.focusNext':
      actions.cyclePane(1);
      break;
    case 'pane.focusPrevious':
      actions.cyclePane(-1);
      break;
    case 'view.toggleSidebar':
      actions.toggleSidebar();
      break;
    case 'view.zoomIn':
      zoom(1);
      break;
    case 'view.zoomOut':
      zoom(-1);
      break;
    case 'view.zoomReset':
      zoom(0);
      break;
    case 'find.open': {
      if (!ctx?.terminal) break;
      const h = paneHandle(ctx.m, ctx.terminal);
      if (h) h.openFind();
      else openFind(ctx.m, ctx.terminal);
      break;
    }
    case 'find.next':
      if (useFind.getState().terminal) findStep(true);
      else if (ctx?.terminal) openFind(ctx.m, ctx.terminal);
      break;
    case 'find.previous':
      if (useFind.getState().terminal) findStep(false);
      else if (ctx?.terminal) openFind(ctx.m, ctx.terminal);
      break;
    case 'code.open':
      if (ctx) void actions.openCode(ctx.m, ctx.cwd);
      break;
    case 'code.diff':
      if (ctx) void actions.openDiff(ctx.m, ctx.cwd, ctx.pane);
      break;
    case 'code.gitGraph':
      if (ctx) void actions.openGitGraph(ctx.m, ctx.cwd, ctx.pane);
      break;
  }
}
