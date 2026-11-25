// What the fake coding agents share: newline-delimited JSON-RPC on the
// standard input and output, a cancellable wait. They are compiled with
// `bun build --compile` (scripts/e2e.sh) and use Node's modules only.

import { createInterface } from 'node:readline';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: Json };

/** One JSON-RPC message as it came, the fields the fakes read. */
export interface Message {
  id?: Json;
  method?: string;
  params?: Json;
  result?: Json;
  error?: Json;
}

/** Writes a message on one line of the standard output. */
export function send(m: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(m) + '\n');
}

/** Calls handle for each JSON object read from the standard input, one
 * per line; when the input closes the process ends, with whatever runs. */
export function serve(handle: (m: Message) => void): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m && typeof m === 'object' && !Array.isArray(m)) handle(m as Message);
  });
  lines.on('close', () => process.stdout.write('', () => process.exit(0)));
}

/** A signal a turn waits on: fired once (cancel, interrupt). */
export class Signal {
  fired = false;
  readonly wait: Promise<void>;
  private resolve!: () => void;
  constructor() {
    this.wait = new Promise((r) => (this.resolve = r));
  }
  fire(): void {
    this.fired = true;
    this.resolve();
  }
}

/** The key of a request id, as the wire spells it. */
export const idKey = (id: Json | undefined): string => JSON.stringify(id ?? null);

/** Whether the message carries an id (a request or a response). */
export const hasID = (m: Message): boolean => m.id !== undefined && m.id !== null;

/** The params as an object (empty when they are not one). */
export function paramsOf(m: Message): Obj {
  return m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params : {};
}

/** A string field of an object, '' when it is missing or not a string. */
export const str = (o: Obj, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');

/** Requests of the fake's own: their ids and the results they wait for. */
export class Requests {
  private next: number;
  private readonly pending = new Map<string, (r: Json) => void>();
  constructor(first: number) {
    this.next = first;
  }

  /** Sends a request (msg adds the members each protocol needs) and waits
   * for its result; undefined when stop fires first. */
  async call(method: string, params: Obj, stop: Signal, extra: Record<string, unknown> = {}): Promise<Json | undefined> {
    const id = this.next++;
    const got = new Promise<Json>((r) => this.pending.set(idKey(id), r));
    send({ ...extra, id, method, params });
    const r = await Promise.race([got, stop.wait.then(() => undefined)]);
    this.pending.delete(idKey(id));
    return r;
  }

  /** Hands a response to the request it answers. */
  answer(m: Message): void {
    const k = idKey(m.id);
    const r = this.pending.get(k);
    this.pending.delete(k);
    r?.(m.result ?? null);
  }
}
