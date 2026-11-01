// Key names of the desktop app's direct shortcuts, shared by the shell's
// matcher (desktop/src/shortcuts.ts) and the settings dialog's recorder
// (desktop.ts), so a key records and matches the same way. A key is named
// after the character the keyboard layout gives it, as macOS names Cmd
// shortcuts: on AZERTY, Cmd+Z is "z" although its physical key is KeyW, so
// undo never matches a cmd+w shortcut. Keys without an ASCII character
// (non-Latin layouts, Option on macOS, dead keys) and keys that type no
// character fall back to their physical key (KeyboardEvent.code).

interface Named {
  code: string;
  accelerator: string;
  /** The character the key types without Shift on a US layout. */
  char?: string;
}

const named: Record<string, Named> = {
  tab: { code: 'Tab', accelerator: 'Tab' },
  space: { code: 'Space', accelerator: 'Space', char: ' ' },
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
  minus: { code: 'Minus', accelerator: '-', char: '-' },
  equal: { code: 'Equal', accelerator: '=', char: '=' },
  comma: { code: 'Comma', accelerator: ',', char: ',' },
  period: { code: 'Period', accelerator: '.', char: '.' },
  slash: { code: 'Slash', accelerator: '/', char: '/' },
  backslash: { code: 'Backslash', accelerator: '\\', char: '\\' },
  semicolon: { code: 'Semicolon', accelerator: ';', char: ';' },
  quote: { code: 'Quote', accelerator: "'", char: "'" },
  backtick: { code: 'Backquote', accelerator: '`', char: '`' },
  bracketleft: { code: 'BracketLeft', accelerator: '[', char: '[' },
  bracketright: { code: 'BracketRight', accelerator: ']', char: ']' },
};

const byChar = new Map(Object.entries(named).flatMap(([name, n]) => (n.char ? [[n.char, name] as const] : [])));
const byCode = new Map(Object.entries(named).map(([name, n]) => [n.code, name] as const));

/** Whether name is a key a shortcut spec can use ("t", "1", "f5", "comma"…). */
export function isKeyName(name: string): boolean {
  return /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/.test(name) || Object.hasOwn(named, name);
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

/** The key part of an Electron menu accelerator, e.g. "T", ",", "Left". */
export function acceleratorKey(name: string): string {
  return named[name]?.accelerator ?? name.toUpperCase();
}
