// Key sequences of keybindings, as the core's internal/keybindings writes
// them: strokes separated by spaces ("ctrl+b c"), each modifiers and a key
// joined by "+", canonically in the order cmd, ctrl, alt, shift with keys
// named after the US layout's unshifted keys ("?" is "shift+slash").
// internal/keybindings does the same; design/testdata/keys holds the vectors
// both are tested with. Shared by the page and the desktop
// app's shell, whose menu shows the keys (desktop/src/menu.ts).
//
// A pressed key is named after the character the keyboard layout gives it,
// as macOS names its shortcuts: on AZERTY, Cmd+Z is "z" although its
// physical key is KeyW, so undo never matches a cmd+w binding. Keys without
// an ASCII character (non-Latin layouts, Option on macOS, dead keys) and
// keys that type no character fall back to their physical key.

export interface Stroke {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export const MAX_STROKES = 4;

/** Why a key sequence was refused: empty, modifier, key, repeat, typing, length. */
export class KeyError extends Error {
  constructor(
    readonly code: string,
    detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

interface Named {
  code: string;
  accelerator: string;
  /** The character the key types without Shift on a US layout. */
  char?: string;
  /** The character it types with Shift. */
  shifted?: string;
}

const named: Record<string, Named> = {
  tab: { code: 'Tab', accelerator: 'Tab' },
  space: { code: 'Space', accelerator: 'Space', char: ' ' },
  enter: { code: 'Enter', accelerator: 'Enter' },
  escape: { code: 'Escape', accelerator: 'Escape' },
  backspace: { code: 'Backspace', accelerator: 'Backspace' },
  delete: { code: 'Delete', accelerator: 'Delete' },
  insert: { code: 'Insert', accelerator: 'Insert' },
  left: { code: 'ArrowLeft', accelerator: 'Left' },
  right: { code: 'ArrowRight', accelerator: 'Right' },
  up: { code: 'ArrowUp', accelerator: 'Up' },
  down: { code: 'ArrowDown', accelerator: 'Down' },
  home: { code: 'Home', accelerator: 'Home' },
  end: { code: 'End', accelerator: 'End' },
  pageup: { code: 'PageUp', accelerator: 'PageUp' },
  pagedown: { code: 'PageDown', accelerator: 'PageDown' },
  minus: { code: 'Minus', accelerator: '-', char: '-', shifted: '_' },
  equal: { code: 'Equal', accelerator: '=', char: '=', shifted: '+' },
  comma: { code: 'Comma', accelerator: ',', char: ',', shifted: '<' },
  period: { code: 'Period', accelerator: '.', char: '.', shifted: '>' },
  slash: { code: 'Slash', accelerator: '/', char: '/', shifted: '?' },
  backslash: { code: 'Backslash', accelerator: '\\', char: '\\', shifted: '|' },
  semicolon: { code: 'Semicolon', accelerator: ';', char: ';', shifted: ':' },
  quote: { code: 'Quote', accelerator: "'", char: "'", shifted: '"' },
  backtick: { code: 'Backquote', accelerator: '`', char: '`', shifted: '~' },
  bracketleft: { code: 'BracketLeft', accelerator: '[', char: '[', shifted: '{' },
  bracketright: { code: 'BracketRight', accelerator: ']', char: ']', shifted: '}' },
};

const shiftedDigits = ')!@#$%^&*(';

const modifierNames: Record<string, keyof Omit<Stroke, 'key'>> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

const keyAliases: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
};

const byChar = new Map(Object.entries(named).flatMap(([name, n]) => (n.char ? [[n.char, name] as const] : [])));
const byShifted = new Map<string, string>([
  ...Object.entries(named).flatMap(([name, n]) => (n.shifted ? [[n.shifted, name] as const] : [])),
  ...[...shiftedDigits].map((c, i) => [c, String(i)] as const),
  ['plus', 'equal'],
]);
const byCode = new Map(Object.entries(named).map(([name, n]) => [n.code, name] as const));

const plainKey = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/;
const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/;

/** Whether name is a key name of the syntax ("t", "1", "f5", "comma"…). */
export function isKeyName(name: string): boolean {
  return plainKey.test(name) || Object.hasOwn(named, name);
}

function parseStroke(text: string): Stroke {
  const lower = text.toLowerCase();
  let parts: string[];
  if (lower === '+') parts = ['+'];
  else if (lower.endsWith('++')) parts = [...lower.slice(0, -2).split('+'), '+'];
  else parts = lower.split('+');
  let key = parts.pop()!;
  const s: Stroke = { cmd: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    const m = modifierNames[p];
    if (!m) throw new KeyError('modifier', p);
    if (s[m]) throw new KeyError('repeat', m);
    s[m] = true;
  }
  if (Object.hasOwn(keyAliases, key)) key = keyAliases[key];
  else if (byChar.has(key)) key = byChar.get(key)!;
  else if (byShifted.has(key) || key === '+') {
    key = key === '+' ? 'equal' : byShifted.get(key)!;
    s.shift = true;
  }
  if (key === '') throw new KeyError('empty');
  if (!isKeyName(key)) throw new KeyError('key', key);
  s.key = key;
  return s;
}

/** Reads a key sequence. The first stroke must hold cmd, ctrl or alt (or be
 * a function key), so a binding never takes a key that types text. */
export function parseKeys(text: string): Stroke[] {
  const fields = text.split(/\s+/).filter(Boolean);
  if (fields.length === 0) throw new KeyError('empty');
  if (fields.length > MAX_STROKES) throw new KeyError('length');
  const seq = fields.map(parseStroke);
  const first = seq[0];
  if (!first.cmd && !first.ctrl && !first.alt && !functionKey.test(first.key)) throw new KeyError('typing', strokeString(first));
  return seq;
}

export function strokeString(s: Stroke): string {
  return [s.cmd && 'cmd', s.ctrl && 'ctrl', s.alt && 'alt', s.shift && 'shift', s.key].filter(Boolean).join('+');
}

/** The canonical form of a key sequence; throws KeyError. */
export function normalizeKeys(text: string): string {
  return parseKeys(text).map(strokeString).join(' ');
}

/** The canonical form, or undefined for an invalid sequence. */
export function tryNormalize(text: string): string | undefined {
  try {
    return normalizeKeys(text);
  } catch {
    return undefined;
  }
}

/** The name of the physical key, as on a US layout. */
function nameOfCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code.toLowerCase();
  return byCode.get(code);
}

/** The name of a pressed key: its character on the current layout when that
 * is a letter, digit or named punctuation, else its physical key. Shift does
 * not change it (Shift+1 is "1", Shift+T is "t"). */
export function keyName(ev: { key?: string; code: string }): string | undefined {
  const k = ev.key;
  if (k && k.length === 1) {
    const c = k.toLowerCase();
    if (/^[a-z0-9]$/.test(c)) return c;
    const n = byChar.get(c);
    if (n) return n;
  }
  return nameOfCode(ev.code);
}

export interface KeyInputLike {
  key?: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The stroke of a key press, e.g. "cmd+shift+t"; undefined for a lone
 * modifier and keys without a name. */
export function strokeOf(ev: KeyInputLike): string | undefined {
  const key = keyName(ev);
  if (!key) return;
  return strokeString({ cmd: ev.metaKey, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, key });
}

/** Whether a canonical stroke takes Alt/Option without Cmd or Ctrl: such
 * keys also type characters on macOS and are Meta keys in terminals. */
export function altOnly(stroke: string): boolean {
  const mods = stroke.split('+').slice(0, -1);
  return mods.includes('alt') && !mods.includes('cmd') && !mods.includes('ctrl');
}

/** The character a punctuation or digit key types with Shift on a US
 * layout ("}" for bracketright, "!" for 1); undefined for other keys. */
export function shiftedChar(name: string): string | undefined {
  return named[name]?.shifted ?? (/^\d$/.test(name) ? shiftedDigits[Number(name)] : undefined);
}

/** Whether the page runs on macOS (or iOS), whose keys are shown as symbols. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Keys shown as symbols on macOS, as its menus show them. */
const macKeys: Record<string, string> = {
  enter: '↩',
  escape: '⎋',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  pageup: '⇞',
  pagedown: '⇟',
  home: '↖',
  end: '↘',
  space: 'Space',
};
const pcKeys: Record<string, string> = { escape: 'Esc', pageup: 'PageUp', pagedown: 'PageDown', backspace: 'Backspace', space: 'Space' };
const macMods: [string, string][] = [
  ['ctrl', '⌃'],
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['cmd', '⌘'],
];
const pcMods: [string, string][] = [
  ['cmd', 'Cmd'],
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
];

/** How a key sequence is shown to the user: as macOS menus show keys
 * ("⇧⌘P", "⌥⌘←") on macOS, else as Windows and Linux do ("Ctrl+Shift+P").
 * A shifted punctuation key shows the character it types ("⌘}", "Ctrl+?");
 * the strokes of a chord are separated by a space. */
export function keyLabel(seq: string, mac = isMac): string {
  return seq
    .split(' ')
    .filter(Boolean)
    .map((stroke) => {
      const parts = stroke.split('+');
      const name = parts.pop()!;
      const shifted = parts.includes('shift') ? shiftedChar(name) : undefined;
      const mods = shifted ? parts.filter((p) => p !== 'shift') : parts;
      const key =
        shifted ??
        (mac ? macKeys[name] : pcKeys[name]) ??
        (named[name]?.char?.trim() || (name.length === 1 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1)));
      const order = mac ? macMods : pcMods;
      const shown = order.filter(([m]) => mods.includes(m)).map(([, label]) => label);
      return mac ? shown.join('') + key : [...shown, key].join('+');
    })
    .join(' ');
}

/** The key part of an Electron menu accelerator, e.g. "T", ",", "Left". */
export function acceleratorKey(name: string): string {
  return named[name]?.accelerator ?? name.toUpperCase();
}
