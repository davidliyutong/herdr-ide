// One client of /api/v1/term: the machines it follows, its calls, and the
// streams it attached, whose output it gets as binary frames and returns
// credit for as it draws. Calls reach the terminal core only through the
// allowlist; terminals that are none of the clients' are answered as
// terminals that do not exist; a read-only client only observes.
import { isForeignRuntimeVar } from '#shared/lib/bunenv.ts';
import type { Logger } from '#shared/lib/log.ts';
import {
  HIDDEN_LABEL,
  isChatHostName,
  MAX_BODY,
  MAX_INLINE,
  Op,
  type Header,
  type TermEnvStageParams,
} from '#shared/proto/agentproto/index.ts';
import { HCError, type AttachParams, type Conn, type Output, type Stream } from '#shared/proto/hc/index.ts';
import type { Audit, AuditFields, Who } from '#kernel/audit.ts';
import { CloseCode, type Channel, type ChannelHandlers, type Message } from '#kernel/channel.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import type { Client } from '#kernel/http/env.ts';
import {
  addEnv,
  AUDITED_METHODS,
  envOf,
  isStringMap,
  readScreenOnly,
  READ_METHODS,
  ROUTING_PARAM,
  TARGET_PARAMS,
  WRITE_METHODS,
  type Params,
} from './allowlist.ts';
import { NotClients, type Backend, type ClientStream, type Subscriber } from './backend.ts';
import { Code, frame, FrameKind, goQuote, parseInbound, resizeFrame, type Inbound } from './messages.ts';
import { cleanRecord, hiddenRecord, isObject, otherMachine } from './records.ts';
import type { Timing } from './timing.ts';

export interface ClientDeps {
  machines: Machines;
  /** The backend of a machine, created on first use. */
  backend(id: string): Backend;
  audit: Audit;
  logger: Logger;
  readOnly: boolean;
  /** The variables of the machine's virtual display for new terminals
   * (feature 14); they replace the client's. */
  paneEnv(m: Machine): Record<string, string> | undefined;
  /** The variables of the machine's ssh session for new terminals
   * (sshenv.ts); the client's own stay. */
  sshEnv(m: Machine): Record<string, string> | null;
  /** Optional vault preset environment variables for a workspace's new
   * terminals; names only are audited, never values. */
  workspaceEnv?(
    m: Machine,
    workspace: string,
    client: Client,
  ): Promise<{ env: Record<string, string>; names: string[]; presets: string[] } | undefined>;
  timing: Timing;
  /** A client whose channel holds more unsent bytes than this stopped
   * reading: it is disconnected. Output is credited (a stream has at most
   * 256 KiB on its way), so only a client that does not read gets there. */
  maxBuffered: number;
}

interface TermStream extends ClientStream {
  readonly observe: boolean;
  /** The connection it is attached through. */
  readonly conn: Conn;
  /** Ends its pump without closing it. */
  readonly pumping: AbortController;
  /** The backend that counts it as a stream setting its terminal's size
   * (Backend.joined), null for an observer: it is handed back there
   * whether or not the client still follows the machine. */
  readonly sizing: Backend | null;
  /** The backend of the machine it was attached through, which knows it
   * while it lasts (Backend.track). */
  readonly backend: Backend;
  focused: boolean;
  /** Output sent to the client that it has not returned as credit; an ack
   * returns at most this much. */
  unacked: number;
}

/** A params object whose JSON is null: the core gets null, as the client
 * sent it. */
const NULL_PARAMS = { toJSON: () => null };
const MAX_PENDING_CALLS = 64;
const MAX_PENDING_ATTACHES = 16;

interface Subscription {
  b: Backend;
  pending: AbortController;
}

export class TermClient implements Subscriber {
  private readonly ch: Channel;
  private readonly who: Who;
  /** Which kind of client this is: vault presets reach its terminals only
   * where the vault is enabled for it. */
  private readonly client: Client;
  private readonly d: ClientDeps;
  private readonly life = new AbortController();
  private readonly attached = new Map<number, TermStream>();
  private readonly subs = new Map<string, Subscription>();
  private pendingCalls = 0;
  private pendingAttaches = 0;
  private next = 0;
  private closed = false;
  private overflowed = false;

  constructor(ch: Channel, who: Who, client: Client, d: ClientDeps) {
    this.ch = ch;
    this.who = who;
    this.client = client;
    this.d = d;
    d.audit.log(who, 'term.connect');
  }

