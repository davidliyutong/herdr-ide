// The core's terminal protocol (/api/v1/term): JSON text messages with a "t"
// field and binary frames [stream u32 LE][kind u8][payload].

/** Output to the client, input from it. */
export const FRAME_DATA = 0;
/** To the client: cols u16 LE, rows u16 LE of an observed terminal. */
export const FRAME_RESIZE = 3;
/** From the client: its terminal's own answers to the program. */
export const FRAME_AUTOMATIC = 6;

export interface Frame {
  stream: number;
  kind: number;
  payload: Uint8Array;
}

export function encodeFrame(stream: number, kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, stream, true);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

/** Decodes a binary message; null when it is shorter than a frame's head. */
export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { stream: view.getUint32(0, true), kind: bytes[4], payload: bytes.subarray(5) };
}

/** The grid of a resize frame. */
export function frameGrid(frame: Frame): { cols: number; rows: number } | null {
  if (frame.kind !== FRAME_RESIZE || frame.payload.length !== 4) return null;
  const p = frame.payload;
  return { cols: p[0] | (p[1] << 8), rows: p[2] | (p[3] << 8) };
}

/** A failed call: the core's error kind (not_found, read_only, refused, unavailable, ...). */
export class TermError extends Error {
  constructor(
    readonly kind: string,
    message = '',
  ) {
    super(message || kind);
  }
}

export type BackendPhase = 'starting' | 'ready' | 'error';

/** What a machine's terminal backend is doing, with the code of an error. */
export interface BackendState {
  phase: BackendPhase;
  code: string;
  version: string;
}

/** A terminal as the core reports it, with every field it sent. */
export type TerminalRecord = Record<string, unknown> & { address: string };

export function isLive(t: TerminalRecord): boolean {
  return t.state === 'live';
}

/** What the program says it is doing (OSC 7501), undefined if it never said. */
export function statusOf(t: TerminalRecord): string | undefined {
  const s = t.status as { state?: unknown } | null | undefined;
  return typeof s?.state === 'string' ? s.state : undefined;
}

/** The directory of a terminal: its foreground program's, else the one it was started in. */
export function directoryOf(t: TerminalRecord): string | undefined {
  const fg = t.foreground as { cwd?: unknown } | null | undefined;
  const cwd = typeof fg?.cwd === 'string' && fg.cwd ? fg.cwd : t.cwd;
  return typeof cwd === 'string' && cwd ? cwd : undefined;
}

/** What to call the terminal in a list: its name, its title, the program in it, or its address. */
export function displayName(t: TerminalRecord): string {
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const fg = t.foreground as { name?: unknown } | null | undefined;
  const argv = Array.isArray(t.argv) ? (t.argv as unknown[]) : [];
  const first = text(argv[0]);
  return text(t.name) ?? text(t.title) ?? text(fg?.name) ?? first?.split('/').pop() ?? t.address;
}
