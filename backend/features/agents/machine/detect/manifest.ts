// What a coding agent in a terminal is doing, the way herdr tells it
// (herdr v0.9.5, src/detect; docs/features/25-agent-detection.md): an
// ordered set of rules over parts of the screen, the agent's manifest. The
// manifests are herdr's TOML files, unchanged (manifests.ts); this module
// reads one strictly, within herdr's limits, and evaluates it.
//
// The rules' regular expressions are RE2 (Rust's regex crate in herdr, Go's
// regexp in the Go agent): re2js runs them here, a port of RE2 with Go's
// syntax and semantics, in linear time whatever a screen holds. JavaScript's
// RegExp would read the same text differently (\s, \b, case folding) and
// backtrack. Rust's spellings that RE2 lacks are rewritten (re2Spelling).
import { RE2JS } from 're2js';
import { z } from 'zod';
import { toLower, trimSpace } from '#shared/lib/gostrings.ts';

/** The states of an agent, as rules and the terminal core report them. */
export const State = {
  Idle: 'idle',
  Working: 'working',
  Blocked: 'blocked',
  Unknown: 'unknown',
  /** Reported once when working or blocked became idle (a turn that
   * ended); no rule's state. */
  Done: 'done',
} as const;

/** herdr's limits of a manifest. */
export const LIMITS = {
  rules: 128,
  gateDepth: 8,
  totalGates: 512,
  matchersPerGate: 32,
  totalMatchers: 1024,
  matcherChars: 512,
} as const;

/** A gate as a manifest writes it: every contains (case-insensitive), every
 * regex, every line_regex on some line, every gate of all, one of any
 * (when there are any), and none of not. */
export interface GateSpec {
  all?: GateSpec[];
  any?: GateSpec[];
  not?: GateSpec[];
  contains?: string[];
  regex?: string[];
  line_regex?: string[];
}

const strings = z.array(z.string()).optional();
const gateFields = (gate: z.ZodType<GateSpec>) => ({
  all: z.array(gate).optional(),
  any: z.array(gate).optional(),
  not: z.array(gate).optional(),
  contains: strings,
  regex: strings,
  line_regex: strings,
});
const gateSchema: z.ZodType<GateSpec> = z.lazy(() => z.strictObject(gateFields(gateSchema)));

/** A rule gives its state when its gate matches its region of the screen. */
const ruleSchema = z.strictObject({
  id: z.string().optional(),
  state: z.string().optional(),
  priority: z.int().optional(),
  region: z.string().optional(),
  /** The rule sees the agent's live chrome (its prompt, a dialog, its
   * spinner) rather than text that may be old. */
  visible_idle: z.boolean().optional(),
  visible_blocker: z.boolean().optional(),
  visible_working: z.boolean().optional(),
  /** The screen shows a viewer of the agent (its transcript), which says
   * nothing about its state. */
  skip_state_update: z.boolean().optional(),
  ...gateFields(gateSchema),
});

/** Unknown members fail, as herdr's parser and the Go agent's do. */
const manifestSchema = z.strictObject({
  id: z.string().optional(),
  version: z.string().optional(),
  aliases: strings,
  rules: z.array(ruleSchema).optional(),
  min_engine_version: z.int().optional(),
  updated_at: z.string().optional(),
});

/** One rule, its defaults applied and its gate compiled. */
export interface Rule {
  id: string;
  state: string;
  priority: number;
  region: string;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  skipStateUpdate: boolean;
  /** The gate as written (testdata/manifests.json holds the same). */
  spec: GateSpec;
  gate: Gate;
}

export interface Manifest {
  id: string;
  version: string;
  aliases: string[];
  minEngineVersion: number;
  updatedAt: string;
  rules: Rule[];
}

/** A compiled gate. */
interface Gate {
  all: Gate[];
  any: Gate[];
  not: Gate[];
  /** Lower case. */
  contains: string[];
  regex: RE2JS[];
  lineRegex: RE2JS[];
}

/** A manifest the parser refuses. */
export class ManifestError extends Error {}