  /** The channel's handlers. */
  handlers(): ChannelHandlers {
    return {
      message: (data) => this.message(data),
      close: () => this.end(),
    };
  }

  // Subscriber

  send(data: string | Uint8Array): void {
    if (this.closed || this.overflowed) return;
    if (this.ch.buffered > this.d.maxBuffered) {
      this.overflowed = true;
      this.d.logger('term: client send queue overflow, disconnecting');
      this.ch.close(CloseCode.Overflow);
      return;
    }
    this.ch.send(data);
  }

  streams(): Iterable<ClientStream> {
    return this.attached.values();
  }

  dropped(machine: string, b: Backend): void {
    if (this.subs.get(machine)?.b === b) this.unsubscribe(machine);
  }

  private sendJSON(v: object): void {
    this.send(JSON.stringify(v));
  }

  private fail(rid: number, kind: string, message = ''): void {
    this.sendJSON({ t: 'res', rid, error: { kind, message } });
  }

  private failErr(rid: number, e: unknown): void {
    if (e instanceof HCError) this.fail(rid, e.kind, e.rpcMessage);
    else this.fail(rid, 'unavailable');
  }

  private audit(event: string, fields?: AuditFields): void {
    this.d.audit.log(this.who, event, fields);
  }

  /** The channel ended: the client's streams and subscriptions go. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.life.abort();
    const streams = [...this.attached.values()];
    const subs = [...this.subs.values()];
    this.attached.clear();
    this.subs.clear();
    for (const ts of streams) this.release(ts);
    for (const { b } of subs) b.unsubscribe(this);
    this.audit('term.disconnect');
  }

  /** Closes the channel (the hub stops). */
  close(code: number = CloseCode.GoingAway): void {
    this.ch.close(code);
  }

