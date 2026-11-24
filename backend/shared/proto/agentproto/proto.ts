// The stream protocol between the core and a machine's agent over a yamux
// session (internal/agentproto while the Go program exists).
//
// Every yamux stream starts with one JSON header line written by the
// opener, answered by one JSON reply line. After a successful reply the
// stream carries op-specific raw bytes (a socket pipe, file contents…).
import type { Readable, Writable } from 'node:stream';
import { EOFError, Reader, write, writeLine } from '#shared/lib/streamio.ts';
import type { VaultProcess } from './vault.ts';

/** The build's version: git describe's, or "dev" (replaced at build time). */
export let VERSION = 'dev';
export function setVersion(v: string): void {
  VERSION = v;
}

/** A build's version as the build names it (git describe: the tag, "v" and
 * three numbers, then "-<n>-g<hash>" commits after it, and "-dirty", which
 * scripts/build.sh follows with the build's time); null for any other (a
 * development build). What follows "-dirty" does not order builds. */
export function parseVersion(v: string): [number, number, number, number] | null {
  v = v.replace(/^v/, '');
  const dirty = v.indexOf('-dirty');
  if (dirty >= 0) v = v.slice(0, dirty);
  const dash = v.indexOf('-');
  const base = dash >= 0 ? v.slice(0, dash) : v;
  const after = dash >= 0 ? v.slice(dash + 1) : null;
  const parts = base.split('.');
  if (parts.length !== 3) return null;
  const n: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (!/^\+?\d+$/.test(parts[i])) return null;
    n[i] = Number(parts[i]);
  }
  if (after !== null) {
    const g = after.indexOf('-g');
    if (g < 0) return null;
    const commits = after.slice(0, g);
    if (!/^\+?\d+$/.test(commits) || after.slice(g + 2) === '') return null;
    n[3] = Number(commits);
  }
  return n;
}

