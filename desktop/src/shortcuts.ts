// Direct shortcuts of the desktop app (keys without herdr's prefix, such as
// Cmd+T). Their specs are core settings (internal/shortcuts); the shell reads
// them from /api/settings, intercepts matching keys before the page sees them
// (so a pane never receives them, whichever frame has focus) and asks the page
// to run the action. Keys are named by web/src/shortcutKey.ts, after the
// character the keyboard layout gives them.

import { acceleratorKey, isKeyName, keyName } from '../../web/src/shortcutKey';

/** Actions the page runs for a shortcut; the core setting that holds its keys. */
export const shortcutSettings = {
  new_tab: 'desktop-new-tab-key',
  close_tab: 'desktop-close-tab-key',
} as const;

export type ShortcutAction = keyof typeof shortcutSettings;
export type Shortcuts = Partial<Record<ShortcutAction, string>>;

export interface Shortcut {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** Parses a spec such as "cmd+shift+t"; undefined for "none" and invalid specs. */
export function parseShortcut(spec: string | undefined): Shortcut | undefined {
  if (!spec || spec === 'none') return;
  const parts = spec.split('+');
  const key = parts.pop()!;
  if (!isKeyName(key)) return;
  const sc: Shortcut = { cmd: false, ctrl: false, alt: false, shift: false, key };
  for (const p of parts) {
    if (p !== 'cmd' && p !== 'ctrl' && p !== 'alt' && p !== 'shift') return;
    if (sc[p]) return;
    sc[p] = true;
  }
  if (!sc.cmd && !sc.ctrl && !sc.alt) return;
  return sc;
}

/** The fields of Electron's before-input-event Input used for matching. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** Whether a key-down matches: the key by its character on the current
 * layout (so AZERTY's Cmd+Z is not cmd+w), and exactly the spec's modifiers. */
export function matchesInput(sc: Shortcut, input: KeyInput): boolean {
  return (
    input.type === 'keyDown' &&
    keyName(input) === sc.key &&
    input.meta === sc.cmd &&
    input.control === sc.ctrl &&
    input.alt === sc.alt &&
    input.shift === sc.shift
  );
}

/** The action whose shortcut matches the input, if any. */
export function shortcutFor(shortcuts: Shortcuts, input: KeyInput): ShortcutAction | undefined {
  for (const [action, spec] of Object.entries(shortcuts)) {
    const sc = parseShortcut(spec);
    if (sc && matchesInput(sc, input)) return action as ShortcutAction;
  }
}

/** Electron accelerator for the menu's key label, e.g. "Command+Shift+T". */
export function toAccelerator(spec: string | undefined): string | undefined {
  const sc = parseShortcut(spec);
  if (!sc) return;
  const mods = [sc.cmd && 'Super', sc.ctrl && 'Control', sc.alt && 'Alt', sc.shift && 'Shift'].filter(Boolean);
  return [...mods, acceleratorKey(sc.key)].join('+');
}

/** The shortcuts in a /api/settings reply; settings that are missing stay unset. */
export function shortcutsFromSettings(reply: unknown): Shortcuts {
  const out: Shortcuts = {};
  const list = (reply as { settings?: unknown })?.settings;
  if (!Array.isArray(list)) return out;
  for (const [action, key] of Object.entries(shortcutSettings) as [ShortcutAction, string][]) {
    const e = list.find((s) => (s as { key?: unknown })?.key === key) as { value?: unknown } | undefined;
    if (typeof e?.value === 'string' && parseShortcut(e.value)) out[action] = e.value;
  }
  return out;
}

/** The default shortcuts, as internal/shortcuts sets them: cmd+t / cmd+w on
 * macOS; elsewhere ctrl+shift+t / ctrl+shift+w, as in terminal emulators,
 * since ctrl+w deletes a word in shells. Used until the core's are read. */
export function defaultShortcuts(platform: string): Shortcuts {
  return platform === 'darwin' ? { new_tab: 'cmd+t', close_tab: 'cmd+w' } : { new_tab: 'ctrl+shift+t', close_tab: 'ctrl+shift+w' };
}

/** The spec of a key-down while the settings dialog records a shortcut, e.g.
 * "cmd+shift+t"; undefined for keys without cmd, ctrl or alt (those reach the
 * page: Escape cancels, Backspace removes) and for lone modifiers. */
export function recordedSpec(input: KeyInput): string | undefined {
  if (input.type !== 'keyDown' || !(input.meta || input.control || input.alt)) return;
  const key = keyName(input);
  if (!key) return;
  const mods = [input.meta && 'cmd', input.control && 'ctrl', input.alt && 'alt', input.shift && 'shift'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Whether url is a VS Code (code-server) frame of the core, /m/<machine>/code/…. */
export function isCodeFrame(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin && !u.username && !u.password && /^\/m\/[^/]+\/code\//.test(u.pathname);
  } catch {
    return false;
  }
}
