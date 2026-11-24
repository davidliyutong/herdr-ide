// The terminal protocol of clients that draw terminals themselves
// (/api/v1/term, docs/features/22-terminal-protocol.md; the web UI's
// side is web/src/term/protocol.ts): calls and events as JSON text
// messages with a type t, terminal bytes as binary frames
// [stream u32 LE][kind u8][payload].
import type { Display } from '#shared/proto/hc/index.ts';

/** Binary frame kinds, as herdr-core numbers them. */
export const FrameKind = {
  /** Output to the client, input from it. */
  Data: 0,
  /** To the client: cols u16 LE, rows u16 LE of an observed terminal. */
  Resize: 3,
  /** From the client: its terminal's own answers to the program. */
  Automatic: 6,
} as const;

/** What a machine's backend is doing. */
export type BackendState = 'starting' | 'ready' | 'error';

/** Why a backend is not ready (backend {state: error, code}); also the
 * errors of the terminal core's routes. */
export const Code = {
  Offline: 'machine_offline',
  NotBundled: 'not_bundled',
  NotRunning: 'not_running',
  Install: 'install_failed',
  Start: 'start_failed',
  Connect: 'connect_failed',
  Lost: 'disconnected',
  Stopped: 'stopped',
} as const;

/** A text message from a client, as the Go core read it into its struct:
 * absent members and nulls are their zero values. */
export interface Inbound {
  t: string;
  rid: number;
  m: string;
  s: number;
  method: string;
  /** The call's parameters as sent; undefined when absent (null when the
   * client sent null). */
  params: unknown;
  terminal: string;
  cols: number;
  rows: number;
  history: number;
  observe: boolean;
  /** null when absent or null. */
  display: Display | null;
  focused: boolean;
  n: number;
}

const INT64 = 2 ** 63;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < INT64;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A display's facts as the core passes them on: the colors that are
 * strings and a cell size that has members, nothing else (hc.Display). A
 * member of another type makes the whole message invalid (undefined). */
function display(v: unknown): Display | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) return undefined;
  const d: Display = {};
  for (const k of ['fg', 'bg', 'cursor'] as const) {
    const c = v[k];
    if (c === undefined || c === null) continue;
    if (typeof c !== 'string') return undefined;
    d[k] = c;
  }
  const cell = v.cell;
  if (cell !== undefined && cell !== null) {
    if (!Array.isArray(cell) || !cell.every(isInt)) return undefined;
    if (cell.length) d.cell = [...cell];
  }
  return d;
}

/** Reads a text message; null for one that is not JSON or whose members
 * have the wrong types (the Go core ignored those as a whole). */
export function parseInbound(text: string): Inbound | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v !== null && !isObject(v)) return null;
  const o: Record<string, unknown> = v ?? {};
  const str = (k: string): string | undefined => {
    const x = o[k];
    return x === undefined || x === null ? '' : typeof x === 'string' ? x : undefined;
  };
  const int = (k: string, min = -INT64, max = INT64): number | undefined => {
    const x = o[k];
    return x === undefined || x === null ? 0 : isInt(x) && x >= min && x <= max ? x : undefined;
  };
  const bool = (k: string): boolean | undefined => {
    const x = o[k];
    return x === undefined || x === null ? false : typeof x === 'boolean' ? x : undefined;
  };
  const m: Partial<Inbound> = {
    t: str('t'),
    rid: int('rid'),
    m: str('m'),
    s: int('s', 0, 0xffff_ffff),
    method: str('method'),
    params: o.params,
    terminal: str('terminal'),
    cols: int('cols'),
    rows: int('rows'),
    history: int('history'),
    observe: bool('observe'),
    display: display(o.display),
    focused: bool('focused'),
    n: int('n'),
  };
  for (const [k, x] of Object.entries(m)) if (x === undefined && k !== 'params') return null;
  return m as Inbound;
}

/** A binary frame of stream s. */
export function frame(s: number, kind: number, payload: Uint8Array): Buffer {
  const b = Buffer.allocUnsafe(5 + payload.length);
  b.writeUInt32LE(s >>> 0, 0);
  b[4] = kind;
  b.set(payload, 5);
  return b;
}

/** A resize frame of stream s. */
export function resizeFrame(s: number, cols: number, rows: number): Buffer {
  const b = Buffer.allocUnsafe(9);
  b.writeUInt32LE(s >>> 0, 0);
  b[4] = FrameKind.Resize;
  b.writeUInt16LE(cols & 0xffff, 5);
  b.writeUInt16LE(rows & 0xffff, 7);
  return b;
}

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
const shortEscapes: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\v': '\\v',
};

/** s quoted as Go's strconv.Quote does: the error messages name terminals
 * as the Go core named them. */
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (printable.test(ch)) out += ch;
    else if (shortEscapes[ch]) out += shortEscapes[ch];
    else {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) out += '\\x' + cp.toString(16).padStart(2, '0');
      // A lone surrogate: Go's JSON decoder had made it U+FFFD.
      else if (cp >= 0xd800 && cp < 0xe000) out += '\ufffd';
      else if (cp < 0x10000) out += '\\u' + cp.toString(16).padStart(4, '0');
      else out += '\\U' + cp.toString(16).padStart(8, '0');
    }
  }
  return out + '"';
}
