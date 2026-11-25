// What crosses the feature's boundaries: the display status and the events
// the agent sends (validated where they enter), the commands a browser
// window sends (only the fields a command may carry are kept) and the
// commands and events the hub writes, as the Go hub wrote them (members
// in the same order, zero values left out).
import { z } from 'zod';
import type { GUICommand, GUIStatus, GUIWindow } from '#shared/proto/agentproto/index.ts';

const int = z.number().int();
const u32 = int.min(0).max(0xffffffff);

const gpu = z.object({
  index: int,
  minor: int,
  uuid: z.string(),
  model: z.string().optional(),
  pci: z.string().optional(),
});

const proc = z.object({ pid: int, comm: z.string(), display: z.boolean().optional() });

/** A machine's display as the agent describes it (Reply.gui). */
export const guiStatus = z.object({
  supported: z.boolean().default(false),
  xvfb: z.string().optional(),
  installable: z.boolean().optional(),
  display: z.string().optional(),
  xauthority: z.string().optional(),
  running: z.boolean().default(false),
  kind: z.string().optional(),
  gpu_display: z.boolean().optional(),
  gpus: z.array(gpu).optional(),
  display_minor: int.optional(),
  pick: z.string().optional(),
  vgl: z.string().optional(),
  gpu: z.boolean().optional(),
  vgl_preload: z.string().optional(),
  error: z.string().optional(),
  procs: z.array(proc).optional(),
  video: z.boolean().optional(),
  video_encoders: z.array(z.string()).optional(),
}) satisfies z.ZodType<GUIStatus, unknown>;

const window = z.object({
  id: u32,
  title: z.string().default(''),
  w: int.default(0),
  h: int.default(0),
  pid: int.optional(),
  terminal: z.string().optional(),
  transient: u32.optional(),
});

const layer = z.object({
  id: u32,
  window: u32,
  x: int.default(0),
  y: int.default(0),
  w: int.default(0),
  h: int.default(0),
});

/** An event of the agent's window manager. Events the hub passes on as
 * they came keep what this does not name. */
const agentEvent = z.object({
  ev: z.string(),
  window: window.optional(),
  layer: layer.optional(),
  id: u32.default(0),
  cursor: z.looseObject({}).optional(),
  stats: z.looseObject({ window: u32 }).optional(),
  video: z.looseObject({ window: u32, codec: z.string().default('') }).optional(),
  control: z.boolean().default(false),
});

export type AgentEvent = z.output<typeof agentEvent>;

/** Parses an event of the agent; undefined for one that does not parse
 * (ignored, as the Go hub did). */
export function parseAgentEvent(payload: Uint8Array): AgentEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    return undefined;
  }
  const r = agentEvent.safeParse(raw);
  return r.success ? r.data : undefined;
}

/** A window record with the members Go's GUIWindow had, zero values left
 * out. */
export function windowOf(w: z.output<typeof window> | GUIWindow): GUIWindow {
  return {
    id: w.id,
    title: w.title,
    w: w.w,
    h: w.h,
    ...(w.pid ? { pid: w.pid } : {}),
    ...(w.terminal ? { terminal: w.terminal } : {}),
    ...(w.transient ? { transient: w.transient } : {}),
  };
}

/** {ev: "window" | "child", window}. */
export const windowEvent = (ev: 'window' | 'child', w: GUIWindow): string => JSON.stringify({ ev, window: w });

/** Tells a browser window whether its hub controls the windows. */
export const roleEvent = (control: boolean): string => JSON.stringify(control ? { ev: 'role', control } : { ev: 'role' });

/** Tells a browser window its program window is gone. */
export const goneEvent = (id: number): string => JSON.stringify(id ? { ev: 'gone', id } : { ev: 'gone' });

/** A command for the agent as one JSON object: cmd and id always, the
 * others when set. */
export function marshalCommand(c: GUICommand): string {
  const o: Record<string, unknown> = { cmd: c.cmd, id: c.id };
  for (const k of ['seq', 'x', 'y', 'button', 'down', 'keycode', 'dx', 'dy'] as const) if (c[k]) o[k] = c[k];
  if (c.codecs?.length) o.codecs = c.codecs;
  return JSON.stringify(o);
}

const field = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);

/** What a browser window sends: a command and its input fields. */
const viewerCommand = z.object({
  cmd: field(z.string()),
  id: field(u32),
  seq: field(u32),
  x: field(int),
  y: field(int),
  button: field(int),
  down: field(z.boolean()),
  keycode: field(int),
  dx: field(int),
  dy: field(int),
  codecs: field(z.array(z.string())),
});

/** Parses a browser window's message; undefined for one that is not a
 * command (ignored). null members count as absent. */
export function parseViewerCommand(text: string): GUICommand | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null) raw = {};
  const r = viewerCommand.safeParse(raw);
  if (!r.success) return undefined;
  const c: GUICommand = { cmd: r.data.cmd ?? '', id: r.data.id ?? 0 };
  for (const k of ['seq', 'x', 'y', 'button', 'keycode', 'dx', 'dy'] as const) if (r.data[k] !== undefined) c[k] = r.data[k];
  if (r.data.down !== undefined) c.down = r.data.down;
  if (r.data.codecs !== undefined) c.codecs = r.data.codecs;
  return c;
}

/** The video streams a browser window decodes, from its WebSocket's
 * ?video=avc1,vp8: at most four short lowercase names, each once. */
export function parseCodecs(q: string): string[] {
  const out: string[] = [];
  for (const c of q.split(',')) {
    if (out.length === 4 || !/^[a-z0-9]{1,8}$/.test(c) || out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/** The order video streams are offered to agents: H.264 (encoded on the
 * GPU) before VP8 (on the CPU); others after, by name. */
export const CODEC_PREFERENCE: readonly string[] = ['avc1', 'vp8'];

/** The video streams every list names, in CODEC_PREFERENCE order; none
 * without lists. */
export function sharedCodecs(lists: Iterable<readonly string[]>): string[] {
  let out: string[] | undefined;
  for (const l of lists) out = out === undefined ? [...l] : out.filter((c) => l.includes(c));
  const rank = (c: string) => {
    const i = CODEC_PREFERENCE.indexOf(c);
    return i >= 0 ? i : CODEC_PREFERENCE.length;
  };
  return (out ?? []).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
