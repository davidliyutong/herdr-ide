// The GUI helper (scripts/gui-helper): the native part of program windows
// on Linux machines, one static executable per architecture that the
// machine build carries. This module puts it on the machine (extracted
// into the instance's data directory, checked by its digest before each
// start), runs its commands and speaks its window manager's protocol
// (scripts/gui-helper/src/proto.zig): over its stdin and stdout, each
// message [u32 little-endian n][u8 type][n-1 bytes], numbers little-endian.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Writable } from 'node:stream';
import { HUB_BIN } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader, write } from '#shared/lib/streamio.ts';

/** The helper this build carries: the executable and its SHA-256. */
export interface Carried {
  bytes: Uint8Array;
  digest: string;
}

/** Messages to the helper. */
export const In = {
  Focus: 1,
  Close: 2,
  Pointer: 3,
  Button: 4,
  Wheel: 5,
  Key: 6,
  Release: 7,
  Capture: 8,
  VideoClose: 9,
  Encoder: 10,
} as const;

/** Messages of the helper. */
export const Out = {
  Ready: 1,
  Window: 2,
  Gone: 3,
  Layer: 4,
  LayerGone: 5,
  Damage: 6,
  Cursor: 7,
  Frame: 8,
  BatchDone: 9,
} as const;

/** Frame encodings (agentproto's GUIEnc; 0: nothing to send). */
export const Enc = { None: 0, JPEG: 1, PNG: 2, Video: 3, VideoKey: 4 } as const;

/** Video stream kinds as the helper numbers them. */
const KIND: Record<string, number> = { avc1: 1, vp8: 2 };

/** The bytes of one capture job (proto.zig job_len). */
export const JOB_LEN = 29;
/** The most jobs of one batch (proto.zig max_jobs). */
export const MAX_JOBS = 1024;
/** The most pixels of one batch (proto.zig max_batch_pixels). */
export const MAX_BATCH_PIXELS = 256 << 20;
/** The longest message the helper takes. */
export const MAX_IN = 1 << 20;
/** The longest message the helper sends: a frame of a whole window. */
export const MAX_OUT = 80 << 20;

export interface Job {
  window: number;
  /** The window or one of its layers. */
  drawable: number;
  x: number;
  y: number;
  w: number;
  h: number;
  seq: number;
  /** Enc.JPEG, Enc.PNG or Enc.Video. */
  enc: number;
  /** Video: the stream, whether to make a key frame, and the kinds of a
   * stream that starts with this frame (none: the stream runs). */
  stream?: number;
  key?: boolean;
  kinds?: string[];
}

export function encodeJobs(jobs: readonly Job[]): Buffer {
  if (jobs.length === 0 || jobs.length > MAX_JOBS) throw new Error(`gui: ${jobs.length} jobs`);
  const b = Buffer.alloc(2 + jobs.length * JOB_LEN);
  b.writeUInt16LE(jobs.length, 0);
  jobs.forEach((j, i) => {
    const o = 2 + i * JOB_LEN;
    b.writeUInt32LE(j.window >>> 0, o);
    b.writeUInt32LE(j.drawable >>> 0, o + 4);
    b.writeInt16LE(j.x, o + 8);
    b.writeInt16LE(j.y, o + 10);
    b.writeUInt16LE(j.w, o + 12);
    b.writeUInt16LE(j.h, o + 14);
    b.writeUInt32LE(j.seq >>> 0, o + 16);
    b[o + 20] = j.enc;
    b.writeUInt32LE((j.stream ?? 0) >>> 0, o + 21);
    b[o + 25] = j.key ? 1 : 0;
    const kinds = (j.kinds ?? []).map((k) => KIND[k]).filter((k): k is number => k !== undefined);
    b[o + 26] = kinds.length;
    kinds.slice(0, 2).forEach((k, n) => (b[o + 27 + n] = k));
  });
  return b;
}

/** One message to the helper. */
export function message(type: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (payload.length + 1 > MAX_IN) throw new Error('gui: message too large');
  const h = Buffer.alloc(5);
  h.writeUInt32LE(payload.length + 1, 0);
  h[4] = type;
  return Buffer.concat([h, payload]);
}

/** Keeps one pointer update while the helper is busy. Commands that must
 * arrive in order are queued up to a hard limit, then the helper ends. */
