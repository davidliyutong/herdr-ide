// Text the conversation view derives from items: a command's output as
// plain text, what a tool call acts on, token counts, costs, the context
// in use, limit windows and paths for people.
import type { Limit } from '../plugins/chat/protocol';
import { ownMeta, type Cost, type ToolItem, type Usage } from './model';

// Terminal control sequences: OSC (to BEL or ST) and DCS, SOS, PM and APC
// strings (to ST), CSI sequences, character set designations, then any
// other escape and the C0 controls but tab, newline and carriage return.
const STRINGS = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\/g;
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const CHARSET = /\x1b[()*+\-./][ -~]/g;
const ESCAPE = /\x1b[ -/]*[0-~]?/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** A command's output as plain text: escape sequences dropped (colors and
 * the rest are not drawn), and a line a carriage return overwrote as the
 * terminal ended up showing it (what follows the last one). */
export function plainOutput(s: string): string {
  const text = s.replace(STRINGS, '').replace(CSI, '').replace(CHARSET, '').replace(ESCAPE, '').replace(CONTROLS, '');
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cr = l.lastIndexOf('\r');
      return cr < 0 ? l : l.slice(cr + 1);
    })
    .join('\n');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** An argv as a shell line: arguments with spaces or quotes quoted. */
function shellLine(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The command line a tool call runs, from its input (command or cmd, a
 * line or an argv; a shell's `-c` script is the command). */
export function commandOf(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return str(c);
  if (Array.isArray(c) && c.length && c.every((a) => typeof a === 'string')) {
    const argv = c as string[];
    if (argv.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return str(argv[2]);
    return shellLine(argv);
  }
  return undefined;
}

/** A tool call's input member that is text, by the first of names it has. */
export function inputText(input: unknown, ...names: string[]): string | undefined {
  if (!isObject(input)) return undefined;
  for (const n of names) {
    const v = str(input[n]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** What a tool call acts on, for its row: a command, a search's pattern, a
 * fetched URL or query, a task's description; for calls on files (their
 * locations show them) the path only when it has no location. */
export function subjectOf(item: ToolItem): string | undefined {
  const input = item.rawInput;
  switch (item.toolKind) {
    case 'execute':
      return commandOf(input);
    case 'search':
      return inputText(input, 'pattern', 'query', 'regex', 'glob', 'q');
    case 'fetch':
      return inputText(input, 'url', 'query', 'uri');
    case 'think':
      return inputText(input, 'description', 'subagent_type');
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
      return item.locations.length ? undefined : inputText(input, 'file_path', 'path', 'notebook_path', 'filePath');
    default:
      return undefined;
  }
}

/** A command's exit code: the product's mark in the call's _meta, else
 * one its raw output names. */
export function exitCodeOf(item: ToolItem): number | undefined {
  const own = ownMeta({ _meta: item.meta });
  if (typeof own?.exitCode === 'number') return own.exitCode;
  const out = item.rawOutput;
  if (isObject(out))
    for (const k of ['exitCode', 'exit_code', 'returncode', 'code']) if (typeof out[k] === 'number') return out[k] as number;
  return undefined;
}

/** Whether the call's command was interrupted (the product's mark). */
export const interrupted = (item: ToolItem): boolean => ownMeta({ _meta: item.meta })?.interrupted === true;

/** A count of tokens for people: 950, 12.3k, 200k, 1.25M. */
export function formatTokens(n: number): string {
  const trim = (x: number, digits: number) =>
    x
      .toFixed(digits)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${trim(n / 1e3, n < 1e4 ? 2 : n < 1e5 ? 1 : 0)}k`;
  return `${trim(n / 1e6, n < 1e7 ? 2 : 1)}M`;
}

/** A path's file name and, apart, the last two directories above it
 * ("…/" before them when there are more). */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.replace(/\/+$/, '').split('/');
  const name = parts.pop() || path;
  const abs = parts[0] === '';
  const dirs = parts.filter((p) => p !== '');
  if (!dirs.length) return { name, dir: abs ? '/' : '' };
  const tail = dirs.slice(-2).join('/');
  return { name, dir: dirs.length > 2 ? `…/${tail}` : abs ? `/${tail}` : tail };
}

/** A value as indented JSON, cut to max characters. */
export function jsonText(v: unknown, max = 20_000): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

/** The most of a message spokenText reads. */
export const SPOKEN_MAX = 4000;

// A table's delimiter row (| --- | :-: |): one line, each part of it taken
// one way only, so that a line that is none is given up in time linear in
// its length.
const TABLE_RULE = /^[ \t]*(?:\|[ \t]*)?:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*(?:\|[ \t]*)?$/gm;

/** The start of Markdown (SPOKEN_MAX characters) read aloud: the marks of
 * emphasis, code, headings and tables left out. */
export function spokenText(md: string): string {
  return md
    .slice(0, SPOKEN_MAX)
    .replace(/```[^\n]*\n?/g, '')
    .replace(TABLE_RULE, '')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/[*_`|]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// A line that is one formula between $$ and $$ (indented less than a code
// block), and a fence of a code block.
const ONE_LINE_MATH = /^( {0,3})\$\$(.+)\$\$[ \t\r]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// What opens a line's containers: a block quote's marker, a list item's,
// indentation; one at a time.
const CONTAINER = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)|[ \t]+)/;
// A fence of a code block once its containers are left out.
const INNER_FENCE = /^(`{3,}|~{3,})([^\r]*)\r?$/;

/** The start of a line that opens its containers (CONTAINER). */
function containerPrefix(line: string): string {
  let n = 0;
  for (let m = CONTAINER.exec(line); m && m[0]; m = CONTAINER.exec(line.slice(n))) n += m[0].length;
  return line.slice(0, n);
}

/** What the lines that go on in the containers of a line with that prefix
 * start with: the quote markers kept, a list item's marker as spaces. */
function continuation(prefix: string): string {
  let out = '';
  let rest = prefix;
  for (let m = CONTAINER.exec(rest); m && m[0]; m = CONTAINER.exec(rest)) {
    out += m[0].includes('>') || !/[^ \t]/.test(m[0]) ? m[0] : ' '.repeat(m[0].length);
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** The code spans of a line, [start, end) each: runs of backticks closed by
 * a run as long on the same line. */
function codeSpans(line: string): [number, number][] {
  const out: [number, number][] = [];
  if (!line.includes('`')) return out;
  // The lengths of runs that have no closing run further on.
  const unclosed = new Set<number>();
  for (let i = line.indexOf('`'); i >= 0;) {
    let end = i;
    while (line[end] === '`') end++;
    let slashes = 0;
    while (i - slashes > 0 && line[i - slashes - 1] === '\\') slashes++;
    if (slashes % 2 === 1) {
      // An escaped backtick is none; the rest of the run may open a span.
      i = line[i + 1] === '`' ? i + 1 : line.indexOf('`', i + 1);
      continue;
    }
    const run = end - i;
    let close = -1;
    if (!unclosed.has(run))
      for (let j = line.indexOf('`', end); j >= 0;) {
        let k = j;
        while (line[k] === '`') k++;
        if (k - j === run) {
          close = k;
          break;
        }
        j = line.indexOf('`', k);
      }
    if (close < 0) {
      unclosed.add(run);
      i = line.indexOf('`', end);
      continue;
    }
    out.push([i, close]);
    i = line.indexOf('`', close);
  }
  return out;
}

/** The end of the code span (of spans in order) that has position i; -1
 * when none has it. */
function spanEnd(spans: readonly [number, number][], i: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = spans[mid];
    if (i < start) hi = mid - 1;
    else if (i >= end) lo = mid + 1;
    else return end;
  }
  return -1;
}

/** Where the first delimiter of a backslash and ch (\[, \], \(, \)) is in
 * a line at or after from, outside its code spans and not after a
 * backslash of its own (\\[ is a backslash, then a bracket); -1 for none. */
function delimiter(line: string, ch: string, from: number, code: readonly [number, number][]): number {
  for (let i = from; ;) {
    const j = line.indexOf('\\' + ch, i);
    if (j < 0) return -1;
    const end = spanEnd(code, j);
    if (end >= 0) {
      i = end;
      continue;
    }
    let slashes = 0;
    while (j - slashes > 0 && line[j - slashes - 1] === '\\') slashes++;
    if (slashes % 2 === 0) return j;
    i = j + 2;
  }
}

/** A line with each formula between \( and \) on it as an inline formula
 * between dollars: $$ when the line has a dollar already, which a single
 * one could pair with. One that goes on to another line stays as it is. */
function inlineLatex(line: string): string {
  if (!line.includes('\\(')) return line;
  const code = codeSpans(line);
  const d = line.includes('$') ? '$$' : '$';
  let out = '';
  let done = 0;
  for (let from = 0; ;) {
    const open = delimiter(line, '(', from, code);
    if (open < 0) break;
    const close = delimiter(line, ')', open + 2, code);
    // None further on the line closes this one or a later one.
    if (close < 0) break;
    const tex = line.slice(open + 2, close).trim();
    if (tex && !tex.includes('$') && !tex.endsWith('\\')) {
      out += `${line.slice(done, open)}${d}${tex}${d}`;
      done = close + 2;
    }
    from = close + 2;
  }
  return done ? out + line.slice(done) : line;
}

/** Whether a line is blank but for its containers' markers. */
const blankIn = (line: string) => line.slice(containerPrefix(line).length).trim() === '';

/** An agent's Markdown with the LaTeX delimiters of formulas as the
 * renderer knows them (dollars): a formula between \[ and \] (on one line
 * or over several of a paragraph) as a formula block, $$ on lines of their
 * own in the containers of the line it starts on (the indentation of a
 * list item, the markers of a quote), the text around it before and after
 * the block; one between \( and \) on one line as an inline formula. Only
 * whole pairs are taken (a message still arriving may have an \[ whose
 * \] is to come), outside fenced code blocks and code spans; an escaped
 * backslash before a bracket (\\[) is no delimiter. */
export function latexMath(md: string): string {
  if (!md.includes('\\[') && !md.includes('\\(')) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  // A display formula of this paragraph found no end: none after it does.
  let unclosed = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const inner = line.slice(containerPrefix(line).length);
    const f = INNER_FENCE.exec(inner);
    if (fence !== undefined) {
      // A closing fence: the same character, at least as many, nothing after.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      out.push(line);
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      unclosed = false;
      out.push(line);
      continue;
    }
    if (blankIn(line)) {
      unclosed = false;
      out.push(line);
      continue;
    }
    // The display formulas that start on the line, one after another; an
    // empty one stays as written.
    for (let from = 0; ;) {
      const code = codeSpans(line);
      const open = unclosed ? -1 : delimiter(line, '[', from, code);
      if (open < 0) break;
      // Its end: on the line, or on a later one of the paragraph.
      let end = -1;
      let at = delimiter(line, ']', open + 2, code);
      if (at >= 0) end = i;
      for (let j = i + 1; at < 0 && j < lines.length; j++) {
        const l = lines[j];
        if (blankIn(l) || INNER_FENCE.test(l.slice(containerPrefix(l).length))) break;
        at = delimiter(l, ']', 0, codeSpans(l));
        if (at >= 0) end = j;
      }
      if (end < 0) {
        unclosed = true;
        break;
      }
      if (end === i && !line.slice(open + 2, at).trim()) {
        from = at + 2;
        continue;
      }
      if (end > i && !line.slice(open + 2).trim() && lines.slice(i + 1, end).every(blankIn) && blankIn(lines[end].slice(0, at))) break;
      const prefix = containerPrefix(line);
      const cont = continuation(prefix);
      const before = line.slice(0, open);
      if (before.slice(prefix.length).trim()) out.push(inlineLatex(before.trimEnd()), `${cont}$$`);
      else out.push(`${prefix}$$`);
      let after: string;
      if (end === i) {
        const tex = line.slice(open + 2, at).trim();
        if (tex) out.push(`${cont}${tex}`);
        after = line.slice(at + 2);
      } else {
        const first = line.slice(open + 2).trim();
        if (first) out.push(`${cont}${first}`);
        for (let j = i + 1; j < end; j++) out.push(lines[j]);
        const last = lines[end].slice(0, at);
        if (!blankIn(last)) out.push(last.trimEnd());
        after = lines[end].slice(at + 2);
        i = end;
      }
      out.push(`${cont}$$`);
      line = after.trim() ? `${cont}${after.trimStart()}` : '';
      if (!line) break;
      from = 0;
    }
    if (line) out.push(inlineLatex(line));
  }
  return out.join('\n');
}

/** An agent's Markdown with its formulas as the renderer shows them: the
 * LaTeX delimiters as dollars (latexMath), and each paragraph that is one
 * formula written on one line between $$ and $$ (as the agents write
 * display formulas) put as a formula block, $$ on lines of their own,
 * which the renderer shows as display math; a formula within a line of
 * text stays inline, and the lines of fenced code blocks stay as they
 * are. */
export function displayMath(source: string): string {
  const md = latexMath(source);
  if (!md.includes('$$')) return md;
  const lines = md.split('\n');
  let fence: string | undefined;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence !== undefined) {
      // A closing fence: the same character, at least as many, nothing after.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const m = ONE_LINE_MATH.exec(line);
    if (!m) continue;
    const tex = m[2].trim();
    if (!tex || tex.includes('$$') || tex.endsWith('\\')) continue;
    if ((i > 0 && lines[i - 1].trim() !== '') || (i < lines.length - 1 && lines[i + 1].trim() !== '')) continue;
    lines[i] = `${m[1]}$$\n${m[1]}${tex}\n${m[1]}$$`;
    changed = true;
  }
  return changed ? lines.join('\n') : md;
}

/** An amount of money for people, in the locale ("$0.042", "US$1.20");
 * an unknown currency as the amount and its code. */
export function formatCost(cost: Cost, locale: string): string {
  const digits = cost.amount !== 0 && Math.abs(cost.amount) < 1 ? 3 : 2;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: cost.currency, maximumFractionDigits: digits }).format(cost.amount);
  } catch {
    return `${cost.amount.toFixed(digits)} ${cost.currency}`;
  }
}

/** How much of the context window is in use, 0 to 100: the agent's own
 * measure, else used of size; undefined while the size is not known. */
export function contextPercent(u: Usage): number | undefined {
  if (u.percentage !== undefined) return Math.min(100, Math.max(0, u.percentage));
  if (u.size > 0) return Math.min(100, Math.max(0, (u.used / u.size) * 100));
  return undefined;
}

/** The limit window closest to its end: the one most used. */
export function tightest(limits: readonly Limit[] | undefined): Limit | undefined {
  let out: Limit | undefined;
  for (const l of limits ?? []) if (!out || l.usedPercent > out.usedPercent) out = l;
  return out;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** When a time (seconds since the epoch) comes, relative to now (ms), in
 * the locale's words: "in 3 hours", "in 12 minutes". */
export function relativeTime(at: number, now: number, locale: string): string {
  const ms = at * 1000 - now;
  const [unit, size] = UNITS.find(([, s]) => Math.abs(ms) >= s) ?? UNITS[UNITS.length - 1];
  const n = Math.round(ms / size);
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(n, unit);
  } catch {
    return new Date(at * 1000).toLocaleString();
  }
}

/** A limit window's length for people: "5h", "7d", "30m". */
export function windowLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
