// The browser's keyboard and mouse as the terminal's encoders take them
// (terminal.ts encodes them for the program's modes: legacy, application
// cursor and keypad, kitty keyboard protocol, mouse formats). Pure, so the
// key table in __tests__/testdata/vt-keys.json pins it with the encoder.

import { MODS_ALT, MODS_CTRL, MODS_SHIFT, MODS_SUPER, type KeyInput } from './terminal';

export const isMac = typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);

export type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat' | 'isComposing' | 'keyCode'
> & {
  type?: string;
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

const usSymbols: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
  IntlBackslash: '\\',
};
const usShifted: Record<string, string> = {
  Minus: '_',
  Equal: '+',
  BracketLeft: '{',
  BracketRight: '}',
  Backslash: '|',
  Semicolon: ':',
  Quote: '"',
  Backquote: '~',
  Comma: '<',
  Period: '>',
  Slash: '?',
  Space: ' ',
  Digit1: '!',
  Digit2: '@',
  Digit3: '#',
  Digit4: '$',
  Digit5: '%',
  Digit6: '^',
  Digit7: '&',
  Digit8: '*',
  Digit9: '(',
  Digit0: ')',
};

/** The character of a physical key on a US layout, shifted or not. */
export function usChar(code: string, shift = false): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return shift ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return shift ? usShifted[code] : digit[1];
  return shift ? usShifted[code] : usSymbols[code];
}

/** The modifiers of an event as the encoders' bits. */
export function modsOf(ev: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey?: boolean }): number {
  return (ev.shiftKey ? MODS_SHIFT : 0) | (ev.ctrlKey ? MODS_CTRL : 0) | (ev.altKey ? MODS_ALT : 0) | (ev.metaKey ? MODS_SUPER : 0);
}

/**
 * The key for the terminal's encoder, or undefined when the browser keeps
 * it: Cmd shortcuts, input method composition and dead keys, whose text
 * arrives as input events instead.
 */
export function keyInput(ev: KeyLike, o: KeyOptions = {}): KeyInput | undefined {
  const mac = o.mac ?? isMac;
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.metaKey) return;
  if (ev.key === 'Dead' || ev.key === 'Process') return;
  const action = ev.type === 'keyup' ? 'release' : ev.repeat ? 'repeat' : 'press';
  // AltGr types characters (and reports Ctrl+Alt on Windows).
  const altGr =
    !!ev.getModifierState?.('AltGraph') || (!mac && ev.ctrlKey && ev.altKey && oneChar(ev.key) && !/^[\x00-\x7f]$/.test(ev.key));
  // On macOS Option types characters unless it acts as Meta.
  const optionTypes = mac && ev.altKey && !o.optionIsMeta;
  let mods = ev.shiftKey ? MODS_SHIFT : 0;
  if (ev.ctrlKey && !altGr) mods |= MODS_CTRL;
  if (ev.altKey && !altGr) mods |= MODS_ALT;
  let consumed = altGr ? 0 : optionTypes ? MODS_ALT : 0;
  const printable = oneChar(ev.key) && ev.key !== '\t';
  if (!printable) return { action, code: ev.code, mods, consumed, text: '', unshifted: 0, optionAsAlt: mac && !!o.optionIsMeta };
  let text = ev.key;
  // Option as Meta: the key's own character, not Option's (å for a).
  if (mac && ev.altKey && o.optionIsMeta) text = usChar(ev.code, ev.shiftKey) ?? text;
  let unshifted: string | undefined;
  if (!ev.shiftKey && !optionTypes && !altGr && /^[\x20-\x7e]$/.test(text)) unshifted = text;
  else if (/^[A-Za-z]$/.test(text) && !optionTypes) unshifted = text.toLowerCase();
  // Ctrl chords on other layouts mean the physical key (Ctrl+С is Ctrl+C).
  if (!unshifted || (mods & MODS_CTRL && !/^[\x00-\x7f]$/.test(text))) unshifted = usChar(ev.code) ?? unshifted;
  if (ev.shiftKey && text !== unshifted) consumed |= MODS_SHIFT;
  if (altGr) consumed |= mods & MODS_SHIFT;
  return { action, code: ev.code, mods, consumed, text, unshifted: unshifted?.codePointAt(0) ?? 0, optionAsAlt: mac && !!o.optionIsMeta };
}

/** Text typed outside key events (input methods, dead keys, mobile
 * keyboards) as the program gets it: UTF-8 as it is. */
export function textInput(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The encoder's button for a browser button: left 1, middle 3, right 2. */
export function mouseButton(button: number): number {
  return button === 0 ? 1 : button === 1 ? 3 : button === 2 ? 2 : 0;
}

/** Whole lines a wheel event turns, carrying the rest over (accum in pixels). */
export function wheelLines(
  ev: { deltaY: number; deltaMode: number },
  lineHeight: number,
  pageRows: number,
  accum: number,
): { lines: number; accum: number } {
  let delta = ev.deltaY;
  if (ev.deltaMode === 1) delta *= lineHeight;
  else if (ev.deltaMode === 2) delta *= lineHeight * pageRows;
  const total = accum + delta;
  const lines = Math.trunc(total / lineHeight);
  return { lines, accum: total - lines * lineHeight };
}