/** Whether build version a is older than b: both are known and a comes first. */
export function olderVersion(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

export const Op = {
  /** Info about the agent host. */
  Hello: 'hello',
  FsStat: 'fs.stat',
  FsList: 'fs.list',
  /** Streams length bytes from offset after the reply. */
  FsRead: 'fs.read',
  /** Raw bytes until the opener closes its write side, written atomically, then a second reply. */
  FsWrite: 'fs.write',
  /** Paths as one zip after the reply (ChunkWriter chunks with chunked). */
  FsArchive: 'fs.archive',
  /** Dials a unix socket below the agent's run directory. */
  DialUnix: 'dial-unix',
  CodeServer: 'code-server',
  /** Opened by the agent towards the core for each VS Code bridge connection. */
  Bridge: 'bridge',
  GUI: 'gui',
  /** The agent's own herdr-core: status, install, start, restart, stop. */
  HC: 'hc',
  /** Pipes raw bytes to the terminal core's socket; starts nothing. */
  HCAPI: 'hc-api',
  /** DetectEvent lines after the reply until either side closes. */
  Detect: 'detect',
  Privacy: 'privacy',
  /** Runs action of the agent's side of plugin with params. */
  Plugin: 'plugin',
  /** Opened by the agent towards the core for each vault MCP connection. */
  Vault: 'vault',
  /** Opened by a node towards each core once another node took its socket. */
  NodeDrain: 'node.drain',
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** One line of an OpDetect stream. */
export interface DetectEvent {
  terminal: string;
  agent: string;
  status: string;
  session?: string;
  session_source?: string;
}

/** How a DetectEvent's session was found. */
export const SessionFrom = {
  Argv: 'argv',
  PID: 'pid',
  FD: 'fd',
  Start: 'start',
  Hook: 'hook',
  Guess: 'guess',
} as const;

/** The first line a client writes on a node's socket. */
export interface NodeHello {
  op: string;
  node?: NodeInfo;
  ssh_connection?: string;
  client?: string;
}

export const NodeOp = { Serve: 'serve', Stop: 'stop', Takeover: 'takeover' } as const;

/** A node's build, or the build of a client of one. */
export interface NodeInfo {
  build: string;
  version: string;
  exe_time: number;
  pid?: number;
}

/** Whether build n is newer than o: by version when both are known, else by
 * when their executables were written. */
export function newer(n: NodeInfo, o: NodeInfo): boolean {
  if (n.build === o.build) return false;
  if (parseVersion(n.version) && parseVersion(o.version) && n.version !== o.version) return olderVersion(o.version, n.version);
  return n.exe_time > o.exe_time;
}

/** The first line of every stream. */
export interface Header {
  op: Op;
  // fs
  path?: string;
  offset?: number;
  length?: number;
  mkdirs?: boolean;
  unique?: boolean;
  paths?: string[];
  chunked?: boolean;
  // code-server, gui, hc
  action?: string;
  version?: string;
  args?: string[];
  bin?: string;
  url?: string;
  digest?: string;
  // plugin
  plugin?: string;
  params?: unknown;
  params_length?: number;
  // vault
  process?: VaultProcess[];
  // detect
  sessions?: boolean;
}

/** The first line written back by the acceptor. */
export interface Reply {
  ok: boolean;
  error?: string;
  code?: string;
  info?: Info;
  node?: NodeInfo;
  ssh?: string;
  stat?: Stat;
  entries?: Stat[];
  exec?: ExecResult;
  cs?: CSStatus;
  bridge?: BridgeInfo;
  gui?: import('./gui.ts').GUIStatus;
  hc?: HCStatus;
  privacy?: PrivacyStatus;
  plugin?: unknown;
  plugin_length?: number;
  entries_length?: number;
}

export const Access = { Granted: 'granted', Denied: 'denied', Unknown: 'unknown' } as const;

export interface PrivacyStatus {
  files: string;
  terminals: string;
  hc: string;
}

export interface Info {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  home: string;
  user: string;
  data_dir: string;
  run_dir: string;
  upload_dir: string;
}

export interface Stat {
  name: string;
  path?: string;
  size: number;
  mode: number;
  /** Unix milliseconds. */
  mtime: number;
  is_dir: boolean;
  is_link?: boolean;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export interface CSStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  socket?: string;
  error?: string;
  bin?: string;
  digest?: string;
}

export interface HCStatus {
  digest?: string;
  running: boolean;
  version?: string;
  session: string;
  socket: string;
}

/** Codes of failed OpHC actions. */
export const HCCode = {
  NotInstalled: 'not_installed',
  BadDigest: 'bad_digest',
  StartFailed: 'start_failed',
  StopFailed: 'stop_failed',
} as const;

export interface BridgeInfo {
  conn_id: string;
}

/** Bounds header and reply lines. */
export const MAX_HEADER_LINE = 1 << 20;
/** The largest JSON a plugin header or reply carries in its line; larger
 * follows the line as a body of at most MAX_BODY bytes. */
export const MAX_INLINE = 32 << 10;
export const MAX_BODY = 64 << 20;

export { writeLine };

/** Reads one JSON line, leaving the bytes after it in the stream. */
export async function readLine<T>(r: Reader): Promise<T> {
  const line = await r.line(MAX_HEADER_LINE).catch((e) => {
    if (e instanceof Error && e.message === 'line too long') throw new Error('agentproto: line too long');
    throw e;
  });
  try {
    return JSON.parse(line) as T;
  } catch (e) {
    const shown = line.length > 120 ? line.slice(0, 120) + '...' : line;
    throw new Error(`agentproto: bad line ${JSON.stringify(shown)}: ${(e as Error).message}`);
  }
}

/** Reads the n bytes of JSON that follow a line (params_length, plugin_length). */
export async function readBody(r: Reader, n: number): Promise<unknown> {
  if (n < 0 || n > MAX_BODY) throw new Error(`agentproto: body of ${n} bytes`);
  let b: Buffer;
  try {
    b = await r.exactly(n);
  } catch (e) {
    throw new Error(`agentproto: body: ${(e as Error).message}`);
  }
  return JSON.parse(b.toString('utf8'));
}

/** Writes a failed reply. */
export function fail(w: Writable, err: Error | string): Promise<void> {
  return writeLine(w, { ok: false, error: typeof err === 'string' ? err : err.message } satisfies Reply);
}

/** Frames a byte stream as [u32 big-endian length][data] chunks ended by a
 * zero-length chunk, so an upload can end its data and still read a reply. */
export class ChunkWriter {
  readonly w: Writable;

  constructor(w: Writable) {
    this.w = w;
  }

  async write(p: Uint8Array): Promise<void> {
    for (let off = 0; off < p.length;) {
      const n = Math.min(p.length - off, 1 << 20);
      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32BE(n);
      await write(this.w, hdr);
      await write(this.w, p.subarray(off, off + n));
      off += n;
    }
  }

  /** Writes the terminating zero-length chunk. */
  finish(): Promise<void> {
    return write(this.w, Buffer.alloc(4));
  }
}

/** Reads a ChunkWriter stream: chunks of data, then null at its end. */
export class ChunkReader {
  private left = 0;
  private done = false;

  readonly r: Reader;

  constructor(r: Reader) {
    this.r = r;
  }

  async read(): Promise<Buffer | null> {
    if (this.done) return null;
    if (this.left === 0) {
      let hdr: Buffer;
      try {
        hdr = await this.r.exactly(4);
      } catch {
        throw new EOFError(true);
      }
      this.left = hdr.readUInt32BE(0);
      if (this.left === 0) {
        this.done = true;
        return null;
      }
    }
    const b = await this.r.chunk(this.left);
    if (b === null) throw new EOFError(true);
    this.left -= b.length;
    return b;
  }

  /** The rest of the data as a stream of chunks. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (let b = await this.read(); b !== null; b = await this.read()) yield b;
  }
}

/** A Reader over a stream, for the functions above. */
export const reader = (s: Readable): Reader => new Reader(s);