/** Reads and checks a manifest in herdr's format (TOML). */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ManifestError(`toml: ${(e as Error).message}`);
  }
  const r = manifestSchema.safeParse(raw);
  if (!r.success) throw new ManifestError(r.error.message);
  const m = r.data;
  const id = m.id ?? '';
  if (id === '') throw new ManifestError('manifest without an id');
  const specs = m.rules ?? [];
  if (specs.length === 0 || specs.length > LIMITS.rules) throw new ManifestError(`manifest ${id}: ${specs.length} rules`);
  const budget = { gates: 0, matchers: 0 };
  const rules = specs.map((s): Rule => {
    const rid = s.id ?? '';
    const region = s.region || 'whole_recent';
    let state = s.state ?? '';
    if (state === '') state = State.Unknown;
    else if (![State.Idle, State.Working, State.Blocked, State.Unknown].includes(state as 'idle'))
      throw new ManifestError(`rule ${rid}: state ${JSON.stringify(state)}`);
    if (trimSpace(rid) === '') throw new ManifestError(`manifest ${id}: a rule without an id`);
    const visible = { idle: !!s.visible_idle, blocker: !!s.visible_blocker, working: !!s.visible_working };
    if (s.skip_state_update && (state !== State.Unknown || visible.idle || visible.blocker || visible.working))
      throw new ManifestError(`rule ${rid}: skip_state_update with a state`);
    if (!validRegion(region)) throw new ManifestError(`rule ${rid}: region ${JSON.stringify(region)}`);
    const spec: GateSpec = { all: s.all, any: s.any, not: s.not, contains: s.contains, regex: s.regex, line_regex: s.line_regex };
    let gate: Gate;
    try {
      gate = compile(spec, 0, false, budget);
    } catch (e) {
      throw new ManifestError(`rule ${rid}: ${(e as Error).message}`);
    }
    return {
      id: rid,
      state,
      priority: s.priority ?? 0,
      region,
      visibleIdle: visible.idle,
      visibleBlocker: visible.blocker,
      visibleWorking: visible.working,
      skipStateUpdate: !!s.skip_state_update,
      spec,
      gate,
    };
  });
  return {
    id,
    version: m.version ?? '',
    aliases: m.aliases ?? [],
    minEngineVersion: m.min_engine_version ?? 0,
    updatedAt: m.updated_at ?? '',
    rules,
  };
}

function compile(g: GateSpec, depth: number, negated: boolean, budget: { gates: number; matchers: number }): Gate {
  if (depth > LIMITS.gateDepth) throw new Error(`gates nested deeper than ${LIMITS.gateDepth}`);
  if (++budget.gates > LIMITS.totalGates) throw new Error(`more than ${LIMITS.totalGates} gates`);
  const contains = g.contains ?? [];
  const regex = g.regex ?? [];
  const lineRegex = g.line_regex ?? [];
  const n = contains.length + regex.length + lineRegex.length;
  if (n > LIMITS.matchersPerGate) throw new Error(`${n} matchers in one gate`);
  if ((budget.matchers += n) > LIMITS.totalMatchers) throw new Error(`more than ${LIMITS.totalMatchers} matchers`);
  const positive = n > 0 || (g.all ?? []).length > 0 || (g.any ?? []).length > 0;
  if (!positive && !(negated && (g.not ?? []).length > 0)) throw new Error('a gate without a positive matcher');
  for (const s of [...contains, ...regex, ...lineRegex])
    if ([...s].length > LIMITS.matcherChars) throw new Error(`a matcher longer than ${LIMITS.matcherChars} characters`);
  const re = (s: string) => {
    try {
      return RE2JS.compile(re2Spelling(s));
    } catch (e) {
      throw new Error(`regex ${JSON.stringify(s)}: ${(e as Error).message}`);
    }
  };
  return {
    contains: contains.map(toLower),
    regex: regex.map(re),
    lineRegex: lineRegex.map(re),
    all: (g.all ?? []).map((x) => compile(x, depth + 1, negated, budget)),
    any: (g.any ?? []).map((x) => compile(x, depth + 1, negated, budget)),
    not: (g.not ?? []).map((x) => compile(x, depth + 1, true, budget)),
  };
}

function match(g: Gate, text: string, lower: string, lines: string[]): boolean {
  for (const s of g.contains) if (!lower.includes(s)) return false;
  for (const re of g.regex) if (!re.test(text)) return false;
  for (const re of g.lineRegex) if (!lines.some((l) => re.test(l))) return false;
  for (const x of g.all) if (!match(x, text, lower, lines)) return false;
  if (g.any.length > 0 && !g.any.some((x) => match(x, text, lower, lines))) return false;
  for (const x of g.not) if (match(x, text, lower, lines)) return false;
  return true;
}

