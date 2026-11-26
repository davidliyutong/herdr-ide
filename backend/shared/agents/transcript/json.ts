// Reading JSON of a transcript's line without decoding all of it: a line
// may be megabytes of many small values (a tool's input, a listing of
// blocks), which a whole decode would turn into many times its size. A
// line is checked whole (valid), then the members a parser needs are found
// by scanning (member, pick, elements) and only they are decoded, a value
// of unknown shape within a budget of values (Decoder). The text is a
// JavaScript string of the line's UTF-8 (bytes that are no UTF-8 read as
// U+FFFD, as Go's decoder reads them in strings).

/** A UTF-16 surrogate without its pair (a JSON escape can make one). */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** s with each lone surrogate as U+FFFD, as Go's decoder reads it. */
export const wellFormed = (s: string): string => (LONE.test(s) ? ((LONE.lastIndex = 0), s.replace(LONE, '�')) : s);

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

export function skipSpace(b: string, i: number): number {
  while (i < b.length && isSpace(b.charCodeAt(i))) i++;
  return i;
}

/** The index after the string that starts at b[i] (a quote); -1 when it
 * does not end. */
export function stringEnd(b: string, i: number): number {
  for (let j = i + 1; ;) {
    const q = b.indexOf('"', j);
    if (q < 0) return -1;
    let n = 0;
    for (let p = q - 1; p > i && b.charCodeAt(p) === 0x5c; p--) n++;
    if (n % 2 === 0) return q + 1;
    j = q + 1;
  }
}

/** The index after the JSON value that starts at b[i]; -1 when it does not
 * end. */
