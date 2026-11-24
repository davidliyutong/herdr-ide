// A page's WebSocket (wire.ts): its subscriptions, each a connection of its
// own to a machine's chat host that carries the chat's events and the
// page's commands, and the messages it is sent, in order.
//
// What waits to be sent to a page is bounded (Limits.backlog*). The events
// of its subscriptions share half of it: a subscription over its share is
// not read from the chat host until the page took enough of them, and the
// host, whose own bound for a connection that falls behind is reached then,
// drops that connection (the page hears lost and attaches again from its
// last sequence number), while the page's other chats go on. The core's own
// messages (answers to attaches and commands, ends of subscriptions) take
// the rest: a page that falls that far behind is disconnected (1013, try
// again later), and so is one that takes nothing for Timing.pageWriteMs.
import * as chat from '#shared/proto/chatproto/index.ts';
import type { AuditFields } from '#kernel/audit.ts';
import { CloseCode, type Channel, type ChannelHandlers, type Message } from '#kernel/channel.ts';
import { auditOf, auditText, type AuditRecord } from './audit.ts';
import { asChatError, statusOf, TIMEOUT } from './errors.ts';
import { readError, type HostConn, type Response } from './hostconn.ts';
import type { ChatHub } from './hub.ts';
import type { Limits, Timing } from './timing.ts';
import {
  ack,
  attached,
  clientMessage,
  COMMAND_OPS,
  commandLine,
  CoreCode,
  detached,
  eventPrefix,
  MAX_CLIENT_MESSAGE,
  MAX_PAGE_ID,
  MAX_SUBS,
  MAX_SUBS_PER_MACHINE,
  type ClientMessage,
  type PageCommand,
} from './wire.ts';

/** Try again later: the page is too far behind. */
const TRY_AGAIN_LATER = 1013;

const bytes = (s: string) => Buffer.byteLength(s);

/** An id a page gives: present and at most MAX_PAGE_ID bytes. */
const pageID = (s: string) => s !== '' && bytes(s) <= MAX_PAGE_ID;

export interface PageDeps {
  hub: ChatHub;
  /** Writes an audit record of the page's user. */
  audit: (event: string, fields: AuditFields) => void;
  now: () => number;
  timing: Timing;
  limits: Limits;
}

/** A message waiting to be sent: an event of a subscription (sub), or one
 * of the core's own. */
interface Out {
  text: string;
  n: number;
  sub?: Sub;
}

export class ChatPage {
  readonly d: PageDeps;
  /** The subscriptions, by the page's id. */
  readonly subs = new Map<string, Sub>();
  private readonly ch: Channel;
  /** What waits to be sent, from head on; ctrlN and ctrlBytes count the
   * core's own messages among it. */
  private out: Out[] = [];
  private head = 0;
  private ctrlN = 0;
  private ctrlBytes = 0;
  /** closing: send what waits, then close with closeCode; closed: nothing
   * more is sent. */
  private closing = false;
  closed = false;
  private closeCode: number = CloseCode.GoingAway;
  private closeWhy = '';
  /** While the channel holds too much to take more: since when, and the
   * timer that looks again. */
  private blockedSince = 0;
  private poll: ReturnType<typeof setInterval> | undefined;
  /** Per audit event, when a refusal of it was last written and how many
   * came since. */
  private readonly refused = new Map<string, { at: number; n: number }>();

  constructor(ch: Channel, d: PageDeps) {
    this.ch = ch;
    this.d = d;
  }

  /** The channel's handlers; gone runs once the page ended. */
  handlers(gone: () => void): ChannelHandlers {
    return {
      message: (data) => this.message(data),
      close: () => {
        this.shut();
        gone();
      },
      drain: () => this.flush(),
    };
  }

