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

/** An agent's Markdown with each paragraph that is one formula written on
 * one line between $$ and $$ (as the agents write display formulas) put as
 * a formula block, $$ on lines of their own, which the renderer shows as
 * display math; a formula within a line of text stays inline, and the
 * lines of fenced code blocks stay as they are. */
export function displayMath(md: string): string {
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
