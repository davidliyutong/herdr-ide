// A terminal core on a unix socket that speaks enough of herdr-core's API
// for captures: the hello, terminal.list, terminal.read and observing
// attaches whose output it sends against credit, in frames of chunk bytes,
// as herdr-core 0.1.21 does (viewers.rs, wire.rs): the terminal's grid
// first, then the first paint, then the program's output; a paint the core
// replaces starts a frame of its own.
import { createServer, type Server, type Socket } from 'node:net';
import { Reader } from '#shared/lib/streamio.ts';
import { Kind, WINDOW, encodeFrame, readFrame } from '#shared/proto/hc/wire.ts';

export interface FakeTerminal {
  address: string;
  state: string;
  pid?: number;
  name?: string;
  reason?: string;
  cols: number;
  rows: number;
  labels: Record<string, string>;
}

export const live = (address: string, pid: number): FakeTerminal => ({ address, state: 'live', pid, cols: 80, rows: 24, labels: {} });

export const finished = (address: string, reason = ''): FakeTerminal => ({
  address,
  state: 'finished',
  cols: 80,
  rows: 24,
  labels: {},
  ...(reason ? { reason } : {}),
});

/** Replaces the paint of the next times attaches after cut bytes; grid is
 * the terminal's grid a resize gives it. */
export interface Splice {
  cut: number;
  times: number;
  grid?: [number, number];
}

const take = (s: Splice | undefined): boolean => {
  if (!s || s.times <= 0) return false;
  s.times--;
  return true;
};

export interface Attach {
  terminal: string;
  cols: number;
  rows: number;
  history?: number;
  observe?: boolean;
  resize_notifications?: boolean;
}

/** An attach's credit. */
class Channel {
  credit = WINDOW;
  closed = false;
  private waiters: Array<() => void> = [];

  add(n: number): void {
    this.credit += n;
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Waits for credit and takes up to n of it; 0 once closed. */
  async take(n: number): Promise<number> {
    while (this.credit === 0 && !this.closed) await new Promise<void>((r) => this.waiters.push(r));
    if (this.closed) return 0;
    n = Math.min(n, this.credit);
    this.credit -= n;
    return n;
  }
}

export class FakeCore {
  terms: FakeTerminal[] = [];
  readonly text = new Map<string, string>();
  /** A terminal's first paint for an attach with history lines; null when
   * the core drops it (a paint above 4 MiB): the attach succeeds and only
   * the program's output follows, after the grid. */
  readonly paint = new Map<string, (history: number) => Buffer | null>();
  /** Output that follows a terminal's paint at once. */
  readonly after = new Map<string, Buffer>();
  /** The terminal is resized after cut bytes of its paint were sent: the
   * core drops the paint's rest and sends the new grid and a repaint
   * without history; the terminal keeps the new grid. */
  readonly regrid = new Map<string, Splice>();
  /** The reader fell behind after cut bytes of the paint: the core drops
   * the backlog and sends a repaint without history. */
  readonly behind = new Map<string, Splice>();
  /** Terminals that wait for their new shell: attaches fail so. */
  readonly unavailable = new Set<string>();
  chunk = 16 << 10;
  readonly reads: Array<Record<string, unknown>> = [];
  readonly attaches: Attach[] = [];
  lists = 0;
  private server?: Server;
  private readonly conns = new Set<Socket>();

  listen(path: string): Promise<void> {
    this.server = createServer((c) => {
      this.conns.add(c);
      c.on('error', () => {});
      c.on('close', () => this.conns.delete(c));
      void this.serve(c).catch(() => c.destroy());
    });
    return new Promise((res) => this.server!.listen(path, res));
  }

  /** Stops listening and ends the connections: no terminal core answers. */
  close(): void {
    this.server?.close();
    for (const c of this.conns) c.destroy();
  }

  set(...terms: FakeTerminal[]): void {
    this.terms = terms;
  }

  setText(addr: string, text: string): void {
    this.text.set(addr, text);
  }

  setPaint(addr: string, fn: (history: number) => Buffer | null): void {
    this.paint.set(addr, fn);
  }