  private message(data: Message): void {
    if (this.closed || typeof data !== 'string') return;
    if (bytes(data) > MAX_CLIENT_MESSAGE) return this.abort(CloseCode.TooBig, 'message too big');
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const r = clientMessage.safeParse(raw);
    if (!r.success) return;
    const m = r.data;
    switch (m.op) {
      case 'attach':
        return this.attach(m);
      case 'detach':
        return this.detach(m.sub);
      case 'command':
        return this.command(m);
    }
  }

  /** Ends the page: nothing more is sent, every subscription ends. */
  private shut(): void {
    this.closed = true;
    this.out = [];
    this.head = this.ctrlN = this.ctrlBytes = 0;
    this.unblocked();
    const subs = [...this.subs.values()];
    this.subs.clear();
    for (const s of subs) s.gone = true;
    for (const s of subs) s.abort();
  }

  /** Closes the channel now, dropping what waits. */
  private abort(code: number, why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.out = [];
    this.head = this.ctrlN = this.ctrlBytes = 0;
    this.unblocked();
    this.ch.close(code, why);
  }

  /** Ends every subscription, telling each the code (none for ""), sends
   * what waits and closes the channel: the feature was turned off, the core
   * stops. */
  finish(code: string): void {
    const subs = [...this.subs.values()];
    this.subs.clear();
    for (const s of subs) {
      s.gone = true;
      if (code) this.send(detached(s.id, { code, message: 'the chat plugin is off' }));
    }
    if (!this.closing && !this.closed) {
      this.closing = true;
      this.closeCode = CloseCode.GoingAway;
      this.closeWhy = code || 'the core stops';
      this.flush();
    }
    for (const s of subs) s.abort();
  }

  /** Queues a message of the core's own. */
  send(text: string): void {
    this.enqueue(text);
  }

  ack(id: string, e?: chat.ChatError): void {
    this.send(ack(id, e));
  }

  /** Queues text, an event of subscription sub or a message of the core's
   * own. Of the latter, a page that fell too far behind is disconnected
   * instead; a subscription's are bounded by its share (Sub.relay). */
  enqueue(text: string, sub?: Sub): void {
    if (this.closed || this.closing) return;
    const n = bytes(text);
    if (sub) {
      sub.queued += n;
      sub.queuedN++;
    } else {
      const { backlogMessages, backlogBytes } = this.d.limits;
      if (this.ctrlN >= Math.floor(backlogMessages / 2) || (this.ctrlN > 0 && this.ctrlBytes + n > Math.floor(backlogBytes / 2)))
        // What it missed it reads again when it attaches anew.
        return this.abort(TRY_AGAIN_LATER, 'too slow');
      this.ctrlN++;
      this.ctrlBytes += n;
    }
    this.out.push({ text, n, sub });
    this.flush();
  }

  /** How many messages and bytes of events one subscription may have
   * waiting: half of the backlog, split among the page's subscriptions. */
  share(): [number, number] {
    const n = Math.max(1, this.subs.size);
    const { backlogMessages, backlogBytes } = this.d.limits;
    return [Math.max(2, Math.floor(backlogMessages / (2 * n))), Math.max(64 << 10, Math.floor(backlogBytes / (2 * n)))];
  }

  /** Hands what waits to the channel, in order, while it takes it. */
  private flush(): void {
    if (this.closed) return;
    while (this.head < this.out.length) {
      if (this.ch.buffered >= this.d.limits.pageBuffered) return this.blocked();
      const e = this.out[this.head];
      this.out[this.head++] = undefined as unknown as Out;
      if (e.sub) {
        e.sub.queued -= e.n;
        e.sub.queuedN--;
        e.sub.room();
      } else {
        this.ctrlN--;
        this.ctrlBytes -= e.n;
      }
      this.ch.send(e.text);
      this.blockedSince = 0;
    }
    this.out = [];
    this.head = 0;
    this.unblocked();
    if (this.closing) {
      this.closed = true;
      this.ch.close(this.closeCode, this.closeWhy);
    }
  }

