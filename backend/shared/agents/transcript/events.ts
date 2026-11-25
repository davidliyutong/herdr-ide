// What a parser makes of one line of a transcript (claude.ts): events
// shaped as the Agent Client Protocol's (ACP v1) session updates, prompts,
// turns and notices, every text cut to its limit (in UTF-8 bytes, as the
// Go agent cut it, at a character's start) and marked when it was, no
// image's data, and at most maxLineEvents events.
import { SLUG } from '#shared/lib/brand.ts';
import { formatRFC3339, parseRFC3339 } from '#shared/lib/gotime.ts';
import { Transcript, TranscriptLimits, noticeMethod, type TranscriptEvent } from '#shared/proto/agentproto/index.ts';
import { Decoder, MAX_LINE_NODES, valid } from './json.ts';

/** A JSON object as the events are built. */
export type Obj = Record<string, unknown>;

/** The notice of a line that was not read (too long). */
export const NOTICE_SKIPPED = 'skipped';

/** The most bytes of a tool call's title. */
export const MAX_TITLE = 1 << 10;
/** The most items of an array a tool call's input keeps. */
export const MAX_ITEMS = 256;
/** How deep a tool call's input is kept. */
export const MAX_DEPTH = 16;
/** The most elements of an array of content blocks a parser reads of a
 * line: the line counts as unknown once for those beyond (they would make
 * more events than a line may). */
export const MAX_BLOCKS = 4 * TranscriptLimits.maxLineEvents;
/** The deepest a value is decoded (an event keeps less, MAX_DEPTH). */
const DECODE_DEPTH = 2 * MAX_DEPTH;

/** Bounds a read. A member that is missing, zero or above agentproto's
 * maximum is that maximum. */
export interface Limits {
  /** The most bytes of an event's text. */
  text?: number;
  /** The most bytes of a tool call's output an event keeps, its start and
   * its end. */
  toolOutput?: number;
}

export interface Bounds {
  text: number;
  tool: number;
}

export function bounds(l: Limits = {}): Bounds {
  const or = (v: number | undefined, m: number) => (!v || v <= 0 || v > m ? m : v);
  return { text: or(l.text, TranscriptLimits.maxTextBytes), tool: or(l.toolOutput, TranscriptLimits.maxToolOutput) };
}

/** An event a parser made of a line, and the block it was made of (1 +
 * the index among the line's content blocks, 0 for none). */
interface Made {
  ev: TranscriptEvent;
  block: number;
}

/** What a parser made of a line. */
export class LineOut {
  readonly lim: Bounds;
  at = '';
  readonly made: Made[] = [];
  unknown = 0;
  /** The session's title the line gives; custom: the user named it. */
  title = '';
  custom = false;
  /** The line would make more than maxLineEvents events: those beyond were
   * not made, and the line counts as unknown once. */
  over = false;
  /** How many more JSON values the line's parse may decode; cut: a decode
   * left something out, and the updates made after it are marked as
   * truncated. */
  readonly nodes = { nodes: MAX_LINE_NODES };
  cut = false;
  /** The assistant message whose content blocks the line holds, how many;
   * first is 1 + the index in the message of the first of them, 0 when the
   * line does not say; block is 1 + the index of the block being mapped. */
  message = '';
  count = 0;
  first = 0;
  block = 0;

  constructor(lim: Bounds) {
    this.lim = lim;
  }

  add(ev: TranscriptEvent): void {
    if (this.made.length >= TranscriptLimits.maxLineEvents) {
      this.over = true;
      return;
    }
    if (this.at) ev = { ...ev, at: this.at };
    this.made.push({ ev, block: this.block });
  }

  update(u: Obj): void {
    if (this.cut) setMeta(u, 'truncated', true);
    this.add({ t: Transcript.Update, update: u });
  }

  user(blocks: Obj[]): void {
    if (blocks.length > 0) this.add({ t: Transcript.User, content: blocks });
  }

  turn(state: string, stop = ''): void {
    this.add({ t: Transcript.Turn, state, ...(stop ? { stopReason: stop } : {}) });
  }

  notice(name: string, params?: Obj): void {
    this.add({ t: Transcript.Notice, method: noticeMethod(name), ...(params && Object.keys(params).length > 0 ? { params } : {}) });
  }

  /** Takes an RFC 3339 time for the line's events. */
  setTime(s: string): void {
    const d = parseRFC3339(s);
    if (d) this.at = formatRFC3339(d);
  }

