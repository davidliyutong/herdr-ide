// JSON text as Go's encoding/json writes and keeps it. The settings file's
// entries are kept as written (Go's json.RawMessage), so a value this
// version does not know or cannot use goes back into the file unchanged,
// only indented again; values are written as json.Marshal writes them, so
// the file reads the same whichever program wrote it.

const space = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipSpace(s: string, i: number): number {
  while (i < s.length && space(s[i])) i++;
  return i;
}

/** The end (exclusive) of the string literal starting at i. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return s.length;
}

/** The end (exclusive) of the value starting at i of valid JSON text. */
function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') j = stringEnd(s, j) - 1;
      else if (d === '{' || d === '[') depth++;
      else if ((d === '}' || d === ']') && --depth === 0) return j + 1;
    }
    return s.length;
  }
  let j = i;
  while (j < s.length && !space(s[j]) && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++;
  return j;
}

/** Whether text is valid JSON. */
export function valid(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The members of an object as written (a name given twice: the last),
 * as Go unmarshals one into map[string]json.RawMessage; undefined when
 * text, which must be valid JSON, is not an object. */
export function members(text: string): Map<string, string> | undefined {
  let i = skipSpace(text, 0);
  if (text[i] !== '{') return undefined;
  const out = new Map<string, string>();
  i = skipSpace(text, i + 1);
  if (text[i] === '}') return out;
  for (;;) {
    const nameEnd = stringEnd(text, i);
    const name = JSON.parse(text.slice(i, nameEnd)) as string;
    i = skipSpace(text, skipSpace(text, nameEnd) + 1); // past ':'
    const end = valueEnd(text, i);
    out.set(name, text.slice(i, end));
    i = skipSpace(text, end);
    if (text[i] !== ',') return out;
    i = skipSpace(text, i + 1);
  }
}

const htmlEscapes = /[<>&\u2028\u2029]/g;
const escape = (c: string) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');

/** v as json.Marshal writes it: compact, with <, >, & and the line and
 * paragraph separators escaped in strings. */
export function marshal(v: unknown): string {
  return JSON.stringify(v).replace(htmlEscapes, escape);
}

/** Valid JSON text without insignificant space, strings escaped as
 * marshal does (what json.Marshal makes of a json.RawMessage). */
export function compact(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end).replace(htmlEscapes, escape);
      i = end - 1;
    } else if (!space(c)) {
      out += c;
    }
  }
  return out;
}

/** Valid JSON text laid out as Go's json.Indent does: each element of an
 * object or array on a line of its own, after prefix and indent once per
 * level; empty objects and arrays stay {} and []; literals unchanged. */
export function indent(text: string, prefix: string, ind: string): string {
  let out = '';
  let depth = 0;
  let needIndent = false;
  const newline = () => '\n' + prefix + ind.repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (space(c)) continue;
    if (needIndent && c !== '}' && c !== ']') {
      needIndent = false;
      depth++;
      out += newline();
    }
    switch (c) {
      case '"': {
        const end = stringEnd(text, i);
        out += text.slice(i, end);
        i = end - 1;
        break;
      }
      case '{':
      case '[':
        // Delayed, so that empty objects and arrays stay {} and [].
        needIndent = true;
        out += c;
        break;
      case ',':
        out += c + newline();
        break;
      case ':':
        out += ': ';
        break;
      case '}':
      case ']':
        if (needIndent) needIndent = false;
        else {
          depth--;
          out += newline();
        }
        out += c;
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Orders strings by their UTF-8 bytes (by code point), as Go's
 * sort.Strings does; JavaScript's < compares UTF-16 units. */
export function byteOrder(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}
