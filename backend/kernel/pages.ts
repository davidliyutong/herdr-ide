// The pages connected to /ws, the event channel of the clients (the
// browser UI, the desktop app's page and shell): machines, program windows,
// agents, settings, keybindings, VS Code's bridge, downloads. Terminals
// have their own channel (/api/v1/term). Messages are JSON objects with a
// type t; what arrives is dispatched by t to whoever handles it.
import type { Logger } from '#shared/lib/log.ts';
import type { Audit, Who } from './audit.ts';
import { CloseCode, parseJSON, type Channel, type ChannelHandlers } from './channel.ts';
import type { Client } from './http/env.ts';

/** A message from a page: its type and what else it carries. */
export type Inbound = { t: string } & Record<string, unknown>;

export interface Page {
  readonly client: Client;
  /** Watchers: no reconnects, no theme changes. */
  readonly readOnly: boolean;
  readonly who: Who;
  send(msg: object): void;
  close(): void;
}

export interface PagesOptions {
  logger: Logger;
  audit: Audit;
  /** A page whose channel holds more than this many unsent bytes has missed
   * events: it is disconnected and reconnects to start from the current
   * state. */
  maxBuffered?: number;
  /** Bounds the idle time a page reports. */
  maxIdleMs?: number;
}

class PageImpl implements Page {
  readonly client: Client;
  readonly readOnly: boolean;
  readonly who: Who;
  /** When the user last used this page (ms); 0 before it reported. */
  active = 0;
  activeSeq = 0;
  private readonly ch: Channel;
  private readonly pages: Pages;
  private closed = false;

  constructor(ch: Channel, info: { client: Client; readOnly: boolean; who: Who }, pages: Pages) {
    this.ch = ch;
    this.client = info.client;
    this.readOnly = info.readOnly;
    this.who = info.who;
    this.pages = pages;
  }

  send(msg: object): void {
    this.sendText(JSON.stringify(msg));
  }

  sendText(text: string): void {
    if (this.closed) return;
    if (this.ch.buffered > this.pages.maxBuffered) {
      this.pages.options.logger('ws: client send queue overflow, disconnecting');
      this.close(CloseCode.Overflow);
      return;
    }
    this.ch.send(text);
  }

  close(code: number = CloseCode.Normal): void {
    if (this.closed) return;
    this.closed = true;
    this.ch.close(code);
  }
}

export class Pages {
  readonly options: PagesOptions;
  readonly maxBuffered: number;
  private readonly pages = new Set<PageImpl>();
  private readonly handlers = new Map<string, (p: Page, m: Inbound) => void>();
  private readonly openers: Array<(p: Page) => (() => void) | void> = [];
  private seq = 0;

  constructor(o: PagesOptions) {
    this.options = o;
    this.maxBuffered = o.maxBuffered ?? 8 << 20;
    this.on('ping', (p, m) => p.send({ t: 'pong', rid: m.rid }));
    this.on('active', (p, m) => this.markActive(p, typeof m.idle === 'number' ? m.idle : 0));
  }

  /** Handles the messages of type t. */
  on(t: string, fn: (p: Page, m: Inbound) => void): void {
    if (this.handlers.has(t)) throw new Error(`pages: ${t} is handled already`);
    this.handlers.set(t, fn);
  }

  /** Runs fn for each page that connects, after it is listed: it sends the
   * page what it starts from and may subscribe it to updates; what it
   * returns runs when the page goes. */
  onOpen(fn: (p: Page) => (() => void) | void): void {
    this.openers.push(fn);
  }

  /** Adopts a /ws channel. */
  connect(ch: Channel, info: { client: Client; readOnly: boolean; who: Who }): ChannelHandlers {
    const p = new PageImpl(ch, info, this);
    this.options.audit.log(p.who, 'ws.connect');
    this.pages.add(p);
    const cleanups: Array<() => void> = [];
    for (const open of this.openers) {
      const c = open(p);
      if (c) cleanups.push(c);
    }
    return {
      message: (data) => {
        const m = parseJSON(data);
        if (typeof m !== 'object' || m === null || typeof (m as Inbound).t !== 'string') return;
        const fn = this.handlers.get((m as Inbound).t);
        try {
          fn?.(p, m as Inbound);
        } catch (e) {
          this.options.logger(`ws: ${(m as Inbound).t}: ${(e as Error).message}`);
        }
      },
      close: () => {
        this.pages.delete(p);
        for (const c of cleanups) c();
        this.options.audit.log(p.who, 'ws.disconnect');
      },
    };
  }

  /** Sends msg to every page that to takes (all without to). */
  broadcast(msg: object, to?: (p: Page) => boolean): void {
    const text = JSON.stringify(msg);
    for (const p of this.pages) if (!to || to(p)) p.sendText(text);
  }

  /** Records that the user used page p idleMs ago. Pages report durations
   * rather than times, so their clocks do not matter. */
  markActive(p: Page, idleMs: number): void {
    const idle = Math.min(Math.max(idleMs, 0), this.options.maxIdleMs ?? 30 * 24 * 3600_000);
    const page = p as PageImpl;
    page.active = Date.now() - idle;
    page.activeSeq = ++this.seq;
  }

  /** The page that plays notification sounds: the one used most recently,
   * so that several open pages do not all sound. */
  soundPage(): Page | undefined {
    let best: PageImpl | undefined;
    for (const p of this.pages) if (!best || p.active > best.active || (p.active === best.active && p.activeSeq > best.activeSeq)) best = p;
    return best;
  }

  get size(): number {
    return this.pages.size;
  }
}