export function valueEnd(b: string, i: number): number {
  if (i >= b.length) return -1;
  const c = b[i];
  if (c === '"') return stringEnd(b, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < b.length;) {
      const d = b[j];
      if (d === '"') {
        j = stringEnd(b, j);
        if (j < 0) return -1;
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if ((d === '}' || d === ']') && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  let j = i;
  for (; j < b.length; j++) {
    const d = b.charCodeAt(j);
    if (d === 0x2c || d === 0x7d || d === 0x5d || isSpace(d)) break;
  }
  return j === i ? -1 : j;
}

/** The raw value of the first top-level member key of the object b, found
 * without decoding the others; null when b is no object or has no such
 * member before something that is not JSON. Keys are compared as written. */
export function member(b: string, key: string): string | null {
  let i = skipSpace(b, 0);
  if (b[i] !== '{') return null;
  i++;
  for (;;) {
    i = skipSpace(b, i);
    if (b[i] !== '"') return null;
    const ke = stringEnd(b, i);
    if (ke < 0) return null;
    const k = b.slice(i + 1, ke - 1);
    i = skipSpace(b, ke);
    if (b[i] !== ':') return null;
    i = skipSpace(b, i + 1);
    const ve = valueEnd(b, i);
    if (ve < 0) return null;
    if (k === key) return b.slice(i, ve);
    i = skipSpace(b, ve);
    if (b[i] !== ',') return null;
    i++;
  }
}

/** The string value of a top-level member of the object b; "" when it has
 * none or the value is no string. */
export function memberString(b: string, key: string): string {
  const v = member(b, key);
  if (v === null || v.length < 2 || v[0] !== '"') return '';
  if (!v.includes('\\')) return v.slice(1, -1);
  try {
    return wellFormed(JSON.parse(v) as string);
  } catch {
    return '';
  }
}

/** Whether a raw value is there and not null. */
export const present = (v: string | null | undefined): v is string => !!v && v.trim() !== '' && v.trim() !== 'null';

/** Calls fn with each element of the array a, in order, until fn returns
 * false, at most limit of them (none for limit < 0): more tells that it
 * stopped at the limit with elements left; ok is false when a is no array.
 * Nothing is decoded. */
export function elements(a: string, limit: number, fn: (v: string) => boolean): { more: boolean; ok: boolean } {
  let i = skipSpace(a, 0);
  if (a[i] !== '[') return { more: false, ok: false };
  i = skipSpace(a, i + 1);
  if (a[i] === ']') return { more: false, ok: true };
  for (let n = 0; ; n++) {
    const e = valueEnd(a, i);
    if (e < 0) return { more: false, ok: false };
    if (limit >= 0 && n === limit) return { more: true, ok: true };
    if (!fn(a.slice(i, e))) return { more: false, ok: true };
    i = skipSpace(a, e);
    if (i >= a.length) return { more: false, ok: false };
    if (a[i] === ',') i = skipSpace(a, i + 1);
    else if (a[i] === ']') return { more: false, ok: true };
    else return { more: false, ok: false };
  }
}

/** The members of the object b that keys name, as raw values (of members
 * of one name, the last), without decoding the others; null when b is no
 * object. */
export function pick(b: string, ...keys: string[]): Map<string, string> | null {
  let i = skipSpace(b, 0);
  if (b[i] !== '{') return null;
  const out = new Map<string, string>();
  i = skipSpace(b, i + 1);
  if (b[i] === '}') return out;
  for (;;) {
    if (b[i] !== '"') return null;
    const ke = stringEnd(b, i);
    if (ke < 0) return null;
    const k = b.slice(i, ke);
    i = skipSpace(b, ke);
    if (b[i] !== ':') return null;
    i = skipSpace(b, i + 1);
    const ve = valueEnd(b, i);
    if (ve < 0) return null;
    for (const key of keys)
      if (keyIs(k, key)) {
        out.set(key, b.slice(i, ve));
        break;
      }
    i = skipSpace(b, ve);
    if (i >= b.length) return null;
    if (b[i] === ',') i = skipSpace(b, i + 1);
    else if (b[i] === '}') return out;
    else return null;
  }
}

/** Whether the JSON string q (with its quotes) holds key. */
function keyIs(q: string, key: string): boolean {
  if (q.length < key.length + 2) return false;
  return q.includes('\\') ? unquote(q) === key : q.slice(1, -1) === key;
}

/** The string a JSON string (with its quotes) holds. */
export function unquote(q: string): string {
  const s = q.slice(1, -1);
  if (!s.includes('\\')) return wellFormed(s);
  try {
    return wellFormed(JSON.parse(q) as string);
  } catch {
    return '';
  }
}

/** Whether s is one valid JSON value (and only space around it), checked
 * without building it. */
export function valid(s: string): boolean {
  let i = skipSpace(s, 0);
  // The containers open, innermost last: true for an object.
  const stack: boolean[] = [];
  const value = (): boolean => {
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      const e = stringEnd(s, i);
      if (e < 0) return false;
      // Control characters may not be in a string; escapes are \", \\, \/,
      // \b, \f, \n, \r, \t and \uXXXX.
      for (let j = i + 1; j < e - 1; j++) {
        const d = s.charCodeAt(j);
        if (d < 0x20) return false;
        if (d === 0x5c) {
          const x = s[j + 1];
          if (x === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(s.slice(j + 2, j + 6))) return false;
            j += 5;
          } else if ('"\\/bfnrt'.includes(x)) j++;
          else return false;
        }
      }
      i = e;
      return true;
    }
    if (c === 0x74) return lit('true');
    if (c === 0x66) return lit('false');
    if (c === 0x6e) return lit('null');
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (!m) return false;
    i += m[0].length;
    // A number longer than the window is cut; what follows must end it.
    if (m[0].length === 400) {
      while (i < s.length && /[0-9eE.+-]/.test(s[i])) i++;
    }
    return true;
  };
  const lit = (w: string) => {
    if (!s.startsWith(w, i)) return false;
    i += w.length;
    return true;
  };
  for (;;) {
    i = skipSpace(s, i);
    const c = s[i];
    if (c === '{' || c === '[') {
      i = skipSpace(s, i + 1);
      if (s[i] === (c === '{' ? '}' : ']')) {
        i++;
      } else {
        stack.push(c === '{');
        if (c === '{' && !key()) return false;
        continue;
      }
    } else if (!value()) return false;
    // After a value: close containers, or go on with the next element.
    for (;;) {
      i = skipSpace(s, i);
      if (stack.length === 0) return i === s.length;
      const obj = stack[stack.length - 1];
      if (s[i] === ',') {
        i++;
        if (obj && !key()) return false;
        break;
      }
      if (s[i] === (obj ? '}' : ']')) {
        i++;
        stack.pop();
        continue;
      }
      return false;
    }
  }

  /** A member's key and its colon. */
  function key(): boolean {
    i = skipSpace(s, i);
    if (s[i] !== '"' || !value()) return false;
    i = skipSpace(s, i);
    if (s[i] !== ':') return false;
    i++;
    return true;
  }
}

/** The most JSON values a line's parse decodes into objects, arrays and
 * scalars (a tool call's input): what is beyond is left out, so a line of
 * many small values does not take many times its size. */
export const MAX_LINE_NODES = 1 << 15;

/** Decodes JSON as JSON.parse does, from a budget of values and no deeper
 * than maxDepth: what is beyond is left out (cut). bad: a number a double
 * does not hold (Go's decoder fails on it, and gives null). */
export class Decoder {
  cut = false;
  bad = false;
  private readonly budget: { nodes: number };
  private readonly maxDepth: number;

  constructor(budget: { nodes: number }, maxDepth: number) {
    this.budget = budget;
    this.maxDepth = maxDepth;
  }

  /** The value at b[i] of valid JSON b, and the index after it. */
  value(b: string, i: number, depth: number): [unknown, number] {
    if (this.budget.nodes <= 0 || depth > this.maxDepth) {
      this.cut = true;
      return [null, valueEnd(b, i)];
    }
    this.budget.nodes--;
    const c = b[i];
    if (c === '{') {
      const m: Record<string, unknown> = {};
      i = skipSpace(b, i + 1);
      if (b[i] === '}') return [m, i + 1];
      for (;;) {
        const ke = stringEnd(b, i);
        const k = unquote(b.slice(i, ke));
        i = skipSpace(b, skipSpace(b, ke) + 1);
        if (this.budget.nodes > 0) {
          let v: unknown;
          [v, i] = this.value(b, i, depth + 1);
          Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true });
        } else {
          this.cut = true;
          i = valueEnd(b, i);
        }
        i = skipSpace(b, i);
        if (b[i] === '}') return [m, i + 1];
        i = skipSpace(b, i + 1);
      }
    }
    if (c === '[') {
      const a: unknown[] = [];
      i = skipSpace(b, i + 1);
      if (b[i] === ']') return [a, i + 1];
      for (;;) {
        if (this.budget.nodes > 0) {
          let v: unknown;
          [v, i] = this.value(b, i, depth + 1);
          a.push(v);
        } else {
          this.cut = true;
          i = valueEnd(b, i);
        }
        i = skipSpace(b, i);
        if (b[i] === ']') return [a, i + 1];
        i = skipSpace(b, i + 1);
      }
    }
    if (c === '"') {
      const e = stringEnd(b, i);
      return [unquote(b.slice(i, e)), e];
    }
    if (c === 't') return [true, i + 4];
    if (c === 'f') return [false, i + 5];
    if (c === 'n') return [null, i + 4];
    const e = valueEnd(b, i);
    const f = Number(b.slice(i, e));
    if (!Number.isFinite(f)) {
      this.bad = true;
      return [null, e];
    }
    return [f, e];
  }
}
