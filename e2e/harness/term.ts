// A client of the core's terminal protocol (/api/v1/term) for checks the
// page draws on a canvas: the terminals' records, their screens and the
// layout document. Reads only, as a test's observer.

import { waitFor } from './wait';

export type TerminalRecord = Record<string, unknown> & { address: string; state?: string; name?: string };

type Msg = Record<string, unknown> & { t: string };

export class TermClient {
  private ws: WebSocket;
  private rid = 0;
  private waiting = new Map<number, (m: Msg) => void>();
  private opened: Promise<void>;
  private ready: Promise<void>;
  private onReady = () => {};

  constructor(baseURL: string) {
    this.ws = new WebSocket(baseURL.replace(/^http/, 'ws') + '/api/v1/term');
    this.ready = new Promise((resolve) => (this.onReady = resolve));
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener(
        'open',
        () => {
          this.ws.send(JSON.stringify({ t: 'sub', m: 'local' }));
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener('error', () => reject(new Error('terminal protocol: connection failed')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data) as Msg;
      if (m.t === 'backend' && m.state === 'ready') this.onReady();
      if (m.t === 'res' && typeof m.rid === 'number') {
        this.waiting.get(m.rid)?.(m);
        this.waiting.delete(m.rid);
      }
    });
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, m = 'local'): Promise<T> {
    await this.opened;
    await this.ready;
    const rid = ++this.rid;
    const res = await new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 15_000);
      this.waiting.set(rid, (x) => {
        clearTimeout(timer);
        resolve(x);
      });
      this.ws.send(JSON.stringify({ t: 'call', rid, m, method, params }));
    });
    const err = res.error as { kind?: string; message?: string } | undefined;
    if (err) throw new Error(`${method}: ${err.kind} ${err.message ?? ''}`);
    return res.result as T;
  }

  async terminals(): Promise<TerminalRecord[]> {
    const r = await this.call<{ terminals?: TerminalRecord[] } | TerminalRecord[]>('terminal.list');
    return (Array.isArray(r) ? r : r.terminals) ?? [];
  }

  async live(): Promise<TerminalRecord[]> {
    return (await this.terminals()).filter((t) => t.state === 'live');
  }

  /** The screen of a terminal as text. */
  async screen(terminal: string): Promise<string> {
    const r = await this.call<{ text?: string }>('terminal.read', { terminal });
    return r.text ?? '';
  }

  /** Waits until the screen of the terminal matches. */
  async waitScreen(terminal: string, re: RegExp, timeout = 10_000): Promise<string> {
    let last = '';
    try {
      return await waitFor(
        async () => {
          last = await this.screen(terminal);
          return re.test(last) ? last : '';
        },
        { what: `${re} on ${terminal}`, timeout },
      );
    } catch (e) {
      throw new Error(`${(e as Error).message}\nscreen:\n${last}`);
    }
  }

  /** The machine's layout document. */
  async layout(): Promise<Layout> {
    const r = await this.call<{ value?: Layout; doc?: Layout } & Layout>('doc.get', { name: 'layout' });
    return (r.value ?? r.doc ?? r) as Layout;
  }

  close() {
    this.ws.close();
  }
}

export interface LayoutTab {
  name?: string;
  pinned?: boolean;
  root?: unknown;
  [k: string]: unknown;
}
export interface Layout {
  workspaces?: { name?: string; cwd?: string; tabs?: LayoutTab[]; [k: string]: unknown }[];
  [k: string]: unknown;
}

/** The terminal addresses of a layout node, in order. */
export function leafTerminals(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.children)) return n.children.flatMap(leafTerminals);
  return typeof n.terminal === 'string' ? [n.terminal] : [];
}
