// The virtual display of a machine (Op.GUI) and its window stream: after
// the reply of action "attach" both sides exchange messages framed as
// [u8 kind][u32 big-endian length][payload].
import type { Writable } from 'node:stream';
import type { Reader } from '#shared/lib/streamio.ts';
import { write } from '#shared/lib/streamio.ts';

/** Kinds of virtual display, and what action start is asked for (args[0]). */
export const GUIDisplay = {
  /** Draws in memory: OpenGL on the CPU (or VirtualGL's). */
  Xvfb: 'xvfb',
  /** Xwayland drawing with a GPU, with the agent's own compositor. */
  Xwayland: 'xwayland',
  Auto: 'auto',
} as const;

export interface GUIGPU {
  index: number;
  minor: number;
  uuid: string;
  model?: string;
  pci?: string;
}

export interface GUIStatus {
  supported: boolean;
  xvfb?: string;
  installable?: boolean;
  display?: string;
  xauthority?: string;
  running: boolean;
  kind?: string;
  gpu_display?: boolean;
  gpus?: GUIGPU[];
  display_minor?: number;
  pick?: string;
  vgl?: string;
  gpu?: boolean;
  vgl_preload?: string;
  error?: string;
  procs?: GUIProc[];
  video?: boolean;
  video_encoders?: string[];
}

export interface GUIProc {
  pid: number;
  comm: string;
  display?: boolean;
}

/** Message kinds. */
export const GUIMessage = {
  /** One JSON object: a GUIEvent from the agent or a GUICommand from the hub. */
  JSON: 1,
  /** Agent to hub: a GUIFrameHeader and an encoded image. */
  Frame: 2,
} as const;

/** Bounds one message (a full-screen PNG fits easily). */
export const MAX_GUI_MESSAGE = 64 << 20;

/** Writes one message; callers serialize writes. */
export async function writeGUI(w: Writable, kind: number, ...parts: Uint8Array[]): Promise<void> {
  const n = parts.reduce((a, p) => a + p.length, 0);
  if (n > MAX_GUI_MESSAGE) throw new Error(`agentproto: gui message of ${n} bytes`);
  const hdr = Buffer.allocUnsafe(5);
  hdr[0] = kind;
  hdr.writeUInt32BE(n, 1);
  await write(w, Buffer.concat([hdr, ...parts]));
}

/** Reads one message. */
export async function readGUI(r: Reader): Promise<{ kind: number; payload: Buffer }> {
  const hdr = await r.exactly(5);
  const n = hdr.readUInt32BE(1);
  if (n > MAX_GUI_MESSAGE) throw new Error(`agentproto: gui message of ${n} bytes`);
  return { kind: hdr[0], payload: n ? await r.exactly(n) : Buffer.alloc(0) };
}

export interface GUIWindow {
  id: number;
  title: string;
  w: number;
  h: number;
  pid?: number;
  terminal?: string;
  transient?: number;
}

export interface GUILayer {
  id: number;
  window: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pointer image (PNG, base64 in JSON as Go's []byte). */
export interface GUICursor {
  png: string;
  xhot: number;
  yhot: number;
}

export interface GUIVideo {
  window: number;
  codec: string;
  encoder: string;
  w: number;
  h: number;
}

export interface GUIStats {
  window: number;
  interval_us: number;
  updates: number;
  frames: number;
  jpeg: number;
  png: number;
  pixels: number;
  bytes: number;
  capture_us: number;
  convert_us: number;
  encode_us: number;
  waits: number;
  budget?: number;
  rtt_us?: number;
  latency_us: number;
  acked: number;
  video?: number;
  encoder?: string;
  fallback?: string;
}

/** Sent by the agent. ev: window, gone, layer, layer_gone, cursor, stats,
 * video, role; the hub adds child for browsers. */
export interface GUIEvent {
  ev: string;
  window?: GUIWindow;
  layer?: GUILayer;
  id?: number;
  cursor?: GUICursor;
  stats?: GUIStats;
  video?: GUIVideo;
  control?: boolean;
}

/** Sent by the hub; coordinates are relative to window id. */
export interface GUICommand {
  cmd: string;
  id: number;
  seq?: number;
  x?: number;
  y?: number;
  button?: number;
  down?: boolean;
  keycode?: number;
  dx?: number;
  dy?: number;
  codecs?: string[];
}

/** Frame encodings. */
export const GUIEnc = { JPEG: 1, PNG: 2, Video: 3, VideoKey: 4 } as const;

/** Precedes the image of a frame message; the hub relays both unchanged. */
export interface GUIFrameHeader {
  window: number;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
  enc: number;
  seq: number;
}

export const GUI_FRAME_HEADER_LEN = 21;

export function marshalFrameHeader(h: GUIFrameHeader): Buffer {
  const b = Buffer.allocUnsafe(GUI_FRAME_HEADER_LEN);
  b.writeUInt32BE(h.window >>> 0, 0);
  b.writeUInt32BE(h.layer >>> 0, 4);
  b.writeInt16BE(h.x, 8);
  b.writeInt16BE(h.y, 10);
  b.writeUInt16BE(h.w, 12);
  b.writeUInt16BE(h.h, 14);
  b[16] = h.enc;
  b.writeUInt32BE(h.seq >>> 0, 17);
  return b;
}

export function parseFrameHeader(b: Uint8Array): GUIFrameHeader {
  if (b.length < GUI_FRAME_HEADER_LEN) throw new Error('agentproto: short gui frame');
  const v = Buffer.from(b.buffer, b.byteOffset, b.length);
  return {
    window: v.readUInt32BE(0),
    layer: v.readUInt32BE(4),
    x: v.readInt16BE(8),
    y: v.readInt16BE(10),
    w: v.readUInt16BE(12),
    h: v.readUInt16BE(14),
    enc: v[16],
    seq: v.readUInt32BE(17),
  };
}
