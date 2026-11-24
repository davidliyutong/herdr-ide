// Key syntax: a key sequence is one or more strokes separated by spaces
// ("ctrl+b c" is ctrl+b, then c); a stroke is modifiers and a key joined by
// "+" ("cmd+shift+t"). The canonical form, which every client compares,
// writes modifiers in the order cmd, ctrl, alt, shift and names keys in
// lower case after the US layout's unshifted keys ("?" is "shift+slash").
// web/src/keys.ts implements the same rules; spec/vectors/keys holds the
// vectors both are tested with.

/** One key press with its modifiers. */
export interface Stroke {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** A stroke in its canonical form. */
export function strokeString(s: Stroke): string {
  let out = '';
  if (s.cmd) out += 'cmd+';
  if (s.ctrl) out += 'ctrl+';
  if (s.alt) out += 'alt+';
  if (s.shift) out += 'shift+';
  return out + s.key;
}

/** A key sequence: a stroke, or a chord of several. */
export type Sequence = Stroke[];

/** A sequence in its canonical form. */
export function sequenceString(q: Sequence): string {
  return q.map(strokeString).join(' ');
}

/** Bounds a sequence. */
export const MAX_STROKES = 4;

/** Why a key sequence was refused; code is one of empty, modifier, key,
 * repeat, typing, length. */
export class ParseError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail = '') {
    super(detail === '' ? 'key: ' + code : `key: ${code}: ${detail}`);
    this.name = 'ParseError';
    this.code = code;
    this.detail = detail;
  }
}

type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift';

const modifierNames = new Map<string, Modifier>([
  ['cmd', 'cmd'],
  ['command', 'cmd'],
  ['meta', 'cmd'],
  ['super', 'cmd'],
  ['win', 'cmd'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['alt', 'alt'],
  ['option', 'alt'],
  ['opt', 'alt'],
  ['shift', 'shift'],
]);

const namedKeys = new Set([
  'tab',
  'space',
  'enter',
  'escape',
  'backspace',
  'delete',
  'insert',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageup',
  'pagedown',
  'minus',
  'equal',
  'comma',
  'period',
  'slash',
  'backslash',
  'semicolon',
  'quote',
  'backtick',
  'bracketleft',
  'bracketright',
]);

const keyAliases = new Map([
  ['esc', 'escape'],
  ['return', 'enter'],
  ['del', 'delete'],
  ['ins', 'insert'],
  ['arrowleft', 'left'],
  ['arrowright', 'right'],
  ['arrowup', 'up'],
  ['arrowdown', 'down'],
  ['pgup', 'pageup'],
  ['pgdn', 'pagedown'],
  ['pgdown', 'pagedown'],
  ['-', 'minus'],
  ['=', 'equal'],
  [',', 'comma'],
  ['.', 'period'],
  ['/', 'slash'],
  ['\\', 'backslash'],
  [';', 'semicolon'],
  ["'", 'quote'],
  ['`', 'backtick'],
  ['[', 'bracketleft'],
  [']', 'bracketright'],
]);

/** Characters typed with Shift on a US layout, and the key. */
const shiftedKeys = new Map([
  ['?', 'slash'],
  ['{', 'bracketleft'],
  ['}', 'bracketright'],
  ['|', 'backslash'],
  ['_', 'minus'],
  ['plus', 'equal'],
  ['+', 'equal'],
  [':', 'semicolon'],
  ['"', 'quote'],
  ['~', 'backtick'],
  ['<', 'comma'],
  ['>', 'period'],
  ['!', '1'],
  ['@', '2'],
  ['#', '3'],
  ['$', '4'],
  ['%', '5'],
  ['^', '6'],
  ['&', '7'],
  ['*', '8'],
  ['(', '9'],
  [')', '0'],
]);

const plainKey = /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/;
/** F1 to F24. */
export const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/;

/** Reads one stroke. */
function parseStroke(text: string): Stroke {
  const lower = text.toLowerCase();
  let parts: string[];
  if (lower === '+') parts = ['+'];
  else if (lower.endsWith('++')) parts = [...lower.slice(0, -2).split('+'), '+'];
  else parts = lower.split('+');
  let key = parts[parts.length - 1];
  const s: Stroke = { cmd: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const p of parts.slice(0, -1)) {
    const m = modifierNames.get(p);
    if (!m) throw new ParseError('modifier', p);
    if (s[m]) throw new ParseError('repeat', m);
    s[m] = true;
  }
  const alias = keyAliases.get(key);
  const shifted = shiftedKeys.get(key);
  if (alias !== undefined) key = alias;
  else if (shifted !== undefined) {
    s.shift = true;
    key = shifted;
  }
  if (key === '') throw new ParseError('empty');
  if (!plainKey.test(key) && !namedKeys.has(key)) throw new ParseError('key', key);
  s.key = key;
  return s;
}

// Go's strings.Fields: runs of unicode.IsSpace.
const fieldSep = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** Reads a key sequence; throws a ParseError. The first stroke must hold
 * cmd, ctrl or alt (or be a function key), so a binding never takes a key
 * that types text. */
export function parse(text: string): Sequence {
  const fields = text.split(fieldSep).filter((f) => f !== '');
  if (fields.length === 0) throw new ParseError('empty');
  if (fields.length > MAX_STROKES) throw new ParseError('length', `at most ${MAX_STROKES} strokes`);
  const seq = fields.map(parseStroke);
  const first = seq[0];
  if (!first.cmd && !first.ctrl && !first.alt && !functionKey.test(first.key)) throw new ParseError('typing', strokeString(first));
  return seq;
}

/** A key sequence in its canonical form; throws a ParseError. */
export function normalize(text: string): string {
  return sequenceString(parse(text));
}
