// The program of the end-to-end tests' program windows
// (e2e/tests/gui.spec.ts, backend/features/gui/integration.test.ts and the
// machine matrix's gui payload): on the display of $DISPLAY (with
// $XAUTHORITY) it shows a red window titled "e2e window" and prints what it
// receives, one line each: mapped, button <n> <x> <y>, key <keycode>,
// delete. With -anim it is 640×360 and repaints itself in another color 60
// times a second (a window that keeps changing, sent as video).
//
// A minimal X11 client of its own, speaking the core protocol over the
// display's socket: connection setup with the MIT-MAGIC-COOKIE-1 of the
// Xauthority file, InternAtom, CreateWindow, ChangeProperty, MapWindow,
// CreateGC, ChangeGC, PolyFillRectangle, GetInputFocus (a round trip), and
// the events it prints. Node's modules only: compiled by `bun build
// --compile` (scripts/e2e.sh), or run as a script.

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { connect, type Socket } from 'node:net';

const anim = process.argv.slice(2).some((a) => a === '-anim' || a === '--anim');

function die(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

/** Prints a line of output. */
const out = (line: string) => process.stdout.write(line + '\n');

// ---------------------------------------------------------------- display

interface Display {
  host: string;
  number: string;
  screen: number;
}

function parseDisplay(d: string | undefined): Display {
  if (!d) die('DISPLAY is not set');
  const m = /^(.*):(\d+)(?:\.(\d+))?$/.exec(d);
  if (!m) die(`bad DISPLAY ${d}`);
  return { host: m[1].replace(/^unix$/, ''), number: m[2], screen: Number(m[3] ?? 0) };
}

/** The MIT-MAGIC-COOKIE-1 of the Xauthority file for the display: the
 * entry of this host (or any host) and the display's number, else the
 * file's first cookie of that number or none. */
function cookie(d: Display): Buffer | undefined {
  const path = process.env.XAUTHORITY || (process.env.HOME ? `${process.env.HOME}/.Xauthority` : '');
  if (!path) return undefined;
  let b: Buffer;
  try {
    b = readFileSync(path);
  } catch {
    return undefined;
  }
  const host = d.host || hostname();
  let fallback: Buffer | undefined;
  for (let off = 0; off + 2 <= b.length;) {
    const family = b.readUInt16BE(off);
    off += 2;
    const fields: Buffer[] = [];
    for (let i = 0; i < 4; i++) {
      if (off + 2 > b.length) return fallback;
      const n = b.readUInt16BE(off);
      off += 2;
      if (off + n > b.length) return fallback;
      fields.push(b.subarray(off, off + n));
      off += n;
    }
    const [addr, number, name, data] = fields;
    if (name.toString() !== 'MIT-MAGIC-COOKIE-1') continue;
    if (number.length && number.toString() !== d.number) continue;
    // FamilyWild, or FamilyLocal of this host.
    if (family === 0xffff || (family === 256 && addr.toString() === host)) return data;
    fallback ??= data;
  }
  return fallback;
}

// ---------------------------------------------------------------- the wire

const pad = (n: number) => (4 - (n % 4)) % 4;

class X {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed = false;
  private seq = 0;
  /** Replies awaited, by sequence number. */
  private replies = new Map<number, (r: Buffer | Error) => void>();
  private nextID = 1;
  /** Events, in order. */
  private events: Buffer[] = [];
  private eventWaiter?: () => void;
  idBase = 0;
  idMask = 0;
  root = 0;
  rootVisual = 0;
  rootDepth = 0;

  constructor(private readonly sock: Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.wake();
    });
    const end = () => {
      this.closed = true;
      this.wake();
    };
    sock.on('end', end);
    sock.on('close', end);
    sock.on('error', end);
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** The next n bytes of the connection; undefined once it closed. */
  private async take(n: number): Promise<Buffer | undefined> {
    while (this.buf.length < n) {
      if (this.closed) return undefined;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return b;
  }

  async setup(screen: number, auth?: Buffer): Promise<void> {
    const name = auth ? Buffer.from('MIT-MAGIC-COOKIE-1') : Buffer.alloc(0);
    const data = auth ?? Buffer.alloc(0);
    const req = Buffer.alloc(12 + name.length + pad(name.length) + data.length + pad(data.length));
    req[0] = 0x6c; // 'l': little-endian
    req.writeUInt16LE(11, 2);
    req.writeUInt16LE(0, 4);
    req.writeUInt16LE(name.length, 6);
    req.writeUInt16LE(data.length, 8);
    name.copy(req, 12);
    data.copy(req, 12 + name.length + pad(name.length));
    this.sock.write(req);
    const head = await this.take(8);
    if (!head) die('the X server closed the connection');
    const body = await this.take(head.readUInt16LE(6) * 4);
    if (!body) die('the X server closed the connection');
    if (head[0] !== 1) {
      const reason = head[0] === 0 ? body.subarray(0, head[1]).toString() : 'more authentication asked for';
      die(`the X server refused the connection: ${reason}`);
    }
    this.idBase = body.readUInt32LE(4);
    this.idMask = body.readUInt32LE(8);
    const vendor = body.readUInt16LE(16);
    const nscreens = body[20];
    const nformats = body[21];
    let off = 32 + vendor + pad(vendor) + 8 * nformats;
    if (screen >= nscreens) die(`the display has no screen ${screen}`);
    for (let s = 0; ; s++) {
      if (s === screen) {
        this.root = body.readUInt32LE(off);
        this.rootVisual = body.readUInt32LE(off + 32);
        this.rootDepth = body[off + 38];
        break;
      }
      // Past a screen: its depths, each with its visuals.
      const ndepths = body[off + 39];
      off += 40;
      for (let i = 0; i < ndepths; i++) off += 8 + 24 * body.readUInt16LE(off + 2);
    }
    void this.read();
  }

  /** Reads what the server sends: replies to their requests, events in
   * order; errors are dropped (as xgb's WaitForEvent returned them). */
  private async read(): Promise<void> {
    for (;;) {
      const b = await this.take(32);
      if (!b) break;
      const code = b[0] & 0x7f;
      if (code === 1 || code === 35) {
        // A reply, or a generic event: 32 bytes and more.
        const more = await this.take(b.readUInt32LE(4) * 4);
        if (!more) break;
        const full = Buffer.concat([b, more]);
        if (code === 1) {
          const seq = full.readUInt16LE(2);
          this.replies.get(seq)?.(full);
          this.replies.delete(seq);
        } else this.event(full);
      } else if (code === 0) {
        const seq = b.readUInt16LE(2);
        const r = this.replies.get(seq);
        this.replies.delete(seq);
        r?.(new Error(`X error ${b[1]} of request ${b[10]}`));
      } else this.event(b);
    }
    this.closed = true;
    for (const r of this.replies.values()) r(new Error('the X server closed the connection'));
    this.replies.clear();
    this.eventWaiter?.();
  }

  private event(b: Buffer) {
    this.events.push(b);
    const w = this.eventWaiter;
    this.eventWaiter = undefined;
    w?.();
  }

  /** The next event; undefined once the connection closed. */
  async nextEvent(): Promise<Buffer | undefined> {
    for (;;) {
      const e = this.events.shift();
      if (e) return e;
      if (this.closed) return undefined;
      await new Promise<void>((r) => (this.eventWaiter = r));
    }
  }

  newID(): number {
    return (this.idBase | (this.nextID++ & this.idMask)) >>> 0;
  }

  /** Sends a request: opcode, the byte after it, and the body after the
   * length (a multiple of 4 bytes). Its sequence number. */
  request(opcode: number, data: number, body: Buffer): number {
    const h = Buffer.alloc(4);
    h[0] = opcode;
    h[1] = data;
    h.writeUInt16LE(1 + body.length / 4, 2);
    this.sock.write(Buffer.concat([h, body]));
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** Sends a request with a reply and waits for it. */
  async call(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    const seq = this.request(opcode, data, body);
    const r = await new Promise<Buffer | Error>((resolve) => {
      if (this.closed) resolve(new Error('the X server closed the connection'));
      else this.replies.set(seq, resolve);
    });
    if (r instanceof Error) throw r;
    return r;
  }

  async internAtom(name: string): Promise<number> {
    const n = Buffer.from(name);
    const body = Buffer.alloc(4 + n.length + pad(n.length));
    body.writeUInt16LE(n.length, 0);
    n.copy(body, 4);
    const r = await this.call(16, 0, body);
    return r.readUInt32LE(8);
  }

  changeProperty(win: number, prop: number, type: number, format: 8 | 32, data: Buffer) {
    const body = Buffer.alloc(20 + data.length + pad(data.length));
    body.writeUInt32LE(win, 0);
    body.writeUInt32LE(prop, 4);
    body.writeUInt32LE(type, 8);
    body[12] = format;
    body.writeUInt32LE(data.length / (format / 8), 16);
    data.copy(body, 20);
    this.request(18, 0 /* Replace */, body);
  }

  /** A round trip: everything sent before was handled (xgb's Sync). */
  async sync(): Promise<void> {
    await this.call(43 /* GetInputFocus */, 0, Buffer.alloc(0));
  }
}

const u32s = (...v: number[]) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32LE(x >>> 0, 4 * i));
  return b;
};