  private async serve(c: Socket): Promise<void> {
    const r = new Reader(c);
    await r.line(1 << 20);
    c.write(
      '{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"},"methods":[],"features":[]}}\n',
    );
    const write = (b: Buffer) => {
      if (!c.destroyed) c.write(b);
    };
    const chans = new Map<number, Channel>();
    c.on('close', () => {
      for (const ch of chans.values()) ch.close();
    });
    const next = { id: 0 };
    for (let f = await readFrame(r); f; f = await readFrame(r)) {
      if (f.channel !== 0) {
        const ch = chans.get(f.channel);
        if (!ch) continue;
        if (f.kind === Kind.Credit) ch.add(f.payload.readUInt32LE(0));
        else if (f.kind === Kind.Close) ch.close();
        continue;
      }
      let req: { id?: number; method: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(f.payload.toString('utf8'));
      } catch {
        continue;
      }
      if (req.id === undefined || req.id === null) continue;
      const reply = (body: object) =>
        write(encodeFrame(0, Kind.Data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }))));
      const failure = (kind: string) => reply({ error: { code: -32000, message: kind, data: { kind } } });
      const p = req.params ?? {};
      switch (req.method) {
        case 'terminal.list':
          this.lists++;
          reply({ result: { terminals: this.terms, hidden_finished: 0, machines: [] } });
          break;
        case 'terminal.read': {
          this.reads.push(p);
          const text = this.text.get(p.terminal as string);
          if (text !== undefined) reply({ result: { text, complete: true, how: 'screen' } });
          else failure('not_found');
          break;
        }
        case 'terminal.attach': {
          const a = p as unknown as Attach;
          this.attaches.push(a);
          const rec = this.terms.find((t) => t.address === a.terminal);
          if (!rec) failure('not_found');
          else if (this.unavailable.has(a.terminal)) failure('unavailable');
          else this.attach(write, rec, a, next, chans, reply);
          break;
        }
        default:
          reply({ error: { code: -32601, message: 'no method' } });
      }
    }
  }

  /** Answers an attach of terminal rec and streams what the core would send
   * for it. */
  private attach(
    write: (b: Buffer) => void,
    rec: FakeTerminal,
    p: Attach,
    next: { id: number },
    chans: Map<number, Channel>,
    reply: (body: object) => void,
  ): void {
    const id = ++next.id;
    const ch = new Channel();
    chans.set(id, ch);
    const addr = rec.address;
    const chunk = this.chunk;
    const after = this.after.get(addr) ?? Buffer.alloc(0);
    const grid: [number, number] = [rec.cols, rec.rows];
    const fn = this.paint.get(addr);
    let data = fn ? fn(p.history ?? 0) : null;
    const rg = this.regrid.get(addr);
    // The core resizes nothing to the grid it has.
    const resized = data !== null && !!rg && !(rg.grid?.[0] === grid[0] && rg.grid?.[1] === grid[1]) && take(rg);
    let answered = { ...rec };
    let newGrid = grid;
    if (resized) {
      // The new grid is the terminal's from now on; the reply's record,
      // read after the paint was queued, has it when the resize came before
      // any byte was sent. The next resize goes back to the grid before.
      newGrid = rg!.grid!;
      rg!.grid = grid;
      rec.cols = newGrid[0];
      rec.rows = newGrid[1];
      if (rg!.cut === 0) answered = { ...rec };
    }
    reply({ result: { channel: id, terminal: answered, resize_notifications: true, automatic_input: false } });
    const stream = (g: [number, number] | null, d: Buffer) => this.stream(write, id, ch, g, d, chunk);
    if (data === null) {
      // Dropped: the grid goes with the first output, if any.
      if (after.length > 0) void stream(grid, after);
      return;
    }
    data = Buffer.concat([data, after]);
    const repaint = () => Buffer.concat([fn!(0) ?? Buffer.alloc(0), after]);
    const bh = this.behind.get(addr);
    if (resized && rg!.cut === 0) {
      // The grid and the paint were not sent yet: both are replaced.
      void stream(newGrid, repaint());
    } else if (resized) {
      const cut = rg!.cut;
      const whole = data;
      void (async () => {
        if (await stream(grid, whole.subarray(0, cut))) await stream(newGrid, repaint());
      })();
    } else if (take(bh)) {
      const cut = bh!.cut;
      const whole = data;
      void (async () => {
        if (await stream(grid, whole.subarray(0, cut))) await stream(null, repaint());
      })();
    } else void stream(grid, data);
  }

  /** Sends a resize notification of grid (when given) and data in chunks as
   * the credit allows; false once the channel closed. */
  private async stream(
    write: (b: Buffer) => void,
    id: number,
    ch: Channel,
    grid: [number, number] | null,
    data: Buffer,
    chunk: number,
  ): Promise<boolean> {
    if (grid && grid[0] > 0) {
      const p = Buffer.alloc(4);
      p.writeUInt16LE(grid[0], 0);
      p.writeUInt16LE(grid[1], 2);
      write(encodeFrame(id, Kind.Resize, p));
    }
    let off = 0;
    while (off < data.length) {
      const n = await ch.take(Math.min(chunk, data.length - off));
      if (n === 0) return false;
      write(encodeFrame(id, Kind.Data, data.subarray(off, off + n)));
      off += n;
    }
    return true;
  }
}
