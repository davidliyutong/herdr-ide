// herdr-compatible prefix keymap. The browser owns Cmd+W/T/N, so window-level
// commands use herdr's prefix (default ctrl+b) exactly like the herdr TUI;
// bindings are loaded from the host's herdr config.toml when available.

import { actions } from './actions';
import { conn } from './lib/conn';
import { useStore } from './state/store';
import { t, type MessageKey } from './i18n';

export interface KeyConfig {
  prefix: string;
  bindings: Record<string, string>; // action -> key spec
  commands: { key: string; type: string; command: string; description?: string }[];
}

export const defaultBindings: Record<string, string> = {
  help: 'prefix+?',
  workspace_picker: 'prefix+w',
  goto: 'prefix+g',
  new_workspace: 'prefix+shift+n',
  rename_workspace: 'prefix+shift+w',
  close_workspace: 'prefix+shift+d',
  new_tab: 'prefix+c',
  rename_tab: 'prefix+shift+t',
  previous_tab: 'prefix+p',
  next_tab: 'prefix+n',
  switch_tab: 'prefix+1..9',
  close_tab: 'prefix+shift+x',
  focus_pane_left: 'prefix+h',
  focus_pane_down: 'prefix+j',
  focus_pane_up: 'prefix+k',
  focus_pane_right: 'prefix+l',
  cycle_pane_next: 'prefix+tab',
  cycle_pane_previous: 'prefix+shift+tab',
  split_vertical: 'prefix+v',
  split_horizontal: 'prefix+minus',
  close_pane: 'prefix+x',
  zoom: 'prefix+z',
  toggle_sidebar: 'prefix+b',
  open_notification_target: 'prefix+o',
  // additions beyond herdr's own bindings
  open_code: 'prefix+e',
  open_diff: 'prefix+d',
  open_git_graph: 'prefix+shift+g',
  command_palette: 'prefix+space',
};

/** Localized label of a keymap action. */
export function actionLabel(action: string): string {
  return t(`action.${action}` as MessageKey);
}

let config: KeyConfig = { prefix: 'ctrl+b', bindings: { ...defaultBindings }, commands: [] };
let prefixActive = false;
let prefixTimer: number | undefined;
const listeners = new Set<(active: boolean) => void>();

export function onPrefixChange(fn: (active: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setPrefix(v: boolean) {
  prefixActive = v;
  window.clearTimeout(prefixTimer);
  if (v) prefixTimer = window.setTimeout(() => setPrefix(false), 3000);
  listeners.forEach((l) => l(v));
}

export function getKeyConfig() {
  return config;
}

const configListeners = new Set<() => void>();

/** Subscribe to keymap (re)loads; returns an unsubscribe function. */
export function onKeyConfig(fn: () => void) {
  configListeners.add(fn);
  return () => configListeners.delete(fn);
}

export async function loadKeymap() {
  try {
    const r = await fetch('/api/keymap');
    if (!r.ok) return;
    const j = (await r.json()) as Partial<KeyConfig>;
    config = {
      prefix: j.prefix || 'ctrl+b',
      bindings: { ...defaultBindings, ...(j.bindings ?? {}) },
      commands: j.commands ?? [],
    };
    configListeners.forEach((f) => f());
  } catch {
    /* keep defaults */
  }
}

/** Human-readable key for an action, e.g. "ctrl+b v". */
export function keyHint(action: string): string {
  const spec = config.bindings[action];
  if (!spec) return '';
  return spec.replace(/^prefix\+/, config.prefix + ' ').replace('minus', '-');
}

const keyAliases: Record<string, string> = {
  minus: '-',
  plus: '+',
  space: ' ',
  tab: 'tab',
  enter: 'enter',
  esc: 'escape',
  escape: 'escape',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  backtick: '`',
};

interface Spec {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

function parseSpec(s: string): Spec {
  const parts = s.toLowerCase().split('+');
  // "prefix+plus" style and literal "+" keys both end up in the last part.
  let key = parts.pop() ?? '';
  if (key === '' && parts.length) key = '+';
  const spec: Spec = { ctrl: false, alt: false, shift: false, meta: false, key: keyAliases[key] ?? key };
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') spec.ctrl = true;
    else if (p === 'alt' || p === 'option') spec.alt = true;
    else if (p === 'shift') spec.shift = true;
    else if (p === 'cmd' || p === 'super' || p === 'meta') spec.meta = true;
  }
  return spec;
}

function eventKey(ev: KeyboardEvent): string {
  if (ev.key === 'Tab') return 'tab';
  // Use the physical key for letters/digits so shift/alt variants still match.
  if (/^Key[A-Z]$/.test(ev.code)) return ev.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(ev.code) && !ev.shiftKey) return ev.code.slice(5);
  return ev.key.toLowerCase();
}

function matches(spec: Spec, ev: KeyboardEvent, ignoreShift = false): boolean {
  const k = eventKey(ev);
  if (spec.key !== k) {
    // Shifted punctuation such as "?" arrives with shiftKey set.
    if (!(spec.key.length === 1 && ev.key === spec.key)) return false;
    return spec.ctrl === ev.ctrlKey && spec.alt === ev.altKey && spec.meta === ev.metaKey;
  }
  return spec.ctrl === ev.ctrlKey && spec.alt === ev.altKey && spec.meta === ev.metaKey && (ignoreShift || spec.shift === ev.shiftKey);
}

function stripPrefix(s: string): string | undefined {
  return s.toLowerCase().startsWith('prefix+') ? s.slice(7) : undefined;
}

/** Key handler installed in every terminal. Returns true when consumed. */
export function handleKey(ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return prefixActive;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key)) return prefixActive;
  const prefix = parseSpec(config.prefix);
  if (!prefixActive) {
    if (matches(prefix, ev)) {
      setPrefix(true);
      ev.preventDefault();
      return true;
    }
    return false;
  }
  setPrefix(false);
  ev.preventDefault();
  // prefix prefix sends the prefix key itself (e.g. ctrl+b to the shell).
  if (matches(prefix, ev)) {
    if (prefix.ctrl && prefix.key.length === 1) actions.sendLiteral(String.fromCharCode(prefix.key.charCodeAt(0) & 0x1f));
    return true;
  }
  for (const c of config.commands) {
    const k = stripPrefix(c.key);
    if (k && matches(parseSpec(k), ev)) {
      runCommand(c);
      return true;
    }
  }
  for (const [action, spec] of Object.entries(config.bindings)) {
    const k = stripPrefix(spec);
    if (!k) continue;
    if (k.endsWith('1..9')) {
      const mods = parseSpec(k.replace('1..9', '1'));
      const digit = /^Digit([1-9])$/.exec(ev.code)?.[1];
      if (digit && mods.ctrl === ev.ctrlKey && mods.alt === ev.altKey && mods.shift === ev.shiftKey) {
        runAction(action, Number(digit) - 1);
        return true;
      }
      continue;
    }
    if (matches(parseSpec(k), ev)) {
      runAction(action);
      return true;
    }
  }
  return true;
}