export class HelperInput {
  private pointer?: Buffer;
  private waiting = false;
  private readonly pipe: Writable;
  private readonly full: () => void;

  constructor(pipe: Writable, full: () => void) {
    this.pipe = pipe;
    this.full = full;
  }

  send(b: Buffer): void {
    if (this.pipe.destroyed || this.pipe.writableEnded) return;
    if (b[4] === In.Pointer && this.pipe.writableNeedDrain) {
      this.pointer = b;
      if (!this.waiting) {
        this.waiting = true;
        this.pipe.once('drain', this.flush);
      }
      return;
    }
    if (b[4]! <= In.Release) this.pointer = undefined;
    if (this.pipe.writableLength + b.length > 2 * MAX_IN) {
      this.close();
      this.full();
      return;
    }
    this.pipe.write(b);
  }

  private readonly flush = () => {
    const b = this.pointer;
    this.pointer = undefined;
    this.waiting = false;
    if (b) this.send(b);
  };

  close(): void {
    this.pointer = undefined;
    this.waiting = false;
    this.pipe.off('drain', this.flush);
  }
}

const u32s = (...v: number[]) => {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeInt32LE(x | 0, i * 4));
  return b;
};

/** The input messages (the window manager's commands of the controller). */
export const input = {
  focus: (win: number) => message(In.Focus, u32s(win)),
  close: (win: number) => message(In.Close, u32s(win)),
  pointer: (win: number, x: number, y: number) => message(In.Pointer, u32s(win, x, y)),
  button: (win: number, x: number, y: number, button: number, down: boolean) =>
    message(In.Button, Buffer.concat([u32s(win, x, y), Buffer.from([button & 0xff, down ? 1 : 0])])),
  wheel: (win: number, x: number, y: number, dx: number, dy: number) => message(In.Wheel, u32s(win, x, y, dx, dy)),
  key: (win: number, keycode: number, down: boolean) =>
    message(In.Key, Buffer.concat([u32s(win), Buffer.from([keycode & 0xff, down ? 1 : 0])])),
  release: () => message(In.Release),
};

// What the helper says.

export interface HWindow {
  t: typeof Out.Window;
  id: number;
  w: number;
  h: number;
  pid: number;
  transient: number;
  title: string;
  terminal: string;
}

export interface HFrame {
  t: typeof Out.Frame;
  window: number;
  drawable: number;
  x: number;
  y: number;
  w: number;
  h: number;
  seq: number;
  enc: number;
  captureUs: number;
  encodeUs: number;
  stream: number;
  /** A stream this frame started: the encoder's name, the WebCodecs codec
   * and the coded size. */
  started?: { name: string; codec: string; w: number; h: number };
  error: string;
  data: Buffer;
}

export type HelperMessage =
  | { t: typeof Out.Ready; shm: boolean; width: number; height: number }
  | HWindow
  | { t: typeof Out.Gone; id: number }
  | { t: typeof Out.Layer; id: number; owner: number; x: number; y: number; w: number; h: number }
  | { t: typeof Out.LayerGone; id: number; owner: number }
  | { t: typeof Out.Damage; rects: Array<{ drawable: number; x: number; y: number; w: number; h: number }> }
  | { t: typeof Out.Cursor; xhot: number; yhot: number; png: Buffer }
  | HFrame
  | { t: typeof Out.BatchDone };

const utf8 = new TextDecoder();

