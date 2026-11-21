// Keys of the page: every keydown the app sees (terminals route theirs
// through handleKey, the window the others) is matched against the bindings
// in effect on this platform (keybindings.ts), chords included: "ctrl+k c"
// is ctrl+k, then c within 3 s. A key no binding takes is left to the
// terminal; so is the second press of a chord's first stroke, which the
// terminal encodes as any other key. No default binding is a chord. In the
// desktop app the page sees a key before the application menu, which gets
// only the keys the page leaves (desktop.ts). What a command does is not
// here: plugins bring their commands' handlers, commands.ts the others'.

import { actions } from './actions';
import * as L from './term/layout';
import { hasMessage, t } from './i18n';
import { keyLabel, strokeOf } from './keys';
import { platform, useKeys, type Binding, type When } from './keybindings';
import { fullDiskAccessAvailable } from './fullDiskAccess';
import type { CommandDef } from './plugins/api';
import { commandOfOffPlugin, pluginCommand } from './plugins/registry';
import { useFrames, windowFocused } from './codeFrames';

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
  'pane.back',
  'pane.forward',
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

/** VS Code's key for closing, pressed in a window without editors
 * (bridge.close; the extension binds it there, as VS Code closes such a
 * window): closes the VS Code pane showing that window, when this page has
 * the keyboard there. Every other key in a VS Code pane is VS Code's
 * first. */
export function closeWindowPane(m: string, window: string, folders?: string[]) {
  const k = windowFocused(m, window, folders);
  const fr = k ? useFrames.getState().frames[k] : undefined;
  if (!fr || keyContext() === 'dialog' || !commandEnabled('pane.close')) return;
  void actions.closePane(fr.m, L.codeKey(fr.id));
}

/** The extension's key for leaving VS Code, pressed in a window
 * (bridge.leave): when this page has the keyboard in that window's pane,
 * it moves to the pane's header, where the page's keys work (code.open
 * then hides VS Code again). */
export function leaveWindowPane(m: string, window: string, folders?: string[]) {
  const k = windowFocused(m, window, folders);
  const fr = k ? useFrames.getState().frames[k] : undefined;
  if (!fr || keyContext() === 'dialog') return;
  const pane = L.codeKey(fr.id);
  const header = document.querySelector<HTMLElement>(`.pane-header[data-m="${CSS.escape(fr.m)}"][data-pane="${CSS.escape(pane)}"]`);
  header?.focus({ preventScroll: true });
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

/** The handlers of the commands that are no plugin's, by id. */
const builtins = new Map<string, CommandDef>();

/** Adds handlers of commands that are no plugin's (commands.ts defines the
 * app's at its start). A plugin's handler of the same id comes first. */
export function defineCommands(table: Record<string, CommandDef>) {
  for (const [id, def] of Object.entries(table)) builtins.set(id, def);
}

/** Whether a command can run now: a pane, tab or workspace for it to act
 * on, something to switch to, a page that may change things. The desktop
 * app's menu shows the others disabled, the palette leaves them out. A
 * command of a plugin that is off cannot; one nothing handles can. */
export function commandEnabled(id: string): boolean {
  const plugin = pluginCommand(id);
  if (plugin) return plugin.enabled?.() ?? true;
  if (commandOfOffPlugin(id)) return false;
  return builtins.get(id)?.enabled?.() ?? true;
}

/** Runs a command; unknown ones do nothing. */
export function runCommand(id: string) {
  (pluginCommand(id) ?? builtins.get(id))?.run();
}