  private message(data: Message): void {
    if (this.closed) return;
    if (typeof data !== 'string') return this.input(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    const m = parseInbound(data);
    if (m) this.dispatch(m);
  }

  /** Forwards a binary frame from the client to its stream. */
  private input(f: Buffer): void {
    if (f.length < 5 || this.d.readOnly) return;
    const ts = this.attached.get(f.readUInt32LE(0));
    if (!ts || ts.observe) return;
    try {
      if (f[4] === FrameKind.Data) ts.stream.write(f.subarray(5));
      else if (f[4] === FrameKind.Automatic) ts.stream.writeAutomatic(f.subarray(5));
    } catch {
      // the connection ended; the stream's pump says so
    }
  }

  private dispatch(m: Inbound): void {
    switch (m.t) {
      case 'ping':
        return this.sendJSON({ t: 'pong', rid: m.rid });
      case 'sub': {
        if (!this.d.machines.get(m.m) || this.subs.has(m.m)) return;
        const b = this.d.backend(m.m);
        this.subs.set(m.m, { b, pending: new AbortController() });
        return b.subscribe(this);
      }
      case 'unsub':
        return this.unsubscribe(m.m)?.unsubscribe(this);
      case 'call':
      case 'attach':
        return void this.request(m);
      case 'ack': {
        // Credit for output the client was sent and has not returned yet,
        // no more: a client cannot make the terminal core send ahead of
        // what it draws.
        const ts = this.attached.get(m.s);
        if (!ts || m.n <= 0) return;
        const n = Math.min(m.n, ts.unacked);
        ts.unacked -= n;
        if (n > 0) this.quietly(() => ts.stream.ack(n));
        return;
      }
      case 'resize': {
        const ts = this.attached.get(m.s);
        if (ts && !ts.observe) this.quietly(() => ts.stream.resize(m.cols, m.rows));
        return;
      }
      case 'focus': {
        // An observer's focus changes nothing: neither the terminal core's
        // viewer nor whether a finished turn counts as seen.
        const ts = this.attached.get(m.s);
        if (!ts || ts.observe) return;
        ts.focused = m.focused;
        const b = this.subs.get(ts.machine)?.b;
        this.quietly(() => ts.stream.focus(m.focused));
        // Looking at a terminal whose turn ended has seen it.
        if (m.focused) b?.seen(ts.terminal);
        return;
      }
      case 'facts': {
        const ts = this.attached.get(m.s);
        if (ts && !ts.observe && m.display) this.quietly(() => ts.stream.facts(m.display!));
        return;
      }
      case 'detach': {
        const ts = this.attached.get(m.s);
        this.attached.delete(m.s);
        if (ts) this.release(ts);
        return;
      }
    }
  }

  private async request(m: Inbound): Promise<void> {
    const attach = m.t === 'attach';
    if (attach ? this.pendingAttaches >= MAX_PENDING_ATTACHES : this.pendingCalls >= MAX_PENDING_CALLS) return this.fail(m.rid, 'busy');
    if (attach) this.pendingAttaches++;
    else this.pendingCalls++;
    try {
      await (attach ? this.attach(m) : this.call(m));
    } catch (e) {
      this.d.logger(`term: ${attach ? 'attach' : m.method}: ${(e as Error).message}`);
      this.fail(m.rid, 'unavailable');
    } finally {
      if (attach) this.pendingAttaches--;
      else this.pendingCalls--;
    }
  }

  private unsubscribe(machine: string): Backend | undefined {
    const sub = this.subs.get(machine);
    this.subs.delete(machine);
    sub?.pending.abort();
    return sub?.b;
  }

  /** Runs a stream's write, whose failure (the connection ended) the
   * stream's pump reports. */
  private quietly(fn: () => void): void {
    try {
      fn();
    } catch {
      // the connection ended, or the size is out of range
    }
  }

  /** Lets go of a stream the client no longer has (it detached, or left):
   * an observer's is closed; one that set its terminal's size goes to the
   * backend, which keeps the last one of a terminal attached
   * (Backend.left). The program is told the viewer's focus is gone, which
   * herdr-core does not say for a viewer that stays. */
  private release(ts: TermStream): void {
    ts.pumping.abort();
    ts.backend.untrack(ts);
    if (!ts.sizing) return ts.stream.close();
    if (ts.focused) this.quietly(() => ts.stream.focus(false));
    ts.sizing.left(ts.conn, ts.terminal, ts.stream, true);
  }

  /** The backend of a machine the client subscribed to and its connection
   * when it is ready. */
  private subscribed(machine: string): (Subscription & { conn: Conn }) | null {
    const sub = this.subs.get(machine);
    const conn = sub?.b.connection();
    return sub && conn ? { ...sub, conn } : null;
  }

  /** Answers a call or an attach that names a terminal that is none of the
   * clients' as the terminal core answers for a terminal it does not have,
   * and audits it with why. */
  private noTerminal(m: Inbound, method: string, param: string, target: string, why: NotClients): void {
    this.audit('denied.term', { machine: m.m, method, param, terminal: target, reason: why.reason });
    const i = target.indexOf('/');
    this.fail(m.rid, 'not_found', `no terminal ${goQuote(i >= 0 ? target.slice(i + 1) : target)}`);
  }

  /** Answers a call that would reach a terminal that is none of the
   * clients' or make a hidden one, and reports whether it did; otherwise
   * names each terminal the call names by its address (Backend.resolve).
   * Labels that are not an object of strings are refused as the terminal
   * core would (usage): what the core reads is what was checked. A run or a
   * label that sets the hidden label, or a run that takes the chat host's
   * name, is refused; so is a call that names a hidden terminal or another
   * machine's, as its terminal, as who calls or as a new terminal's parent
   * (answered as for a terminal that does not exist). None of these
   * reaches the terminal core; a target the backend does not know is
   * looked up there (terminal.get) before. */
  private async refuseTargets(b: Backend, conn: Conn, m: Inbound, params: Params, signal: AbortSignal): Promise<boolean> {
    if ('labels' in params && !isStringMap(params.labels)) {
      this.fail(m.rid, 'usage');
      return true;
    }
    if (m.method === 'terminal.run' || m.method === 'terminal.label') {
      const labels = isStringMap(params.labels) ? params.labels : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const param = HIDDEN_LABEL in labels ? 'labels' : isChatHostName(name) ? 'name' : '';
      if (param) {
        this.audit('denied.term', { machine: m.m, method: m.method, param });
        this.fail(m.rid, 'refused');
        return true;
      }
    }
    for (const param of TARGET_PARAMS) {
      const target = params[param];
      if (typeof target !== 'string') continue; // absent, or not a terminal the core takes
      let addr: string;
      try {
        addr = await b.resolve(target, conn, signal);
      } catch (e) {
        if (e instanceof NotClients) this.noTerminal(m, m.method, param, target, e);
        else this.failErr(m.rid, e);
        return true;
      }
      if (addr !== target) params[param] = addr;
    }
    return false;
  }

  private async call(m: Inbound): Promise<void> {
    const write = WRITE_METHODS.has(m.method);
    if (!write && !READ_METHODS.has(m.method)) {
      this.audit('denied.term', { machine: m.m, method: m.method });
      return this.fail(m.rid, 'refused');
    }
    if (write && this.d.readOnly) return this.fail(m.rid, 'read_only');
    // Absent: an empty object; null: null, as the client sent it.
    let params: Params | null = {};
    if (m.params !== undefined) {
      if (m.params !== null && !isObject(m.params)) return this.fail(m.rid, 'usage');
      params = m.params;
    }
    // "on" would address a machine the terminal core itself added.
    if (params && ROUTING_PARAM in params) {
      this.audit('denied.term', { machine: m.m, method: m.method, param: ROUTING_PARAM });
      return this.fail(m.rid, 'refused');
    }
    if (this.d.readOnly && m.method === 'terminal.read') readScreenOnly(params);
    const sub = this.subscribed(m.m);
    if (!sub) return this.fail(m.rid, 'unavailable');
    const signal = AbortSignal.any([this.life.signal, AbortSignal.timeout(this.d.timing.callMs)]);
    if (params && (await this.refuseTargets(sub.b, sub.conn, m, params, signal))) return;
    const ev: AuditFields = { machine: m.m, terminal: params?.terminal ?? null, argv: params?.argv ?? null };
    let stagedToken = '';
    const mc = m.method === 'terminal.run' ? this.d.machines.get(m.m) : undefined;
    if (m.method === 'terminal.run') {
      // Hub-only parameter naming the workspace whose linked vault presets
      // should be injected; stripped before reaching the terminal core.
      let workspace = '';
      if (params && 'workspace' in params) {
        if (typeof params.workspace !== 'string' || Buffer.byteLength(params.workspace) > 128 || /[\x00-\x1f\x7f]/.test(params.workspace))
          return this.fail(m.rid, 'usage');
        workspace = params.workspace;
        delete params.workspace;
      }
      // The audit entry names the variables the client gave, not their
      // values, which may be secrets.
      const given = envOf(params?.env);
      if (given === undefined) return this.fail(m.rid, 'usage');
      if (given && Object.keys(given).length) ev.client_env = Object.keys(given).sort();
      ev.cwd = params?.cwd ?? null;
      if (mc) {
        const p: Params = { ...(params ?? {}) };
        const added: string[] = [];
        const display = this.d.paneEnv(mc);
        const ssh = this.d.sshEnv(mc);
        // Workspace-linked vault presets (feature 30): staged in memory on the
        // machine's node (Op.TermEnv) and consumed once via <run>/env.sock +
        // execve, never sent in terminal.run.env (which herdr-core persists to
        // terminals.json and reuses on kept-terminal recovery). Precedence:
        // virtual display > client env > vault preset > ssh env.
        const vaultEnv: Record<string, string> = {};
        let vaultPresets: string[] = [];
        if (workspace && this.d.workspaceEnv) {
          const resolved = await this.d.workspaceEnv(mc, workspace, this.client);
          if (resolved && Object.keys(resolved.env).length) {
            for (const [k, val] of Object.entries(resolved.env)) {
              if ((given && k in given) || (display && k in display)) continue;
              vaultEnv[k] = val;
            }
            vaultPresets = resolved.presets;
          }
        }
        const vaultNames = Object.keys(vaultEnv).sort();
        const clientEnv = p.env;
        // New programs get the machine's virtual display (feature 14): its
        // variables replace any the client gave, so a client cannot point
        // them elsewhere. Programs on an ssh machine learn that their
        // terminal is shown elsewhere; what the client gave stays.
        const plain = (): boolean => {
          if (display && Object.keys(display).length) {
            const names = addEnv(p, display, true);
            if (!names) return false;
            added.push(...names);
          }
          if (ssh && Object.keys(ssh).length) {
            const names = addEnv(p, ssh, false);
            if (!names) return false;
            added.push(...names);
          }
          if (added.length) {
            ev.env = [...new Set(added)].sort();
            params = p;
          }
          return true;
        };
        let staged = false;
        if (vaultNames.length > 0) {
          let runArgv: string[] | undefined;
          if (p.argv !== undefined && p.argv !== null) {
            if (
              !Array.isArray(p.argv) ||
              !p.argv.every((a): a is string => typeof a === 'string' && !a.includes('\0')) ||
              (p.argv.length > 0 && p.argv[0] === '')
            ) {
              return this.fail(m.rid, 'usage');
            }
            if (p.argv.length > 0) runArgv = p.argv;
          }
          let runLine: string | undefined;
          if (p.line !== undefined && p.line !== null) {
            if (typeof p.line !== 'string' || p.line.includes('\0')) return this.fail(m.rid, 'usage');
            runLine = p.line;
          }
          if (runArgv && runLine !== undefined) return this.fail(m.rid, 'usage');
          const stageEnv: Record<string, string> = { ...vaultEnv };
          const coreGiven: Record<string, string> = {};
          if (given) {
            for (const [k, val] of Object.entries(given)) {
              if (display && k in display) continue;
              // Keep BUN_* client vars off the `term-env` Bun binary itself
              // while still handing them to the execve'd user program.
              if (isForeignRuntimeVar(k)) stageEnv[k] = val;
              else coreGiven[k] = val;
            }
          }
          for (const [k, val] of Object.entries(stageEnv)) {
            if (k === '' || k.includes('=') || k.includes('\0') || val.includes('\0')) return this.fail(m.rid, 'usage');
          }
          if (Object.keys(coreGiven).length > 0) p.env = coreGiven;
          else delete p.env;
          ev.vault_env = vaultNames;
          ev.vault_presets = vaultPresets;
          added.push(...vaultNames);
          if (display && Object.keys(display).length) {
            const names = addEnv(p, display, true);
            if (!names) return this.fail(m.rid, 'usage');
            added.push(...names);
          }
          if (ssh && Object.keys(ssh).length) {
            const sshOnly = Object.fromEntries(Object.entries(ssh).filter(([k]) => !(k in stageEnv)));
            if (Object.keys(sshOnly).length) {
              const names = addEnv(p, sshOnly, false);
              if (!names) return this.fail(m.rid, 'usage');
              added.push(...names);
            }
          }
          ev.env = [...new Set(added)].sort();
          const stagePayload: TermEnvStageParams = {
            env: stageEnv,
            ...(runArgv ? { argv: runArgv } : {}),
            ...(runLine !== undefined ? { line: runLine } : {}),
          };
          const encoded = Buffer.from(JSON.stringify(stagePayload));
          if (encoded.length > MAX_BODY) return this.fail(m.rid, 'usage');
          const h: Header =
            encoded.length > MAX_INLINE
              ? { op: Op.TermEnv, action: 'stage', params_length: encoded.length }
              : { op: Op.TermEnv, action: 'stage', params: stagePayload };
          try {
            const rep = await mc.request(h, {
              signal,
              timeoutMs: this.d.timing.callMs,
              ...(encoded.length > MAX_INLINE ? { body: encoded } : {}),
            });
            if (!rep.termenv?.token || !Array.isArray(rep.termenv.launch) || rep.termenv.launch.length === 0) {
              return this.fail(m.rid, 'unavailable');
            }
            stagedToken = rep.termenv.token;
            p.argv = rep.termenv.launch;
            delete p.line;
            params = p;
            staged = true;
          } catch (e) {
            if (!unknownOp(e)) return this.fail(m.rid, 'unavailable');
            // A node of an earlier release (AGENTS.md rule 7) cannot stage
            // values: the terminal starts without them, and the audit entry
            // says which it did not get.
            if (clientEnv === undefined) delete p.env;
            else p.env = clientEnv;
            added.length = 0;
            delete ev.vault_env;
            delete ev.vault_presets;
            delete ev.env;
            ev.vault_unsupported = vaultNames;
          }
        }
        if (!staged && !plain()) return this.fail(m.rid, 'usage');
      }
    }
    if (AUDITED_METHODS.has(m.method)) this.audit(m.method, ev);
    let result: unknown;
    try {
      result = await sub.conn.call(m.method, params ?? NULL_PARAMS, { signal });
    } catch (e) {
      if (stagedToken && mc) {
        void mc.request({ op: Op.TermEnv, action: 'drop', params: { token: stagedToken } }, { timeoutMs: 5000 }).catch(() => {});
      }
      return this.failErr(m.rid, e);
    }
    if ((m.method === 'terminal.run' || m.method === 'terminal.get') && isObject(result)) {
      result = cleanRecord(result);
    }
    if (m.method === 'terminal.list') {
      result = sub.b.visible(result);
      if (result === undefined) return this.fail(m.rid, 'unavailable');
    }
    this.sendJSON({ t: 'res', rid: m.rid, result: result ?? null });
  }

  private async attach(m: Inbound): Promise<void> {
    const sub = this.subscribed(m.m);
    if (!sub) return this.fail(m.rid, 'unavailable');
    const { b, conn } = sub;
    const signal = AbortSignal.any([this.life.signal, sub.pending.signal, AbortSignal.timeout(this.d.timing.attachMs)]);
    // The terminal by its address (Backend.resolve): a name, or an address
    // the backend does not know yet, is looked up first.
    let addr: string;
    try {
      addr = await b.resolve(m.terminal, conn, signal);
    } catch (e) {
      if (e instanceof NotClients) return this.noTerminal(m, 'terminal.attach', 'terminal', m.terminal, e);
      return this.failErr(m.rid, e);
    }
    const observe = m.observe || this.d.readOnly;
    const p: AttachParams = { terminal: addr, cols: m.cols, rows: m.rows };
    if (m.history) p.history = m.history;
    if (observe) {
      p.observe = true;
      p.resize_notifications = true;
    } else if (m.display) {
      // A viewer's display facts are what the terminal answers programs
      // with; an observer sends none, as it sends no facts later.
      p.display = m.display;
    }
    let stream: Stream;
    let rec: Record<string, unknown>;
    let automatic: boolean;
    try {
      const a = await conn.attach(p, { signal });
      stream = a.stream;
      rec = isObject(a.attached.terminal) ? a.attached.terminal : {};
      automatic = a.attached.automatic_input === true;
    } catch (e) {
      return this.failErr(m.rid, e);
    }
    // The terminal attached to, as its record in the reply says: a hidden
    // one (it became so since it was looked up) is none, and its stream
    // ends unread.
    if (typeof rec.address === 'string' && rec.address) addr = rec.address;
    if (hiddenRecord(rec) || otherMachine(addr) || b.isHidden(addr)) {
      stream.close();
      return this.noTerminal(m, 'terminal.attach', 'terminal', m.terminal, new NotClients('hidden'));
    }
    // The terminal has this viewer now: the one kept for its size ends. It
    // is counted before the client has the stream, so that a client leaving
    // meanwhile hands back one that is counted.
    const sizing = observe ? null : b;
    sizing?.joined(conn, addr);
    if (signal.aborted) {
      if (sizing) sizing.left(conn, addr, stream, true);
      else stream.close();
      return this.fail(m.rid, 'unavailable');
    }
    const id = ++this.next;
    // The stream is of the terminal's address, whatever the client named:
    // it ends when that terminal becomes hidden.
    const ts: TermStream = {
      stream,
      observe,
      conn,
      pumping: new AbortController(),
      sizing,
      backend: b,
      machine: m.m,
      terminal: addr,
      focused: false,
      unacked: 0,
    };
    this.attached.set(id, ts);
    // The reply goes before the stream's first frame.
    this.sendJSON({
      t: 'attached',
      rid: m.rid,
      s: id,
      terminal: m.terminal,
      cols: typeof rec.cols === 'number' ? rec.cols : 0,
      rows: typeof rec.rows === 'number' ? rec.rows : 0,
      observe,
      automatic,
    });
    void this.pump(id, ts);
    // Hidden in the instant before the backend knew the stream: it ends now.
    if (b.track(ts)) stream.close();
  }

  /** Forwards a stream's output to the client until it ends. The client
   * returns credit with "ack" as it draws, which reaches the terminal
   * core. */
  private async pump(id: number, ts: TermStream): Promise<void> {
    for (;;) {
      let out: Output | null | undefined;
      try {
        out = await ts.stream.recv(ts.pumping.signal);
      } catch {
        out = undefined;
      }
      if (!out) {
        if (this.attached.get(id) !== ts) return; // detached, or the client left
        this.attached.delete(id);
        // The stream is over: it no longer counts for its terminal's size.
        ts.pumping.abort();
        ts.backend.untrack(ts);
        ts.sizing?.left(ts.conn, ts.terminal, ts.stream, false);
        const x = out === null ? ts.stream.exit() : null;
        this.sendJSON(
          x
            ? { t: 'closed', s: id, reason: x.reason, exit_code: x.exit_code ?? null, signal: x.signal ?? null }
            : { t: 'closed', s: id, reason: Code.Lost },
        );
        return;
      }
      if ('data' in out) {
        if (this.attached.get(id) === ts) ts.unacked += out.data.length;
        this.send(frame(id, FrameKind.Data, out.data));
      } else this.send(resizeFrame(id, out.cols, out.rows));
    }
  }
}

/** Whether e is a node's refusal of an op it does not know (a node of an
 * earlier release). */
function unknownOp(e: unknown): boolean {
  return e instanceof AgentError && typeof e.reply?.error === 'string' && e.reply.error.startsWith('unknown op');
}
