// Direct shortcuts of the desktop app (keys without herdr's prefix, such as
// Cmd+T). Their specs are core settings (internal/shortcuts); the shell reads
// them from /api/settings, intercepts matching keys before the page sees them
// (so a pane never receives them, whichever frame has focus) and asks the page
// to run the action.

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

const named: Record<string, { code: string; accelerator: string }> = {
  tab: { code: 'Tab', accelerator: 'Tab' },
  space: { code: 'Space', accelerator: 'Space' },
  enter: { code: 'Enter', accelerator: 'Enter' },
  escape: { code: 'Escape', accelerator: 'Escape' },
  backspace: { code: 'Backspace', accelerator: 'Backspace' },
  delete: { code: 'Delete', accelerator: 'Delete' },
  left: { code: 'ArrowLeft', accelerator: 'Left' },
  right: { code: 'ArrowRight', accelerator: 'Right' },
  up: { code: 'ArrowUp', accelerator: 'Up' },
  down: { code: 'ArrowDown', accelerator: 'Down' },
  home: { code: 'Home', accelerator: 'Home' },
  end: { code: 'End', accelerator: 'End' },
  pageup: { code: 'PageUp', accelerator: 'PageUp' },
  pagedown: { code: 'PageDown', accelerator: 'PageDown' },
  minus: { code: 'Minus', accelerator: '-' },
  equal: { code: 'Equal', accelerator: '=' },
  comma: { code: 'Comma', accelerator: ',' },
  period: { code: 'Period', accelerator: '.' },
  slash: { code: 'Slash', accelerator: '/' },
  backslash: { code: 'Backslash', accelerator: '\\' },
  semicolon: { code: 'Semicolon', accelerator: ';' },
  quote: { code: 'Quote', accelerator: "'" },
  backtick: { code: 'Backquote', accelerator: '`' },
  bracketleft: { code: 'BracketLeft', accelerator: '[' },
  bracketright: { code: 'BracketRight', accelerator: ']' },
};

/** The physical key (KeyboardEvent.code) of a spec's key. */
function codeOf(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  return named[key]?.code;
}

/** Parses a spec such as "cmd+shift+t"; undefined for "none" and invalid specs. */
export function parseShortcut(spec: string | undefined): Shortcut | undefined {
  if (!spec || spec === 'none') return;
  const parts = spec.split('+');
  const key = parts.pop()!;
  if (!codeOf(key)) return;
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
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** Whether a key-down matches; physical keys, so layouts and Shift do not change letters. */
export function matchesInput(sc: Shortcut, input: KeyInput): boolean {
  return (
    input.type === 'keyDown' &&
    input.code === codeOf(sc.key) &&
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
  const key = named[sc.key]?.accelerator ?? sc.key.toUpperCase();
  return [...mods, key].join('+');
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