/** What a manifest is evaluated on: the screen's text (a line per row,
 * trailing blanks trimmed, as terminal.read gives it), the terminal's
 * title, and OSC progress reports (none here: empty). */
export interface Input {
  screen: string;
  title?: string;
  progress?: string;
}

/** A manifest's verdict on a screen. */
export interface Result {
  state: string;
  /** The rule that matched; "" when none did (a known agent then reads
   * as idle, as in herdr). */
  rule: string;
  /** The screen says nothing about the agent's state: keep the last one. */
  skip: boolean;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
}

/** Runs the manifest's rules over in: the highest priority among the
 * rules that match wins, the first one among equals. */
export function evaluate(m: Manifest, input: Input): Result {
  let best: Rule | undefined;
  const texts = new Map<string, { text: string; lower: string; lines: string[] }>();
  for (const r of m.rules) {
    let t = texts.get(r.region);
    if (!t) {
      const text = region(input, r.region);
      t = { text, lower: toLower(text), lines: splitLines(text) };
      texts.set(r.region, t);
    }
    if (!match(r.gate, t.text, t.lower, t.lines)) continue;
    if (!best || r.priority > best.priority) best = r;
  }
  if (!best) return { state: State.Idle, rule: '', skip: false, visibleIdle: false, visibleBlocker: false, visibleWorking: false };
  return {
    state: best.state,
    rule: best.id,
    skip: best.skipStateUpdate,
    visibleIdle: best.visibleIdle && best.state === State.Idle,
    visibleBlocker: best.visibleBlocker && best.state === State.Blocked,
    visibleWorking: best.visibleWorking && best.state === State.Working,
  };
}

/** text split as Rust's str::lines does: on "\n", without a final empty
 * line, a trailing "\r" removed. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
}

const REGIONS = new Set([
  'whole_recent',
  'after_last_prompt_marker',
  'before_current_prompt_marker',
  'whole_recent_without_current_prompt_marker',
  'current_prompt_block_marker',
  'after_current_prompt_block_marker',
  'prompt_box_body',
  'above_prompt_box',
  'last_non_empty_above_prompt_box',
  'after_last_horizontal_rule',
  'osc_title',
  'osc_progress',
]);

export const validRegion = (spec: string): boolean => REGIONS.has(trimSpace(spec)) || regionCount(spec) !== null;

const COUNTED = ['bottom_lines(', 'bottom_non_empty_lines(', 'top_non_empty_lines('];

/** The count of "bottom_lines(N)", "bottom_non_empty_lines(N)" and
 * "top_non_empty_lines(N)"; null for anything else. */
function regionCount(spec: string): number | null {
  spec = trimSpace(spec);
  for (const name of COUNTED) {
    if (!spec.startsWith(name) || !spec.endsWith(')')) continue;
    const digits = spec.slice(name.length, -1);
    // Go's strconv.Atoi: an optional sign and decimal digits.
    if (!/^[+-]?\d+$/.test(digits)) return null;
    const n = Number(digits);
    if (n < 0) return null;
    if (name === 'top_non_empty_lines(' && (n === 0 || n > 65535 || digits[0] === '0')) return null;
    return n;
  }
  return null;
}

/** The part of in a rule looks at, as herdr cuts it. Offsets are of
 * UTF-16 units: the cuts fall on line ends, where they are the same text
 * as Go's byte offsets. */