  /** The channel holds as much as it may: look again until it takes more,
   * or disconnect a page that took nothing for pageWriteMs. */
  private blocked(): void {
    if (this.head > 1024 && this.head * 2 > this.out.length) {
      this.out = this.out.slice(this.head);
      this.head = 0;
    }
    if (!this.blockedSince) this.blockedSince = Date.now();
    if (this.poll) return;
    const every = Math.max(1, Math.min(100, this.d.timing.pageWriteMs / 4));
    this.poll = setInterval(() => {
      if (Date.now() - this.blockedSince > this.d.timing.pageWriteMs) this.abort(TRY_AGAIN_LATER, 'too slow');
      else this.flush();
    }, every);
  }

  private unblocked(): void {
    this.blockedSince = 0;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private attach(m: ClientMessage): void {
    if (!pageID(m.sub)) return;
    const refuse = (code: string, message: string) => this.send(detached(m.sub, { code, message }));
    if (!pageID(m.m) || !chat.validChatID(m.chat)) return refuse(chat.Code.BadRequest, 'attach names a machine and a chat');
    if (this.closed || this.closing) return;
    // Attaching under an id the page has replaces that subscription.
    const old = this.subs.get(m.sub);
    if (old) {
      old.gone = true;
      this.subs.delete(m.sub);
    }
    let perMachine = 0;
    for (const s of this.subs.values()) if (s.m === m.m) perMachine++;
    if (this.subs.size >= MAX_SUBS || perMachine >= MAX_SUBS_PER_MACHINE) {
      old?.abort();
      return refuse(CoreCode.TooMany, 'the page has as many subscriptions as it may');
    }
    const s = new Sub(this, m.sub, m.m, m.chat, m.from);
    this.subs.set(m.sub, s);
    old?.abort();
    this.d.hub.watch.inUse(s.m, 1);
    void s.run();
  }

  private detach(id: string): void {
    const s = this.subs.get(id);
    if (!s) {
      if (pageID(id)) this.send(detached(id, { code: CoreCode.UnknownSub, message: 'no such subscription' }));
      return;
    }
    s.gone = true;
    this.subs.delete(id);
    s.abort();
  }

  private command(m: ClientMessage): void {
    if (!pageID(m.id)) return;
    const cmd = m.cmd;
    if (!cmd || !COMMAND_OPS.has(cmd.op)) return this.ack(m.id, { code: chat.Code.BadRequest, message: 'no command of the protocol' });
    if (!pageID(m.m) || !chat.validChatID(m.chat))
      // Nothing of it is audited: it names no chat.
      return this.ack(m.id, { code: chat.Code.BadRequest, message: 'a command names a machine and a chat' });
    let rec = auditOf(m.m, m.chat, cmd);
    if (this.d.hub.readOnly) {
      const e = { code: CoreCode.ReadOnly, message: 'read-only mode' };
      rec ??= { event: `chat.${cmd.op}`, fields: { plugin: 'chat', machine: m.m, chat: m.chat } };
      this.audit(rec, e);
      return this.ack(m.id, e);
    }
    let s: Sub | undefined;
    for (const c of this.subs.values())
      if (c.m === m.m && c.chat === m.chat) {
        s = c;
        break;
      }
    if (!s) return this.ack(m.id, { code: CoreCode.NotAttached, message: 'the page has no subscription to the chat' });
    const e = s.submit(m.id, cmd, rec);
    if (e) {
      this.audit(rec, e);
      this.ack(m.id, e);
    }
  }

  /** Writes a command's record with how it ended (e undefined: done). Of a
   * page's refusals of one operation, one is written per refusalGapMs;
   * those that come meanwhile are counted into the next one's member
   * repeated. */
  audit(rec: AuditRecord | undefined, e: chat.ChatError | undefined): void {
    if (!rec) return;
    const code = e ? auditText(e.code) : '';
    let repeated = 0;
    if (code) {
      const now = this.d.now();
      let r = this.refused.get(rec.event);
      if (r && now - r.at < this.d.timing.refusalGapMs) {
        r.n++;
        return;
      }
      if (!r) this.refused.set(rec.event, (r = { at: 0, n: 0 }));
      repeated = r.n;
      r.at = now;
      r.n = 0;
    }
    this.d.audit(rec.event, {
      ...rec.fields,
      status: statusOf(code),
      ...(code ? { error: code } : {}),
      ...(repeated > 0 ? { repeated } : {}),
    });
  }
}

/** A command that waits for its answer: the page's id of it, and the
 * record to write once it is answered. */
interface Pending {
  id: string;
  rec?: AuditRecord;
}

/** A page's subscription to a chat: a connection of its own to the chat
 * host, which carries the chat's events and the page's commands. */
export class Sub {
  readonly id: string;
  readonly m: string;
  readonly chat: string;
  private readonly from: number;
  private readonly page: ChatPage;
  private readonly ac = new AbortController();
  /** The page no longer has the subscription (detached, closed): nothing
   * more is sent of it. queued and queuedN are the bytes and the messages
   * of its events that wait to be sent to the page. */
  gone = false;
  queued = 0;
  queuedN = 0;
  /** The page took some of its events: set while nobody waits for it. */
  private roomTaken = false;
  private roomWake: (() => void) | null = null;
  /** The command lines to write to the host, and whether a write runs. */
  private readonly cmds: string[] = [];
  private writing = false;
  private conn: HostConn | undefined;
  /** The commands written or to be written, by the core's id; next numbers
   * them; ended: the subscription ended, commands are refused. */
  private pending = new Map<string, Pending>();
  private next = 0;
  private ended = false;

