// The terminal history plugin's core routes (backend/features/history),
// all of a machine: the snapshots of its terminals' output it keeps, one
// generation's bytes, and their removal. What the machine answers is
// checked before use: entries with a terminal's address and numbers, bytes
// within the size of one generation.
import { isAddress } from '../../term/layout';
import { answer, failureOf, jsonBody, makeErrorText, PluginError } from '../../lib/pluginApi';

/** A failure with the core's or the machine's code (bad_request, busy,
 * not_found, offline, bad_reply, transport; too_large and mismatch from
 * the page's own checks). */
export class HistoryError extends PluginError {}

/** One generation of a terminal's snapshot (agentproto.HistorySnapshot). */
export interface HistorySnapshot {
  /** The terminal's program it is of. */
  pid: number;
  /** When it was taken, in ms since the epoch. */
  at: number;
  lines: number;
  bytes: number;
  cols: number;
  rows: number;
}

/** A terminal's snapshots: the current generation's fields (at 0 when it
 * has only a previous one), and the previous one when there is one. */
export interface HistoryEntry extends HistorySnapshot {
  terminal: string;
  /** The current generation shows that the terminal core restored the
   * screen of the program before above this one itself (its
   * restore_screen): the machine found the core's line in its bytes. */
  restored?: boolean;
  previous?: HistorySnapshot;
}

export interface HistoryList {
  terminals: HistoryEntry[];
  /** The terminal core's own restore_screen is on: it shows a replaced
   * program's last screen above the new shell itself. */
  restoreScreen: boolean;
}

export type Generation = 'current' | 'previous';

/** The most bytes of one generation (agentproto.HistoryMaxBytes). */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;

/** The most entries taken from a list (a machine keeps at most 128). */
const MAX_ENTRIES = 1024;

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/history`;
const fail = failureOf((code, message) => new HistoryError(code, message));

/** A request to the core; one that does not reach it fails as network. */
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', ...init });
  } catch (e) {
    throw new HistoryError('network', e instanceof Error ? e.message : String(e));
  }
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

function snapshotOf(v: unknown): HistorySnapshot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pid = count(o.pid);
  const at = count(o.at);
  if (pid === undefined || at === undefined) return undefined;
  return { pid, at, lines: count(o.lines) ?? 0, bytes: count(o.bytes) ?? 0, cols: count(o.cols) ?? 0, rows: count(o.rows) ?? 0 };
}

/** A list as the machine answered it, without the entries that are not
 * a terminal's with numbers. */
export function parseList(v: unknown): HistoryList {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const terminals: HistoryEntry[] = [];
  for (const e of Array.isArray(o.terminals) ? o.terminals.slice(0, MAX_ENTRIES) : []) {
    const terminal = (e as Record<string, unknown> | null)?.terminal;
    const own = snapshotOf(e);
    if (!isAddress(terminal) || !own) continue;
    const previous = snapshotOf((e as Record<string, unknown>).previous);
    const restored = (e as Record<string, unknown>).restored === true ? { restored: true } : {};
    terminals.push(previous ? { terminal, ...own, ...restored, previous } : { terminal, ...own, ...restored });
  }
  return { terminals, restoreScreen: o.restoreScreen === true };
}

/** The snapshots machine m keeps. */
export async function listHistory(m: string): Promise<HistoryList> {
  return parseList(await answer<unknown>(await send(base(m)), fail));
}

/** One generation's bytes, with the program and the time it is of, and the
 * grid they were painted at (0 when the machine did not say). */
export interface HistoryBytes {
  bytes: Uint8Array;
  pid: number;
  at: number;
  cols: number;
  rows: number;
}

/** A body read up to max bytes; a longer one is refused (too_large). */
async function boundedBody(r: Response, max: number): Promise<Uint8Array> {
  const tooLarge = () => new HistoryError('too_large', `more than ${max} bytes`);
  const declared = Number(r.headers.get('Content-Length') ?? NaN);
  if (declared > max) throw tooLarge();
  const reader = r.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await r.arrayBuffer());
    if (all.length > max) throw tooLarge();
    return all;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The bytes of one generation of terminal's snapshot on machine m: the
 * terminal's first paint as the terminal core sent it, without titles. At
 * most HISTORY_MAX_BYTES. */
export async function readHistory(m: string, terminal: string, generation: Generation): Promise<HistoryBytes> {
  const r = await send(`${base(m)}/read?terminal=${encodeURIComponent(terminal)}&generation=${generation}`);
  if (!r.ok) throw fail(r, await jsonBody(r));
  const bytes = await boundedBody(r, HISTORY_MAX_BYTES);
  const header = (name: string) => count(Number(r.headers.get(name) ?? NaN)) ?? 0;
  return {
    bytes,
    pid: Number(r.headers.get('X-History-Pid')),
    at: Number(r.headers.get('X-History-At')),
    cols: header('X-History-Cols'),
    rows: header('X-History-Rows'),
  };
}

/** Moves the newest snapshot of terminal `from` on machine m, one the
 * page replaced by terminal `to`, to `to` as its previous generation (the
 * machine keeps one of `to` taken later, and removes `from`'s): whether
 * one was moved. */
export async function adoptHistory(m: string, from: string, to: string): Promise<boolean> {
  const q = new URLSearchParams({ from, to });
  const j = await answer<{ adopted?: unknown }>(await send(`${base(m)}/adopt?${q}`, { method: 'POST' }), fail);
  return j?.adopted === true;
}

/** Removes every snapshot machine m keeps; how many terminals had any. */
export async function clearHistory(m: string): Promise<number> {
  const j = await answer<{ removed?: unknown }>(await send(base(m), { method: 'DELETE' }), fail);
  return count(j?.removed) ?? 0;
}

/** A failure as the user reads it. */
export const historyErrorText = makeErrorText(HistoryError, 'history.error');