/** Decodes one message of the helper; throws on one that does not parse. */
export function decode(type: number, p: Buffer): HelperMessage {
  let o = 0;
  const need = (n: number) => {
    if (o + n > p.length) throw new Error(`gui: short message ${type}`);
  };
  const u8 = () => (need(1), p[o++]);
  const u16 = () => (need(2), (o += 2), p.readUInt16LE(o - 2));
  const i16 = () => (need(2), (o += 2), p.readInt16LE(o - 2));
  const u32 = () => (need(4), (o += 4), p.readUInt32LE(o - 4));
  const i32 = () => (need(4), (o += 4), p.readInt32LE(o - 4));
  const str = (n: number) => (need(n), (o += n), utf8.decode(p.subarray(o - n, o)));
  switch (type) {
    case Out.Ready:
      return { t: Out.Ready, shm: u8() === 1, width: u16(), height: u16() };
    case Out.Window: {
      const id = u32();
      const w = u16();
      const h = u16();
      const pid = u32();
      const transient = u32();
      const title = str(u16());
      return { t: Out.Window, id, w, h, pid, transient, title, terminal: str(u16()) };
    }
    case Out.Gone:
      return { t: Out.Gone, id: u32() };
    case Out.Layer:
      return { t: Out.Layer, id: u32(), owner: u32(), x: i32(), y: i32(), w: u16(), h: u16() };
    case Out.LayerGone:
      return { t: Out.LayerGone, id: u32(), owner: u32() };
    case Out.Damage: {
      const n = u16();
      const rects = [];
      for (let i = 0; i < n; i++) rects.push({ drawable: u32(), x: i32(), y: i32(), w: i32(), h: i32() });
      return { t: Out.Damage, rects };
    }
    case Out.Cursor:
      return { t: Out.Cursor, xhot: u16(), yhot: u16(), png: p.subarray(o) };
    case Out.Frame: {
      const f = {
        t: Out.Frame,
        window: u32(),
        drawable: u32(),
        x: i16(),
        y: i16(),
        w: u16(),
        h: u16(),
        seq: u32(),
        enc: u8(),
        captureUs: u32(),
        encodeUs: u32(),
        stream: u32(),
      } as HFrame;
      if (u8() === 1) f.started = { name: str(u8()), codec: str(u8()), w: u16(), h: u16() };
      f.error = str(u16());
      f.data = p.subarray(o);
      return f;
    }
    case Out.BatchDone:
      return { t: Out.BatchDone };
  }
  throw new Error(`gui: unknown message ${type} of the helper`);
}

/** Reads the helper's messages from its stdout. */
export async function* messages(r: Reader): AsyncGenerator<HelperMessage> {
  for (;;) {
    let h: Buffer;
    try {
      h = await r.exactly(5);
    } catch {
      return;
    }
    const n = h.readUInt32LE(0);
    if (n < 1 || n > MAX_OUT) throw new Error(`gui: helper message of ${n} bytes`);
    const p = n > 1 ? await r.exactly(n - 1) : Buffer.alloc(0);
    yield decode(h[4], p);
  }
}

// Placing the executable.

/** Extractions not finished for this long are removed. */
export const STAGING_RETENTION_MS = 60 * 60_000;
/** Other builds' helpers unused for this long are removed. */
export const VERSION_RETENTION_MS = 14 * 24 * 60 * 60_000;
const MAX_BINARY = 64 << 20;

/** The directory of the helpers below an instance's data directory. */
export const helperRoot = (base: string) => posix.join(base, 'gui');

async function sha256File(p: string): Promise<string> {
  const b = await readFile(p);
  if (b.length > MAX_BINARY) return '';
  return createHash('sha256').update(b).digest('hex');
}

/** The helper of an instance, extracted from what the build carries into
 * <base>/gui/<digest prefix>/<bin>-gui (0700) and checked by its SHA-256
 * before each use (hashed again when the file changed). */
export class HelperFile {
  private hashed: { path: string; size: number; mtimeMs: number } | null = null;
  private placing: Promise<string> | null = null;

  private readonly base: string;
  private readonly carried: () => Promise<Carried | null>;

  constructor(base: string, carried: () => Promise<Carried | null>) {
    this.base = base;
    this.carried = carried;
  }

  /** The helper's path, placing it first; throws when the build carries
   * none or it cannot be placed. */
  async path(): Promise<string> {
    const c = await this.carried();
    if (!c) throw new Error('this build carries no GUI helper for the machine');
    const dir = posix.join(helperRoot(this.base), c.digest.slice(0, 16));
    const p = posix.join(dir, `${HUB_BIN}-gui`);
    if (await this.ok(p, c.digest)) {
      const now = new Date();
      await utimes(dir, now, now).catch(() => {}); // in use
      return p;
    }
    this.placing ??= this.place(dir, p, c).finally(() => (this.placing = null));
    return this.placing;
  }