export function region(input: Input, spec: string): string {
  spec = trimSpace(spec);
  if (spec === 'osc_title') return input.title ?? '';
  if (spec === 'osc_progress') return input.progress ?? '';
  const content = input.screen;
  const lines = splitLines(content);
  const from = (i: number) => content.slice(lineOffset(content, lines, i));
  switch (spec) {
    case 'whole_recent':
      return content;
    case 'after_last_prompt_marker':
      for (let i = lines.length - 1; i >= 0; i--) if (codexPrompt(lines[i])) return from(i + 1);
      return content;
    case 'before_current_prompt_marker': {
      const p = currentCodexPrompt(lines);
      return p < 0 ? content : content.slice(0, lineOffset(content, lines, p));
    }
    case 'whole_recent_without_current_prompt_marker':
      return currentCodexPrompt(lines) >= 0 ? '' : content;
    case 'current_prompt_block_marker':
    case 'after_current_prompt_block_marker': {
      const p = currentCodexPrompt(lines);
      if (p >= 0)
        for (let i = p - 1; i >= 0; i--) if (codexBlockMarker(lines[i])) return spec === 'current_prompt_block_marker' ? lines[i] : from(i);
      return '';
    }
    case 'prompt_box_body': {
      const top = promptBoxTop(lines);
      if (top < 0) return '';
      let end = lines.length;
      for (let i = top + 1; i < lines.length; i++)
        if (horizontalRule(lines[i])) {
          end = i;
          break;
        }
      return content.slice(lineOffset(content, lines, top + 1), lineOffset(content, lines, end));
    }
    case 'above_prompt_box':
      return abovePromptBox(content, lines);
    case 'last_non_empty_above_prompt_box': {
      const above = splitLines(abovePromptBox(content, lines));
      for (let i = above.length - 1; i >= 0; i--) if (trimSpace(above[i]) !== '') return above[i];
      return '';
    }
    case 'after_last_horizontal_rule': {
      let end = 0;
      let offset = 0;
      for (const l of content.split('\n')) {
        const next = offset + l.length + 1;
        if (horizontalRule(l.replace(/\r$/, ''))) end = Math.min(next, content.length);
        offset = next;
      }
      return content.slice(end);
    }
  }
  const n = regionCount(spec) ?? 0;
  if (spec.startsWith('bottom_lines(')) return from(Math.max(lines.length - n, 0));
  if (spec.startsWith('bottom_non_empty_lines(')) {
    let start = -1;
    for (let i = lines.length - 1, seen = 0; i >= 0 && seen < n; i--)
      if (trimSpace(lines[i]) !== '') {
        start = i;
        seen++;
      }
    return start < 0 ? '' : from(start);
  }
  if (spec.startsWith('top_non_empty_lines(')) {
    let end = -1;
    for (let i = 0, seen = 0; i < lines.length && seen < n; i++)
      if (trimSpace(lines[i]) !== '') {
        end = i;
        seen++;
      }
    return end < 0 ? '' : content.slice(0, lineOffset(content, lines, end + 1));
  }
  return '';
}

/** The offset of line i (each line and its "\n"). */
function lineOffset(content: string, lines: string[], i: number): number {
  let off = 0;
  for (const l of lines.slice(0, Math.min(i, lines.length))) off += l.length + 1;
  return Math.min(off, content.length);
}

const codexPrompt = (l: string): boolean => l === '›' || l.startsWith('› ');

const codexBlockMarker = (l: string): boolean => ['•', '■', '✗', '✓'].some((p) => l.startsWith(p));

/** The last prompt line with no block marker after it; -1 for none. */
function currentCodexPrompt(lines: string[]): number {
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (codexPrompt(lines[i])) {
      p = i;
      break;
    }
  if (p < 0) return -1;
  return lines.slice(p + 1).some(codexBlockMarker) ? -1 : p;
}

/** The second horizontal rule from the bottom; -1 for none. */
function promptBoxTop(lines: string[]): number {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (horizontalRule(lines[i]) && ++seen === 2) return i;
  return -1;
}

function abovePromptBox(content: string, lines: string[]): string {
  const top = promptBoxTop(lines);
  return top < 0 ? content : content.slice(0, lineOffset(content, lines, top));
}

/** A line of "─" alone, or of at least three followed by anything (a
 * titled rule). */
function horizontalRule(l: string): boolean {
  const t = trimSpace(l);
  let n = 0;
  while (t.startsWith('─', n)) n++;
  if (n === 0) return false;
  return trimSpace(t.slice(n)) === '' || n >= 3;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** The Rust regex syntax herdr's manifests use that RE2 spells
 * differently: \uXXXX and \u{X} code points, and the Alphabetic property
 * (letters here). */
export function re2Spelling(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const rest = s.slice(i + 1);
    if (rest.startsWith('u{')) {
      const end = rest.indexOf('}');
      if (end > 0) {
        out += `\\x{${rest.slice(2, end)}}`;
        i += end + 1;
        continue;
      }
    } else if (rest.length >= 5 && rest[0] === 'u' && HEX4.test(rest.slice(1, 5))) {
      out += `\\x{${rest.slice(1, 5)}}`;
      i += 5;
      continue;
    } else if (rest.startsWith('p{Alphabetic}') || rest.startsWith('P{Alphabetic}')) {
      out += `\\${rest[0]}{L}`;
      i += 'p{Alphabetic}'.length;
      continue;
    }
    // Any other escape, the escaped character included.
    out += s.slice(i, i + 2);
    i++;
  }
  return out;
}