// ---------------------------------------------------------------- main

const XA_ATOM = 4;
const XA_STRING = 31;
const XA_WM_NAME = 39;

async function main(): Promise<void> {
  const d = parseDisplay(process.env.DISPLAY);
  const sock = await new Promise<Socket>((resolve) => {
    const s = d.host ? connect({ host: d.host, port: 6000 + Number(d.number) }) : connect({ path: `/tmp/.X11-unix/X${d.number}` });
    s.once('connect', () => resolve(s));
    s.once('error', (e) => die(`connecting to the display ${process.env.DISPLAY}: ${e.message}`));
  });
  const x = new X(sock);
  await x.setup(d.screen, cookie(d));

  const win = x.newID();
  const [w, h] = anim ? [640, 360] : [320, 200];
  // CreateWindow: InputOutput, the back pixel red, and the events wanted
  // (ButtonPress, KeyPress, StructureNotify).
  {
    const body = Buffer.alloc(28 + 8);
    body.writeUInt32LE(win, 0);
    body.writeUInt32LE(x.root, 4);
    body.writeInt16LE(0, 8);
    body.writeInt16LE(0, 10);
    body.writeUInt16LE(w, 12);
    body.writeUInt16LE(h, 14);
    body.writeUInt16LE(0, 16);
    body.writeUInt16LE(1, 18);
    body.writeUInt32LE(x.rootVisual, 20);
    body.writeUInt32LE(0x2 | 0x800, 24);
    body.writeUInt32LE(0xff0000, 28);
    body.writeUInt32LE(0x4 | 0x1 | 0x20000, 32);
    x.request(1, x.rootDepth, body);
  }
  const [netWMName, utf8, protocols, del] = await Promise.all(
    ['_NET_WM_NAME', 'UTF8_STRING', 'WM_PROTOCOLS', 'WM_DELETE_WINDOW'].map((n) => x.internAtom(n)),
  );
  const title = Buffer.from('e2e window');
  x.changeProperty(win, netWMName, utf8, 8, title);
  x.changeProperty(win, XA_WM_NAME, XA_STRING, 8, title);
  x.changeProperty(win, protocols, XA_ATOM, 32, u32s(del));
  x.request(8 /* MapWindow */, 0, u32s(win));

  if (anim) {
    const gc = x.newID();
    x.request(55 /* CreateGC */, 0, u32s(gc, win, 0));
    void (async () => {
      try {
        for (let i = 0; ; i = (i + 1) >>> 0) {
          // A gradient of bands that moves: every frame changes all of it.
          for (let b = 0; b < 16; b++) {
            const color = ((((i * 8 + b * 16) >>> 0) % 256) << 16) | ((b * 16) << 8) | (255 - (((i * 4) >>> 0) % 256));
            x.request(56 /* ChangeGC */, 0, u32s(gc, 0x4 /* Foreground */, color));
            const r = Buffer.alloc(16);
            r.writeUInt32LE(win, 0);
            r.writeUInt32LE(gc, 4);
            r.writeInt16LE(Math.floor((b * w) / 16), 8);
            r.writeInt16LE(0, 10);
            r.writeUInt16LE(Math.floor(w / 16), 12);
            r.writeUInt16LE(h, 14);
            x.request(70 /* PolyFillRectangle */, 0, r);
          }
          await x.sync();
          await new Promise((r) => setTimeout(r, 16));
        }
      } catch {
        // The connection closed: the events' loop ends the program.
      }
    })();
  }

  for (;;) {
    const e = await x.nextEvent();
    if (!e) return;
    switch (e[0] & 0x7f) {
      case 19: // MapNotify
        out('mapped');
        break;
      case 4: // ButtonPress
        out(`button ${e[1]} ${e.readInt16LE(24)} ${e.readInt16LE(26)}`);
        break;
      case 2: // KeyPress
        out(`key ${e[1]}`);
        break;
      case 33: // ClientMessage
        if (e.readUInt32LE(12) === del) {
          out('delete');
          return;
        }
        break;
    }
  }
}

main().then(
  () => process.stdout.write('', () => process.exit(0)),
  (e: unknown) => die(String(e instanceof Error ? e.message : e)),
);