export function runCommand(c: KeyConfig['commands'][number]) {
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

export function runAction(action: string, index?: number) {
  const ctx = actions.focusedContext();
  const s = useStore.getState();
  switch (action) {
    case 'split_vertical':
      if (ctx?.pane) actions.split(ctx.m, ctx.pane, 'right');
      break;
    case 'split_horizontal':
      if (ctx?.pane) actions.split(ctx.m, ctx.pane, 'down');
      break;
    case 'close_pane':
      if (ctx?.pane) actions.closePane(ctx.m, ctx.pane);
      break;
    case 'zoom':
      if (ctx?.pane) actions.zoom(ctx.m, ctx.pane);
      break;
    case 'focus_pane_left':
      actions.focusDirection('left');
      break;
    case 'focus_pane_right':
      actions.focusDirection('right');
      break;
    case 'focus_pane_up':
      actions.focusDirection('up');
      break;
    case 'focus_pane_down':
      actions.focusDirection('down');
      break;
    case 'cycle_pane_next':
      actions.cyclePane(1);
      break;
    case 'cycle_pane_previous':
      actions.cyclePane(-1);
      break;
    case 'new_tab':
      actions.newTab();
      break;
    case 'next_tab':
      actions.switchTab(1);
      break;
    case 'previous_tab':
      actions.switchTab(-1);
      break;
    case 'switch_tab':
      actions.switchTab({ index: index ?? 0 });
      break;
    case 'close_tab': {
      const c = actions.currentTab();
      if (c) actions.closeTab(c.m, c.tab);
      break;
    }
    case 'rename_tab': {
      const c = actions.currentTab();
      if (c) actions.renameTab(c.m, c.tab, c.label);
      break;
    }
    case 'new_workspace':
      actions.newWorkspace();
      break;
    case 'rename_workspace':
    case 'close_workspace': {
      if (!s.machineId || !s.workspaceId) break;
      const w = s.machines[s.machineId]?.snapshot?.workspaces.find((x) => x.workspace_id === s.workspaceId);
      if (action === 'close_workspace') actions.closeWorkspace(s.machineId, s.workspaceId);
      else actions.renameWorkspace(s.machineId, s.workspaceId, w?.label ?? '');
      break;
    }
    case 'toggle_sidebar':
      actions.toggleSidebar();
      break;
    case 'open_notification_target':
      actions.openAttention();
      break;
    case 'open_code':
      if (ctx) actions.openCode(ctx.m, ctx.cwd);
      break;
    case 'open_diff':
      if (ctx) actions.openDiff(ctx.m, ctx.cwd);
      break;
    case 'open_git_graph':
      if (ctx) actions.openGitGraph(ctx.m, ctx.cwd);
      break;
    case 'workspace_picker':
    case 'goto':
    case 'command_palette':
      s.setPalette?.(action === 'workspace_picker' ? 'workspaces' : 'commands');
      break;
    case 'help':
      s.setPalette?.('help');
      break;
  }
}
