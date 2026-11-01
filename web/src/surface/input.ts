// Browser input as herdr's semantic pane input (ClientPaneInputEvent).
//
// The browser no longer encodes keys: it reports the key, its modifiers and
// the text it types, and herdr encodes them for the pane's own keyboard mode
// (legacy, application cursor, kitty keyboard protocol). The expected events
// per key are pinned in src/__tests__/testdata/keys.json, and
// TestIntegrationKeyParity checks the bytes herdr makes of them.

export const MODS = { shift: 1, ctrl: 2, alt: 4, super: 8 } as const;

export interface KeyEvent {
  code: string;
  char?: string;
  f?: number;
  mods?: number;
  /** 0 press, 1 repeat, 2 release. */
  kind?: number;
  shifted?: number;
  text?: string;
  tracksRelease?: boolean;
}

export interface MouseEvent {
  kind: 'down' | 'up' | 'drag' | 'move' | 'scrollUp' | 'scrollDown' | 'scrollLeft' | 'scrollRight';
  button?: number;
  col: number;
  row: number;
  mods?: number;
  lines?: number;
}

export type InputEvent =
  { t: 'key'; key: KeyEvent } | { t: 'text'; text: string } | { t: 'paste'; text: string } | { t: 'mouse'; mouse: MouseEvent };

const named: Record<string, string> = {
  Backspace: 'Backspace',
  Enter: 'Enter',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Tab: 'Tab',
  Delete: 'Delete',
  Insert: 'Insert',
  Escape: 'Esc',
};

export const isMac = typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);

type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat' | 'isComposing' | 'keyCode'
> & {
  getModifierState?(k: string): boolean;
};

export interface KeyOptions {
  /** macOS: Option is Alt (Meta) instead of typing characters. */
  optionIsMeta?: boolean;
  mac?: boolean;
}

/** One grapheme: a single character, possibly with combining marks. */
function oneChar(s: string): boolean {
  return s.length > 0 && [...s].length === 1;
}

/**
 * The pane input for a keydown, or undefined when the browser should handle
 * the key (Cmd shortcuts, modifier keys, IME composition, dead keys).
 */
export function keyEvent(ev: KeyLike, o: KeyOptions = {}): InputEvent | undefined {
  const mac = o.mac ?? isMac;
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.metaKey) return; // Cmd (macOS) / Super: left to the browser
  const altGr =
    !!ev.getModifierState?.('AltGraph') || (!mac && ev.ctrlKey && ev.altKey && oneChar(ev.key) && !/^[\x00-\x7f]$/.test(ev.key));
  // On macOS Option types characters unless it is set to act as Meta.
  const optionTypes = mac && ev.altKey && !o.optionIsMeta;
  let mods = 0;
  if (ev.shiftKey) mods |= MODS.shift;
  if (ev.ctrlKey && !altGr) mods |= MODS.ctrl;
  if (ev.altKey && !altGr && !optionTypes) mods |= MODS.alt;
  const kind = ev.repeat ? 1 : 0;

  const code = named[ev.key];
  // herdr 0.9.5 encodes no bytes for a Backspace key without Ctrl (its own
  // client forwards the terminal's DEL byte as text): send DEL as text too.
  if (code === 'Backspace' && !(mods & (MODS.ctrl | MODS.shift))) return { t: 'text', text: mods & MODS.alt ? '\x1b\x7f' : '\x7f' };
  if (code) {
    if (code === 'Tab' && ev.shiftKey) return { t: 'key', key: { code: 'BackTab', mods, kind, tracksRelease: true } };
    return { t: 'key', key: { code, mods, kind, tracksRelease: true } };
  }
  const f = /^F(\d{1,2})$/.exec(ev.key);
  if (f) return { t: 'key', key: { code: 'F', f: Number(f[1]), mods, kind, tracksRelease: true } };
  if (!oneChar(ev.key)) return; // Shift, Dead, Unidentified, …

  let char = ev.key;
  let shifted: number | undefined;
  if (ev.shiftKey && char.toLowerCase() !== char && oneChar(char.toLowerCase())) {
    // Kitty-style: the unshifted key plus its shifted alternate.
    shifted = char.codePointAt(0);
    char = char.toLowerCase();
  }
  // Ctrl chords on non-Latin layouts mean the physical Latin key (Ctrl+С is Ctrl+C).
  if (mods & MODS.ctrl && !/^[\x00-\x7f]$/.test(char)) {
    const k = /^Key([A-Z])$/.exec(ev.code);
    if (k) char = k[1].toLowerCase();
  }
  const types = !(mods & (MODS.ctrl | MODS.alt));
  const text = types ? ev.key : undefined;
  return { t: 'key', key: { code: 'Char', char, mods, kind, shifted, text, tracksRelease: !text } };
}

/** The release of a key reported with tracksRelease. */
export function releaseOf(press: KeyEvent): KeyEvent {
  return { ...press, kind: 2, text: undefined, shifted: press.shifted };
}

/** Pasted text as terminals send it: newlines as CR, and without ESC or
 * other C0/C1 controls (tab and CR aside), so pasted text cannot end the
 * paste early or smuggle escape sequences (herdr wraps it in markers when
 * the pane's program asked for that, but does not filter it). The core
 * filters again. */
export function pasteText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r?\n/g, '\r').replace(/[\x00-\x08\x0a-\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
