// Keys of the page: every keydown the app sees (terminals route theirs
// through handleKey, the window the others) is matched against the bindings
// in effect on this platform (keybindings.ts), chords included: "ctrl+k c"
// is ctrl+k, then c within 3 s. A key no binding takes is left to the
// terminal; so is the second press of a chord's first stroke, which the
// terminal encodes as any other key. No default binding is a chord. In the
// desktop app the page sees a key before the application menu, which gets
// only the keys the page leaves (desktop.ts).

import { actions } from './actions';
import { useStore } from './state/store';
import { hasMessage, t } from './i18n';
import { keyLabel, strokeOf } from './keys';
import { platform, useKeys, type Binding, type When } from './keybindings';
import { findStep, openFind, useFind } from './vt/find';
import { paneHandle } from './state/panes';

/** Where a key is pressed: the main UI, VS Code, or a dialog. */
export type KeyContext = 'terminal' | 'vscode' | 'dialog';

/** What a stroke did: nothing (the key is not the app's), a chord goes on,
 * a command ran, the chord's first stroke was pressed again (this press
 * goes on to the terminal), or an unmatched chord ended and the key is
 * dropped. */
export type StrokeResult =
  { kind: 'none' } | { kind: 'pending' } | { kind: 'run'; command: string } | { kind: 'literal' } | { kind: 'swallow' };

export function applies(when: When, ctx: KeyContext): boolean {
  return when === 'always' || when === ctx;
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
      if (ev.repeat && !prev) return true;
      runCommand(step.result.command);
      return true;
  }
}

/** The label of a command, e.g. "New tab". */
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

/** Runs a command; unknown ones do nothing. */
export function runCommand(id: string) {
  const ctx = actions.focusedContext();
  const s = useStore.getState();
  const select = /^tab\.select([1-9])$/.exec(id);
  if (select) {
    actions.switchTab({ index: Number(select[1]) - 1 });
    return;
  }
  switch (id) {
    case 'app.commandPalette':
      s.setPalette?.('commands');
      break;
    case 'app.keyboardShortcuts':
      s.setPalette?.('help');
      break;
    case 'app.settings':
      s.openSettings(true);
      break;
    case 'app.agentAttention':
      actions.openAttention();
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
    case 'workspace.rename':
      if (s.machineId && s.workspaceId) actions.startRename('workspace', s.machineId, s.workspaceId);
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
      if (ctx?.terminal) void actions.split(ctx.m, ctx.terminal, 'right');
      break;
    case 'pane.splitDown':
      if (ctx?.terminal) void actions.split(ctx.m, ctx.terminal, 'down');
      break;
    case 'pane.close':
      if (ctx?.terminal) void actions.closePane(ctx.m, ctx.terminal);
      break;
    case 'pane.zoom':
      if (ctx?.terminal) actions.zoom(ctx.m, ctx.terminal);
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
    case 'view.toggleCode':
      actions.toggleCode();
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
      if (ctx) actions.openCode(ctx.m, ctx.cwd);
      break;
    case 'code.diff':
      if (ctx) actions.openDiff(ctx.m, ctx.cwd);
      break;
    case 'code.gitGraph':
      if (ctx) actions.openGitGraph(ctx.m, ctx.cwd);
      break;
  }
}
