// Keys of the page: every keydown the app sees (panes route theirs through
// handleKey, the window the others) is matched against the bindings in
// effect on this platform (keybindings.ts), chords included: "ctrl+b c" is
// ctrl+b, then c within 3 s, as with herdr's prefix. The same chord's first
// stroke twice sends it to the pane. The desktop app's shell takes direct
// shortcuts before the page (desktop.ts); here they run in browsers.
// herdr's own custom commands ([[keys.command]] in its config.toml, served
// by /api/keymap) keep working as chords with herdr's prefix.

import { actions } from './actions';
import { conn } from './lib/conn';
import { useStore } from './state/store';
import { hasMessage, t } from './i18n';
import { keyLabel, strokeOf, tryNormalize } from './keys';
import { platform, useKeys, type Binding, type When } from './keybindings';
import { openFind, findStep } from './surface/find';

/** Where a key is pressed: the main UI, VS Code, or a dialog. */
export type KeyContext = 'terminal' | 'vscode' | 'dialog';

/** What a stroke did: nothing (the key is not the app's), a chord goes on,
 * a command ran, the chord's first stroke is sent to the terminal, or an
 * unmatched chord ended and the key is dropped. */
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

// herdr's custom commands, as its config.toml has them.
interface HerdrCommand {
  key: string;
  type: string;
  command: string;
  description?: string;
}
let herdrCommands: (HerdrCommand & { binding: string })[] = [];

/** herdr's custom commands with their keys, for the palette. */
export function getHerdrCommands() {
  return herdrCommands;
}

/** Reads herdr's custom commands: "prefix+v" becomes a chord of herdr's
 * prefix (ctrl+b unless its config names another). */
export async function loadHerdrCommands() {
  try {
    const r = await fetch('/api/keymap');
    if (!r.ok) return;
    const j = (await r.json()) as { prefix?: string; commands?: HerdrCommand[] };
    const prefix = tryNormalize(j.prefix || 'ctrl+b') ?? 'ctrl+b';
    herdrCommands = (j.commands ?? []).flatMap((c) => {
      const rest = c.key.toLowerCase().startsWith('prefix+') ? tryNormalize(`ctrl+x ${c.key.slice(7)}`)?.split(' ')[1] : undefined;
      return rest ? [{ ...c, binding: `${prefix} ${rest}` }] : [];
    });
  } catch {
    /* none */
  }
}

/** The bindings matched here: herdr's custom commands first, as before. */
function bindings(): Binding[] {
  const custom = herdrCommands.map((c, i): Binding => ({ key: c.binding, command: `herdr:${i}`, when: 'terminal' }));
  return [...custom, ...useKeys.getState().effective];
}

let pending = '';
let pendingTimer: number | undefined;
const listeners = new Set<(active: boolean) => void>();

/** Calls fn when a chord starts or ends (the status bar shows it). */
export function onPrefixChange(fn: (active: boolean) => void) {
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

/** The chord typed so far, as shown ("ctrl+b"). */
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
      return false;
    case 'pending':
    case 'swallow':
      ev.preventDefault();
      return true;
    case 'literal': {
      ev.preventDefault();
      // A Ctrl+letter prefix reaches the pane as its control character.
      const m = /^ctrl\+([a-z])$/.exec(prev);
      if (m) actions.sendLiteral(String.fromCharCode(m[1].charCodeAt(0) & 0x1f));
      return true;
    }
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
 * it has one, else its first chord ("cmd+t", "ctrl+b c"). */
export function keyHint(command: string): string {
  const keys = useKeys
    .getState()
    .effective.filter((b) => b.command === command)
    .map((b) => b.key);
  const direct = platform() === 'mac' || platform() === 'pc' ? keys.find((k) => !k.includes(' ')) : undefined;
  const key = direct ?? keys[0];
  return key ? keyLabel(key) : '';
}

/** Runs a command; unknown ones do nothing. */
export function runCommand(id: string) {
  const herdr = /^herdr:(\d+)$/.exec(id);
  if (herdr) {
    const c = herdrCommands[Number(herdr[1])];
    if (c) runHerdrCommand(c);
    return;
  }
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
    case 'workspace.new':
      actions.newWorkspace();
      break;
    case 'workspace.rename':
      if (s.machineId && s.workspaceId) actions.startRename('workspace', s.machineId, s.workspaceId);
      break;
    case 'workspace.close':
      if (s.machineId && s.workspaceId) actions.closeWorkspace(s.machineId, s.workspaceId);
      break;
    case 'tab.new':
      actions.newTab();
      break;
    case 'tab.rename': {
      const c = actions.currentTab();
      if (c) actions.startRename('tab', c.m, c.tab);
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
      if (c) void actions.closeTab(c.m, c.tab);
      break;
    }
    case 'pane.splitRight':
      if (ctx?.pane) actions.split(ctx.m, ctx.pane, 'right');
      break;
    case 'pane.splitDown':
      if (ctx?.pane) actions.split(ctx.m, ctx.pane, 'down');
      break;
    case 'pane.close':
      if (ctx?.pane) actions.closePane(ctx.m, ctx.pane);
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
    case 'view.toggleCode':
      actions.toggleCode();
      break;
    case 'find.open':
      if (s.focused) openFind(s.focused.m, s.focused.pane);
      break;
    case 'find.next':
      findStep(true);
      break;
    case 'find.previous':
      findStep(false);
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

export function runHerdrCommand(c: HerdrCommand) {
  const ctx = actions.focusedContext();
  if (!ctx) return;
  if (c.type === 'plugin_action') {
    const i = c.command.lastIndexOf('.');
    const params: Record<string, unknown> = { action_id: c.command };
    if (i > 0) {
      params.plugin_id = c.command.slice(0, i);
      params.action_id = c.command.slice(i + 1);
    }
    if (ctx.pane) params.context = { pane_id: ctx.pane };
    conn.api(ctx.m, 'plugin.action.invoke', params).catch((e) => useStore.getState().toast?.(String(e.message ?? e)));
  } else if (c.type === 'pane' || c.type === 'popup' || c.type === 'shell') {
    actions.runInNewPane(ctx.m, c.command, ctx.cwd);
  }
}