  /** The value of valid JSON raw within the line's budget of values; ok is
   * false when raw is no JSON value or holds a number a double does not
   * hold (Go's decoder fails on those too). */
  decode(raw: string | undefined): { v: unknown; ok: boolean } {
    const s = (raw ?? '').trim();
    if (s === '' || !valid(s)) return { v: null, ok: false };
    const d = new Decoder(this.nodes, DECODE_DEPTH);
    const [v] = d.value(s, 0, 0);
    this.cut ||= d.cut;
    return { v, ok: !d.bad };
  }

  /** The text of a message or a thought, cut to the limit. */
  text(s: string): [string, boolean] {
    return cutText(s, this.lim.text);
  }

  /** An ACP text block, its text cut to the limit (marked). */
  textBlock(s: string): Obj {
    const [t, cut] = this.text(s);
    const b: Obj = { type: 'text', text: t };
    if (cut) setMeta(b, 'truncated', true);
    return b;
  }

  /** A tool call's output as its content, cut to the limit (marked in u);
   * undefined for no output. */
  output(u: Obj, s: string): Obj[] | undefined {
    if (s === '') return undefined;
    const [t, cut] = cutMiddle(s, this.lim.tool);
    if (cut) setMeta(u, 'truncated', true);
    return [{ type: 'content', content: { type: 'text', text: t } }];
  }

  /** v bounded for an event (marked in u when cut). */
  bounded(u: Obj, v: unknown): unknown {
    const [out, cut] = bound(v, this.lim.text, 0);
    if (cut) setMeta(u, 'truncated', true);
    return out;
  }

  /** An ACP v1 diff of a file; without hasOld the old text is null (a new
   * file). Texts are cut to the limit (marked in u). */
  diff(u: Obj, path: string, oldText: string, newText: string, hasOld: boolean): Obj {
    const [n, cutNew] = this.text(newText);
    const d: Obj = { type: 'diff', path, newText: n, oldText: null };
    let cutOld = false;
    if (hasOld) [d.oldText, cutOld] = this.text(oldText);
    if (cutNew || cutOld) setMeta(u, 'truncated', true);
    return d;
  }
}

/** Sets a member of m's own metadata: _meta.<slug>.key. */
export function setMeta(m: Obj, key: string, v: unknown): void {
  const meta = (isObj(m._meta) ? m._meta : (m._meta = {})) as Obj;
  const own = (isObj(meta[SLUG]) ? meta[SLUG] : (meta[SLUG] = {})) as Obj;
  own[key] = v;
}

/** An image, which is never forwarded: an empty text block marked as an
 * image. */
export function imageBlock(): Obj {
  const b: Obj = { type: 'text', text: '' };
  setMeta(b, 'image', true);
  return b;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const runeStart = (b: number) => (b & 0xc0) !== 0x80;

/** s cut to at most n UTF-8 bytes at a character's start. */
export function cutText(s: string, n: number): [string, boolean] {
  if (s.length * 3 <= n) return [s, false];
  const b = enc.encode(s);
  if (b.length <= n) return [s, false];
  let k = n;
  while (k > 0 && !runeStart(b[k])) k--;
  return [dec.decode(b.subarray(0, k)), true];
}

/** Joins the start and the end of a tool's output that was cut. */
const ELISION = '\n…\n';
const ELISION_BYTES = enc.encode(ELISION).length;

/** s cut to about n bytes by leaving out its middle: a tool's output says
 * most at its start and its end. */
export function cutMiddle(s: string, n: number): [string, boolean] {
  if (s.length * 3 <= n) return [s, false];
  const b = enc.encode(s);
  if (b.length <= n) return [s, false];
  const half = Math.floor(Math.max(n - ELISION_BYTES, 0) / 2);
  const [head] = cutText(s, half);
  let j = b.length - half;
  while (j < b.length && !runeStart(b[j])) j++;
  return [head + ELISION + dec.decode(b.subarray(j)), true];
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A copy of a decoded value with strings cut to text bytes, arrays to
 * MAX_ITEMS items and nothing deeper than MAX_DEPTH; whether anything was
 * left out. */
export function bound(v: unknown, text: number, depth: number): [unknown, boolean] {
  if (typeof v === 'string') return cutText(v, text);
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return [null, true];
    const n = Math.min(v.length, MAX_ITEMS);
    let cut = n < v.length;
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const [x, c] = bound(v[i], text, depth + 1);
      out.push(x);
      cut ||= c;
    }
    return [out, cut];
  }
  if (isObj(v)) {
    if (depth >= MAX_DEPTH) return [null, true];
    const out: Obj = {};
    let cut = false;
    for (const [k, e] of Object.entries(v)) {
      const [x, c] = bound(e, text, depth + 1);
      Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
      cut ||= c;
    }
    return [out, cut];
  }
  return [v, false];
}