  /** Whether p is the helper of digest: a regular file, executable, whose
   * contents hash to it (cached while its size and time stay). */
  private async ok(p: string, digest: string): Promise<boolean> {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return false;
    }
    if (!st.isFile() || (st.mode & 0o100) === 0 || st.uid !== process.getuid?.()) return false;
    const h = this.hashed;
    if (h && h.path === p && h.size === st.size && h.mtimeMs === st.mtimeMs) return true;
    if ((await sha256File(p).catch(() => '')) !== digest) return false;
    this.hashed = { path: p, size: st.size, mtimeMs: st.mtimeMs };
    return true;
  }

  private async place(dir: string, p: string, c: Carried): Promise<string> {
    const root = helperRoot(this.base);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const tmp = await mkdtemp(posix.join(root, '.fetch-'));
    try {
      const staged = posix.join(tmp, `${HUB_BIN}-gui`);
      const f = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o700);
      try {
        await f.writeFile(c.bytes);
        await f.sync();
      } finally {
        await f.close();
      }
      if ((await sha256File(staged)) !== c.digest) throw new Error('gui: the written helper does not match its digest');
      await rm(dir, { recursive: true, force: true }); // a damaged copy
      await rename(tmp, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    if (!(await this.ok(p, c.digest))) throw new Error('gui: the placed helper is not usable');
    return p;
  }
}

/** Removes helpers of other builds unused for VERSION_RETENTION_MS and
 * extractions that did not finish. */
export async function pruneHelpers(base: string, keep: string, now: number): Promise<void> {
  const root = helperRoot(base);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
    const p = posix.join(root, name);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    const limit = name.startsWith('.fetch-') ? STAGING_RETENTION_MS : VERSION_RETENTION_MS;
    if (now - st.mtimeMs > limit) await rm(p, { recursive: true, force: true }).catch(() => {});
  }
}

// Running it.

/** A running command of the helper: its stdin, a reader of its stdout,
 * the last lines it wrote on stderr, and its end. */
export interface Proc {
  readonly child: ChildProcess;
  readonly reader: Reader;
  /** Resolves with the exit code (null: killed) once it ended. */
  readonly exited: Promise<number | null>;
  /** The last lines of its standard error. */
  stderr(): string;
  send(b: Buffer): Promise<void>;
  /** Closes its stdin: the window manager ends. */
  end(): void;
  kill(): void;
}

/** Starts a command of the helper at path. Its stderr is logged and kept. */
export function startHelper(
  path: string,
  args: string[],
  o: { env: Record<string, string>; cwd: string; logger: Logger; stdin?: boolean },
): Proc {
  const child = spawn(path, args, { env: o.env, cwd: o.cwd, stdio: [o.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let partial = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (s: string) => {
    const parts = (partial + s).split('\n');
    partial = parts.pop() ?? '';
    if (partial.length > 4096) partial = partial.slice(-4096);
    for (const l of parts) {
      if (!l) continue;
      o.logger(`gui: ${l}`);
      lines.push(l);
      if (lines.length > 8) lines.shift();
    }
  });
  child.stdin?.on('error', () => {});
  const exited = new Promise<number | null>((res) => {
    child.once('error', (e) => {
      lines.push(e.message);
      res(-1);
    });
    child.once('close', (code) => res(code));
  });
  return {
    child,
    reader: new Reader(child.stdout!),
    exited,
    stderr: () => [...lines, partial].filter(Boolean).join('\n'),
    send: async (b) => {
      if (!child.stdin || child.stdin.destroyed) throw new Error('gui: the helper has ended');
      await write(child.stdin, b);
    },
    end: () => child.stdin?.end(),
    kill: () => child.kill('SIGKILL'),
  };
}

/** Runs a command of the helper that prints one line of JSON and exits,
 * within timeoutMs. */
export async function runHelper<T>(
  path: string,
  args: string[],
  o: { env: Record<string, string>; cwd: string; logger: Logger; timeoutMs: number },
): Promise<T> {
  const p = startHelper(path, args, { ...o, stdin: false });
  const t = setTimeout(() => p.kill(), o.timeoutMs);
  try {
    const parts: Buffer[] = [];
    let n = 0;
    for (let b; (b = await p.reader.chunk()) !== null;) {
      if ((n += b.length) > 1 << 20) throw new Error('gui: the helper printed too much');
      parts.push(b);
    }
    const code = await p.exited;
    if (code !== 0) throw new Error(lastLine(p.stderr()) || `the GUI helper exited with ${code}`);
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
  } finally {
    clearTimeout(t);
  }
}

/** The last line of s without the helper's command prefix. */
export function lastLine(s: string): string {
  const l = s.trim().split('\n').pop() ?? '';
  return l.replace(/^gui-[a-z]+: /, '');
}