  constructor(page: ChatPage, id: string, m: string, chatID: string, from: number) {
    this.page = page;
    this.id = id;
    this.m = m;
    this.chat = chatID;
    this.from = from;
  }

  abort(): void {
    this.ac.abort();
  }

  /** The page took one of its events. */
  room(): void {
    if (this.roomWake) this.roomWake();
    else this.roomTaken = true;
  }

  /** Queues a command for the host under an id of the core's; an error
   * refuses it at once. */
  submit(id: string, cmd: PageCommand, rec: AuditRecord | undefined): chat.ChatError | undefined {
    if (this.ended) return { code: CoreCode.NotAttached, message: 'the subscription ended' };
    if (this.pending.size >= this.page.d.limits.maxPending)
      return { code: chat.Code.Busy, message: 'too many commands wait for their answer' };
    const core = `k${++this.next}`;
    let line: string;
    try {
      line = commandLine(cmd, core);
    } catch {
      return { code: chat.Code.BadRequest, message: 'the command does not encode' };
    }
    if (bytes(line) > chat.MAX_LINE + 1) return { code: chat.Code.TooLarge, message: 'a command longer than the protocol takes' };
    if (this.cmds.length >= this.page.d.limits.subCommands) return { code: chat.Code.Busy, message: 'too many commands wait to be sent' };
    this.cmds.push(line);
    this.pending.set(core, { id, rec });
    void this.write();
    return undefined;
  }

  /** Sends the commands to the host in order, once it is attached. */
  private async write(): Promise<void> {
    const c = this.conn;
    if (this.writing || !c) return;
    this.writing = true;
    try {
      while (this.cmds.length > 0 && !this.ac.signal.aborted) await c.write(this.cmds.shift()!);
    } catch {
      c.destroy();
    } finally {
      this.writing = false;
    }
  }

  /** Attaches to the chat and relays its events until the subscription or
   * the connection ends; then tells the page how it ended. */
  async run(): Promise<void> {
    let e: chat.ChatError | undefined;
    try {
      e = await this.relay();
    } catch (err) {
      e = asChatError(err);
    }
    this.ac.abort();
    this.ended = true;
    const pending = this.pending;
    this.pending = new Map();
    const pg = this.page;
    const gone = this.gone;
    if (!gone && pg.subs.get(this.id) === this) pg.subs.delete(this.id);
    e ??= pg.d.hub.isReady(this.m)
      ? { code: CoreCode.Lost, message: 'the connection to the chat host ended' }
      : { code: CoreCode.Offline, message: 'machine not connected' };
    if (!gone) pg.send(detached(this.id, e));
    const ackErr = gone ? { code: CoreCode.NotAttached, message: 'the page detached the subscription' } : e;
    for (const c of pending.values()) {
      pg.audit(c.rec, ackErr);
      pg.ack(c.id, ackErr);
    }
    pg.d.hub.watch.inUse(this.m, -1);
  }

