// Port forwards: a service that listens on a machine's loopback, reachable
// on the hub host's loopback as ssh -L makes it. A forward listens on a
// loopback port of the hub's host, on both loopback addresses, and
// carries each connection to the machine's port through its agent (the
// dial action), so a page of the UI on the hub's host can show the
// service in a browser pane under http://localhost:<port>.
//
// The listeners are on loopback only and exist only while their forward
// does: the Forwards own them, and a forward ends when it is stopped,
// unused for the idle time (reap), its machine removed, the feature
// turned off, its listener failed for good, or the Forwards closed (the
// hub stopped); its connections end with it. At most maxForwards
// forwards, maxConns connections each.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import type { Logger } from '#shared/lib/log.ts';
import { other } from '#shared/host/loopback.ts';
import { Fail } from '#kernel/fail.ts';

/** A forward as clients see it: port on machine m is reachable on the hub
 * host's loopback port local. */
export interface Forward {
  m: string;
  port: number;
  local: number;
  /** RFC 3339, as Go's time.Time. */
  created: string;
  connections: number;
}

/** A connection to a machine's port: what its agent sends comes from
 * readable, what is written to writable goes there; close ends it. */
export interface Dialed {
  readable: Readable;
  writable: Writable;
  close(): void;
}

export const MAX_FORWARDS = 32;
export const MAX_CONNS = 128;

export interface ForwardsOptions {
  /** Connects to port of machine m through its agent; the connection ends
   * with signal. */
  dial: (m: string, port: number, signal: AbortSignal) => Promise<Dialed>;
  logger: Logger;
  now?: () => number;
  maxForwards?: number;
  maxConns?: number;
  /** How often at most the bytes a forward carries are noted as a use. */
  useEveryMs?: number;
  /** Listens on the hub host's loopback (listenLoopback). */
  listen?: (pref: number) => Promise<Listening>;
}

export interface Listening {
  servers: Server[];
  local: number;
}

/** Listens on host and port, a loopback address, with a server of its own. */
function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer({ pauseOnConnect: false });
    s.once('error', reject);
    s.listen({ host, port, ipv6Only: host.includes(':'), exclusive: true }, () => {
      s.off('error', reject);
      resolve(s);
    });
  });
}

/** Listens on the hub host's loopback, on port pref when it is free (so
 * the page's address is the one the service expects), else on one the
 * system picks. The same port is taken on ::1, where "localhost" may lead
 * first: a port whose ::1 side another program holds, or that cannot be
 * taken for any other reason, is not used, since a browser could then
 * reach another program in the forward's stead. Only a host without IPv6
 * loopback listens on 127.0.0.1 alone. Ports below 1024 are the system's
 * to give: never asked for. */
