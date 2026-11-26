// The terminals of a machine's terminal core that clients see, for typing
// the variables of the machine's virtual display into their shells
// (program windows, feature 14): which shells wait at their prompt, and
// typing as a viewer of the terminal's own size, so typing changes no
// viewer's size. Hidden terminals and other machines' are none: nothing is
// asked about them and nothing typed into them.
import { HCError, type Conn } from '#shared/proto/hc/index.ts';
import type { Backend } from './backend.ts';
import { goQuote } from './messages.ts';
import { hiddenRecord, isObject, otherMachine, type Rec } from './records.ts';

export interface Shells {
  /** Every live terminal, sorted. */
  all(): string[];
  /** The pid of the terminal's shell (0 when it has none) and whether it
   * waits at its prompt: an interactive shell is its own process group, in
   * the foreground while it reads a command line. */
  shell(addr: string, signal?: AbortSignal): Promise<{ pid: number; idle: boolean }>;
  /** Types text into the terminal. */
  send(addr: string, text: string, signal?: AbortSignal): Promise<void>;
}

const notFound = (addr: string) => new HCError(-32000, `no terminal ${goQuote(addr)}`, 'not_found', '');

/** The shells of a backend's terminals. */
export function shells(b: Backend): Shells {
  // The record now: its foreground is read about twice a second, so the
  // backend's may be older. One that is hidden by now (its event has not
  // reached the backend yet) is none either.
  const get = async (addr: string, signal?: AbortSignal): Promise<{ conn: Conn; rec: Rec & { address: string } }> => {
    const conn = b.connection();
    if (!conn) throw new Error('the terminal core is not connected');
    const local = b.localTarget(addr);
    if (local === null) throw notFound(addr);
    const rec = await conn.call<unknown>('terminal.get', { terminal: local }, { signal });
    if (!isObject(rec) || typeof rec.address !== 'string' || !rec.address) throw notFound(addr);
    if (otherMachine(rec.address) || hiddenRecord(rec) || b.isHidden(rec.address)) throw notFound(addr);
    return { conn, rec: rec as Rec & { address: string } };
  };
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    all: () => b.live(),
    async shell(addr, signal) {
      const { rec } = await get(addr, signal);
      if (rec.state !== 'live' || typeof rec.pid !== 'number') return { pid: 0, idle: false };
      const fg = isObject(rec.foreground) ? rec.foreground : null;
      return { pid: rec.pid, idle: fg?.pid === rec.pid };
    },
    async send(addr, text, signal) {
      const { conn, rec } = await get(addr, signal);
      // The terminal the record is, by its address.
      const { stream, attached } = await conn.attach(
        { terminal: rec.address, cols: Math.max(num(rec.cols), 1), rows: Math.max(num(rec.rows), 1), resumed: true },
        { signal },
      );
      try {
        if (hiddenRecord(attached.terminal)) throw notFound(addr);
        stream.write(Buffer.from(text));
      } finally {
        stream.close();
      }
    },
  };
}
