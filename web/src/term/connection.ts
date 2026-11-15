import { decodeFrame, encodeFrame, frameGrid, FRAME_AUTOMATIC, FRAME_DATA, TermError } from './protocol';

/** What a stream delivers to the pane that attached it, in the order the core sent it. */
export interface StreamHandler {
  output(data: Uint8Array): void;
  resized?(cols: number, rows: number): void;
  /** The stream is over: the program's end (exited, killed, ...) or "disconnected". */
  closed(reason: string, exitCode?: number): void;
}

/** What a viewer tells the terminal core about itself: the colors (as
 * `#rrggbb`) and cell size (pixels) the core answers programs' queries
 * with (OSC 10/11, `CSI ? 996 n`, size reports). The core answers those
 * itself and keeps them from the viewer, so without them programs see its
 * defaults (a dark background). */
export interface Display {
  fg?: string;
  bg?: string;
  cursor?: string;
  cell?: [number, number];
}

export interface AttachOptions {
  machine: string;
  terminal: string;
  cols: number;
  rows: number;
  /** Lines above the screen the first paint brings. */
  history?: number;
  observe?: boolean;
  /** Sent unless observing. */
  display?: Display;
}

/** The part of WebSocket the connection uses, so tests can supply their own. */
export interface Socket {
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

type Reply = { resolve: (v: Record<string, unknown>) => void; reject: (e: TermError) => void };

/**
 * A connection to the core's terminal protocol. It reconnects by itself and
 * subscribes again; streams end with the connection they were opened on and
 * are attached again by their owners.
 */
export class TermConnection {
  /** A text message a store may hold (backend, snapshot, event). */
  onMessage: (msg: Record<string, unknown>) => void = () => {};
  /** The connection came (true) or went (false). */
  onConnection: (up: boolean) => void = () => {};

  private socket: Socket | null = null;
  private up = false;
  private closed = false;
  private rid = 1;
  private retry = 500;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly replies = new Map<number, Reply>();
  private readonly attaching = new Map<number, StreamHandler>();
  private readonly streams = new Map<number, StreamHandler>();
  private readonly machines = new Set<string>();

  constructor(private readonly open: () => Socket) {}

  /** A connection to the core that served the page. */
  static toCore(): TermConnection {
    const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/term`;
    return new TermConnection(() => new WebSocket(url()) as unknown as Socket);
  }

  get connected(): boolean {
    return this.up;
  }

  start(): void {
    if (this.socket || this.closed) return;
    const socket = this.open();
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.up = true;
      this.retry = 500;
      for (const m of this.machines) this.send({ t: 'sub', m });
      this.onConnection(true);
    };
    socket.onclose = () => {
      if (socket === this.socket) this.dropped();
    };
    socket.onmessage = (ev) => {
      if (socket !== this.socket) return;
      if (typeof ev.data === 'string') this.text(ev.data);
      else this.binary(ev.data as ArrayBuffer);
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (this.up) this.dropped();
  }

  private dropped(): void {
    this.socket = null;
    const wasUp = this.up;
    this.up = false;
    const waiting = [...this.replies.values()];
    const open = [...this.streams.values()];
    this.replies.clear();
    this.attaching.clear();
    this.streams.clear();
    for (const r of waiting) r.reject(new TermError('unavailable'));
    for (const s of open) s.closed('disconnected');
    if (wasUp) this.onConnection(false);
    if (this.closed) return;
    this.timer = setTimeout(() => this.start(), this.retry);
    this.retry = Math.min(this.retry * 2, 8000);
  }

  private send(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private binary(data: ArrayBuffer): void {
    const frame = decodeFrame(data);
    const handler = frame && this.streams.get(frame.stream);
    if (!frame || !handler) return;
    if (frame.kind === FRAME_DATA) handler.output(frame.payload);
    else {
      const grid = frameGrid(frame);
      if (grid) handler.resized?.(grid.cols, grid.rows);
    }
  }

  private text(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const rid = typeof msg.rid === 'number' ? msg.rid : 0;
    switch (msg.t) {
      case 'res': {
        this.attaching.delete(rid);
        const reply = this.replies.get(rid);
        this.replies.delete(rid);
        const error = msg.error as { kind?: string; message?: string } | undefined;
        if (error) reply?.reject(new TermError(error.kind ?? '', error.message ?? ''));
        else reply?.resolve((msg.result ?? {}) as Record<string, unknown>);
        break;
      }
      case 'attached': {
        // Registered here, before the stream's first frame is read.
        const handler = this.attaching.get(rid);
        this.attaching.delete(rid);
        if (handler && typeof msg.s === 'number') this.streams.set(msg.s, handler);
        const reply = this.replies.get(rid);
        this.replies.delete(rid);
        reply?.resolve(msg);
        break;
      }
      case 'closed': {
        const id = msg.s as number;
        const handler = this.streams.get(id);
        this.streams.delete(id);
        handler?.closed(String(msg.reason ?? ''), typeof msg.exit_code === 'number' ? msg.exit_code : undefined);
        break;
      }
      default:
        this.onMessage(msg);
    }
  }

  subscribe(machine: string): void {
    if (this.machines.has(machine)) return;
    this.machines.add(machine);
    if (this.up) this.send({ t: 'sub', m: machine });
  }

  unsubscribe(machine: string): void {
    if (!this.machines.delete(machine)) return;
    if (this.up) this.send({ t: 'unsub', m: machine });
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.up) return Promise.reject(new TermError('unavailable'));
    const rid = this.rid++;
    return new Promise((resolve, reject) => {
      this.replies.set(rid, { resolve, reject });
      this.send({ ...msg, rid });
    });
  }

  /** Calls a method of the machine's terminal core. */
  call(machine: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.request({ t: 'call', m: machine, method, params });
  }

  /** Attaches to a terminal and resolves with the stream's number. */
  async attach(o: AttachOptions, handler: StreamHandler): Promise<number> {
    if (!this.up) throw new TermError('unavailable');
    const rid = this.rid; // the one request() takes next
    this.attaching.set(rid, handler);
    const msg = await this.request({
      t: 'attach',
      m: o.machine,
      terminal: o.terminal,
      cols: o.cols,
      rows: o.rows,
      history: o.history ?? 0,
      observe: o.observe ?? false,
      ...(o.display && !o.observe ? { display: o.display } : {}),
    });
    if (typeof msg.s !== 'number') throw new TermError('unavailable');
    return msg.s;
  }

  write(stream: number, data: Uint8Array, automatic = false): void {
    if (this.streams.has(stream)) this.socket?.send(encodeFrame(stream, automatic ? FRAME_AUTOMATIC : FRAME_DATA, data));
  }

  /** Returns the credit of output bytes the terminal has drawn. */
  ack(stream: number, count: number): void {
    if (count > 0 && this.streams.has(stream)) this.send({ t: 'ack', s: stream, n: count });
  }

  resize(stream: number, cols: number, rows: number): void {
    if (this.streams.has(stream)) this.send({ t: 'resize', s: stream, cols, rows });
  }

  /** Tells the core this viewer's display changed (a theme or font change). */
  facts(stream: number, display: Display): void {
    if (this.streams.has(stream)) this.send({ t: 'facts', s: stream, display });
  }

  focus(stream: number, focused: boolean): void {
    if (this.streams.has(stream)) this.send({ t: 'focus', s: stream, focused });
  }

  detach(stream: number): void {
    if (this.streams.delete(stream)) this.send({ t: 'detach', s: stream });
  }
}