export async function listenLoopback(pref: number): Promise<Listening> {
  const attempt = async (port: number): Promise<Listening> => {
    const l4 = await listenOn('127.0.0.1', port);
    const local = (l4.address() as AddressInfo).port;
    const o = await other(l4.address(), listenOn);
    if (o.other) return { servers: [l4, o.other], local };
    if (o.owned) return { servers: [l4], local };
    l4.close();
    throw o.err ?? new Error("the other loopback address of the port is not this program's");
  };
  if (pref >= 1024) {
    try {
      return await attempt(pref);
    } catch {
      // another port
    }
  }
  let err: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      return await attempt(0);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

/** Whether a listener's failure may pass: the process or the system is out
 * of descriptors for now, or a connection ended before it was accepted
 * (the runtime accepts again by itself). */
export function temporary(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EMFILE' || code === 'ENFILE' || code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

class Entry {
  readonly m: string;
  readonly port: number;
  readonly local: number;
  readonly servers: Server[];
  readonly created: Date;
  /** When the forward was last used (ms). */
  used: number;
  conns = 0;
  readonly sockets = new Set<Socket>();
  /** Ends with the forward: its dials and connections end with it. */
  readonly ac = new AbortController();

  constructor(m: string, port: number, l: Listening, now: number) {
    this.m = m;
    this.port = port;
    this.local = l.local;
    this.servers = l.servers;
    this.created = new Date(now);
    this.used = now;
  }

  public(): Forward {
    return { m: this.m, port: this.port, local: this.local, created: formatRFC3339(this.created), connections: this.conns };
  }

  /** Ends the listeners and the connections. */
  end(): void {
    this.ac.abort();
    for (const s of this.servers) s.close();
    for (const s of this.sockets) s.destroy();
  }
}

const key = (m: string, port: number) => `${m}\n${port}`;

interface PendingForward {
  m: string;
  port: number;
  cancel: AbortController;
  result: Promise<Entry>;
}

export class Forwards {
  private readonly o: ForwardsOptions;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  /** Forwards being made: a second ask waits for the first. */
  private readonly making = new Map<string, PendingForward>();
  private closed = false;

  constructor(o: ForwardsOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** The forward of port on machine m, made if there is none yet; it counts
   * as a use. Fails too_many beyond maxForwards, listen when no port can
   * be taken. */
  async ensure(m: string, port: number): Promise<Forward> {
    const k = key(m, port);
    // One forward per port: a second ask waits for the one being made, and
    // makes it itself only when that failed.
    for (let pending = this.making.get(k); pending; pending = this.making.get(k)) {
      await pending.result.catch(() => undefined);
      if (pending.cancel.signal.aborted) throw new Fail('listen', 400, 'the forward was stopped');
    }
    const have = this.entries.get(k);
    if (have) {
      have.used = this.now();
      return have.public();
    }
    if (this.closed) throw new Fail('listen', 400, 'the hub is stopping');
    const max = this.o.maxForwards ?? MAX_FORWARDS;
    if (this.entries.size + this.making.size >= max) throw new Fail('too_many', 400, `at most ${max} forwards`);
    const cancel = new AbortController();
    const result = this.make(m, port, cancel.signal);
    this.making.set(k, { m, port, cancel, result });
    try {
      const entry = await result;
      if (cancel.signal.aborted) throw new Fail('listen', 400, 'the forward was stopped');
      return entry.public();
    } finally {
      this.making.delete(k);
    }
  }

  private async make(m: string, port: number, signal: AbortSignal): Promise<Entry> {
    let l: Listening;
    try {
      l = await (this.o.listen ?? listenLoopback)(port);
    } catch (e) {
      throw new Fail('listen', 400, e instanceof Error ? e.message : String(e));
    }
    if (signal.aborted) {
      for (const s of l.servers) s.close();
      throw new Fail('listen', 400, 'the forward was stopped');
    }
    const f = new Entry(m, port, l, this.now());
    this.entries.set(key(m, port), f);
    for (const s of l.servers) {
      s.on('connection', (sock) => this.accept(f, sock));
      // A failure that passes is the runtime's to retry; any other ends the
      // forward, which would else stay listed with a listener nobody serves.
      s.on('error', (err) => {
        if (temporary(err)) return;
        if (this.closeWhere((x) => x === f) > 0) this.o.logger(`browser: the forward of port ${f.port} of ${f.m} ended: ${err.message}`);
      });
    }
    return f;
  }

  /** The forwards, by machine and port. */
  list(): Forward[] {
    return [...this.entries.values()].sort((a, b) => (a.m !== b.m ? (a.m < b.m ? -1 : 1) : a.port - b.port)).map((f) => f.public());
  }

  /** Ends the forwards match picks; how many. */
  closeWhere(match: (f: { m: string; port: number; used?: number }) => boolean): number {
    let cancelled = 0;
    for (const [k, pending] of this.making) {
      if (!pending.cancel.signal.aborted && match(pending)) {
        pending.cancel.abort();
        if (!this.entries.has(k)) cancelled++;
      }
    }
    const gone = [...this.entries].filter(([, f]) => match(f));
    for (const [k, f] of gone) {
      this.entries.delete(k);
      f.end();
    }
    return gone.length + cancelled;
  }

  /** Ends the forward of port on machine m; whether there was one. */
  stop(m: string, port: number): boolean {
    return this.closeWhere((f) => f.m === m && f.port === port) > 0;
  }

  /** Ends the forwards unused for idleMs (0: none), and all of them while
   * off. A forward's open connections do not keep it: one that carried
   * nothing for that long ends with it, so a program that holds a
   * connection open cannot keep a way into the machine. */
  reap(idleMs: number, off = false): void {
    const now = this.now();
    this.closeWhere((f) => off || (idleMs > 0 && f.used !== undefined && now - f.used > idleMs));
  }

  /** Ends every forward and makes no more. */
  close(): void {
    this.closed = true;
    this.closeWhere(() => true);
  }

  /** The forward of port on machine m, for tests. */
  entry(m: string, port: number): { readonly used: number; readonly conns: number; readonly servers: Server[] } | undefined {
    return this.entries.get(key(m, port));
  }

  private accept(f: Entry, sock: Socket): void {
    if (f.ac.signal.aborted || f.conns >= (this.o.maxConns ?? MAX_CONNS)) {
      sock.destroy();
      return;
    }
    f.conns++;
    f.used = this.now();
    f.sockets.add(sock);
    sock.once('close', () => {
      f.conns--;
      f.sockets.delete(sock);
    });
    sock.on('error', () => {});
    void this.carry(f, sock);
  }

  /** Connects sock to the forward's port on its machine and copies both
   * ways until either side ends, or the forward does. */
  private async carry(f: Entry, sock: Socket): Promise<void> {
    let d: Dialed;
    try {
      d = await this.o.dial(f.m, f.port, f.ac.signal);
    } catch {
      sock.destroy();
      return;
    }
    if (sock.destroyed) return d.close();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      sock.destroy();
      d.close();
    };
    // Bytes carried are a use of the forward, noted at most every
    // useEveryMs: a clock reading and a comparison for a chunk.
    const every = this.o.useEveryMs ?? 1000;
    const note = () => {
      const now = this.now();
      if (now - f.used >= every) f.used = now;
    };
    for (const s of [sock, d.readable, d.writable]) s.on('error', end).once('close', end);
    sock.once('end', end);
    d.readable.once('end', end);
    sock.on('data', note);
    d.readable.on('data', note);
    sock.pipe(d.writable, { end: false });
    d.readable.pipe(sock, { end: false });
  }
}