  /** Attaches and relays; returns why the subscription ended, undefined
   * when the connection to the host ended (or the page ended it). */
  private async relay(): Promise<chat.ChatError | undefined> {
    const pg = this.page;
    const hub = pg.d.hub;
    const signal = this.ac.signal;
    // The connection lives with the subscription. A prompt on it may start
    // the chat's agent: the host takes the machine's settings first.
    let c: HostConn;
    try {
      c = await hub.connect(this.m, { start: true, agent: true, signal });
    } catch (e) {
      return signal.aborted ? undefined : asChatError(e);
    }
    this.conn = c;
    try {
      // A reader who may not change the chat starts nothing on the machine:
      // no catch-up of what its session did in a terminal.
      const readOnly = hub.readOnly;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        c.destroy();
      }, pg.d.timing.attachMs);
      let res: Response;
      try {
        res = await c.send({
          op: chat.Op.Attach,
          chat: this.chat,
          ...(this.from ? { from: this.from } : {}),
          ...(readOnly ? { noCatchUp: true } : {}),
        });
      } catch (e) {
        if (signal.aborted) return undefined;
        return timedOut ? TIMEOUT : asChatError(e);
      } finally {
        clearTimeout(timer);
      }
      const it = res.chat && readOnly ? chat.redactedChat(res.chat as unknown as chat.Chat) : (res.chat ?? undefined);
      if (!this.gone) pg.enqueue(attached(this.id, it, res.first ?? 0), this);
      void this.write();
      const prefix = eventPrefix(this.id);
      for (;;) {
        let line: Buffer;
        try {
          line = await c.readLine();
        } catch {
          return undefined;
        }
        if (line.length === 0 || line[0] !== 0x7b) continue;
        let text = line.toString('utf8');
        let head: Record<string, unknown>;
        try {
          head = JSON.parse(text);
        } catch {
          continue;
        }
        if (head.t === chat.EventType.Ack) {
          this.acked(typeof head.id === 'string' ? head.id : '', readError(head.error));
          continue;
        }
        if (readOnly && text.includes('"stderr"')) text = chat.line(chat.redactedEvent(head as unknown as chat.Event)).slice(0, -1);
        if (this.gone) continue;
        pg.enqueue(prefix + text + '}', this);
        const [n, b] = pg.share();
        if ((this.queuedN > n || this.queued > b) && !(await this.waitRoom())) return undefined;
      }
    } finally {
      c.close();
    }
  }

  /** Waits, reading nothing of the host, until the page took half of the
   * subscription's share of its events; false when the subscription ended
   * meanwhile. The host drops a connection that falls behind for long (the
   * page hears lost). */
  private async waitRoom(): Promise<boolean> {
    const signal = this.ac.signal;
    for (;;) {
      if (!this.roomTaken && !signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            signal.removeEventListener('abort', done);
            this.roomWake = null;
            resolve();
          };
          this.roomWake = done;
          signal.addEventListener('abort', done, { once: true });
        });
      this.roomTaken = false;
      if (signal.aborted || this.gone || this.page.closed) return false;
      const [n, b] = this.page.share();
      if (this.queuedN <= Math.floor(n / 2) && this.queued <= Math.floor(b / 2)) return true;
    }
  }

  /** Relays the host's answer to a command. */
  private acked(id: string, e: chat.ChatError | undefined): void {
    const c = this.pending.get(id);
    if (!c) return;
    this.pending.delete(id);
    this.page.audit(c.rec, e);
    this.page.ack(c.id, e);
  }
}
